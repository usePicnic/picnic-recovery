import { decodeEventLog, type Address, type Hex, type TransactionReceipt } from "viem";
import { delayAbi, erc20Abi, legacySafeEvents, safeAbi } from "./abi";
import { same } from "./client";

export type TokenExpectation = { token: Address; recipient: Address; minimum: string };
// Persisted with each submitted transaction (exported/imported with progress)
// so a receipt found after a timeout or reload is verified against the same
// effects as one awaited immediately.
export type ReceiptExpectation = {
  safe?: Address; safeHash?: Hex;
  // 1 only for an approved MultiSendCallOnly batch; `calls` children.
  operation?: 0 | 1; multisend?: Address; calls?: number;
  receive?: TokenExpectation;
  receives?: TokenExpectation[];
  // Native coin sent by a Safe batch child. No log exists for it: it is
  // proven by ExecutionSuccess of the exact Safe hash (which binds the value),
  // because MultiSendCallOnly reverts entirely if any child fails.
  native?: { recipient: Address; minimum: string }[];
  queued?: { module: Address; txHash: Hex }[];
};
type Log = { address: Address; data: Hex; topics: readonly Hex[] };

export function safeReceiptSucceeded(logs: readonly Log[], safe: Address, expectedHash?: Hex) {
  let success = false;
  for (const log of logs) {
    if (!same(log.address, safe)) continue;
    try {
      const event = decodeEventLog({ abi: log.topics.length === 1 ? legacySafeEvents : safeAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if ((event.eventName === "ExecutionSuccess" || event.eventName === "ExecutionFailure") && expectedHash && event.args.txHash !== expectedHash) continue;
      if (event.eventName === "ExecutionFailure") throw new Error("Safe execution failed");
      if (event.eventName === "ExecutionSuccess") success = true;
    } catch (error) {
      if (error instanceof Error && error.message === "Safe execution failed") throw error;
    }
  }
  if (!success) throw new Error("Receipt does not confirm Safe execution");
}
// Net ERC-20 amount that reached `recipient` in this receipt.
function netReceived(logs: readonly Log[], token: Address, recipient: Address) {
  let received = 0n;
  for (const log of logs) {
    if (!same(log.address, token)) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (same(event.args.to, recipient)) received += event.args.value;
      if (same(event.args.from, recipient)) received -= event.args.value;
    } catch { /* unrelated event */ }
  }
  return received;
}
export function verifyTokenReceipt(receipt: Pick<TransactionReceipt, "logs">, effect: TokenExpectation) {
  if (netReceived(receipt.logs, effect.token, effect.recipient) < BigInt(effect.minimum)) throw new Error("Receipt does not prove the expected token receipt; inspect before retrying");
}
// Every expected effect, not just the first: Safe execution of the exact hash,
// each token/recipient total, and each queued card request.
export function verifyReceipt(receipt: Pick<TransactionReceipt, "logs" | "status">, expectation: ReceiptExpectation = {}) {
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  if (expectation.operation === 1 && (!expectation.safe || !expectation.safeHash)) throw new Error("Batch receipt expectation is missing its Safe hash");
  if (expectation.safe) safeReceiptSucceeded(receipt.logs, expectation.safe, expectation.safeHash);
  if (expectation.native?.length && !expectation.safeHash) throw new Error("Native batch transfers can only be proven by a Safe execution hash");
  const totals = new Map<string, TokenExpectation & { sum: bigint }>();
  for (const effect of [...expectation.receive ? [expectation.receive] : [], ...expectation.receives ?? []]) {
    const key = `${effect.token.toLowerCase()}:${effect.recipient.toLowerCase()}`;
    const entry = totals.get(key) ?? { ...effect, sum: 0n };
    // Two children paying the same token to the same recipient need both amounts.
    entry.sum += BigInt(effect.minimum);
    totals.set(key, entry);
  }
  const missing = [...totals.values()].filter(effect => netReceived(receipt.logs, effect.token, effect.recipient) < effect.sum);
  if (missing.length) throw new Error(`Receipt does not prove the expected receipt of ${missing.length} token(s): ${missing.map(m => m.token).join(", ")}. Inspect before retrying`);
  for (const entry of expectation.queued ?? []) {
    const found = receipt.logs.some(log => {
      if (!same(log.address, entry.module)) return false;
      try {
        const event = decodeEventLog({ abi: delayAbi, eventName: "TransactionAdded", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        return event.args.txHash === entry.txHash;
      } catch { return false; }
    });
    if (!found) throw new Error("Receipt does not prove every queued card request. Inspect the card queue before retrying");
  }
}
