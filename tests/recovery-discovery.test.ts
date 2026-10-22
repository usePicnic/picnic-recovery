import { beforeEach, describe, expect, it, vi } from "vitest";
import { pad, zeroAddress, type Address, type PublicClient, type Hex } from "viem";
import { gnosis } from "viem/chains";
import { discoverRecoveryAccounts, guardianAddedTopic, recoveryFinalizedTopic, recoveredOwnerTopic, verifyRecoveryHandoff } from "../src/core/discovery";
import { inspectAccount } from "../src/core/inspect";
import { ReadPool } from "../src/core/reads";
import type { AccountSnapshot } from "../src/core/types";
import recoveryArtifact from "./fixtures/recovery.json";
vi.mock("../src/core/inspect", async importOriginal => ({ ...await importOriginal<typeof import("../src/core/inspect")>(), inspectAccount: vi.fn() }));
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const safe = "0x2222222222222222222222222222222222222222" as Address;
const stranger = "0x3333333333333333333333333333333333333333" as Address;
const module = recoveryArtifact.address as Address;
const recovery = { module, runtimeHash: zeroAddress as Hex, supported: true, period: 604800n, guardians: [wallet], threshold: 1n, nonce: 0n,
  pending: { newOwners: [], newThreshold: 0n, executeAfter: 0n, guardiansApprovalCount: 0n } };
const snapshot: AccountSnapshot = { address: safe, chainId: 100, version: "1.4.1", owners: [stranger], threshold: 1n, nonce: 0n,
  block: 1n, timestamp: 1n, nativeBalance: 0n, modules: [module], guard: zeroAddress, moduleGuard: zeroAddress,
  recoveries: [recovery], warnings: [], passkey: "detected" };
function fixture(mode: "guardian" | "owner" = "guardian", signal = new AbortController().signal) {
  const event = mode === "guardian" ? guardianAddedTopic : recoveryFinalizedTopic;
  const identity = mode === "guardian" ? pad(wallet, { size: 32 }) : recoveredOwnerTopic(wallet);
  const log = { address: module, topics: [event, pad(safe, { size: 32 }), identity], data: "0x", removed: false };
  const client = { getChainId: vi.fn(async () => 100), getCode: vi.fn(async () => recoveryArtifact.runtime),
    request: vi.fn(async (args: { params: [{ topics: Hex[] }] }) => args.params[0].topics[0] === event ? [log] : []) };
  return { log, client, pool: new ReadPool(gnosis, [{ url: "http://localhost:18547", client: client as unknown as PublicClient }], signal, 0) };
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(inspectAccount).mockResolvedValue(snapshot); });
describe("verified guardian and recovered-owner discovery", () => {
  it("preserves cross-network recovery only after freshly verifying the expected new owner", async () => {
    const { pool } = fixture();
    const hint = { account: safe, chainId: 100, newOwner: wallet };
    expect(await verifyRecoveryHandoff(pool, stranger, hint)).toBeUndefined();
    expect(inspectAccount).not.toHaveBeenCalled();
    expect(await verifyRecoveryHandoff(pool, wallet, hint)).toBeUndefined();
    vi.mocked(inspectAccount).mockResolvedValue({ ...snapshot, owners: [wallet], passkey: "not-detected" });
    expect(await verifyRecoveryHandoff(pool, wallet, hint)).toBe(safe);
  });
  it("finds a guardian Safe from indexed events only after fresh membership verification", async () => {
    const { pool, client } = fixture();
    expect(await discoverRecoveryAccounts(pool, wallet)).toEqual([safe]);
    expect(client.request).toHaveBeenCalledWith({ method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest", topics: [guardianAddedTopic, null, pad(wallet, { size: 32 })] }] });
    vi.mocked(inspectAccount).mockResolvedValue({ ...snapshot, recoveries: [{ ...recovery, guardians: [stranger] }] });
    expect(await discoverRecoveryAccounts(pool, wallet)).toEqual([]);
  });
  it("discovers the recovered Safe for the new owner rather than predicting another Safe", async () => {
    const { pool } = fixture("owner");
    vi.mocked(inspectAccount).mockResolvedValue({ ...snapshot, owners: [wallet], passkey: "not-detected" });
    expect(await discoverRecoveryAccounts(pool, wallet)).toEqual([safe]);
    vi.mocked(inspectAccount).mockResolvedValue(snapshot);
    expect(await discoverRecoveryAccounts(pool, wallet)).toEqual([]);
  });
  it("rejects spoofed emitter runtime and a module no longer enabled on the Safe", async () => {
    const spoof = fixture(); spoof.client.getCode.mockResolvedValue("0x1234");
    expect(await discoverRecoveryAccounts(spoof.pool, wallet)).toEqual([]); expect(inspectAccount).not.toHaveBeenCalled();
    vi.mocked(inspectAccount).mockResolvedValue({ ...snapshot, modules: [], recoveries: [] });
    expect(await discoverRecoveryAccounts(fixture().pool, wallet)).toEqual([]);
  });
  it("does not accept wrong-topic or removed logs returned by an RPC", async () => {
    const removed = fixture(); removed.log.removed = true;
    expect(await discoverRecoveryAccounts(removed.pool, wallet)).toEqual([]);
    const wrong = fixture(); wrong.log.topics[2] = pad(stranger, { size: 32 });
    expect(await discoverRecoveryAccounts(wrong.pool, wallet)).toEqual([]);
  });
  it("fails visibly on a history limit, unavailable history, or stale cancellation", async () => {
    const capped = fixture(); capped.client.request.mockResolvedValue(Array.from({ length: 2000 }, () => capped.log));
    await expect(discoverRecoveryAccounts(capped.pool, wallet)).rejects.toThrow(/history limit/);
    const unavailable = fixture(); unavailable.client.request.mockRejectedValue(new Error("History unavailable"));
    await expect(discoverRecoveryAccounts(unavailable.pool, wallet)).rejects.toThrow(/History unavailable/);
    const abort = new AbortController(); abort.abort(); const cancelled = fixture("guardian", abort.signal);
    await expect(discoverRecoveryAccounts(cancelled.pool, wallet)).rejects.toThrow(); expect(cancelled.client.request).not.toHaveBeenCalled();
  });
  it("deduplicates history and returns every verified candidate rather than silently choosing one", async () => {
    const { pool, client, log } = fixture();
    client.request.mockImplementation(async args => args.params[0].topics[0] === guardianAddedTopic
      ? [log, log, { ...log, topics: [guardianAddedTopic, pad(stranger, { size: 32 }), pad(wallet, { size: 32 })] }] : []);
    expect(await discoverRecoveryAccounts(pool, wallet)).toEqual([safe, stranger]);
    expect(inspectAccount).toHaveBeenCalledTimes(2);
  });
});
