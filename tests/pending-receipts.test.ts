import { describe, expect, it, vi } from "vitest";
import { encodeEventTopics, encodeAbiParameters, parseAbi, type PublicClient } from "viem";
import { checkSubmittedReceipt, pendingForAccount, type TransactionRecord } from "../src/core/pendingReceipts";
const account = "0x1111111111111111111111111111111111111111";
const hash = `0x${"12".repeat(32)}` as const;
const safeHash = `0x${"34".repeat(32)}` as const;
const tx: TransactionRecord = { account, chainId: 137, hash, label: "Batch migration", status: "pending", expectation: { safe: account, safeHash } };
const receipt = { transactionHash: hash, blockNumber: 100n, status: "success", logs: [{ address: account,
  topics: encodeEventTopics({ abi: parseAbi(["event ExecutionSuccess(bytes32 txHash, uint256 payment)"]), eventName: "ExecutionSuccess" }),
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [safeHash, 0n]),
}] };
const client = (overrides = {}) => ({ getChainId: vi.fn(async () => 137), getTransactionReceipt: vi.fn(async () => receipt), getBlockNumber: vi.fn(async () => 101n), ...overrides } as unknown as PublicClient);
describe("pending receipt reconciliation", () => {
  it("confirms only the exact submitted hash and verified Safe execution after two blocks", async () => {
    await expect(checkSubmittedReceipt(client(), tx)).resolves.toBe("confirmed");
    await expect(checkSubmittedReceipt(client({ getBlockNumber: async () => 100n }), tx)).resolves.toBe("waiting");
    await expect(checkSubmittedReceipt(client({ getChainId: async () => 1 }), tx)).rejects.toThrow("chain");
    await expect(checkSubmittedReceipt(client({ getTransactionReceipt: async () => ({ ...receipt, transactionHash: safeHash }) }), tx)).rejects.toThrow("hash");
  });
  it("never treats a successful outer transaction or missing token effects as a completed migration", async () => {
    await expect(checkSubmittedReceipt(client({ getTransactionReceipt: async () => ({ ...receipt, logs: [] }) }), tx)).rejects.toThrow("Safe execution");
    await expect(checkSubmittedReceipt(client(), { ...tx, expectation: { ...tx.expectation, receives: [{ token: account, recipient: account, minimum: "1" }] } })).rejects.toThrow("expected receipt");
    await expect(checkSubmittedReceipt(client(), { ...tx, expectation: undefined, migration: { destination: account, assets: [] } })).rejects.toThrow("Missing migration");
  });
  it("reconciles reverted receipts and keeps missing receipts or RPC failures unresolved", async () => {
    await expect(checkSubmittedReceipt(client({ getTransactionReceipt: async () => ({ ...receipt, status: "reverted" }) }), tx)).resolves.toBe("reverted");
    await expect(checkSubmittedReceipt(client({ getTransactionReceipt: async () => { throw Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" }); } }), tx)).resolves.toBe("waiting");
    await expect(checkSubmittedReceipt(client({ getTransactionReceipt: async () => { throw new Error("RPC offline"); } }), tx)).rejects.toThrow("RPC offline");
  });
  it("does not block a different connected account or clear other pending receipts", () => {
    const other = { ...tx, hash: safeHash, account: "0x2222222222222222222222222222222222222222" as const };
    expect(pendingForAccount([tx, other], [account])).toEqual([tx]);
    expect(pendingForAccount([{ ...tx, status: "confirmed" }, other], [account])).toEqual([]);
    expect(pendingForAccount([{ ...tx, status: "confirmed" }, other], [other.account])).toEqual([other]);
  });
});
