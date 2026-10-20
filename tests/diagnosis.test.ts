import { describe, expect, it, vi } from "vitest";
import { defineChain, zeroAddress, type Address, type PublicClient } from "viem";
import { diagnoseNetwork, emptyDiagnosis, hasAssets, nextAction, type NetworkDiagnosis, type TokenEntry } from "../src/core/diagnosis";
import type { AccountSnapshot } from "../src/core/types";
import catalogue from "../src/catalog/tokens.json";

const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const chain = defineChain({ id: 1337, name: "Test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://localhost:8545"] } } });
const token = { chainId: chain.id, address: other, name: "Token" };
const snapshot: AccountSnapshot = { address: account, chainId: chain.id, block: 10n, timestamp: 100n, version: "EOA", owners: [account], threshold: 1n, nonce: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 0n, warnings: [] };
function result(patch: Partial<NetworkDiagnosis> = {}): NetworkDiagnosis {
  return { ...emptyDiagnosis(chain.id, account), status: "complete", snapshot, ...patch };
}
function mockClient() {
  return {
    getChainId: vi.fn(async (): Promise<number> => chain.id), getBlock: vi.fn(async () => ({ number: 10n, timestamp: 100n })),
    getCode: vi.fn(async () => "0x"), getTransactionCount: vi.fn(async () => 0), getBalance: vi.fn(async () => 0n),
    getBlockNumber: vi.fn(async () => 10n),
    readContract: vi.fn(async ({ functionName }: { functionName: string; address?: string }): Promise<number | bigint> => functionName === "decimals" ? 6 : 5_000_000n),
  };
}
async function scan(client = mockClient(), tokens: TokenEntry[] = [token], controller = new AbortController()) {
  const updates: NetworkDiagnosis[] = [];
  await diagnoseNetwork({ chain, account, rpc: chain.rpcUrls.default.http[0], signal: controller.signal, client: client as unknown as PublicClient, catalogue: tokens, update: r => updates.push(r) });
  return updates;
}
describe("automatic network diagnosis", () => {
  it("discovers tokens even with zero native balance, at the inspected block", async () => {
    const client = mockClient(), updates = await scan(client);
    expect(updates.some(r => r.phase === "assets" && r.tokens.length === 0)).toBe(true);
    const last = updates.at(-1)!;
    expect(last.status).toBe("complete");
    expect(last.nativeBalance).toBe(0n);
    expect(last.tokens[0]).toMatchObject({ balance: 5_000_000n, verifiedDecimals: 6 });
    expect(hasAssets(last)).toBe(true);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 10n }));
    expect(nextAction(last, account, { address: account, balance: 0n })).toBe("fund");
  });
  it("does not turn a failed network or a mismatched RPC into zero balance", async () => {
    const down = mockClient(); down.getChainId.mockRejectedValue(new Error("https://private.example/key"));
    const failed = (await scan(down)).at(-1)!;
    expect(failed.status).toBe("unavailable");
    expect(failed.nativeBalance).toBeUndefined();
    expect(failed.issues.join()).not.toContain("private.example");
    const wrong = mockClient(); wrong.getChainId.mockResolvedValue(1);
    expect((await scan(wrong)).at(-1)!.issues).toContain("RPC chain mismatch");
    expect(wrong.getBalance).not.toHaveBeenCalled();
  });
  it("retains holdings and marks failed tokens unverified", async () => {
    const client = mockClient();
    client.readContract.mockImplementation(async ({ address, functionName }) => {
      if (address === account) throw new Error("missing contract");
      return functionName === "decimals" ? 6 : 1n;
    });
    const last = (await scan(client, [token, { ...token, address: account }])).at(-1)!;
    expect(last.status).toBe("partial");
    expect(last.failedTokens).toBe(1);
    expect(last.tokens).toHaveLength(1);
    expect(nextAction(result({ status: "partial" }))).not.toBe("no-findings");
  });
  it("continues after a fully reverted batch when the RPC still works", async () => {
    const client = mockClient();
    const tokens = Array.from({ length: 101 }, (_, i) => ({ ...token, address: `0x${(i + 10).toString(16).padStart(40, "0")}` }));
    client.readContract.mockImplementation(async ({ address, functionName }) => {
      if (address?.toLowerCase() !== tokens[100].address) throw new Error("retired");
      return functionName === "decimals" ? 6 : 2n;
    });
    const last = (await scan(client, tokens)).at(-1)!;
    expect(last.tokens).toHaveLength(1);
    expect(last.checkedTokens).toBe(101);
    expect(last.failedTokens).toBe(100);
  });
  it("suppresses stale updates and further batches after cancellation", async () => {
    const client = mockClient(), controller = new AbortController();
    client.readContract.mockImplementation(async () => { controller.abort(); return 1n; });
    const tokens = Array.from({ length: 12 }, (_, i) => ({ ...token, address: `0x${(i + 10).toString(16).padStart(40, "0")}` }));
    const updates = await scan(client, tokens, controller);
    expect(client.readContract).toHaveBeenCalledTimes(5);
    expect(updates.at(-1)!.checkedTokens).toBe(0);
    expect(updates.some(r => r.phase === "done")).toBe(false);
  });
  it("distinguishes connected owners, recovery and gas from another wallet", () => {
    const funded = result({ nativeBalance: 10n });
    expect(nextAction(funded)).toBe("connect");
    expect(nextAction(funded, other)).toBe("owner-required");
    expect(nextAction(funded, account, { address: other, balance: 0n })).toBe("prepare");
    const recovery = { module: other, runtimeHash: "0x" as const, supported: true, guardians: [other], threshold: 1n, nonce: 0n, pending: { guardiansApprovalCount: 0n, newThreshold: 1n, executeAfter: 0n, newOwners: [other] } };
    const recoverable = result({ snapshot: { ...snapshot, version: "1.4.1", recoveries: [recovery] } });
    expect(nextAction(recoverable, other)).toBe("recover");
    recovery.pending.executeAfter = 101n;
    expect(nextAction(recoverable, other)).toBe("waiting");
    recovery.pending.executeAfter = 100n;
    expect(nextAction(recoverable, other)).toBe("finalize");
  });
  it("keeps the public catalogue deduplicated and restricted to public token metadata", () => {
    expect(new Set(catalogue.map(t => `${t.chainId}:${t.address.toLowerCase()}`)).size).toBe(catalogue.length);
    for (const item of catalogue) expect(Object.keys(item).every(k => ["chainId", "address", "name", "symbol", "decimals"].includes(k))).toBe(true);
  });
});
