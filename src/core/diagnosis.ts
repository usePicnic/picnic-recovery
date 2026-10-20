import { hexToString, isAddress, parseAbi, type Hex, type Address, type Chain, type PublicClient } from "viem";
import { products } from "../catalog/products";
import { address, same } from "./client";
import { erc20Abi } from "./abi";
import { inspectAccount } from "./inspect";
import { inspectPosition, type Position } from "./investments";
import { discoverMamo, type MamoPosition } from "./mamo";
import { BASKET, discoverBaskets } from "./legacy";
import { inspectCard, type CardDelay } from "./card";
import { aggregateWords, balanceOfData, classify, decimalsData, ReadPool, type WordRead } from "./reads";
import type { AccountSnapshot } from "./types";

export type TokenEntry = { chainId: number; address: string; name: string; symbol?: string; decimals?: number };
export type TokenHolding = TokenEntry & { balance: bigint; verifiedDecimals?: number };
export type NetworkDiagnosis = {
  chainId: number; account: Address; status: "queued" | "scanning" | "complete" | "partial" | "unavailable";
  phase: "account" | "assets" | "done"; snapshot?: AccountSnapshot; nativeBalance?: bigint;
  tokens: TokenHolding[]; positions: Position[]; basketCount?: bigint; strategyCount?: number; strategies?: MamoPosition[]; basketIds?: bigint[]; cards: CardDelay[]; linkedCards?: NetworkDiagnosis[];
  // failedTokens: balance unknown because the RPC did not answer.
  // unreadableTokens: the contract itself reverts or returns no balance at this block.
  checkedTokens: number; totalTokens: number; failedTokens: number; unreadableTokens: TokenEntry[]; issues: string[];
  // Token balances are read at the account snapshot block; if the RPC no longer
  // serves that state (short-history BSC nodes), later chunks use newer blocks.
  tokenBlocks?: { from: bigint; to: bigint }; sources: string[];
};
export type WalletGas = { address: Address; balance?: bigint; error?: string };
export const emptyDiagnosis = (chainId: number, account: Address): NetworkDiagnosis => ({
  chainId, account, status: "queued", phase: "account", tokens: [], positions: [], cards: [], checkedTokens: 0, totalTokens: 0, failedTokens: 0, unreadableTokens: [], issues: [], sources: [],
});
export function hasPosition(p: Position) {
  return p.balance > 0n || (p.pending ?? 0n) > 0n || (p.claimable ?? 0n) > 0n || (p.pendingDeposit ?? 0n) > 0n || (p.claimableDeposit ?? 0n) > 0n || !!p.requests?.length;
}
export function hasAssets(d: NetworkDiagnosis) {
  return (d.nativeBalance ?? 0n) > 0n || !!d.tokens.length || d.positions.some(hasPosition) || (d.basketCount ?? 0n) > 0n || (d.strategyCount ?? 0) > 0 || !!d.linkedCards?.some(card => (card.nativeBalance ?? 0n) > 0n || card.tokens.length > 0 || card.cards.some(delay => delay.tail > delay.head));
}
export type NextAction = "unverified" | "unsupported" | "waiting" | "finalize" | "connect" | "fund" | "prepare" | "recover" | "owner-required" | "no-findings";
export function nextAction(d: NetworkDiagnosis, wallet?: Address, gas?: WalletGas): NextAction {
  if (!d.snapshot) return "unverified";
  if (d.snapshot.warnings.some(w => w.includes("transactions disabled"))) return "unsupported";
  const pending = d.snapshot.recoveries.find(r => r.supported && r.pending.executeAfter > 0n);
  if (pending) return pending.pending.executeAfter > d.snapshot.timestamp ? "waiting" : "finalize";
  if (!hasAssets(d) && d.snapshot.version === "EOA" && d.status === "complete") return "no-findings";
  if (!wallet) return "connect";
  if (d.snapshot.owners.some(o => same(o, wallet))) {
    return gas && same(gas.address, wallet) && gas.balance === 0n ? "fund" : "prepare";
  }
  if (d.snapshot.recoveries.some(r => r.supported && r.threshold > 0n)) return "recover";
  return "owner-required";
}

export type ReadSource = { url: string; client?: PublicClient };
type TokenRead = { status: "ok"; value: bigint } | { status: "contract" } | { status: "rpc" };
const CHUNK = 100;
const MIN_SPLIT = 12;

// Publish incrementally. Cancellation prevents stale results and further batches;
// each already-issued RPC is bounded by its transport timeout.
export async function diagnoseNetwork(options: {
  chain: Chain; account: Address; sources: readonly ReadSource[]; signal: AbortSignal;
  update: (result: NetworkDiagnosis) => void;
  catalogue?: readonly TokenEntry[]; waitLimit?: number;
}) {
  const { chain, account, signal, update } = options;
  let state = emptyDiagnosis(chain.id, account);
  const pool = new ReadPool(chain, options.sources, signal, options.waitLimit);
  const emit = (patch: Partial<NetworkDiagnosis>) => { state = { ...state, ...patch, sources: [...pool.used] }; if (!signal.aborted) update(state); };
  const issue = (message: string) => emit({ issues: [...state.issues, message] });
  const active = () => { if (signal.aborted) throw new DOMException("Cancelled", "AbortError"); };
  try {
    active(); emit({ status: "scanning" });
    // Do not read balances from a misconfigured RPC or label unknown bytecode empty.
    // The whole account snapshot comes from one endpoint at one block.
    const snapshot = await pool.run(client => inspectAccount(client, account, chain.id));
    active(); emit({ snapshot, nativeBalance: snapshot.nativeBalance, phase: "assets" });
    const blockNumber = snapshot.block;
    const catalogue = options.catalogue ?? (await import("../catalog/tokens.json")).default;
    const candidates = [...catalogue.filter(t => t.chainId === chain.id), ...products.filter(p => p.chainId === chain.id && p.kind !== "staking").map(p => ({ chainId: p.chainId, address: p.address, name: p.name }))];
    const tokens = [...new Map(candidates.filter(t => isAddress(t.address, { strict: false })).map(t => [t.address.toLowerCase(), t])).values()];
    emit({ totalTokens: tokens.length });
    // Current products include pending requests even when the share balance is zero.
    await Promise.all(products.filter(p => p.chainId === chain.id).map(async product => {
      active();
      try { const position = await pool.run(client => inspectPosition(client, account, product)); active(); if (hasPosition(position)) emit({ positions: [...state.positions, position] }); }
      catch (e) { active(); issue(`${product.name}: ${message(e)}`); }
    }));
    if (chain.id === 137) {
      try {
        const basketCount = await pool.run(client => client.readContract({ address: BASKET, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber }));
        emit({ basketCount });
        if (basketCount > 0n) {
          const page = await pool.run(client => discoverBaskets(client, account, 0n));
          active(); emit({ basketIds: page.owned });
          if (BigInt(page.owned.length) < basketCount) issue("Some basket IDs remain unidentified; use the remaining baskets row to continue discovery.");
        }
      }
      catch (e) { active(); issue(`Legacy baskets: ${message(e)}`); }
    }
    if (chain.id === 8453) {
      try {
        const strategies = await pool.run(client => discoverMamo(client, account)); active();
        emit({ strategyCount: strategies.filter(r => r.status === "fulfilled").length, strategies: strategies.flatMap(r => r.status === "fulfilled" ? [r.value] : []) });
        if (strategies.some(r => r.status === "rejected")) issue("Some MAMO strategies could not be inspected");
      } catch (e) { active(); issue(`MAMO: ${message(e)}`); }
    }
    if (chain.id === 100 && snapshot.version !== "EOA") {
      try { emit({ cards: await pool.run(client => inspectCard(client, account, chain.id)) }); }
      catch { /* A normal Safe is not a card. Account inspection remains valid. */ }
    }
    const reader = new TokenReader(pool, chain, account, blockNumber, signal);
    for (let offset = 0; offset < tokens.length; offset += CHUNK) {
      active();
      const batch = tokens.slice(offset, offset + CHUNK);
      const values = await reader.balances(batch);
      active();
      const positive = batch.flatMap((t, i) => { const v = values[i]; return v.status === "ok" && v.value > 0n ? [{ token: t, balance: v.value }] : []; });
      const decimals = await reader.decimals(positive.map(p => p.token));
      active();
      emit({
        checkedTokens: offset + batch.length,
        failedTokens: state.failedTokens + values.filter(v => v.status === "rpc").length,
        unreadableTokens: [...state.unreadableTokens, ...batch.filter((_, i) => values[i].status === "contract")],
        tokens: [...state.tokens, ...positive.map((p, i) => ({ ...p.token, balance: p.balance, verifiedDecimals: decimals[i] }))],
        tokenBlocks: reader.range(),
      });
      if (values.length && values.every(v => v.status === "rpc")) {
        // Stop if even a basic read now fails; remaining tokens stay unchecked.
        await pool.run(client => client.getBlockNumber());
      }
    }
    active();
    emit({ status: state.issues.length || state.failedTokens || state.checkedTokens < state.totalTokens ? "partial" : "complete", phase: "done" });
  } catch (e) {
    if (signal.aborted) return;
    emit({ status: state.snapshot ? "partial" : "unavailable", phase: "done", issues: [...state.issues, message(e)] });
  }
}

// Bounded adaptive token reads: one aggregate3 per chunk, halving on oversized
// or failed requests down to MIN_SPLIT, then individual reads. Unanswered
// tokens are reported as RPC failures; they are never treated as zero.
class TokenReader {
  private block: bigint;
  private blocks?: { from: bigint; to: bigint };
  private repins = 0;
  constructor(private pool: ReadPool, private chain: Chain, private account: Address, block: bigint, private signal: AbortSignal) { this.block = block; }
  // Blocks at which token reads actually succeeded.
  range() { return this.blocks && { ...this.blocks }; }
  private note(block: bigint) {
    this.blocks = { from: !this.blocks || block < this.blocks.from ? block : this.blocks.from, to: !this.blocks || block > this.blocks.to ? block : this.blocks.to };
  }
  private async repin(error: unknown) {
    if (classify(error) !== "state" || this.repins >= 5) return false;
    this.repins++;
    const latest = await this.pool.run(client => client.getBlockNumber());
    this.block = latest;
    return true;
  }
  private async alive() {
    try { await this.pool.run(client => client.getBlockNumber()); return true; } catch (e) { if (this.signal.aborted) throw e; return false; }
  }
  async balances(batch: readonly TokenEntry[]): Promise<TokenRead[]> {
    const multicall = this.chain.contracts?.multicall3?.address;
    if (!multicall) return this.individually(batch, "balanceOf");
    return this.words(batch, balanceOfData(this.account), multicall);
  }
  async decimals(batch: readonly TokenEntry[]): Promise<(number | undefined)[]> {
    if (!batch.length) return [];
    const multicall = this.chain.contracts?.multicall3?.address;
    const reads = multicall ? await this.words(batch, decimalsData, multicall) : await this.individually(batch, "decimals");
    // Show raw balance when decimals are unreadable; do not trust catalogue precision.
    return reads.map(r => r.status === "ok" && r.value <= 255n ? Number(r.value) : undefined);
  }
  private async words(batch: readonly TokenEntry[], data: `0x${string}`, multicall: Address): Promise<TokenRead[]> {
    for (;;) {
      try {
        const block = this.block;
        const words: WordRead[] = await this.pool.run(client => aggregateWords(client, multicall, batch.map(t => ({ target: t.address, data })), block));
        this.note(block);
        return words.map(w => w.ok ? { status: "ok", value: w.value } : { status: "contract" });
      } catch (e) {
        if (this.signal.aborted) throw e;
        if (await this.repin(e)) continue;
        // The pool already tried its endpoints/backoff. Smaller eth_call
        // requests cannot fix a method-level rate limit, even if block reads
        // still work; do not fan it out into thousands of individual calls.
        if (classify(e) === "rate") {
          if (data === decimalsData) return batch.map(() => ({ status: "rpc" }));
          throw e;
        }
        // A down RPC is not retried token by token; the scan reports it unverified.
        if (["rate", "transport"].includes(classify(e)) && !await this.alive()) return batch.map(() => ({ status: "rpc" }));
        if (batch.length > MIN_SPLIT) {
          const half = Math.ceil(batch.length / 2);
          return [...await this.words(batch.slice(0, half), data, multicall), ...await this.words(batch.slice(half), data, multicall)];
        }
        return this.individually(batch, data === decimalsData ? "decimals" : "balanceOf");
      }
    }
  }
  private async individually(batch: readonly TokenEntry[], functionName: "balanceOf" | "decimals"): Promise<TokenRead[]> {
    const out: TokenRead[] = [];
    for (let i = 0; i < batch.length; i += 5) {
      if (this.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      out.push(...await Promise.all(batch.slice(i, i + 5).map(t => this.one(t, functionName))));
    }
    return out;
  }
  private async one(token: TokenEntry, functionName: "balanceOf" | "decimals"): Promise<TokenRead> {
    for (;;) {
      try {
        const block = this.block, target = address(token.address.toLowerCase());
        const value: bigint | number = functionName === "balanceOf"
          ? await this.pool.run(client => client.readContract({ address: target, abi: erc20Abi, functionName, args: [this.account], blockNumber: block }))
          : await this.pool.run(client => client.readContract({ address: target, abi: erc20Abi, functionName, blockNumber: block }));
        this.note(block);
        return { status: "ok", value: BigInt(value) };
      } catch (e) {
        if (this.signal.aborted) throw e;
        if (await this.repin(e)) continue;
        return { status: classify(e) === "revert" ? "contract" : "rpc" };
      }
    }
  }
}

// Session-only token added by the user. Metadata strings come from an arbitrary
// contract: they are trimmed, stripped of control characters and rendered as text.
export type CustomToken = TokenHolding & { block: bigint; account: Address; custom: true };
export type CustomTokenError = "not-contract" | "no-balance" | "rpc" | "invalid-address";
export class CustomTokenFailure extends Error { constructor(readonly code: CustomTokenError) { super(code); } }
const metadataAbi = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);
const bytes32Abi = parseAbi(["function name() view returns (bytes32)", "function symbol() view returns (bytes32)"]);
function clean(value: unknown) {
  if (typeof value !== "string") return undefined;
  let text = value;
  if (/^0x[0-9a-f]{64}$/i.test(value)) { try { text = hexToString(value as Hex); } catch { return undefined; } }
  const result = text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, 32);
  return result || undefined;
}
export async function inspectCustomToken(pool: ReadPool, chainId: number, account: Address, raw: string): Promise<CustomToken> {
  let token: Address;
  try { token = address(raw); } catch { throw new CustomTokenFailure("invalid-address"); }
  try {
    // One endpoint, one block: code, balance and decimals are mutually consistent.
    return await pool.run(async client => {
      const block = await client.getBlockNumber();
      const code = await client.getCode({ address: token, blockNumber: block });
      pool.throwIfAborted();
      if (!code || code === "0x") throw new CustomTokenFailure("not-contract");
      let balance: bigint;
      try { balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber: block }); }
      catch (e) { if (classify(e) === "revert") throw new CustomTokenFailure("no-balance"); throw e; }
      const optional = async <T,>(read: () => Promise<T>) => { try { return await read(); } catch (e) { if (classify(e) === "revert") return undefined; throw e; } };
      const decimals = await optional(() => client.readContract({ address: token, abi: erc20Abi, functionName: "decimals", blockNumber: block }));
      const text = async (functionName: "name" | "symbol") => clean(await optional(() => client.readContract({ address: token, abi: metadataAbi, functionName, blockNumber: block })))
        ?? clean(await optional(() => client.readContract({ address: token, abi: bytes32Abi, functionName, blockNumber: block })));
      pool.throwIfAborted();
      const [symbol, name] = [await text("symbol"), await text("name")];
      pool.throwIfAborted();
      return { chainId, address: token, name: name ?? symbol ?? token, symbol, balance, verifiedDecimals: decimals, block, account, custom: true as const };
    });
  } catch (e) {
    if (e instanceof CustomTokenFailure || (e instanceof DOMException && e.name === "AbortError")) throw e;
    throw new CustomTokenFailure("rpc");
  }
}

function message(error: unknown) {
  // RPC URLs may contain API keys: do not echo request URLs or bodies in results.
  const name = error instanceof Error ? error.name : "RPC error";
  return error instanceof Error && error.message === "RPC chain mismatch" ? error.message : name;
}
