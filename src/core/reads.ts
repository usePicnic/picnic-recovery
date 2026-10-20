import { BaseError, decodeAbiParameters, encodeFunctionData, HttpRequestError, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { address, publicClient } from "./client";
import { erc20Abi } from "./abi";

// Read-only failover. Every endpoint proves its chain ID before its first
// answer is used. Writes never use this pool: they keep the single RPC chosen
// in the app and verify its chain before sending.
export type ReadFailure = "abort" | "state" | "rate" | "revert" | "size" | "transport" | "unknown";
export function classify(error: unknown): ReadFailure {
  if (error instanceof DOMException && error.name === "AbortError") return "abort";
  const parts: unknown[] = [];
  if (error instanceof BaseError) error.walk(e => { parts.push(e); return false; });
  else parts.push(error);
  const text = parts.map(e => e instanceof BaseError ? `${e.name} ${e.shortMessage} ${e.details}` : e instanceof Error ? `${e.name} ${e.message}` : "").join(" ");
  const codes = parts.map(e => (e as { code?: unknown }).code);
  const status = parts.map(e => e instanceof HttpRequestError ? e.status : undefined).find(Boolean);
  if (/missing trie node|header not found|state (is )?not available|historical state|state histor|pruned|unknown block|block not found/i.test(text)) return "state";
  if (status === 429 || codes.includes(-32005) || /rate limit|too many requests/i.test(text)) return "rate";
  if (status === 413 || /too large|payload|response size|exceeds the .* limit/i.test(text)) return "size";
  if (codes.includes(3) || /ContractFunctionRevertedError|ContractFunctionZeroDataError|AbiDecodingZeroDataError|execution reverted|out of gas/i.test(text)) return "revert";
  if (status || /HttpRequestError|TimeoutError|fetch failed|network|Failed to fetch|LimitExceededRpcError|InternalRpcError|ResourceUnavailable/i.test(text)) return "transport";
  return "unknown";
}
function retryAfter(error: unknown) {
  let header: string | undefined;
  if (error instanceof BaseError) error.walk(e => { if (e instanceof HttpRequestError) header = e.headers?.get("retry-after") ?? undefined; return false; });
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
    signal.addEventListener("abort", stop, { once: true });
  });
}
// Hostnames only: paths and query strings of RPC URLs may carry API keys.
export function rpcHost(url: string) { try { return new URL(url).host; } catch { return "custom RPC"; } }

export const READ_TIMEOUTS = [20_000, 40_000, 60_000] as const;
type Endpoint = { host: string; clients: PublicClient[]; verified?: Promise<void>; dead?: boolean };
export class ReadPool {
  private endpoints: Endpoint[];
  private current = 0;
  private retrying = new Map<symbol, number>();
  readonly used = new Set<string>();
  constructor(private chain: Chain, endpoints: readonly { url: string; client?: PublicClient }[], private signal: AbortSignal,
    private waitLimit = 8_000, private onRetry?: (timeouts: number[]) => void) {
    if (!endpoints.length) throw new Error("No RPC configured");
    this.endpoints = endpoints.map(e => ({ host: rpcHost(e.url), clients: READ_TIMEOUTS.map(timeout => e.client ?? publicClient(chain, e.url, timeout)) }));
  }
  throwIfAborted() { if (this.signal.aborted) throw new DOMException("Cancelled", "AbortError"); }
  // Retry only this failed read unit, never the completed diagnosis. There are
  // at most three attempts, with 1x/2x/3x transport timeouts. Snapshot units
  // intentionally repeat together so their account/block data stays coherent.
  // Writes never use this pool. Contract errors are not transient retries.
  async run<T>(read: (client: PublicClient) => Promise<T>): Promise<T> {
    let last: unknown;
    const id = Symbol();
    try {
      for (let attempt = 0; attempt < READ_TIMEOUTS.length; attempt++) {
        this.throwIfAborted();
        const live = this.endpoints.filter(e => !e.dead);
        if (!live.length) break;
        const endpoint = live[this.current % live.length];
        const client = endpoint.clients[attempt];
        if (attempt > 0) {
          this.retrying.set(id, READ_TIMEOUTS[attempt]);
          this.onRetry?.([...this.retrying.values()]);
        }
        try {
          endpoint.verified ??= client.getChainId().then(chainId => { if (chainId !== this.chain.id) throw new Error("RPC chain mismatch"); });
          try { await endpoint.verified; } catch (e) {
            if (e instanceof Error && e.message === "RPC chain mismatch") endpoint.dead = true;
            else endpoint.verified = undefined;
            throw e;
          }
          this.throwIfAborted();
          const value = await read(client);
          this.throwIfAborted();
          this.used.add(endpoint.host);
          return value;
        } catch (e) {
          this.throwIfAborted();
          last = e;
          if (endpoint.dead) continue;
          const kind = classify(e);
          if (kind !== "rate" && kind !== "transport") throw e;
          this.current++;
          if (attempt === READ_TIMEOUTS.length - 1) break;
          const wait = retryAfter(e);
          // Do not hammer a sole endpoint requesting a minutes-long cooldown.
          if (wait !== undefined && wait > this.waitLimit && live.length === 1) throw e;
          if (live.length === 1 || (attempt + 1) % live.length === 0)
            await sleep(Math.min(wait ?? 500 * 2 ** attempt, this.waitLimit), this.signal);
        }
      }
      throw last ?? new Error("RPC unavailable");
    } finally {
      if (this.retrying.delete(id)) this.onRetry?.([...this.retrying.values()]);
    }
  }
}

const aggregate3Abi = [{
  type: "function", name: "aggregate3", stateMutability: "view",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
}] as const;
export type WordRead = { ok: true; value: bigint } | { ok: false };
// Direct aggregate3 call: viem's multicall({ allowFailure }) folds an HTTP 429
// or timeout of the whole request into per-token failures, which looked like
// thousands of reverting tokens. Here transport errors throw for the whole
// chunk and only per-call results are attributed to individual contracts.
export async function aggregateWords(client: PublicClient, multicall: Address, calls: readonly { target: string; data: Hex }[], blockNumber?: bigint): Promise<WordRead[]> {
  const results = await client.readContract({
    address: multicall, abi: aggregate3Abi, functionName: "aggregate3", blockNumber,
    args: [calls.map(c => ({ target: address(c.target.toLowerCase()), allowFailure: true, callData: c.data }))],
  });
  if (results.length !== calls.length) throw new Error("Malformed multicall response");
  return results.map(r => {
    if (!r.success || r.returnData.length < 66) return { ok: false };
    try { return { ok: true, value: decodeAbiParameters([{ type: "uint256" }], r.returnData)[0] }; } catch { return { ok: false }; }
  });
}
export const balanceOfData = (owner: Address) => encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] });
export const decimalsData = encodeFunctionData({ abi: erc20Abi, functionName: "decimals" });
