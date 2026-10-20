import { isAddress, isHash } from "viem";
import type { ReceiptExpectation } from "./receipts";
import type { Progress } from "./types";
import { chains } from "../catalog/chains";

const KEY = "picnic-recovery-v1";
export const emptyProgress = (): Progress => ({ version: 1, accounts: [], transactions: [] });
export function parseProgress(text: string): Progress {
  if (text.length > 1_000_000) throw new Error("Progress file is too large");
  const data = JSON.parse(text);
  if (data.version !== 1 || !Array.isArray(data.accounts) || !Array.isArray(data.transactions)) throw new Error("Invalid progress file");
  if (data.accounts.length > 100 || data.transactions.length > 1000) throw new Error("Progress limit exceeded");
  // Copy only public, typed fields. Never ingest arbitrary kit/secret fields.
  const accounts = data.accounts.map((row: Record<string, unknown>) => {
    if (!isAddress(String(row.address)) || !chains.some(c => c.id === row.chainId)) throw new Error("Invalid account");
    return { address: String(row.address) as `0x${string}`, chainId: Number(row.chainId), label: String(row.label ?? "").slice(0, 80) };
  });
  const transactions = data.transactions.map((row: Record<string, unknown>) => {
    if (!isHash(String(row.hash)) || !isAddress(String(row.account)) || !chains.some(c => c.id === row.chainId)) throw new Error("Invalid transaction");
    let expectation: ReceiptExpectation | undefined;
    if (row.expectation && typeof row.expectation === "object") {
      const e = row.expectation as Record<string, unknown>;
      expectation = {};
      if (e.safe) {
        if (!isAddress(String(e.safe)) || !isHash(String(e.safeHash))) throw new Error("Invalid Safe receipt expectation");
        expectation.safe = String(e.safe) as `0x${string}`; expectation.safeHash = String(e.safeHash) as `0x${string}`;
      }
      if (e.receive && typeof e.receive === "object") {
        const effect = e.receive as Record<string, unknown>;
        if (!isAddress(String(effect.token)) || !isAddress(String(effect.recipient)) || !/^\d{1,78}$/.test(String(effect.minimum))) throw new Error("Invalid token receipt expectation");
        expectation.receive = { token: String(effect.token) as `0x${string}`, recipient: String(effect.recipient) as `0x${string}`, minimum: String(effect.minimum) };
      }
    }
    const status = row.status === "confirmed" || row.status === "reverted" ? row.status : "pending";
    return { hash: String(row.hash) as `0x${string}`, account: String(row.account) as `0x${string}`,
      chainId: Number(row.chainId), label: String(row.label ?? "").slice(0, 160), status, expectation };
  });
  return { version: 1, accounts, transactions };
}
export function readProgress(): Progress {
  try { return parseProgress(localStorage.getItem(KEY) ?? ""); } catch { return emptyProgress(); }
}
export function saveProgress(progress: Progress) {
  localStorage.setItem(KEY, JSON.stringify(progress));
}
export function downloadProgress(progress: Progress) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(progress, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = "picnic-recovery-progress.json"; anchor.click();
  URL.revokeObjectURL(url);
}
