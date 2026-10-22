import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeEventTopics, zeroAddress, type Address, type Hex } from "viem";
import { BASKET, BASKET_BRL, basketAbi } from "../src/core/legacy";
import { planBatch, batchPartAction, type BatchFact } from "../src/core/batch";
import { assertAllowedRecipients } from "../src/core/actions";
import { verifyReceipt } from "../src/core/receipts";
import { parseProgress } from "../src/core/progress";
import type { AccountSnapshot } from "../src/core/types";
const safe = "0x1111111111111111111111111111111111111111" as Address;
const dest = "0x2222222222222222222222222222222222222222" as Address;
const wallet = "0x3333333333333333333333333333333333333333" as Address;
const ms = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address;
const snapshot: AccountSnapshot = { address: safe, chainId: 137, block: 1n, timestamp: 1n, version: "1.4.1", owners: [wallet], threshold: 1n, nonce: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 0n, warnings: [] };
const basket: Extract<BatchFact, { kind: "basket" }> = { id: "basket", kind: "basket", label: "Basket #1", nftId: 1n, owned: true, wallet, tokens: [], native: 3n, stakes: [] };
const plan = (fact = basket) => planBatch({ snapshot, destination: dest, facts: [fact], multisend: ms });
const nft = { collection: BASKET, from: safe, recipient: dest, tokenId: "1" };
const log = (from = safe, to = dest, tokenId = 1n, collection: Address = BASKET) => ({ address: collection, data: "0x" as Hex, topics: encodeEventTopics({ abi: basketAbi, eventName: "Transfer", args: { from, to, tokenId } }) });

describe("BRL withdrawal followed by basket ownership transfer", () => {
  it("transfers an empty/no-BRL basket including unknown contents and native coin without unwrapping them", () => {
    const e = plan().entries[0];
    expect(e.calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: basketAbi, data: e.calls[0].data })).toMatchObject({ functionName: "safeTransferFrom", args: [safe, dest, 1n] });
    expect(e.receives).toEqual([]);
    expect(e.later).toEqual([]);
    expect(e.outcome).toBe("basket");
  });
  it("rechecks ownership and BRL reads even when the reviewed BRL balance was zero", async () => {
    for (const fresh of [{ ...basket, owned: false }, { ...basket, readFailed: true }]) {
      const action = batchPartAction({ snapshot, plan: plan(), part: 0, label: "NFT", reread: async () => [fresh] });
      await expect(action.revalidate!()).rejects.toThrow(/changed/);
    }
    const action = batchPartAction({ snapshot, plan: plan(), part: 0, label: "NFT", reread: async () => [] });
    await expect(action.revalidate!()).rejects.toThrow(/revalidated/);
  });
  it("rejects decreased BRL and guardian NFT destinations", async () => {
    const fact = { ...basket, tokens: [{ key: "brl", token: BASKET_BRL, category: "token" as const, name: "BRL", balance: 10n, fresh: 10n, types: [], assetIds: [] }] };
    const action = batchPartAction({ snapshot, plan: plan(fact), part: 0, label: "BRL + NFT", reread: async () => [basket] });
    await expect(action.revalidate!()).rejects.toThrow(/balance changed/);
    expect(() => assertAllowedRecipients({ ...action, destinations: [], receives: [] }, [dest])).toThrow(/guardian/);
  });
  it("requires exact NFT collection, id, source and recipient and rejects a later transfer out", () => {
    const check = (logs: ReturnType<typeof log>[]) => verifyReceipt({ status: "success", logs: logs as never }, { nfts: [nft] });
    expect(() => check([log()])).not.toThrow();
    for (const logs of [[], [log(wallet)], [log(safe, wallet)], [log(safe, dest, 2n)], [log(safe, dest, 1n, wallet)], [log(), log(dest, wallet)]]) {
      expect(() => check(logs)).toThrow(/NFT transfer/);
    }
  });
  it("keeps NFT receipt proof across reloads and rejects malformed expectations", () => {
    const progress = (nftValue: object) => JSON.stringify({ version: 1, accounts: [], transactions: [{ chainId: 137, account: safe, hash: `0x${"ab".repeat(32)}`, expectation: { nfts: [nftValue] } }] });
    expect(parseProgress(progress(nft)).transactions[0].expectation?.nfts).toEqual([nft]);
    for (const patch of [{ tokenId: "-1" }, { tokenId: (2n ** 256n).toString() }, { recipient: "invalid" }, { collection: "invalid" }]) {
      expect(() => parseProgress(progress({ ...nft, ...patch }))).toThrow(/NFT/);
    }
  });
});
