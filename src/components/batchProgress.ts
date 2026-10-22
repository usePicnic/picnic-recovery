import type { Address, Hex } from "viem";
import { GAS, PART_GAS_BUDGET, type BatchPlan } from "../core/batch";
import { MAX_BATCH_CALLS } from "../core/multisend";
import { BASKET, BASKET_BRL } from "../core/legacy";
import { same } from "../core/client";
import type { MigrationReceipt, Progress } from "../core/types";
import { basketsId, nativeId, tokenId, type MigrationItem } from "./migration";

export type ConfirmedBatch = { hash: Hex; assets: MigrationReceipt["assets"] };

// Inventory progress is independent of transaction confirmation. Failed reads
// never fill the bar; a successful chunk contributes within its own basket.
export function basketReadProgress(items: readonly MigrationItem[]) {
  let total = 0, complete = 0, loading = 0, queued = 0, failed = 0, value = 0, checked = 0, checks = 0;
  for (const item of items) {
    if (item.basketId === undefined) continue;
    total++;
    const c = item.contents;
    if (!c || c.status === "queued") { queued++; continue; }
    if (c.status === "complete") { complete++; value++; continue; }
    if (c.status === "error" || c.status === "partial") failed++;
    else loading++;
    if (c.total > 0) value += Math.max(0, Math.min(1, (c.checked - c.failed) / c.total));
    if (c.status === "loading") { checked += c.checked; checks += c.total; }
  }
  return { total, complete, loading, queued, failed, value, checked, checks };
}
export function confirmedBatches(transactions: Progress["transactions"], chainId: number, account: Address, destination: string): ConfirmedBatch[] {
  const found = new Map<string, ConfirmedBatch>();
  for (const tx of transactions) {
    if (tx.status !== "confirmed" || tx.chainId !== chainId || !same(tx.account, account)) continue;
    if (tx.migration) {
      if (same(tx.migration.destination, destination)) found.set(tx.hash, { hash: tx.hash, assets: tx.migration.assets });
      continue;
    }
    // Compatibility with receipts saved before transaction progress was added.
    const e = tx.expectation;
    if (!tx.label.startsWith("Batch migration") || e?.operation !== 1) continue;
    const effects = [...e.receives ?? [], ...e.native ?? [], ...e.nfts ?? []];
    if (!effects.length || effects.some(effect => !same(effect.recipient, destination))) continue;
    const assets: MigrationReceipt["assets"] = (e.nfts ?? []).filter(nft => same(nft.collection, BASKET)).map(nft => ({ id: basketsId(chainId, BigInt(nft.tokenId)), label: `Basket #${nft.tokenId}`, outcome: "basket" }));
    for (const token of e.receives ?? []) {
      // BRL forwarded out of a basket belongs to that basket's migration.
      if (assets.some(asset => asset.outcome === "basket") && same(token.token, BASKET_BRL)) continue;
      assets.push({ id: tokenId(chainId, token.token), label: token.token, outcome: "received" });
    }
    if (e.native?.length) assets.push({ id: nativeId(chainId), label: "Native coin", outcome: "received" });
    found.set(tx.hash, { hash: tx.hash, assets: [...new Map(assets.map(a => [a.id, a])).values()] });
  }
  return [...found.values()];
}

// An initial display estimate only. The actual plan always comes from fresh
// reads and simulations before opening the wallet; this never builds calldata.
export function estimateParts(items: MigrationItem[]): string[][] {
  const parts: string[][] = [];
  let ids: string[] = [], gas = 0n, calls = 0;
  for (const item of items) {
    if (!item.selectable || item.pending || item.kind === "baskets" && item.basketId === undefined) continue;
    let cost = GAS.transfer, count = 1;
    if (item.kind === "baskets") {
      const brl = !item.contents || item.contents.status !== "complete" || item.contents.holdings.some(h => same(h.token ?? "", BASKET_BRL) && h.balance > 0n);
      cost = GAS.basket + (brl ? GAS.basketToken + GAS.transfer : 0n); count = brl ? 3 : 1;
    } else if (item.kind === "mamo") { cost = GAS.mamo + GAS.transfer; count = 2; }
    else if (item.kind === "card") cost = GAS.enqueue;
    else if (item.kind === "position") { cost = GAS.staking + GAS.transfer; count = 2; }
    if (ids.length && (gas + cost > PART_GAS_BUDGET || calls + count > MAX_BATCH_CALLS)) { parts.push(ids); ids = []; gas = 0n; calls = 0; }
    ids.push(item.id); gas += cost; calls += count;
  }
  if (ids.length) parts.push(ids);
  return parts;
}

export function migrationProgress({ history, items, plan, remainingParts }: {
  history: ConfirmedBatch[]; items: MigrationItem[]; plan?: BatchPlan; remainingParts?: string[][];
}) {
  const confirmed = new Set(history.flatMap(tx => tx.assets.filter(a => a.outcome !== "queued").map(a => a.id)));
  const processed = new Set(history.flatMap(tx => tx.assets.map(a => a.id)));
  const estimated = remainingParts === undefined;
  const parts = remainingParts ?? estimateParts(items.filter(item => !processed.has(item.id)));
  const remaining = new Set(parts.flat());
  const blocked = plan?.entries.filter(e => e.transferBlocked) ?? [];
  const followups = plan?.entries.filter(e => !e.transferBlocked && (e.status === "individual" || e.status === "later" || e.later.length > 0)) ?? [];
  const selectedIds = new Set([...processed, ...items.map(i => i.id)]);
  return { confirmed, processed, remaining, blocked, followups, parts, estimated, totalAssets: selectedIds.size, totalTransactions: history.length + parts.length };
}
