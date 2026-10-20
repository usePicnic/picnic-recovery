import { isAddress, type Address, type Chain, type PublicClient } from "viem";
import { products } from "../catalog/products";
import { publicClient, address, same } from "./client";
import { erc20Abi } from "./abi";
import { inspectAccount } from "./inspect";
import { inspectPosition, type Position } from "./investments";
import { discoverMamo } from "./mamo";
import { BASKET } from "./legacy";
import { inspectCard, type CardDelay } from "./card";
import type { AccountSnapshot } from "./types";

export type TokenEntry = { chainId: number; address: string; name: string; symbol?: string; decimals?: number };
export type TokenHolding = TokenEntry & { balance: bigint; verifiedDecimals?: number };
export type NetworkDiagnosis = {
  chainId: number; account: Address; status: "queued" | "scanning" | "complete" | "partial" | "unavailable";
  phase: "account" | "assets" | "done"; snapshot?: AccountSnapshot; nativeBalance?: bigint;
  tokens: TokenHolding[]; positions: Position[]; basketCount?: bigint; strategyCount?: number; cards: CardDelay[];
  checkedTokens: number; totalTokens: number; failedTokens: number; issues: string[];
};
export type WalletGas = { address: Address; balance?: bigint; error?: string };
export const emptyDiagnosis = (chainId: number, account: Address): NetworkDiagnosis => ({
  chainId, account, status: "queued", phase: "account", tokens: [], positions: [], cards: [], checkedTokens: 0, totalTokens: 0, failedTokens: 0, issues: [],
});
export function hasPosition(p: Position) {
  return p.balance > 0n || (p.pending ?? 0n) > 0n || (p.claimable ?? 0n) > 0n || (p.pendingDeposit ?? 0n) > 0n || (p.claimableDeposit ?? 0n) > 0n || !!p.requests?.length;
}
export function hasAssets(d: NetworkDiagnosis) {
  return (d.nativeBalance ?? 0n) > 0n || !!d.tokens.length || d.positions.some(hasPosition) || (d.basketCount ?? 0n) > 0n || (d.strategyCount ?? 0) > 0;
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

// Publish incrementally. Cancellation prevents stale results and further batches;
// each already-issued RPC is bounded by its transport timeout.
export async function diagnoseNetwork(options: {
  chain: Chain; account: Address; rpc: string; signal: AbortSignal;
  update: (result: NetworkDiagnosis) => void;
  client?: PublicClient; catalogue?: readonly TokenEntry[];
}) {
  const { chain, account, signal, update } = options;
  let state = emptyDiagnosis(chain.id, account);
  const emit = (patch: Partial<NetworkDiagnosis>) => { state = { ...state, ...patch }; if (!signal.aborted) update(state); };
  const issue = (message: string) => emit({ issues: [...state.issues, message] });
  const active = () => { if (signal.aborted) throw new DOMException("Cancelled", "AbortError"); };
  try {
    active(); emit({ status: "scanning" });
    const client = options.client ?? publicClient(chain, options.rpc);
    // Do not read balances from a misconfigured RPC or label unknown bytecode empty.
    if (await client.getChainId() !== chain.id) throw new Error("RPC chain mismatch");
    const snapshot = await inspectAccount(client, account, chain.id);
    active(); emit({ snapshot, nativeBalance: snapshot.nativeBalance, phase: "assets" });
    const blockNumber = snapshot.block;
    const catalogue = options.catalogue ?? (await import("../catalog/tokens.json")).default;
    const candidates = [...catalogue.filter(t => t.chainId === chain.id), ...products.filter(p => p.chainId === chain.id && p.kind !== "staking").map(p => ({ chainId: p.chainId, address: p.address, name: p.name }))];
    const tokens = [...new Map(candidates.filter(t => isAddress(t.address, { strict: false })).map(t => [t.address.toLowerCase(), t])).values()];
    emit({ totalTokens: tokens.length });
    // Current products include pending requests even when the share balance is zero.
    await Promise.all(products.filter(p => p.chainId === chain.id).map(async product => {
      active();
      try { const position = await inspectPosition(client, account, product); active(); if (hasPosition(position)) emit({ positions: [...state.positions, position] }); }
      catch (e) { active(); issue(`${product.name}: ${message(e)}`); }
    }));
    if (chain.id === 137) {
      try { emit({ basketCount: await client.readContract({ address: BASKET, abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber }) }); }
      catch (e) { issue(`Legacy baskets: ${message(e)}`); }
    }
    if (chain.id === 8453) {
      try {
        const strategies = await discoverMamo(client, account); active();
        emit({ strategyCount: strategies.filter(r => r.status === "fulfilled").length });
        if (strategies.some(r => r.status === "rejected")) issue("Some MAMO strategies could not be inspected");
      } catch (e) { active(); issue(`MAMO: ${message(e)}`); }
    }
    if (chain.id === 100 && snapshot.version !== "EOA") {
      try { emit({ cards: await inspectCard(client, account, chain.id) }); }
      catch { /* A normal Safe is not a card. Account inspection remains valid. */ }
    }
    // Bounded multicalls keep the full local catalogue affordable to scan. One
    // failed chunk remains unknown; it never erases already-discovered holdings.
    for (let offset = 0; offset < tokens.length; offset += 100) {
      active();
      const batch = tokens.slice(offset, offset + 100);
      let values: ({ status: "success"; result: bigint } | { status: "failure" })[];
      if (chain.contracts?.multicall3) {
        values = await client.multicall({ contracts: batch.map(t => ({ address: address(t.address.toLowerCase()), abi: erc20Abi, functionName: "balanceOf" as const, args: [account] as const })), blockNumber, allowFailure: true, batchSize: 16_384 });
      } else {
        // Chains without a configured multicall use small groups of direct reads.
        values = [];
        for (let i = 0; i < batch.length; i += 5) {
          active();
          const result = await Promise.allSettled(batch.slice(i, i + 5).map(t => client.readContract({ address: address(t.address.toLowerCase()), abi: erc20Abi, functionName: "balanceOf", args: [account], blockNumber })));
          values.push(...result.map(r => r.status === "fulfilled" ? { status: "success" as const, result: r.value } : { status: "failure" as const }));
        }
      }
      active();
      const found: TokenHolding[] = [];
      for (let i = 0; i < values.length; i++) {
        const result = values[i];
        if (result.status !== "success" || result.result <= 0n) continue;
        let verifiedDecimals: number | undefined;
        try { verifiedDecimals = await client.readContract({ address: address(batch[i].address.toLowerCase()), abi: erc20Abi, functionName: "decimals", blockNumber }); }
        catch { /* Show raw balance; do not silently trust catalogue precision. */ }
        active(); found.push({ ...batch[i], balance: result.result, verifiedDecimals });
      }
      emit({ checkedTokens: offset + batch.length, failedTokens: state.failedTokens + values.filter(v => v.status !== "success").length, tokens: [...state.tokens, ...found] });
      if (values.length && values.every(v => v.status === "failure")) {
        // Retired catalogue contracts can all revert without the RPC being down.
        // Continue past them, but stop if even a basic network read now fails.
        await client.getBlockNumber();
      }
    }
    active();
    emit({ status: state.issues.length || state.failedTokens || state.checkedTokens < state.totalTokens ? "partial" : "complete", phase: "done" });
  } catch (e) {
    if (signal.aborted) return;
    emit({ status: state.snapshot ? "partial" : "unavailable", phase: "done", issues: [...state.issues, message(e)] });
  }
}
function message(error: unknown) {
  // RPC URLs may contain API keys: do not echo request URLs or bodies in results.
  const name = error instanceof Error ? error.name : "RPC error";
  return error instanceof Error && error.message === "RPC chain mismatch" ? error.message : name;
}
