import { describe, expect, it, vi } from "vitest";
import {
  concatHex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodePacked, HttpRequestError, numberToHex, pad, zeroAddress,
  type Address, type Hex, type PublicClient,
} from "viem";
import { polygon } from "viem/chains";
import { packMultiSend, unpackMultiSend, multiSendCall, assertBatchPayload, multiSendAbi, approvedMultiSend } from "../src/core/multisend";
import { safeBatchAction, receiptExpectation, assertActionShape } from "../src/core/actions";
import { planBatch, batchPartAction, includedEntries, type BatchFact } from "../src/core/batch";
import { verifyReceipt } from "../src/core/receipts";
import { parseProgress } from "../src/core/progress";
import { delayAbi, erc20Abi, safeAbi } from "../src/core/abi";
import { queueHash } from "../src/core/card";
import { BASKET, BASKET_BRL, basketAbi } from "../src/core/legacy";
import { basketReadPlan, readBasketContents } from "../src/core/basket-contents";
import { destinationError, knownGuardians, newOwnerError } from "../src/core/destination";
import { ReadPool, type ReadCheckpoint } from "../src/core/reads";
import type { LegacyCatalogue } from "../src/core/legacy-routes";
import type { AccountSnapshot, Call } from "../src/core/types";

const safe = "0x1111111111111111111111111111111111111111" as Address;
const dest = "0x2222222222222222222222222222222222222222" as Address;
const usdc = "0x3333333333333333333333333333333333333333" as Address;
const usdt = "0x4444444444444444444444444444444444444444" as Address;
const guardian = "0x5555555555555555555555555555555555555555" as Address;
const basketWallet = "0x6666666666666666666666666666666666666666" as Address;
const delay = "0x7777777777777777777777777777777777777777" as Address;
const card = "0x8888888888888888888888888888888888888888" as Address;
const MS141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address;
const snap = (patch: Partial<AccountSnapshot> = {}): AccountSnapshot => ({ address: safe, chainId: 137, block: 10n, timestamp: 100n, version: "1.4.1", owners: [dest === safe ? safe : "0x9999999999999999999999999999999999999999"],
  threshold: 1n, nonce: 7n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 0n, warnings: [], ...patch });
const transfer = (token: Address, amount: bigint): Call => ({ to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [dest, amount] }) });
const transferLog = (token: Address, from: Address, to: Address, value: bigint) => ({ address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [value]) });
const success = (hash: Hex) => ({ address: safe, topics: encodeEventTopics({ abi: safeAbi, eventName: "ExecutionSuccess", args: { txHash: hash } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [0n]) });

describe("MultiSendCallOnly packing", () => {
  it("packs uint8 operation, address, uint256 value, uint256 length and bytes per CALL child, and round-trips", () => {
    const calls: Call[] = [transfer(usdc, 5n), { to: dest, value: 3n, data: "0x" }];
    const packed = packMultiSend(calls);
    const manual = concatHex([
      "0x00", usdc.toLowerCase() as Hex, pad(numberToHex(0n), { size: 32 }), pad(numberToHex(68n), { size: 32 }), calls[0].data,
      "0x00", dest.toLowerCase() as Hex, pad(numberToHex(3n), { size: 32 }), pad(numberToHex(0n), { size: 32 }),
    ]);
    expect(packed.toLowerCase()).toBe(manual.toLowerCase());
    expect(unpackMultiSend(packed).map(c => ({ ...c, to: c.to.toLowerCase() }))).toEqual(calls.map(c => ({ ...c, to: c.to.toLowerCase(), operation: 0 })));
    expect(() => packMultiSend([])).toThrow();
    expect(() => unpackMultiSend(`${packed}00` as Hex)).toThrow(/Malformed/);
  });
  it("only targets a pinned MultiSendCallOnly per chain, with exactly the reviewed CALL children", () => {
    const calls = [transfer(usdc, 5n), transfer(usdt, 6n)];
    expect(approvedMultiSend(137, MS141)?.version).toBe("1.4.1");
    expect(approvedMultiSend(31337, MS141)).toBeUndefined();
    expect(() => multiSendCall(137, usdc, calls)).toThrow(/approved/);
    const call = multiSendCall(137, MS141, calls);
    expect(() => assertBatchPayload(137, safe, call, calls)).not.toThrow();
    // Not the reviewed calls, a value at Safe level, a nested DELEGATECALL, or a call to the Safe itself.
    expect(() => assertBatchPayload(137, safe, call, [calls[0], transfer(usdt, 7n)])).toThrow(/match/);
    expect(() => assertBatchPayload(137, safe, { ...call, value: 1n }, calls)).toThrow(/value/);
    const nested = encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [1, usdc, 0n, 68n, calls[0].data]);
    expect(() => assertBatchPayload(137, safe, { to: MS141, value: 0n, data: encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [nested] }) }, [calls[0]])).toThrow(/CALL only/);
    const self = [{ to: safe, value: 0n, data: "0x" as Hex }, calls[0]];
    expect(() => assertBatchPayload(137, safe, { to: MS141, value: 0n, data: encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packMultiSend(self)] }) }, self)).toThrow(/Safe/);
  });
  it("builds operation 1 only for a multi-call Safe batch, keeps single calls as operation 0, and refuses EOAs", () => {
    const calls = [transfer(usdc, 5n), transfer(usdt, 6n)];
    const action = safeBatchAction(snap(), MS141, calls, ["a", "b"], "Batch");
    expect(action.operation).toBe(1);
    expect(action.call.to).toBe(MS141);
    expect(action.safeNonce).toBe(7n);
    const single = safeBatchAction(snap(), MS141, [calls[0]], ["a"], "One");
    expect(single.operation).toBe(0);
    expect(single.call).toEqual(calls[0]);
    expect(() => safeBatchAction(snap({ version: "EOA" }), MS141, calls, ["a", "b"], "Batch")).toThrow(/EOA/);
    expect(() => assertActionShape({ ...action, batch: undefined })).toThrow(/DELEGATECALL/);
    expect(() => assertActionShape({ ...action, kind: "direct" })).toThrow(/DELEGATECALL/);
    expect(() => assertActionShape({ ...action, call: { ...action.call, to: usdc } })).toThrow(/approved/);
  });
});

describe("batch planning", () => {
  const facts: BatchFact[] = [
    { id: "137:native", kind: "native", label: "POL", balance: 5n },
    { id: "137:token:usdc", kind: "token", label: "USDC", token: usdc, balance: 100n },
    { id: "137:token:usdt", kind: "token", label: "USDT", token: usdt, balance: 0n },
    { id: "137:baskets:9", kind: "basket", label: "Basket #9", nftId: 9n, owned: true, wallet: basketWallet, native: 2n, contents: "complete",
      tokens: [{ key: `erc20:${usdc.toLowerCase()}`, token: BASKET_BRL, category: "token", name: "Brilliant", symbol: "BRL", balance: 25n, fresh: 25n, decimals: 6, assetIds: [], types: ["token"] }],
      stakes: [{ key: "stake:x:1", category: "position", name: "Farm", balance: 4n, assetIds: [], types: ["IAutofarmDeposit"] }] },
    { id: "137:baskets", kind: "unidentified", label: "Unidentified baskets" },
  ];
  it("states one outcome for every selected fact and never adds unselected assets", () => {
    const plan = planBatch({ snapshot: snap(), destination: dest, facts, multisend: MS141 });
    expect(plan.entries.map(e => [e.id, e.status])).toEqual([
      ["137:native", "included"], ["137:token:usdc", "included"], ["137:token:usdt", "empty"], ["137:baskets:9", "included"], ["137:baskets", "individual"],
    ]);
    expect(plan.parts).toEqual([["137:native", "137:token:usdc", "137:baskets:9"]]);
    const basket = plan.entries.find(e => e.id === "137:baskets:9")!;
    const withdraw = decodeFunctionData({ abi: basketAbi, data: basket.calls[0].data });
    expect(withdraw.functionName).toBe("withdrawPortfolio");
    expect(withdraw.args).toEqual([9n, { tokens: [BASKET_BRL], amounts: [100_000n] }, 0n, [], []]);
    // The Safe forwards exactly the basket amounts in the same transaction.
    expect(basket.receives).toEqual([{ token: BASKET_BRL, recipient: dest, minimum: 25n }]);
    expect(decodeFunctionData({ abi: basketAbi, data: basket.calls[2].data })).toMatchObject({ functionName: "safeTransferFrom", args: [safe, dest, 9n] });
    expect(basket.nfts).toEqual([{ collection: BASKET, from: safe, recipient: dest, tokenId: 9n }]);
    expect(basket.later).toEqual([]);
    const action = batchPartAction({ snapshot: snap(), plan, part: 0, label: "Batch" });
    expect(action.batch?.calls).toHaveLength(5);
    const expectation = receiptExpectation(action, `0x${"ab".repeat(32)}`);
    expect(expectation.operation).toBe(1);
    expect(expectation.receives).toEqual([{ token: usdc, recipient: dest, minimum: "100" }, { token: BASKET_BRL, recipient: dest, minimum: "25" }]);
    expect(expectation.native).toEqual([{ recipient: dest, minimum: "5" }]);
    expect(expectation.nfts).toEqual([{ collection: BASKET, from: safe, recipient: dest, tokenId: "9" }]);
  });
  it("uses explicit individual fallbacks for EOAs and unverified multisend, and refuses guardian or source destinations", () => {
    const eoa = planBatch({ snapshot: snap({ version: "EOA" }), destination: dest, facts, multisend: MS141 });
    expect(eoa.unavailable).toBe("eoa"); expect(eoa.parts).toEqual([]);
    expect(eoa.entries.filter(e => e.status === "included")).toHaveLength(0);
    expect(planBatch({ snapshot: snap(), destination: dest, facts }).unavailable).toBe("multisend");
    expect(() => planBatch({ snapshot: snap(), destination: guardian, facts, multisend: MS141, guardians: [guardian] })).toThrow(/guardian/);
    expect(() => planBatch({ snapshot: snap({ recoveries: [{ module: delay, runtimeHash: "0x", supported: true, guardians: [guardian], threshold: 1n, nonce: 0n, pending: { guardiansApprovalCount: 0n, newThreshold: 0n, executeAfter: 0n, newOwners: [] } }] }), destination: guardian, facts, multisend: MS141 })).toThrow(/guardian/);
    expect(() => planBatch({ snapshot: snap(), destination: safe, facts, multisend: MS141 })).toThrow(/source/);
  });
  it("queues card withdrawals without claiming receipt, binding the exact queue hash", () => {
    const fact: BatchFact = { id: "100:card", kind: "card", label: "Card EURe", asset: usdc, balance: 40n, card,
      delay: { address: delay, card, controllers: [safe], delayVersion: "v5", head: 0n, tail: 0n, cooldown: 180n, expiration: 0n } };
    const [e] = planBatch({ snapshot: snap({ chainId: 100 }), destination: dest, facts: [fact], multisend: MS141 }).entries;
    expect(e.outcome).toBe("queued");
    expect(e.receives).toEqual([]);
    const inner = transfer(usdc, 40n);
    expect(e.queued).toEqual([{ module: delay, txHash: queueHash(inner) }]);
    expect(decodeFunctionData({ abi: delayAbi, data: e.calls[0].data }).args).toEqual([usdc, 0n, inner.data, 0]);
    expect(e.later[0]).toMatch(/NOT received/);
  });
  it("splits only very large batches into visible gas-bounded parts that together cover every included entry", () => {
    const many: BatchFact[] = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, kind: "token", label: `T${i}`, token: usdc, balance: BigInt(i + 1) }));
    const plan = planBatch({ snapshot: snap(), destination: dest, facts: many, multisend: MS141, budget: 700_000n });
    expect(plan.parts.length).toBe(3);
    expect(plan.parts.flat()).toEqual(many.map(f => f.id));
    expect(includedEntries(plan, 1).map(e => e.id)).toEqual(plan.parts[1]);
  });
  it("revalidates fresh balances before sending and rejects a decrease", async () => {
    const plan = planBatch({ snapshot: snap(), destination: dest, facts: facts.slice(0, 2), multisend: MS141 });
    const ok = batchPartAction({ snapshot: snap(), plan, part: 0, label: "B", reread: async () => [{ ...facts[0], balance: 6n } as BatchFact, facts[1]] });
    await expect(ok.revalidate!()).resolves.toBeUndefined();
    const lower = batchPartAction({ snapshot: snap(), plan, part: 0, label: "B", reread: async () => [facts[0], { ...facts[1], balance: 99n } as BatchFact] });
    await expect(lower.revalidate!()).rejects.toThrow(/changed/);
  });
});

describe("receipt verification for every expected effect", () => {
  const hash = `0x${"cd".repeat(32)}` as Hex;
  const expectation = { safe, safeHash: hash, operation: 1 as const, multisend: MS141, calls: 3,
    receives: [{ token: usdc, recipient: dest, minimum: "100" }, { token: usdc, recipient: dest, minimum: "25" }, { token: usdt, recipient: dest, minimum: "7" }],
    native: [{ recipient: dest, minimum: "5" }], queued: [{ module: delay, txHash: hash }] };
  const queuedLog = { address: delay, topics: encodeEventTopics({ abi: delayAbi, eventName: "TransactionAdded", args: { queueNonce: 0n, txHash: hash } }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint8" }], [usdc, 0n, "0x", 0]) };
  const logs = [success(hash), transferLog(usdc, safe, dest, 100n), transferLog(usdc, basketWallet, safe, 25n), transferLog(usdc, safe, dest, 25n), transferLog(usdt, safe, dest, 7n), queuedLog];
  it("accepts only when Safe execution, every token total and every queue entry are proven", () => {
    expect(() => verifyReceipt({ status: "success", logs: logs as never }, expectation)).not.toThrow();
    // The second token, not just the first, must be proven.
    expect(() => verifyReceipt({ status: "success", logs: logs.filter((_, i) => i !== 4) as never }, expectation)).toThrow(/1 token/);
    // Two children paying the same token need both amounts.
    expect(() => verifyReceipt({ status: "success", logs: logs.filter((_, i) => i !== 3) as never }, expectation)).toThrow(/token/);
    expect(() => verifyReceipt({ status: "success", logs: logs.filter((_, i) => i !== 5) as never }, expectation)).toThrow(/queued/);
    expect(() => verifyReceipt({ status: "success", logs: [success(`0x${"00".repeat(32)}`), ...logs.slice(1)] as never }, expectation)).toThrow(/Safe execution/);
    expect(() => verifyReceipt({ status: "reverted", logs: logs as never }, expectation)).toThrow(/reverted/);
    expect(() => verifyReceipt({ status: "success", logs: logs as never }, { ...expectation, safeHash: undefined })).toThrow(/Safe hash/);
  });
  it("persists every expectation across export/import and rejects malformed batch records", () => {
    const progress = { version: 1, accounts: [], transactions: [{ chainId: 137, hash, account: safe, label: "Batch migration · Polygon", status: "pending", expectation }] };
    const parsed = parseProgress(JSON.stringify(progress));
    expect(parsed.transactions[0].expectation).toEqual(expectation);
    expect(parseProgress(JSON.stringify(parsed)).transactions[0].expectation).toEqual(expectation);
    const broken = (e: object) => JSON.stringify({ ...progress, transactions: [{ ...progress.transactions[0], expectation: { ...expectation, ...e } }] });
    expect(() => parseProgress(broken({ operation: 2 }))).toThrow();
    expect(() => parseProgress(broken({ calls: 0 }))).toThrow();
    expect(() => parseProgress(broken({ receives: [{ token: "x", recipient: dest, minimum: "1" }] }))).toThrow();
    expect(() => parseProgress(broken({ queued: [{ module: delay, txHash: "0x1" }] }))).toThrow();
    expect(() => parseProgress(broken({ native: [{ recipient: dest, minimum: "-1" }] }))).toThrow();
  });
});

describe("guardian destinations", () => {
  const recovery = { module: delay, runtimeHash: "0x" as Hex, supported: true, guardians: [guardian], threshold: 1n, nonce: 0n, pending: { guardiansApprovalCount: 0n, newThreshold: 0n, executeAfter: 0n, newOwners: [] } };
  it("collects guardians of this source on any network, connected or not, and ignores other accounts", () => {
    const other = snap({ address: dest, recoveries: [{ ...recovery, guardians: [usdt] }] });
    const found = knownGuardians([snap({ chainId: 100, recoveries: [recovery] }), snap(), undefined, other], safe);
    expect(found).toEqual([guardian]);
    expect(destinationError(guardian.toLowerCase(), safe, undefined, found)).toBe("guardian");
    expect(destinationError(dest, safe, undefined, found)).toBeUndefined();
    expect(destinationError(usdt, safe, undefined, found)).toBeUndefined();
  });
  it("flags a guardian or the Safe as the proposed new owner immediately", () => {
    const s = snap({ recoveries: [recovery] });
    expect(newOwnerError(guardian, s)).toBe("guardian");
    expect(newOwnerError(safe, s)).toBe("source");
    expect(newOwnerError("0x12", s)).toBe("invalid");
    expect(newOwnerError("", s)).toBeUndefined();
    expect(newOwnerError(dest, s)).toBeUndefined();
  });
});

describe("legacy basket contents", () => {
  const catalogue: LegacyCatalogue = { chainId: 137, contracts: [], assets: [
    { _id: "a", address: usdc, type: "token", name: "USD Coin", symbol: "USDC" },
    { _id: "b", address: usdc.toLowerCase(), type: "IBeefyDeposit", name: "USDC vault alias" },
    { _id: "c", address: usdt, type: "IBalancerLiquidity", name: "BPT", symbol: "BPT" },
    { _id: "d", address: "0x89d065572136814230A55DdEeDDEC9DF34EB0B76", type: "IAutofarmDeposit", name: "Farm", callParams: { poolId: 3 } },
    { _id: "e", address: zeroAddress, type: "networkToken", name: "POL" },
  ] };
  const multicall = polygon.contracts.multicall3.address;
  it("deduplicates ERC-20 contracts, separates protocol stakes and reads native POL from the basket wallet address", () => {
    const plan = basketReadPlan(catalogue, basketWallet, multicall);
    expect(plan.map(r => [r.key, r.category])).toEqual([["native", "native"], [`erc20:${usdc.toLowerCase()}`, "token"], [`erc20:${usdt.toLowerCase()}`, "receipt"], ["stake:0x89d065572136814230a55ddeeddec9df34eb0b76:3", "position"]]);
    expect(plan[1].assetIds).toEqual(["a", "b"]);
    expect(plan.every(r => r.data.toLowerCase().includes(basketWallet.slice(2).toLowerCase()))).toBe(true);
  });
  it("reads walletOf contents in bounded chunks, reports unknown chunks as partial and retries only them", async () => {
    let failing = true;
    const batches: number[] = [];
    const word = (n: bigint) => ({ success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [n]) });
    const client = { getChainId: vi.fn(async () => 137), getBlockNumber: vi.fn(async () => 50n),
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
        if (functionName === "ownerOf") return safe;
        if (functionName === "walletOf") return basketWallet;
        const calls = args![0] as { target: Address; callData: Hex }[];
        batches.push(calls.length);
        if (failing && calls.some(c => c.target.toLowerCase() === usdt.toLowerCase())) throw new HttpRequestError({ url: "x", status: 503 });
        return calls.map(c => c.callData.startsWith("0x313ce567") ? word(6n) : c.target.toLowerCase() === usdc.toLowerCase() ? word(25n) : word(0n));
      }) } as unknown as PublicClient;
    const checkpoint: ReadCheckpoint = new Map();
    const pool = () => new ReadPool(polygon, [{ url: "http://localhost:1", client }], new AbortController().signal, 0, undefined, checkpoint);
    const first = await readBasketContents({ pool: pool(), nftId: 9n, owner: safe, multicall, catalogue, chunk: 2 });
    expect(first.status).toBe("partial");
    expect(first.failed).toBe(2);
    expect(first.holdings.map(h => [h.symbol, h.balance, h.decimals])).toEqual([["USDC", 25n, 6]]);
    expect(Math.max(...batches)).toBeLessThanOrEqual(2);
    failing = false; batches.length = 0;
    const second = await readBasketContents({ pool: pool(), nftId: 9n, owner: safe, multicall, catalogue, chunk: 2 });
    expect(second.status).toBe("complete");
    // Successful chunk and decimals came from the checkpoint; only the failed chunk was read again.
    expect(batches).toEqual([2]);
    await expect(readBasketContents({ pool: pool(), nftId: 9n, owner: dest, multicall, catalogue })).rejects.toThrow(/no longer owns/);
  });
});
