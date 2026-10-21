import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeAbiParameters, zeroAddress, type Address, type PublicClient, type EIP1193Provider } from "viem";
import { polygon } from "viem/chains";
import { destinationError, assertSeparateRecipient } from "../src/core/destination";
import { assertAllowedRecipients, connectedWallet } from "../src/core/actions";
import { readBatchFacts, screenTokenTransfers, planBatch, batchPartAction, type BatchFact } from "../src/core/batch";
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


describe("selected wallet session", () => {
  it("reuses account access and reports the network-switch step without requesting permission again", async () => {
    const calls: string[] = [], stages: string[] = [];
    let chain = 1;
    const provider = { request: async ({ method }: { method: string }) => {
      calls.push(method);
      if (method === "eth_accounts") return [wallet];
      if (method === "eth_chainId") return `0x${chain.toString(16)}`;
      if (method === "wallet_switchEthereumChain") { chain = 137; return null; }
      throw new Error(`Unexpected permission request: ${method}`);
    } } as EIP1193Provider;
    expect((await connectedWallet(provider, 137, stage => stages.push(stage))).sender.toLowerCase()).toBe(wallet.toLowerCase());
    expect(calls).not.toContain("eth_requestAccounts");
    expect(stages).toEqual(["wallet", "network"]);
  });
  it("reports a locked/disconnected selected wallet without choosing another provider", async () => {
    const provider = { request: async () => [] } as unknown as EIP1193Provider;
    await expect(connectedWallet(provider, 137)).rejects.toThrow(/disconnected or locked/);
    expect(displayError({ cause: { code: -32002 } }, "pt")).toContain("Abra a extensão");
  });
});


describe("nontransferable tokens in a network batch", () => {
  it("screens through the Safe with the actual sender and destination, and retains blocked balances as pending", async () => {
    const { safeAbi, erc20Abi } = await import("../src/core/abi");
    const facts: BatchFact[] = [{ id: "blocked", kind: "token", label: "LOCKED", token, balance: 10n }, { id: "native", kind: "native", label: "POL", balance: 5n }];
    const client = { call: async (call: { account: Address; to: Address; data: `0x${string}`; blockNumber: bigint }) => {
      expect(call.account).toBe(wallet); expect(call.to).toBe(safe); expect(call.blockNumber).toBe(snapshot.block);
      const execution = decodeFunctionData({ abi: safeAbi, data: call.data });
      expect(execution.functionName).toBe("execTransaction");
      const args = execution.args as readonly unknown[];
      expect(args[0]).toBe(token);
      expect(decodeFunctionData({ abi: erc20Abi, data: args[2] as `0x${string}` }).args).toEqual([recipient, 10n]);
      throw new Error("Execution reverted with reason: GS013");
    } } as unknown as PublicClient;
    const checked = await screenTokenTransfers(client, snapshot, facts, recipient, wallet);
    const plan = planBatch({ snapshot, destination: recipient, facts: checked, multisend });
    expect(plan.parts).toEqual([["native"]]);
    expect(plan.entries[0]).toMatchObject({ status: "individual", transferBlocked: true, calls: [], receives: [] });
    expect(plan.entries[0].notes.join(" ")).toContain("balance remains");
    expect(facts[0]).not.toHaveProperty("transferBlocked");
  });
  it("does not exclude assets on RPC failures or Safe authorization failures", async () => {
    const facts: BatchFact[] = [{ id: "t", kind: "token", label: "T", token, balance: 10n }];
    for (const error of ["RPC timeout", "execution reverted GS026", "out of gas"]) {
      const client = { call: async () => { throw new Error(error); } } as unknown as PublicClient;
      await expect(screenTokenTransfers(client, snapshot, facts, recipient, wallet)).rejects.toThrow(error);
    }
  });
  it("does not reuse blocked status when a fresh transfer succeeds or simulate an unauthorized multisig executor", async () => {
    let calls = 0;
    const client = { call: async () => { calls++; return { data: "0x" }; } } as unknown as PublicClient;
    const facts: BatchFact[] = [{ id: "t", kind: "token", label: "T", token, balance: 10n, transferBlocked: true }];
    expect((await screenTokenTransfers(client, snapshot, facts, recipient, wallet))[0]).toMatchObject({ transferBlocked: false });
    await screenTokenTransfers(client, { ...snapshot, threshold: 2n }, facts, recipient, wallet);
    await screenTokenTransfers(client, snapshot, facts, recipient, recipient);
    expect(calls).toBe(1);
    expect(displayError(new Error("Execution reverted with reason: GS013"), "pt")).toContain("transferência pode estar bloqueada");
  });
});
