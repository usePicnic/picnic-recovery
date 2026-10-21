import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { zeroAddress, type Address, type Hex } from "viem";
import { confirmedBatches, estimateParts, migrationProgress } from "../src/components/batchProgress";
import { BatchTransactionProgress } from "../src/components/BatchTransactionProgress";
import { planBatch, type BatchFact } from "../src/core/batch";
import { BASKET, BASKET_BRL } from "../src/core/legacy";
import { parseProgress } from "../src/core/progress";
import type { AccountSnapshot, Progress } from "../src/core/types";
import type { MigrationItem } from "../src/components/migration";

const safe = "0x1111111111111111111111111111111111111111" as Address;
const dest = "0x2222222222222222222222222222222222222222" as Address;
const hash = `0x${"ab".repeat(32)}` as Hex;
const snapshot: AccountSnapshot = { address: safe, chainId: 137, block: 10n, timestamp: 100n, version: "1.4.1", owners: [dest], threshold: 1n, nonce: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 0n, warnings: [] };
const items: MigrationItem[] = Array.from({ length: 149 }, (_, i) => ({ id: `137:baskets:${i}`, basketId: BigInt(i), kind: "baskets", symbol: `#${i}`, name: "Basket", chainId: 137, tab: "legacy", order: i, selectable: true }));
const facts: BatchFact[] = items.map(item => ({ id: item.id, kind: "basket", label: item.symbol, nftId: item.basketId!, owned: true, wallet: dest, native: 0n, stakes: [], tokens: [{ key: "brl", token: BASKET_BRL, name: "BRL", category: "token", balance: 1n, fresh: 1n, types: [], assetIds: [] }] }));
const plan = planBatch({ snapshot, destination: dest, multisend: dest, facts: [...facts, { id: "locked", kind: "token", label: "MNEP", token: safe, balance: 300000n, transferBlocked: true }] });
const receipt: Progress["transactions"][number] = { chainId: 137, account: safe, hash, label: "Batch migration · Polygon · part 1/8", status: "confirmed",
  migration: { destination: dest, assets: items.slice(0, 21).map(item => ({ id: item.id, label: item.symbol, outcome: "basket" })) } };

describe("multi-transaction migration progress", () => {
  it("shows 21 completed, 128 remaining and transaction 2 of 8 without counting blocked assets as migrated", () => {
    const history = confirmedBatches([receipt], 137, safe, dest);
    const progress = migrationProgress({ history, items, plan, remainingParts: plan.parts.slice(1) });
    expect(plan.parts).toHaveLength(8);
    expect(progress.confirmed.size).toBe(21);
    expect(progress.remaining.size).toBe(128);
    expect(progress.totalAssets).toBe(149);
    expect(progress.totalTransactions).toBe(8);
    expect(progress.blocked.map(e => e.label)).toEqual(["MNEP"]);
    const html = renderToStaticMarkup(createElement(BatchTransactionProgress, { history, progress, chainId: 137, lang: "en", active: false, awaitingReceipt: false, uncertain: false }));
    expect(html).toContain("21 of 149 assets migrated");
    expect(html).toContain("Transaction 2 of 8");
    expect(html).toContain(`/tx/${hash}`);
    expect(html).not.toContain("All transactions in this sequence are confirmed");
  });
  it("uses estimates until a live plan exists, and refreshes the total when a plan changes", () => {
    expect(estimateParts(items)).toHaveLength(8);
    const history = confirmedBatches([receipt], 137, safe, dest);
    const estimate = migrationProgress({ history, items: items.slice(21) });
    expect(estimate.estimated).toBe(true);
    expect(estimate.totalTransactions).toBe(8);
    expect(estimate.totalAssets).toBe(149);
    const updated = migrationProgress({ history, items, plan, remainingParts: [items.slice(21).map(i => i.id)] });
    expect(updated.estimated).toBe(false);
    expect(updated.totalTransactions).toBe(2);
  });
  it("persists confirmed history through reloads and ignores pending/reverted transactions and other destinations", () => {
    const stored = parseProgress(JSON.stringify({ version: 1, accounts: [], transactions: [receipt] }));
    expect(confirmedBatches(stored.transactions, 137, safe, dest)).toHaveLength(1);
    expect(confirmedBatches([receipt, receipt], 137, safe, dest)).toHaveLength(1);
    expect(confirmedBatches([{ ...receipt, status: "pending" }, { ...receipt, status: "reverted" }], 137, safe, dest)).toHaveLength(0);
    expect(confirmedBatches([receipt], 100, safe, dest)).toHaveLength(0);
    expect(confirmedBatches([receipt], 137, dest, dest)).toHaveLength(0);
    expect(confirmedBatches([receipt], 137, safe, safe)).toHaveLength(0);
  });
  it("restores earlier basket receipts without counting forwarded BRL as an additional migrated asset", () => {
    const legacy = { ...receipt, migration: undefined, expectation: { operation: 1 as const, nfts: items.slice(0, 21).map(item => ({ collection: BASKET, from: safe, recipient: dest, tokenId: item.basketId!.toString() })), receives: [{ token: BASKET_BRL, recipient: dest, minimum: "21" }] } };
    expect(confirmedBatches([legacy], 137, safe, dest)[0].assets).toHaveLength(21);
  });
  it("does not claim queued card assets have migrated", () => {
    const queued = { ...receipt, migration: { destination: dest, assets: [{ id: "card", label: "Card", outcome: "queued" as const }] } };
    const progress = migrationProgress({ history: confirmedBatches([queued], 137, safe, dest), items: [], remainingParts: [] });
    expect(progress.confirmed.size).toBe(0);
    expect(progress.processed.size).toBe(1);
  });
  it("rejects malformed persisted history instead of using it as confirmation", () => {
    expect(() => parseProgress(JSON.stringify({ version: 1, accounts: [], transactions: [{ ...receipt, migration: { destination: dest, assets: [{ id: "bad", label: "bad", outcome: "confirmed" }] } }] }))).toThrow("Invalid migration asset history");
  });
});
