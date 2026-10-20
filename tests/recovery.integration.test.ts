import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, type Address, type Hex, type EIP1193Provider, concatHex, pad, encodeAbiParameters } from "viem";
import { foundry } from "viem/chains";
import safeArtifact from "./fixtures/Safe.json";
import proxyArtifact from "./fixtures/SafeProxy.json";
import delayArtifact from "./fixtures/Delay.json";
import { inspectCard, enqueueCard, readQueue, dispatchCard } from "../src/core/card";
import recoveryArtifact from "./fixtures/recovery.json";
import { inspectAccount, recoveryPeriod } from "../src/core/inspect";
import { safeAbi, recoveryAbi, erc20Abi } from "../src/core/abi";
import { recoveryAction, sendAction, safeAction, transferCall, approveSafeProposal } from "../src/core/actions";

const setupAbi = parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]);
const zero = "0x0000000000000000000000000000000000000000" as const;
const port = 18545;
const publicClient = createPublicClient({ chain: foundry, transport: http(`http://127.0.0.1:${port}`) });
const wallet = createWalletClient({ chain: foundry, transport: http(`http://127.0.0.1:${port}`) });
const singleton = "0x41675C099F32341bf84BFc5382aF534df5C7461a" as Address;
let child: ChildProcess;
let accounts: Address[], safe: Address, module: Address, token: Address;
function provider(index: number): EIP1193Provider {
  return {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [accounts[index]];
      return publicClient.request({ method, params } as never);
    },
    on: () => {}, removeListener: () => {},
  } as EIP1193Provider;
}
async function raw(method: string, params: unknown[]) { return publicClient.request({ method, params } as never); }
async function deploy(abi: readonly unknown[], bytecode: Hex, args: unknown[] = []): Promise<Address> {
  const hash = await wallet.deployContract({ account: accounts[0], abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("Deployment failed");
  return receipt.contractAddress;
}
async function oldOwnerCall(to: Address, data: Hex) {
  const signature = concatHex([pad(accounts[0], { size: 32 }), pad("0x", { size: 32 }), "0x01"]);
  const hash = await wallet.writeContract({ account: accounts[0], address: safe, abi: safeAbi, functionName: "execTransaction",
    args: [to, 0n, data, 0, 0n, 0n, 0n, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", signature] });
  await publicClient.waitForTransactionReceipt({ hash });
}
beforeAll(async () => {
  child = spawn("anvil", ["--port", String(port), "--block-time", "1", "--silent"], { stdio: "pipe" });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) throw new Error("Anvil could not start; check test port");
    try { accounts = await wallet.getAddresses(); ready = true; break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!ready) throw new Error("Anvil unavailable");
  await raw("anvil_setCode", [singleton, safeArtifact.deployedBytecode]);
  safe = await deploy(proxyArtifact.abi, proxyArtifact.bytecode as Hex, [singleton]);
  const setupAbi = parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]);
  const zero = "0x0000000000000000000000000000000000000000" as const;
  const setup = await wallet.writeContract({ account: accounts[0], address: safe, abi: setupAbi, functionName: "setup", args: [[accounts[0]], 1n, zero, "0x", zero, zero, 0n, zero] });
  await publicClient.waitForTransactionReceipt({ hash: setup });
  // Transaction input on Gnosis is salt (32 bytes), creation code, constructor args.
  module = await deploy([], `0x${recoveryArtifact.transactionInput.slice(66)}`);
  await oldOwnerCall(safe, encodeFunctionData({ abi: parseAbi(["function enableModule(address module)"]), functionName: "enableModule", args: [module] }));
  await oldOwnerCall(module, encodeFunctionData({ abi: parseAbi(["function addGuardianWithThreshold(address guardian,uint256 threshold)"]), functionName: "addGuardianWithThreshold", args: [accounts[1], 1n] }));
  const input = { language: "Solidity", sources: { "TestToken.sol": { content: readFileSync(new URL("./fixtures/TestToken.sol", import.meta.url), "utf8") } },
    settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const artifact = output.contracts["TestToken.sol"].TestToken;
  token = await deploy(artifact.abi, `0x${artifact.evm.bytecode.object}`);
  const mint = await wallet.writeContract({ account: accounts[0], address: token, abi: parseAbi(["function mint(address to,uint256 amount)"]), functionName: "mint", args: [safe, 1_000_000n] });
  await publicClient.waitForTransactionReceipt({ hash: mint });
}, 60_000);
afterAll(() => child?.kill("SIGTERM"));

describe("Independent recovery using deployed contract bytecode", () => {
  it("identifies actual Safe owner, guardian and seven-day contract period", async () => {
    const s = await inspectAccount(publicClient, safe, foundry.id);
    expect(s.owners.map(a => a.toLowerCase())).toEqual([accounts[0].toLowerCase()]);
    expect(s.recoveries[0].period).toBe(604800n);
    expect(s.recoveries[0].guardians[0].toLowerCase()).toBe(accounts[1].toLowerCase());
  });
  it("refuses guardian as destination and a non-guardian signature", async () => {
    const s = await inspectAccount(publicClient, safe, foundry.id);
    expect(() => recoveryAction(s, module, "approve", accounts[1])).toThrow(/guardian/);
    await expect(sendAction(publicClient, provider(2), recoveryAction(s, module, "approve", accounts[3]), () => {})).rejects.toThrow(/not a recovery guardian/);
  });
  it("collects nonce-bound approval without the hosted Candide service", async () => {
    const s = await inspectAccount(publicClient, safe, foundry.id);
    await sendAction(publicClient, provider(1), recoveryAction(s, module, "approve", accounts[3]), () => {});
    expect(await publicClient.readContract({ address: module, abi: recoveryAbi, functionName: "getRecoveryApprovals", args: [safe, [accounts[3]], 1n] })).toBe(1n);
  }, 30_000);
  it("starts waiting and rejects premature finalization / duplicate initiation", async () => {
    const s = await inspectAccount(publicClient, safe, foundry.id);
    await sendAction(publicClient, provider(1), recoveryAction(s, module, "start", accounts[3]), () => {});
    const waiting = await inspectAccount(publicClient, safe, foundry.id);
    expect(() => recoveryAction(waiting, module, "finalize")).toThrow(/not ready/);
    expect(() => recoveryAction(waiting, module, "start", accounts[3])).toThrow(/already pending/);
  }, 30_000);
  it("finalizes to an independent owner after contract delay", async () => {
    await raw("evm_increaseTime", [604801]); await raw("evm_mine", []);
    const s = await inspectAccount(publicClient, safe, foundry.id);
    await sendAction(publicClient, provider(3), recoveryAction(s, module, "finalize"), () => {});
    const recovered = await inspectAccount(publicClient, safe, foundry.id);
    expect(recovered.owners[0].toLowerCase()).toBe(accounts[3].toLowerCase());
    expect(recovered.recoveries[0].pending.executeAfter).toBe(0n);
  }, 30_000);
  it("new owner moves real ERC20 balance through Safe execTransaction", async () => {
    const s = await inspectAccount(publicClient, safe, foundry.id);
    const action = { ...safeAction(s, transferCall(token, accounts[4], 123_456n), "Test transfer"),
      receive: { token, recipient: accounts[4], minimum: 123_456n } };
    await sendAction(publicClient, provider(3), action, () => {});
    expect(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [accounts[4]] })).toBe(123_456n);
    await expect(sendAction(publicClient, provider(3), action, () => {})).rejects.toThrow(/nonce changed/);
  }, 30_000);
  it("will not execute using the former owner or wrong chain", async () => {
    const s = await inspectAccount(publicClient, safe, foundry.id);
    const action = safeAction(s, transferCall(token, accounts[4], 1n), "Test transfer");
    await expect(sendAction(publicClient, provider(0), action, () => {})).rejects.toThrow(/approvals/);
    await expect(inspectAccount(publicClient, safe, 100)).rejects.toThrow(/chain/);
  });
  it("executes a card withdrawal through a real Delay clone, after its cooldown", async () => {
    const card = await deploy(proxyArtifact.abi, proxyArtifact.bytecode as Hex, [singleton]);
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: card, abi: setupAbi, functionName: "setup", args: [[accounts[0]], 1n, zero, "0x", zero, zero, 0n, zero] }) });
    const implementation = "0x22d903fd45f441f51bcad198d14eba8a75ea1ef0" as Address;
    const deployedDelay = await deploy([], delayArtifact.bytecode as Hex);
    await raw("anvil_setCode", [implementation, await publicClient.getCode({ address: deployedDelay })]);
    const delay = accounts[8];
    await raw("anvil_setCode", [delay, `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`]);
    const init = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }], [accounts[0], card, card, 60n, 0n]);
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: delay, abi: parseAbi(["function setUp(bytes params)"]), functionName: "setUp", args: [init] }) });
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: delay, abi: parseAbi(["function enableModule(address module)"]), functionName: "enableModule", args: [safe] }) });
    const cardSnapshot = await inspectAccount(publicClient, card, foundry.id);
    await sendAction(publicClient, provider(0), safeAction(cardSnapshot, { to: card, value: 0n, data: encodeFunctionData({ abi: parseAbi(["function enableModule(address module)"]), functionName: "enableModule", args: [delay] }) }, "Enable card module in test"), () => {});
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: token, abi: parseAbi(["function mint(address to,uint256 amount)"]), functionName: "mint", args: [card, 500_000n] }) });
    let [state] = await inspectCard(publicClient, card, foundry.id);
    const controller = await inspectAccount(publicClient, safe, foundry.id);
    await sendAction(publicClient, provider(3), enqueueCard(state, transferCall(token, accounts[5], 200_000n), foundry.id, safe, controller), () => {});
    [state] = await inspectCard(publicClient, card, foundry.id);
    const [queued] = await readQueue(publicClient, state);
    await expect(dispatchCard(publicClient, state, queued, foundry.id)).rejects.toThrow(/not executable/);
    await raw("evm_increaseTime", [61]); await raw("evm_mine", []);
    const action = await dispatchCard(publicClient, state, queued, foundry.id);
    await sendAction(publicClient, provider(5), action, () => {});
    expect(await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [accounts[5]] })).toBe(200_000n);
    await expect(sendAction(publicClient, provider(5), action, () => {})).rejects.toThrow(/head changed/);
  }, 60_000);
  it("supports existing EOA accounts and refuses a different connected signer", async () => {
    const s = await inspectAccount(publicClient, accounts[0], foundry.id);
    expect(s.version).toBe("EOA");
    const action = safeAction(s, transferCall(null, accounts[6], 1n), "Legacy EOA transfer");
    await expect(sendAction(publicClient, provider(3), action, () => {})).rejects.toThrow(/does not control/);
    await sendAction(publicClient, provider(0), action, () => {});
  }, 30_000);
  it("combines an on-chain approval and a nonce-bound signature for a 2-of-2 Safe", async () => {
    const multi = await deploy(proxyArtifact.abi, proxyArtifact.bytecode as Hex, [singleton]);
    await publicClient.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: multi, abi: setupAbi, functionName: "setup", args: [[accounts[0], accounts[1]], 2n, zero, "0x", zero, zero, 0n, zero] }) });
    await raw("anvil_setBalance", [multi, "0x100000"]);
    const s = await inspectAccount(publicClient, multi, foundry.id);
    const action = safeAction(s, transferCall(null, accounts[6], 1n), "Multisig transfer");
    await expect(sendAction(publicClient, provider(0), action, () => {})).rejects.toThrow(/approvals/);
    await approveSafeProposal(publicClient, provider(0), action, () => {});
    await sendAction(publicClient, provider(1), action, () => {});
    expect((await inspectAccount(publicClient, multi, foundry.id)).nonce).toBe(1n);
  }, 30_000);
  it("recognizes canonical period variants but rejects modified runtime", () => {
    const offset = 2 + 0x2bac * 2;
    const fast = `${recoveryArtifact.runtime.slice(0, offset)}${(180n).toString(16).padStart(64, "0")}${recoveryArtifact.runtime.slice(offset + 64)}` as Hex;
    expect(recoveryPeriod(fast)).toBe(180n);
    expect(recoveryPeriod(`${fast.slice(0, -2)}00` as Hex)).toBeUndefined();
  });
});
