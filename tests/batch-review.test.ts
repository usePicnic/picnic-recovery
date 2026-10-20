import { describe, expect, it } from "vitest";
import { encodeAbiParameters, zeroAddress, type Address, type PublicClient } from "viem";
import { polygon } from "viem/chains";
import { destinationError, assertSeparateRecipient } from "../src/core/destination";
import { assertAllowedRecipients } from "../src/core/actions";
import { readBatchFacts, planBatch, batchPartAction, type BatchFact } from "../src/core/batch";
import type { BasketContents } from "../src/core/basket-contents";
import type { AccountSnapshot, PreparedAction } from "../src/core/types";

const safe = "0x1111111111111111111111111111111111111111" as Address;
const recipient = "0x2222222222222222222222222222222222222222" as Address;
const token = "0x3333333333333333333333333333333333333333" as Address;
const wallet = "0x4444444444444444444444444444444444444444" as Address;
const multisend = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address;
const snapshot: AccountSnapshot = { address: safe, chainId: 137, block: 10n, timestamp: 100n, version: "1.4.1", owners: [wallet], threshold: 1n, nonce: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 0n, warnings: [] };
const contents: BasketContents = { nftId: 1n, owner: safe, wallet, status: "complete", checked: 2, total: 2, failed: 0, holdings: [{ key: "erc20", token, category: "token", name: "Test", balance: 20n, decimals: 6, assetIds: [], types: ["token"] }] };
const card: Extract<BatchFact, {kind: "card"}> = { id: "card", kind: "card", label: "Card", asset: token, balance: 20n, card: wallet, delay: { address: token, card: wallet, controllers: [safe], delayVersion: "v5", head: 0n, tail: 0n, cooldown: 10n, expiration: 0n } };

describe("reviewed batch edge cases", () => {
  it("names the guardian even when connected and normalizes pasted destinations", () => {
    expect(destinationError(` ${recipient} `, safe, recipient, [recipient])).toBe("guardian");
    expect(() => assertSeparateRecipient(` ${recipient} `, wallet, [recipient])).toThrow(/guardian/);
  });
  it("protects queued destinations even though no funds arrive in this transaction", () => {
    const action: PreparedAction = { kind: "safe", account: safe, chainId: 137, call: { to: token, value: 0n, data: "0x" }, label: "Queue", destinations: [recipient] };
    expect(() => assertAllowedRecipients(action, [recipient])).toThrow(/guardian/);
  });
  it("does not turn failed fresh basket balances into a migrated empty basket", async () => {
    let calls = 0;
    const ok = (n: bigint) => ({ success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [n]) });
    const client = { readContract: async () => ++calls === 1 ? [ok(BigInt(safe)), ok(BigInt(wallet))] : [ok(0n), { success: false, returnData: "0x" }] } as unknown as PublicClient;
    const facts = await readBatchFacts(client, snapshot, [{ id: "basket", kind: "basket", label: "Basket", nftId: 1n, contents }], polygon.contracts.multicall3.address);
    const plan = planBatch({ snapshot, destination: recipient, facts, multisend });
    expect(plan.entries[0].status).toBe("individual");
    expect(plan.entries[0].notes.join(" ")).toMatch(/unknown, not zero/);
    expect(plan.parts).toEqual([]);
  });
  it("never queues a card balance twice and detects newly queued requests before sending", async () => {
    const pending = { ...card, delay: { ...card.delay!, tail: 1n } };
    const plan = planBatch({ snapshot, destination: recipient, facts: [pending], multisend });
    expect(plan.entries[0].status).toBe("later");
    expect(plan.parts).toEqual([]);
    const ready = planBatch({ snapshot, destination: recipient, facts: [card], multisend });
    const action = batchPartAction({ snapshot, plan: ready, part: 0, label: "Queue", reread: async () => [pending] });
    expect(action.destinations).toEqual([recipient]);
    await expect(action.revalidate!()).rejects.toThrow(/changed/);
  });
});

import { displayError } from "../src/core/errors";
it("shows wallet rejection without dumping calldata", () => {
  expect(displayError({ shortMessage: "Rejected", cause: { code: 4001 } }, "pt")).toContain("Você recusou");
  expect(displayError({ shortMessage: "Insufficient funds", message: "full calldata" }, "en")).toBe("Insufficient funds");
});
