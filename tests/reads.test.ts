import { describe, expect, it, vi } from "vitest";
import { defineChain, encodeAbiParameters, HttpRequestError, RpcRequestError, zeroAddress, type Address, type PublicClient } from "viem";
import { CustomTokenFailure, diagnoseNetwork, inspectCustomToken, type NetworkDiagnosis, type TokenEntry } from "../src/core/diagnosis";
import { classify, ReadPool } from "../src/core/reads";
import { readRpcs, rpcFor } from "../src/components/useDiagnosis";

const account = "0x1111111111111111111111111111111111111111" as Address;
const chain = defineChain({
  id: 1337, name: "Test", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://localhost:8545"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const tokens: TokenEntry[] = Array.from({ length: 250 }, (_, i) => ({ chainId: chain.id, address: `0x${(i + 16).toString(16).padStart(40, "0")}`, name: `T${i}` }));
const word = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);
const rateLimited = () => new HttpRequestError({ url: "https://public.example/key", status: 429, headers: new Headers({ "retry-after": "285" }), details: "public RPC rate limit" });
const stale = () => new RpcRequestError({ url: "https://public.example", body: {}, error: { code: -32000, message: "missing trie node abc (path ) state is not available" } });
type Call = { target: string; callData: string };
// Token i holds i units; tokens listed in `reverting` revert balanceOf.
function node(options: { chainId?: number; reverting?: Set<string>; fail?: (calls: Call[], block?: bigint) => Error | undefined } = {}) {
  return {
    getChainId: vi.fn(async () => options.chainId ?? chain.id), getBlock: vi.fn(async () => ({ number: 10n, timestamp: 100n })),
    getCode: vi.fn(async () => "0x"), getTransactionCount: vi.fn(async () => 0), getBalance: vi.fn(async () => 0n),
    getBlockNumber: vi.fn(async () => 50n),
    readContract: vi.fn(async ({ functionName, args, blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      if (functionName !== "aggregate3") throw new Error("unexpected direct read");
      const calls = args![0] as Call[];
      const failure = options.fail?.(calls, blockNumber); if (failure) throw failure;
      return calls.map(c => {
        if (options.reverting?.has(c.target.toLowerCase())) return { success: false, returnData: "0x" };
        if (c.callData.startsWith("0x313ce567")) return { success: true, returnData: word(6n) };
        return { success: true, returnData: word(BigInt(tokens.findIndex(t => t.address === c.target.toLowerCase()))) };
      });
    }),
  };
}
async function scan(nodes: ReturnType<typeof node>[], catalogue = tokens) {
  const updates: NetworkDiagnosis[] = [];
  await diagnoseNetwork({ chain, account, catalogue, waitLimit: 1, signal: new AbortController().signal, update: r => updates.push(r),
    sources: nodes.map((client, i) => ({ url: `https://rpc${i}.example/secret`, client: client as unknown as PublicClient })) });
  return updates.at(-1)!;
}

describe("resilient read path", () => {
  it("classifies rate limits, stale state and reverts separately", () => {
    expect(classify(rateLimited())).toBe("rate");
    expect(classify(stale())).toBe("state");
    expect(classify(new RpcRequestError({ url: "x", body: {}, error: { code: 3, message: "execution reverted" } }))).toBe("revert");
  });
  it("does not record a rate-limited multicall as thousands of failed tokens", async () => {
    // viem's multicall({ allowFailure }) folded HTTP 429 into per-call failures.
    const limited = node({ fail: () => rateLimited() });
    const last = await scan([limited]);
    expect(last.status).toBe("partial");
    expect(last.unreadableTokens).toHaveLength(0);
    expect(last.tokens).toHaveLength(0);
    expect(last.issues.join()).not.toContain("secret");
    expect(limited.readContract).toHaveBeenCalledTimes(1);
    expect(last.checkedTokens).toBe(0);
    expect(last.totalTokens).toBe(250);
  });
  it("fails over to a chain-verified endpoint and keeps earlier results", async () => {
    let calls = 0;
    const flaky = node({ fail: () => ++calls > 1 ? rateLimited() : undefined });
    const backup = node();
    const last = await scan([flaky, backup]);
    expect(last.status).toBe("complete");
    expect(last.checkedTokens).toBe(250);
    expect(last.tokens).toHaveLength(249);
    expect(last.tokens.every(t => t.verifiedDecimals === 6)).toBe(true);
    expect(last.sources).toEqual(["rpc0.example", "rpc1.example"]);
  });
  it("never reads from a fallback reporting another chain", async () => {
    const down = node({ fail: () => rateLimited() }), wrong = node({ chainId: 1 });
    const last = await scan([down, wrong]);
    expect(wrong.readContract).not.toHaveBeenCalled();
    expect(wrong.getBlock).not.toHaveBeenCalled();
    expect(last.status).toBe("partial");
  });
  it("reports reverting contracts separately from unanswered reads", async () => {
    const last = await scan([node({ reverting: new Set([tokens[3].address]) })]);
    expect(last.status).toBe("complete");
    expect(last.failedTokens).toBe(0);
    expect(last.unreadableTokens.map(t => t.name)).toEqual(["T3"]);
    expect(last.tokens.some(t => t.name === "T3")).toBe(false);
  });
  it("re-pins to a newer block only when the pinned state is gone, and says so", async () => {
    const pruned = node({ fail: (_, block) => block === 10n ? stale() : undefined });
    const last = await scan([pruned]);
    expect(last.status).toBe("complete");
    expect(last.snapshot?.block).toBe(10n);
    expect(last.tokenBlocks).toEqual({ from: 50n, to: 50n });
  });
  it("splits oversized requests instead of dropping the chunk", async () => {
    const small = node({ fail: calls => calls.length > 30 ? new HttpRequestError({ url: "x", status: 413 }) : undefined });
    const last = await scan([small]);
    expect(last.status).toBe("complete");
    expect(last.tokens).toHaveLength(249);
  });
  it("respects an explicit custom RPC without public fallback", () => {
    expect(readRpcs(56, { 56: "http://127.0.0.1:8545" })).toEqual(["http://127.0.0.1:8545"]);
    expect(readRpcs(56, {})[0]).toBe("https://bsc-dataseed.bnbchain.org");
    expect(readRpcs(56, {})).toHaveLength(3);
    expect(rpcFor(56, {})).toBe("https://bsc-dataseed.bnbchain.org");
    expect(readRpcs(1, {})).toEqual(["https://ethereum.reth.rs/rpc", "https://ethereum-rpc.publicnode.com"]);
  });
});

describe("custom ERC-20 token", () => {
  const tokenAddress = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0";
  function tokenNode(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      getChainId: vi.fn(async () => chain.id), getBlockNumber: vi.fn(async () => 77n),
      getCode: vi.fn(async () => overrides.code ?? "0x60016000"),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
        if (functionName in overrides) { const v = overrides[functionName]; if (v instanceof Error) throw v; return v; }
        return { balanceOf: 123456789n, decimals: 6, symbol: "TEST‮\u0000" }[functionName] ?? (() => { throw new RpcRequestError({ url: "x", body: {}, error: { code: 3, message: "execution reverted" } }); })();
      }),
    };
  }
  const pool = (client: unknown, signal = new AbortController().signal) => new ReadPool(chain, [{ url: "http://127.0.0.1:1", client: client as PublicClient }], signal, 1);
  it("uses on-chain decimals, tolerates missing name() and cleans metadata", async () => {
    const found = await inspectCustomToken(pool(tokenNode()), chain.id, account, tokenAddress);
    expect(found).toMatchObject({ balance: 123456789n, verifiedDecimals: 6, symbol: "TEST", name: "TEST", block: 77n, account, custom: true });
  });
  it("keeps zero balance as a verified zero and unknown decimals as unknown", async () => {
    const found = await inspectCustomToken(pool(tokenNode({ balanceOf: 0n, decimals: new RpcRequestError({ url: "x", body: {}, error: { code: 3, message: "execution reverted" } }) })), chain.id, account, tokenAddress);
    expect(found.balance).toBe(0n);
    expect(found.verifiedDecimals).toBeUndefined();
  });
  it("rejects non-contracts, non-tokens and unreachable RPCs with distinct reasons", async () => {
    const reason = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => e instanceof CustomTokenFailure ? e.code : String(e));
    expect(await reason(inspectCustomToken(pool(tokenNode({ code: "0x" })), chain.id, account, tokenAddress))).toBe("not-contract");
    expect(await reason(inspectCustomToken(pool(tokenNode({ balanceOf: new RpcRequestError({ url: "x", body: {}, error: { code: 3, message: "execution reverted" } }) })), chain.id, account, tokenAddress))).toBe("no-balance");
    expect(await reason(inspectCustomToken(pool(tokenNode({ balanceOf: rateLimited() })), chain.id, account, tokenAddress))).toBe("rpc");
    expect(await reason(inspectCustomToken(pool(tokenNode()), chain.id, account, zeroAddress))).toBe("invalid-address");
  });
  it("stops when the account changes mid-read", async () => {
    const controller = new AbortController(), client = tokenNode();
    client.getCode.mockImplementation(async () => { controller.abort(); return "0x60016000"; });
    await expect(inspectCustomToken(pool(client, controller.signal), chain.id, account, tokenAddress)).rejects.toThrow("Cancelled");
    expect(client.readContract).not.toHaveBeenCalled();
  });
});
