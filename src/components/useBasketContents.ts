import { useCallback, useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { chainById } from "../catalog/chains";
import { same } from "../core/client";
import type { NetworkDiagnosis } from "../core/diagnosis";
import { readBasketContents, type BasketContents } from "../core/basket-contents";
import { legacyCatalogue, type LegacyCatalogue } from "../core/legacy-routes";
import { ReadPool, type ReadCheckpoint } from "../core/reads";
import { readRpcs, type RpcOverrides } from "./useDiagnosis";

// Reads every identified basket's contents in the background through a
// bounded queue (two baskets at a time, chunked Multicall3 reads each). Opened
// or reviewed baskets can jump the queue. Successful chunks are checkpointed
// for retries; an account or RPC change cancels everything.
export const BASKET_CONCURRENCY = 2;
export type BasketContentsState = {
  contents: Record<string, BasketContents>;
  retry: (ids?: readonly bigint[]) => void; prioritize: (ids: readonly bigint[]) => void; refresh: (ids: readonly bigint[]) => void;
};
export function useBasketContents(account: Address | undefined, results: readonly NetworkDiagnosis[], overrides: RpcOverrides): BasketContentsState {
  const polygon = results.find(r => r.chainId === 137 && !!account && same(r.account, account));
  // Cache identity follows the account, not a transient diagnosis snapshot.
  // A rescan briefly omits that snapshot; navigation must never discard reads.
  const owner = account?.toLowerCase() as Address | undefined;
  const verified = !!polygon?.snapshot && !!owner && same(polygon.snapshot.address, owner);
  const ids = (verified ? polygon?.basketIds ?? [] : []).map(String);
  const [contents, setContents] = useState<Record<string, BasketContents>>({});
  const contentsRef = useRef(contents); contentsRef.current = contents;
  // Only the Polygon RPC matters here: other networks' RPC changes keep the reads.
  const polygonRpc = overrides[137] ?? "";
  const context = useRef<{ owner?: Address; overrides: RpcOverrides; controller: AbortController; checkpoint: ReadCheckpoint; queue: string[]; running: Set<string> }>();
  const catalogue = useRef<Promise<LegacyCatalogue>>();
  const pump = useCallback(() => {
    const ctx = context.current;
    if (!ctx?.owner) return;
    while (ctx.running.size < BASKET_CONCURRENCY && ctx.queue.length) {
      const id = ctx.queue.shift()!;
      if (ctx.running.has(id)) continue;
      ctx.running.add(id);
      const nftId = BigInt(id), owner = ctx.owner;
      const current = () => context.current === ctx && !ctx.controller.signal.aborted;
      const set = (state: BasketContents) => { if (current()) {
        contentsRef.current = { ...contentsRef.current, [id]: state };
        setContents(contentsRef.current);
      } };
      set({ ...contentsRef.current[id] ?? { nftId, owner, checked: 0, total: 0, failed: 0, holdings: [] }, status: "loading", error: undefined, holdings: [], checked: 0, failed: 0 });
      void (async () => {
        try {
          catalogue.current ??= legacyCatalogue();
          const pool = new ReadPool(chainById(137), readRpcs(137, ctx.overrides).map(url => ({ url })), ctx.controller.signal, undefined, undefined, ctx.checkpoint, owner.toLowerCase());
          await readBasketContents({ pool, nftId, owner, multicall: chainById(137).contracts!.multicall3!.address, catalogue: await catalogue.current, onProgress: set });
        } catch (error) {
          if (current()) set({ nftId, owner, status: "error", checked: 0, total: 0, failed: 0, holdings: [], error: error instanceof Error ? error.message : String(error) });
        } finally {
          ctx.running.delete(id);
          if (current()) pump();
        }
      })();
    }
  }, []);
  // New context: cancel and forget everything from the previous account/RPC.
  useEffect(() => {
    context.current?.controller.abort();
    context.current = { owner, overrides, controller: new AbortController(), checkpoint: new Map(), queue: [], running: new Set() };
    contentsRef.current = {}; setContents({});
    return () => context.current?.controller.abort();
  }, [owner, polygonRpc]);
  // Every identified basket is eventually read; new IDs join the queue.
  const key = ids.join(",");
  useEffect(() => {
    const ctx = context.current;
    if (!ctx?.owner) return;
    const fresh = ids.filter(id => !contentsRef.current[id] && !ctx.queue.includes(id) && !ctx.running.has(id));
    if (!fresh.length) return;
    ctx.queue.push(...fresh);
    setContents(old => ({ ...old, ...Object.fromEntries(fresh.map(id => [id, { nftId: BigInt(id), owner: ctx.owner!, status: "queued" as const, checked: 0, total: 0, failed: 0, holdings: [] }])) }));
    pump();
  }, [key, owner, polygonRpc, pump]);
  const enqueue = useCallback((list: readonly bigint[], front: boolean) => {
    const ctx = context.current;
    if (!ctx?.owner) return;
    const wanted = list.map(String).filter(id => !ctx.running.has(id));
    ctx.queue = front ? [...wanted, ...ctx.queue.filter(id => !wanted.includes(id))] : [...ctx.queue.filter(id => !wanted.includes(id)), ...wanted];
    pump();
  }, [pump]);
  const retry = useCallback((list?: readonly bigint[]) => {
    const targets = list ?? Object.values(contentsRef.current).filter(c => c.status === "error" || c.status === "partial").map(c => c.nftId);
    enqueue(targets, true);
  }, [enqueue]);
  const prioritize = useCallback((list: readonly bigint[]) => {
    const ctx = context.current;
    enqueue(list.filter(id => ctx?.queue.includes(String(id))), true);
  }, [enqueue]);
  // After a transaction, re-read from the chain instead of the checkpoint.
  const refresh = useCallback((list: readonly bigint[]) => {
    const ctx = context.current;
    if (!ctx) return;
    for (const nft of list) {
      const wallet = contentsRef.current[String(nft)]?.wallet?.toLowerCase();
      for (const k of [...ctx.checkpoint.keys()]) if (k.endsWith(`basket-wallet:${ctx.owner?.toLowerCase()}:${nft}`) || (wallet && k.includes(`basket-contents:${wallet}`))) ctx.checkpoint.delete(k);
    }
    enqueue(list, true);
  }, [enqueue]);
  return { contents, retry, prioritize, refresh };
}
