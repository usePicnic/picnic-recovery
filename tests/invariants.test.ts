import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { transferCall, safeReceiptSucceeded } from "../src/core/actions";
import { erc20Abi, safeAbi } from "../src/core/abi";
import { queueStatus, queueHash, proxyImplementation } from "../src/core/card";
import { validateRpc, address, parseAmount } from "../src/core/client";
import { parseProgress } from "../src/core/progress";
import { products } from "../src/catalog/products";

const a = "0x1111111111111111111111111111111111111111" as Address;
const b = "0x2222222222222222222222222222222222222222" as Address;
describe("Money-path invariants", () => {
  it("uses exact raw token amounts, including above JS safe integer", () => {
    expect(() => parseAmount("0.0000019", 6)).toThrow(/decimal/);
    expect(() => parseAmount("1e2", 18)).toThrow();
    expect(parseAmount("12.345678", 6)).toBe(12345678n);
    const amount = 12345678901234567890123456789n;
    const call = transferCall(a, b, amount);
    expect(decodeFunctionData({ abi: erc20Abi, data: call.data }).args).toEqual([b, amount]);
    expect(call.value).toBe(0n);
    expect(() => transferCall(a, b, 0n)).toThrow();
    expect(() => transferCall(null, zeroAddress, 1n)).toThrow();
  });
  it("keeps the exact cooldown and expiration boundaries", () => {
    expect(queueStatus(100n, 10n, 20n, 109n)).toBe("waiting");
    expect(queueStatus(100n, 10n, 20n, 110n)).toBe("ready");
    expect(queueStatus(100n, 10n, 20n, 130n)).toBe("ready");
    expect(queueStatus(100n, 10n, 20n, 131n)).toBe("expired");
    expect(queueStatus(100n, 10n, 0n, 100000000n)).toBe("ready");
  });
  it("binds queued transaction to all calldata fields", () => {
    const call = transferCall(a, b, 5n);
    expect(queueHash(call)).not.toBe(queueHash({ ...call, value: 1n }));
    expect(queueHash(call)).not.toBe(queueHash(call, 1));
  });
  it("does not mistake an outer successful transaction for Safe execution", () => {
    const data = encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [`0x${"0".repeat(64)}`, 0n]);
    expect(() => safeReceiptSucceeded([], a)).toThrow();
    expect(() => safeReceiptSucceeded([{ address: b, data, topics: encodeEventTopics({ abi: safeAbi, eventName: "ExecutionSuccess" }) as Hex[] }], a)).toThrow();
    expect(() => safeReceiptSucceeded([{ address: a, data, topics: encodeEventTopics({ abi: safeAbi, eventName: "ExecutionFailure" }) as Hex[] }], a)).toThrow(/failed/);
    expect(() => safeReceiptSucceeded([{ address: a, data, topics: encodeEventTopics({ abi: safeAbi, eventName: "ExecutionSuccess" }) as Hex[] }], a)).not.toThrow();
  });
  it("validates transport and discards arbitrary imported fields", () => {
    expect(() => validateRpc("http://remote.example")).toThrow();
    expect(() => validateRpc("https://user:password@example.com")).toThrow();
    expect(validateRpc("http://127.0.0.1:8545")).toContain("127.0.0.1");
    const restored = parseProgress(JSON.stringify({ version: 1, accounts: [{ address: a, chainId: 100, label: "Account", ignored: "not imported" }], transactions: [], ignored: "not imported" }));
    expect(JSON.stringify(restored)).not.toContain("ignored");
  });
  it("has syntactically valid public contract addresses", () => {
    for (const p of products) {
      expect(address(p.address.toLowerCase())).toBeTruthy();
      if (p.asset) expect(address(p.asset.toLowerCase())).toBeTruthy();
      if (p.pool) expect(address(p.pool.toLowerCase())).toBeTruthy();
    }
    expect(proxyImplementation("0x1234")).toBeUndefined();
  });
});
