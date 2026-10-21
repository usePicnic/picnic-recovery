import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, decodeFunctionData, defineChain, hashTypedData, http, parseAbi, zeroAddress, type Address, type EIP1193Provider, type Hex } from "viem";
import { foundry } from "viem/chains";
import safeArtifact from "./fixtures/Safe.json";
import proxyArtifact from "./fixtures/SafeProxy.json";
import multiSendArtifact from "./fixtures/MultiSendCallOnly.json";
import { inspectAccount } from "../src/core/inspect";
import { erc20Abi, safeAbi } from "../src/core/abi";
import { sendAction, approveSafeProposal, safeHash, safeTypes, safeBatchAction, transferCall } from "../src/core/actions";
import { batchPartAction, planBatch, readBatchFacts, screenAssetTransfers, type BatchSource } from "../src/core/batch";
import { findMultiSend } from "../src/core/multisend";
import { verifyReceipt, type ReceiptExpectation } from "../src/core/receipts";
import { BASKET, BASKET_BRL, basketAbi } from "../src/core/legacy";
import { parseProgress } from "../src/core/progress";

// Gnosis chain ID so the pinned registry entry applies; all state is local Anvil.
const port = 18546;
const chain = defineChain({ ...foundry, id: 100, name: "Anvil as Gnosis" });
const client = createPublicClient({ chain, transport: http(`http://127.0.0.1:${port}`) });
const wallet = createWalletClient({ chain, transport: http(`http://127.0.0.1:${port}`) });
const singleton = "0x41675C099F32341bf84BFc5382aF534df5C7461a" as Address;
const MS141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address;
const MS130 = "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D" as Address;
const setupAbi = parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]);
let child: ChildProcess;
let accounts: Address[], tokenA: Address, tokenB: Address, artifact: { abi: unknown[]; evm: { bytecode: { object: string } } };
const methods: string[] = [];
// Records every wallet request. Typed-data signing can be refused to prove
// that a threshold-1 owner needs only the transaction itself.
function provider(index: number, refuseSignatures = false): EIP1193Provider {
  return { request: async ({ method, params }: { method: string; params?: unknown }) => {
    methods.push(method);
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [accounts[index]];
    if (refuseSignatures && method.startsWith("eth_sign")) throw new Error(`Unexpected signature request: ${method}`);
    return client.request({ method, params } as never);
  }, on: () => {}, removeListener: () => {} } as EIP1193Provider;
}
const raw = (method: string, params: unknown[]) => client.request({ method, params } as never);
async function deploy(abi: readonly unknown[], bytecode: Hex, args: unknown[] = []) {
  const receipt = await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: accounts[0], abi, bytecode, args }) });
  return receipt.contractAddress!;
}
async function newSafe(owners: Address[], threshold: bigint) {
  const safe = await deploy(proxyArtifact.abi, proxyArtifact.bytecode as Hex, [singleton]);
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: safe, abi: setupAbi, functionName: "setup", args: [owners, threshold, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] }) });
  return safe;
}
async function mint(token: Address, to: Address, amount: bigint) {
  await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: token, abi: parseAbi(["function mint(address to,uint256 amount)"]), functionName: "mint", args: [to, amount] }) });
}
const balance = (token: Address, owner: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
const sources = (): BatchSource[] => [
  { id: "100:native", kind: "native", label: "xDAI" },
  { id: "100:token:a", kind: "token", label: "TEST A", token: tokenA },
  { id: "100:token:b", kind: "token", label: "TEST B", token: tokenB },
];
async function prepare(safe: Address, destination: Address, list = sources()) {
  const snapshot = await inspectAccount(client, safe, 100);
  const multisend = (await findMultiSend(client, 100))?.address;
  const facts = await readBatchFacts(client, snapshot, list);
  const plan = planBatch({ snapshot, destination, facts, multisend });
  return { snapshot, plan, action: batchPartAction({ snapshot, plan, part: 0, label: "Batch migration · Anvil",
    reread: async () => readBatchFacts(client, await inspectAccount(client, safe, 100), list) }) };
}

beforeAll(async () => {
  child = spawn("anvil", ["--port", String(port), "--chain-id", "100", "--block-time", "1", "--silent"], { stdio: "pipe" });
  for (let i = 0; i < 40 && !accounts; i++) {
    if (child.exitCode !== null) throw new Error("Anvil could not start; check test port");
    try { accounts = await wallet.getAddresses(); } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!accounts) throw new Error("Anvil unavailable");
  await raw("anvil_setCode", [singleton, safeArtifact.deployedBytecode]);
  await raw("anvil_setCode", [MS141, multiSendArtifact.deployedBytecode]);
  const input = { language: "Solidity", sources: { "TestToken.sol": { content: readFileSync(new URL("./fixtures/TestToken.sol", import.meta.url), "utf8") } },
    settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } } };
  artifact = JSON.parse(solc.compile(JSON.stringify(input))).contracts["TestToken.sol"].TestToken;
  tokenA = await deploy(artifact.abi, `0x${artifact.evm.bytecode.object}`);
  tokenB = await deploy(artifact.abi, `0x${artifact.evm.bytecode.object}`);
}, 60_000);
afterAll(() => child?.kill("SIGTERM"));

describe("Safe batch migration through the canonical MultiSendCallOnly runtime", () => {
  it("moves two ERC-20s and native coin in one transaction, with one wallet request and no typed-data signature", async () => {
    const safe = await newSafe([accounts[0]], 1n), destination = accounts[4];
    await mint(tokenA, safe, 1_000n); await mint(tokenB, safe, 2_000n);
    await raw("anvil_setBalance", [safe, "0x1000"]);
    const nativeBefore = await client.getBalance({ address: destination });
    const { plan, action } = await prepare(safe, destination);
    expect(plan.parts).toEqual([["100:native", "100:token:a", "100:token:b"]]);
    expect(action.operation).toBe(1);
    // The Safe hash binds the operation: operation 0 with the same call is a different hash.
    const typed = (operation: number) => hashTypedData({ domain: { chainId: 100, verifyingContract: safe }, types: safeTypes, primaryType: "SafeTx",
      message: { ...action.call, operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: 0n } });
    const onChain = await safeHash(client, action);
    expect(onChain).toBe(typed(1));
    expect(onChain).not.toBe(typed(0));
    methods.length = 0;
    let stored: ReceiptExpectation | undefined, txHash: Hex | undefined;
    const receipt = await sendAction(client, provider(0, true), action, (hash, expectation) => { txHash = hash; stored = expectation; });
    expect(methods.filter(m => m.startsWith("eth_sign"))).toEqual([]);
    expect(methods.filter(m => m === "eth_sendTransaction")).toHaveLength(1);
    expect(await balance(tokenA, destination)).toBe(1_000n);
    expect(await balance(tokenB, destination)).toBe(2_000n);
    expect(await client.getBalance({ address: destination }) - nativeBefore).toBe(0x1000n);
    expect(await balance(tokenA, safe)).toBe(0n);
    // Calldata is execTransaction(operation 1) to the approved multisend, pre-validated signature.
    const tx = await client.getTransaction({ hash: txHash! });
    const exec = decodeFunctionData({ abi: safeAbi, data: tx.input });
    expect(exec.functionName).toBe("execTransaction");
    expect(exec.args![0]).toBe(MS141); expect(exec.args![3]).toBe(1);
    expect((exec.args![9] as Hex).toLowerCase()).toBe(`0x${accounts[0].slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}01`);
    // The persisted expectation survives export/import and still proves every effect.
    expect(stored?.receives).toHaveLength(2);
    expect(stored?.native).toEqual([{ recipient: destination, minimum: "4096" }]);
    const reloaded = parseProgress(JSON.stringify({ version: 1, accounts: [], transactions: [{ chainId: 100, hash: txHash, account: safe, label: action.label, status: "pending", expectation: stored }] }));
    expect(() => verifyReceipt(receipt, reloaded.transactions[0].expectation)).not.toThrow();
    expect(() => verifyReceipt(receipt, { ...stored, receives: [...stored!.receives!, { token: tokenB, recipient: destination, minimum: "1" }] })).toThrow(/token/);
    // Replaying the reviewed action is refused (balances and nonce both moved).
    await expect(sendAction(client, provider(0), action, () => {})).rejects.toThrow(/balance changed|nonce changed/);
    await expect(sendAction(client, provider(0), { ...action, revalidate: undefined }, () => {})).rejects.toThrow(/nonce changed/);
  }, 60_000);

  it("keeps a reverting token pending while migrating the other token in one transaction", async () => {
    const safe = await newSafe([accounts[0]], 1n), destination = accounts[7];
    await mint(tokenA, safe, 31n); await mint(tokenB, safe, 47n);
    const setBlocked = async (blocked: boolean) => client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: tokenB,
      abi: parseAbi(["function setTransfersBlocked(bool blocked)"]), functionName: "setTransfersBlocked", args: [blocked] }) });
    await setBlocked(true);
    try {
      const { snapshot, action: unscreened } = await prepare(safe, destination, sources().slice(1));
      methods.length = 0;
      await expect(sendAction(client, provider(0, true), unscreened, () => {})).rejects.toThrow(/GS013/);
      expect(methods.filter(m => m === "eth_sendTransaction")).toHaveLength(0);
      const facts = await readBatchFacts(client, snapshot, sources().slice(1));
      const checked = await screenAssetTransfers(client, snapshot, facts, destination, accounts[0]);
      const plan = planBatch({ snapshot, destination, facts: checked, multisend: MS141 });
      expect(plan.parts).toEqual([["100:token:a"]]);
      expect(plan.entries[1]).toMatchObject({ transferBlocked: true, status: "individual" });
      const action = batchPartAction({ snapshot, plan, part: 0, label: "Migrate transferable token" });
      await sendAction(client, provider(0, true), action, () => {});
      expect(methods.filter(m => m === "eth_sendTransaction")).toHaveLength(1);
      expect(await balance(tokenA, destination)).toBe(31n);
      expect(await balance(tokenB, destination)).toBe(0n);
      expect(await balance(tokenB, safe)).toBe(47n);
    } finally { await setBlocked(false); }
  }, 60_000);

  it("refuses tampered payloads, unverified runtimes and failing children before any transaction is sent", async () => {
    const safe = await newSafe([accounts[0]], 1n), destination = accounts[5];
    await mint(tokenA, safe, 10n); await mint(tokenB, safe, 10n);
    const { action, snapshot } = await prepare(safe, destination, sources().slice(1));
    methods.length = 0;
    const tampered = { ...action, batch: { ...action.batch!, calls: [action.batch!.calls[0], transferCall(tokenB, accounts[6], 10n)] } };
    await expect(sendAction(client, provider(0), tampered, () => {})).rejects.toThrow(/match/);
    // A registry address whose runtime is not the pinned MultiSendCallOnly.
    await raw("anvil_setCode", [MS130, "0x6000"]);
    const wrongRuntime = safeBatchAction(snapshot, MS130, action.batch!.calls, action.batch!.labels, "Batch");
    await expect(sendAction(client, provider(0), wrongRuntime, () => {})).rejects.toThrow(/runtime/);
    // A child that would fail (more than the balance) fails the whole simulation.
    const failing = safeBatchAction(snapshot, MS141, [action.batch!.calls[0], transferCall(tokenB, destination, 11n)], ["a", "b"], "Batch");
    await expect(sendAction(client, provider(0), failing, () => {})).rejects.toThrow();
    // A balance drop after review is caught by revalidation.
    await sendAction(client, provider(0), safeBatchAction(snapshot, MS141, [transferCall(tokenB, accounts[7], 1n)], ["one"], "One"), () => {});
    await expect(sendAction(client, provider(0), action, () => {})).rejects.toThrow(/changed/);
    expect(methods.filter(m => m === "eth_sendTransaction")).toHaveLength(1);
    expect(await balance(tokenA, destination)).toBe(0n);
  }, 60_000);

  it("keeps explicit approvals for a 2-of-2 Safe instead of promising one signature", async () => {
    const safe = await newSafe([accounts[0], accounts[1]], 2n), destination = accounts[8];
    await mint(tokenA, safe, 50n); await mint(tokenB, safe, 60n);
    const { action } = await prepare(safe, destination, sources().slice(1));
    await expect(sendAction(client, provider(0), action, () => {})).rejects.toThrow(/approvals/);
    await approveSafeProposal(client, provider(0), action, () => {});
    methods.length = 0;
    await sendAction(client, provider(1), action, () => {});
    expect(methods).toContain("eth_signTypedData_v4");
    expect(await balance(tokenA, destination)).toBe(50n);
    expect(await balance(tokenB, destination)).toBe(60n);
  }, 60_000);
});


it("withdraws only BRL then transfers the basket NFT atomically, leaving locked assets inside", async () => {
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: {
    "Basket.sol": { content: readFileSync(new URL("./fixtures/TestBasket.sol", import.meta.url), "utf8") },
    "Token.sol": { content: readFileSync(new URL("./fixtures/TestToken.sol", import.meta.url), "utf8") },
  }, settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode"] } } } })));
  const basket = compiled.contracts["Basket.sol"].TestBasket;
  await raw("anvil_setCode", [BASKET, `0x${basket.evm.deployedBytecode.object}`]);
  await raw("anvil_setCode", [BASKET_BRL, `0x${compiled.contracts["Token.sol"].TestToken.evm.deployedBytecode.object}`]);
  const safe = await newSafe([accounts[0]], 1n), destination = accounts[6];
  const write = async (address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) => client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address, abi, functionName, args }) });
  await write(BASKET, basket.abi, "mint", [1n, safe]);
  const basketWallet = await client.readContract({ address: BASKET, abi: basketAbi, functionName: "walletOf", args: [1n] });
  await mint(BASKET_BRL, basketWallet, 100n);
  await mint(tokenB, basketWallet, 300_000n);
  const blockAbi = parseAbi(["function setTransfersBlocked(bool blocked)"]);
  await write(tokenB, blockAbi, "setTransfersBlocked", [true]);
  const snapshot = await inspectAccount(client, safe, 100);
  const facts = [{ id: "basket", label: "Basket #1", kind: "basket" as const, nftId: 1n, wallet: basketWallet, owned: true, native: 0n, stakes: [], tokens: [
    { key: "brl", token: BASKET_BRL, name: "BRL", category: "token" as const, balance: 100n, fresh: 100n, assetIds: [], types: [] },
    { key: "locked", token: tokenB, name: "Locked", category: "token" as const, balance: 300_000n, fresh: 300_000n, assetIds: [], types: [] },
  ] }];
  const prepareBasket = (to: Address) => batchPartAction({ snapshot, plan: planBatch({ snapshot, destination: to, facts, multisend: MS141 }), part: 0, label: "BRL + NFT" });
  // An incompatible NFT receiver must roll back the preceding BRL transfers too.
  const reject = prepareBasket(tokenA);
  const { safeExecution } = await import("../src/core/actions");
  const failedCall = await safeExecution(client, reject, accounts[0], undefined, true);
  const failed = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: accounts[0], ...failedCall, gas: 1_000_000n }) });
  expect(failed.status).toBe("reverted");
  expect(await balance(BASKET_BRL, basketWallet)).toBe(100n);
  expect(await balance(BASKET_BRL, tokenA)).toBe(0n);
  expect((await client.readContract({ address: BASKET, abi: basketAbi, functionName: "ownerOf", args: [1n] })).toLowerCase()).toBe(safe.toLowerCase());
  const checked = await screenAssetTransfers(client, snapshot, facts, destination, accounts[0], MS141);
  expect(checked[0].transferBlocked).toBe(false);
  methods.length = 0;
  let expectation: ReceiptExpectation | undefined;
  const receipt = await sendAction(client, provider(0, true), prepareBasket(destination), (_, e) => { expectation = e; });
  expect(methods.filter(m => m === "eth_sendTransaction")).toHaveLength(1);
  expect(await balance(BASKET_BRL, destination)).toBe(100n);
  expect(await balance(BASKET_BRL, basketWallet)).toBe(0n);
  expect(await balance(tokenB, basketWallet)).toBe(300_000n);
  expect((await client.readContract({ address: BASKET, abi: basketAbi, functionName: "ownerOf", args: [1n] })).toLowerCase()).toBe(destination.toLowerCase());
  expect(expectation?.nfts).toEqual([{ collection: BASKET, from: snapshot.address, recipient: destination, tokenId: "1" }]);
  expect(() => verifyReceipt(receipt, expectation)).not.toThrow();
}, 90_000);
