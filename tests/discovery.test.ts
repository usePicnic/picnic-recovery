import { beforeEach, describe, expect, it, vi } from "vitest";
import { pad, zeroAddress, type Address, type PublicClient } from "viem";
import { gnosis } from "viem/chains";
import { discoverCards, discoverPicnicAccount, predictCardAccount, predictPicnicAccount } from "../src/core/discovery";
import { inspectAccount } from "../src/core/inspect";
import { inspectCard } from "../src/core/card";
import { ReadPool } from "../src/core/reads";
import type { AccountSnapshot } from "../src/core/types";
vi.mock("../src/core/inspect", async importOriginal => ({ ...await importOriginal<typeof import("../src/core/inspect")>(), inspectAccount: vi.fn() }));
vi.mock("../src/core/card", () => ({ inspectCard: vi.fn() }));
const owner = "0x1111111111111111111111111111111111111111" as Address;
const card = "0x2222222222222222222222222222222222222222" as Address;
const stranger = "0x3333333333333333333333333333333333333333" as Address;
const singleton = "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552" as Address;
const snapshot: AccountSnapshot = { address: predictPicnicAccount(owner), chainId: 100, version: "1.4.1", owners: [owner], threshold: 1n, nonce: 0n, block: 1n, timestamp: 1n, nativeBalance: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], warnings: [] };
function fixture(signal = new AbortController().signal) {
  const client = { getChainId: vi.fn(async () => 100), getCode: vi.fn(async () => "0x1234"), getStorageAt: vi.fn(async () => pad(singleton)),
    getLogs: vi.fn(async (_args: unknown): Promise<{ args: { from: Address; to: Address } }[]> => []) };
  return { client, pool: new ReadPool(gnosis, [{ url: "http://localhost:18547", client: client as unknown as PublicClient }], signal, 0) };
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(inspectAccount).mockResolvedValue(snapshot); vi.mocked(inspectCard).mockResolvedValue([]); });
describe("automatic Picnic account and card discovery", () => {
  it("selects the predicted Picnic Safe only after verifying current ownership", async () => {
    const { pool } = fixture();
    expect(await discoverPicnicAccount(pool, owner)).toBe(predictPicnicAccount(owner));
    vi.mocked(inspectAccount).mockResolvedValue({ ...snapshot, owners: [stranger] });
    expect(await discoverPicnicAccount(pool, owner)).toBeUndefined();
    vi.mocked(inspectAccount).mockResolvedValue({ ...snapshot, warnings: ["Unrecognized Safe singleton: transactions disabled"] });
    await expect(discoverPicnicAccount(pool, owner)).rejects.toThrow();
  });
  it("does not mistake an undeployed prediction for a usable account", async () => {
    const { pool, client } = fixture(); client.getCode.mockResolvedValue("0x");
    expect(await discoverPicnicAccount(pool, owner)).toBeUndefined(); expect(inspectAccount).not.toHaveBeenCalled();
  });
  it("finds a replacement card through incoming transfers and rejects an unrelated counterparty", async () => {
    const { pool, client } = fixture();
    client.getLogs.mockImplementation(async args => (args as { args: { to?: string } }).args.to ? [{ args: { from: card, to: owner } }, { args: { from: stranger, to: owner } }] : []);
    vi.mocked(inspectCard).mockImplementation(async (_client, address) => [{ address: stranger, card: address, delayVersion: "v5", controllers: address === card ? [owner] : [stranger], head: 0n, tail: 0n, cooldown: 180n, expiration: 0n }]);
    const found = await discoverCards(pool, owner);
    expect(found.addresses).toEqual([card]); expect(client.getLogs).toHaveBeenCalledWith(expect.objectContaining({ args: { to: owner } }));
  });
  it("uses the original v4 card only as a history hint and admits the v5 replacement", async () => {
    const { pool, client } = fixture();
    client.getLogs.mockImplementation(async args => (args as { args: { from?: string } }).args.from === predictCardAccount(owner)
      ? [{ args: { from: predictCardAccount(owner), to: card } }] : []);
    vi.mocked(inspectCard).mockImplementation(async (_client, address) => [{ address: stranger, card: address,
      delayVersion: address === card ? "v5" : "v4", controllers: [owner], head: 0n, tail: 0n, cooldown: 180n, expiration: 0n }]);
    expect((await discoverCards(pool, owner)).addresses).toEqual([card]);
  });
  it("retains discovery uncertainty when transfer history is unavailable", async () => {
    const { pool, client } = fixture(); client.getLogs.mockRejectedValue(new Error("History unavailable"));
    const found = await discoverCards(pool, owner);
    expect(found.addresses).toEqual([]); expect(found.issues.join()).toMatch(/history could not be verified/);
  });
  it("keeps an unsupported original card informational instead of a retryable failure", async () => {
    const { pool, client } = fixture(); client.getStorageAt.mockResolvedValue(pad(stranger));
    const found = await discoverCards(pool, owner);
    expect(found.addresses).toEqual([]); expect(found.issues).toEqual([]); expect(found.notes.join()).toContain(predictCardAccount(owner)); expect(inspectCard).not.toHaveBeenCalled();
  });
  it("cancels stale account discovery and refuses the wrong network", async () => {
    const abort = new AbortController(); abort.abort(); const cancelled = fixture(abort.signal);
    await expect(discoverPicnicAccount(cancelled.pool, owner)).rejects.toThrow(); expect(cancelled.client.getCode).not.toHaveBeenCalled();
    const wrong = fixture(); wrong.client.getChainId.mockResolvedValue(1);
    await expect(discoverPicnicAccount(wrong.pool, owner)).rejects.toThrow(/chain mismatch/);
  });
});
