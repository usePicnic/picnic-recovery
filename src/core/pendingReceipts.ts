import type { PublicClient } from "viem";
import { assertChain, same } from "./client";
import { verifyReceipt } from "./receipts";
import type { Progress } from "./types";

export type TransactionRecord = Progress["transactions"][number];
export const pendingForAccount = (transactions: Progress["transactions"], accounts: readonly string[]) =>
  transactions.filter(tx => tx.status === "pending" && accounts.some(account => same(account, tx.account)));

// Reconciliation is read-only. A mined outer transaction alone is insufficient
// for Safe batches: verify the exact Safe hash and every saved expected effect.
export async function checkSubmittedReceipt(client: PublicClient, tx: TransactionRecord): Promise<"confirmed" | "reverted" | "waiting"> {
  await assertChain(client, tx.chainId);
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: tx.hash }); }
  catch (error) {
    if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return "waiting";
    throw error;
  }
  if (!same(receipt.transactionHash, tx.hash)) throw new Error("Receipt hash does not match the submitted transaction");
  const head = await client.getBlockNumber({ cacheTime: 0 });
  if (head < receipt.blockNumber + 1n) return "waiting"; // Same two confirmations as sendAction.
  if (receipt.status === "reverted") return "reverted";
  if (tx.migration && !tx.expectation) throw new Error("Missing migration receipt verification data. Inspect the transaction before retrying.");
  verifyReceipt(receipt, tx.expectation ?? {});
  return "confirmed";
}
