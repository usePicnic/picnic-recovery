import {
  concatHex, encodeFunctionData, getAddress, pad, zeroAddress,
  decodeEventLog, createWalletClient, custom,
  type Address, type Hex, type PublicClient, type EIP1193Provider,
} from "viem";
import { safeAbi, recoveryAbi, erc20Abi, legacySafeEvents } from "./abi";
import { verifyTokenReceipt, type ReceiptExpectation } from "./receipts";
import { address, assertChain, same } from "./client";
import { assertSupportedSafe, inspectAccount, inspectRecovery } from "./inspect";
import type { AccountSnapshot, Call, PreparedAction } from "./types";

export function transferCall(token: Address | null, destination: string, amount: bigint): Call {
  const to = address(destination);
  if (amount <= 0n) throw new Error("Amount must be greater than zero");
  return token
    ? { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) }
    : { to, value: amount, data: "0x" };
}
export function safeAction(snapshot: AccountSnapshot, call: Call, label: string): PreparedAction {
  if (snapshot.version === "EOA") return { kind: "direct", chainId: snapshot.chainId, account: snapshot.address, expectedSender: snapshot.address, call, label };
  assertSupportedSafe(snapshot);
  return { kind: "safe", chainId: snapshot.chainId, account: snapshot.address, call,
    safeNonce: snapshot.nonce, label };
}
export function recoveryAction(
  snapshot: AccountSnapshot, module: Address, mode: "approve" | "start" | "finalize" | "cancel", proposedOwner?: string,
): PreparedAction {
  assertSupportedSafe(snapshot);
  const recovery = snapshot.recoveries.find(r => same(r.module, module));
  if (!recovery?.supported || recovery.threshold < 1n) throw new Error("Unsupported recovery configuration");
  const pending = recovery.pending;
  const binding = { module, nonce: recovery.nonce, pendingAfter: pending.executeAfter };
  if (mode === "cancel") {
    if (!pending.executeAfter) throw new Error("No pending recovery");
    return { ...safeAction(snapshot, {
      to: module, value: 0n, data: encodeFunctionData({ abi: recoveryAbi, functionName: "cancelRecovery" }),
    }, "Cancel pending recovery"), recovery: binding };
  }
  if (mode === "finalize") {
    if (!pending.executeAfter || pending.executeAfter > snapshot.timestamp) throw new Error("Recovery is not ready");
    if (pending.newOwners.length !== 1 || pending.newThreshold !== 1n) throw new Error("Review a multi-owner recovery outside this flow");
    return { kind: "direct", chainId: snapshot.chainId, account: snapshot.address,
      call: { to: module, value: 0n, data: encodeFunctionData({ abi: recoveryAbi, functionName: "finalizeRecovery", args: [snapshot.address] }) },
      label: "Finalize recovery", recovery: binding, expectedOwner: pending.newOwners[0] };
  }
  if (pending.executeAfter !== 0n) throw new Error("A recovery is already pending. Review it before proceeding");
  const owner = address(proposedOwner ?? "");
  if (same(owner, snapshot.address) || recovery.guardians.some(g => same(g, owner))) throw new Error("The new owner must differ from the Safe and every guardian");
  return {
    kind: "direct", chainId: snapshot.chainId, account: snapshot.address,
    call: { to: module, value: 0n, data: mode === "start"
      ? encodeFunctionData({ abi: recoveryAbi, functionName: "executeRecovery", args: [snapshot.address, [owner], 1n] })
      : "0x" },
    label: mode === "start" ? "Start recovery waiting period" : "Approve recovery to new owner",
    recovery: binding, expectedOwner: owner,
    ...(mode === "approve" ? { approval: { module, nonce: recovery.nonce, owner } } : {}),
  };
}
export const safeTypes = { SafeTx: [
  { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
  { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
  { name: "nonce", type: "uint256" },
] } as const;
const safeArgs = (call: Call) => [
  call.to, call.value, call.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress,
] as const;
export async function safeHash(client: PublicClient, action: PreparedAction): Promise<Hex> {
  if (action.kind !== "safe" || action.safeNonce === undefined) throw new Error("Not a Safe proposal");
  return client.readContract({ address: action.account, abi: safeAbi, functionName: "getTransactionHash",
    args: [...safeArgs(action.call), action.safeNonce] });
}
export async function safeExecution(client: PublicClient, action: PreparedAction, sender: Address, ownerSignature?: Hex): Promise<Call> {
  const snapshot = await inspectAccount(client, action.account, action.chainId);
  assertSupportedSafe(snapshot);
  if (snapshot.nonce !== action.safeNonce) throw new Error("Safe nonce changed. Inspect and review again");
  const hash = await safeHash(client, action);
  const allowed: Address[] = [];
  for (const owner of snapshot.owners) {
    if ((same(owner, sender) && ownerSignature) || await client.readContract({
      address: action.account, abi: safeAbi, functionName: "approvedHashes", args: [owner, hash],
    }) !== 0n) allowed.push(owner);
  }
  if (BigInt(allowed.length) < snapshot.threshold) throw new Error("More owner approvals are required. Approve this exact proposal with the other owners");
  const signatures = concatHex(allowed.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, Number(snapshot.threshold))
    .map(owner => same(owner, sender) && ownerSignature ? ownerSignature : concatHex([pad(owner, { size: 32 }), pad("0x", { size: 32 }), "0x01"])));
  return { to: action.account, value: 0n,
    data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...safeArgs(action.call), signatures] }) };
}
export function safeReceiptSucceeded(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], safe: Address, expectedHash?: Hex) {
  let success = false;
  for (const log of logs) {
    if (!same(log.address, safe)) continue;
    try {
      const event = decodeEventLog({ abi: log.topics.length === 1 ? legacySafeEvents : safeAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if ((event.eventName === "ExecutionSuccess" || event.eventName === "ExecutionFailure") && expectedHash && event.args.txHash !== expectedHash) continue;
      if (event.eventName === "ExecutionFailure") throw new Error("Safe execution failed");
      if (event.eventName === "ExecutionSuccess") success = true;
    } catch (error) {
      if (error instanceof Error && error.message === "Safe execution failed") throw error;
    }
  }
  if (!success) throw new Error("Receipt does not confirm Safe execution");
}
export const recoveryTypes = {
  ExecuteRecovery: [
    { name: "wallet", type: "address" }, { name: "newOwners", type: "address[]" },
    { name: "newThreshold", type: "uint256" }, { name: "nonce", type: "uint256" },
  ],
} as const;
export async function connectedWallet(provider: EIP1193Provider, chainId: number) {
  const wallet = createWalletClient({ transport: custom(provider) });
  const accounts = await wallet.requestAddresses();
  if (!accounts[0]) throw new Error("Connect a wallet");
  if (await wallet.getChainId() !== chainId) {
    await wallet.switchChain({ id: chainId });
    if (await wallet.getChainId() !== chainId) throw new Error("Wallet is on a different network");
  }
  return { wallet, sender: getAddress(accounts[0]) };
}
async function assertFresh(client: PublicClient, action: PreparedAction) {
  await assertChain(client, action.chainId);
  if (action.recovery) {
    const state = await inspectRecovery(client, action.account, action.recovery.module);
    if (!state.supported || state.nonce !== action.recovery.nonce || state.pending.executeAfter !== action.recovery.pendingAfter) {
      throw new Error("Recovery state changed. Inspect and review again");
    }
    if (action.recovery.pendingAfter && action.expectedOwner &&
      (state.pending.newOwners.length !== 1 || !same(state.pending.newOwners[0], action.expectedOwner) || state.pending.newThreshold !== 1n)) {
      throw new Error("Pending recovery target changed");
    }
  }
}
export async function sendAction(
  client: PublicClient, provider: EIP1193Provider, action: PreparedAction,
  onSubmitted: (hash: Hex, expectation?: ReceiptExpectation) => void,
) {
  const { wallet, sender } = await connectedWallet(provider, action.chainId);
  if (action.expectedSender && !same(sender, action.expectedSender)) throw new Error("Connected wallet does not control the selected account");
  await assertFresh(client, action);
  await action.revalidate?.();
  let call = action.call;
  if (action.approval) {
    const { module, owner, nonce } = action.approval;
    const state = await inspectRecovery(client, action.account, module);
    if (!state.guardians.some(g => same(g, sender))) throw new Error("Connected wallet is not a recovery guardian");
    const signature = await wallet.signTypedData({
      account: sender, domain: { name: "Social Recovery Module", version: "0.0.1", chainId: action.chainId, verifyingContract: module },
      types: recoveryTypes, primaryType: "ExecuteRecovery",
      message: { wallet: action.account, newOwners: [owner], newThreshold: 1n, nonce },
    });
    // Unlike legacy confirmRecovery, this signature is bound to the nonce.
    await assertFresh(client, action);
    call = { to: module, value: 0n, data: encodeFunctionData({
      abi: recoveryAbi, functionName: "multiConfirmRecovery",
      args: [action.account, [owner], 1n, [{ signer: sender, signature }], false],
    }) };
  } else if (action.kind === "safe") {
    const snapshot = await inspectAccount(client, action.account, action.chainId);
    if (snapshot.nonce !== action.safeNonce) throw new Error("Safe nonce changed. Inspect and review again");
    const signature = snapshot.owners.some(o => same(o, sender)) ? await wallet.signTypedData({
      account: sender, domain: { chainId: action.chainId, verifyingContract: action.account },
      primaryType: "SafeTx", types: safeTypes,
      message: { ...action.call, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: action.safeNonce! },
    }) : undefined;
    call = await safeExecution(client, action, sender, signature);
  }
  if (action.kind === "safe") await client.call({ account: action.account, ...action.call });
  await client.call({ account: sender, ...call });
  const gas = await client.estimateGas({ account: sender, ...call });
  const balanceBefore = action.receive ? await receivedBalance(client, action.receive) : undefined;
  await assertFresh(client, action);
  await action.revalidate?.();
  const expectation: ReceiptExpectation = {
    ...(action.kind === "safe" ? { safe: action.account, safeHash: await safeHash(client, action) } : {}),
    ...(action.receive?.token ? { receive: { token: action.receive.token, recipient: action.receive.recipient, minimum: action.receive.minimum.toString() } } : {}),
  };
  if (await wallet.getChainId() !== action.chainId || !(await wallet.getAddresses()).some(a => same(a, sender))) throw new Error("Wallet account or network changed");
  const hash = await wallet.sendTransaction({ account: sender, chain: null, ...call, gas: gas * 120n / 100n });
  onSubmitted(hash, expectation); // Persist before waiting: a timeout must not trigger a retry.
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  if (action.kind === "safe") safeReceiptSucceeded(receipt.logs, action.account, expectation.safeHash);
  if (expectation.receive) verifyTokenReceipt(receipt, expectation.receive);
  if (action.receive && balanceBefore !== undefined) {
    let delta = await receivedBalance(client, action.receive) - balanceBefore;
    if (!action.receive.token && same(action.receive.recipient, sender)) delta += receipt.gasUsed * receipt.effectiveGasPrice;
    if (delta < action.receive.minimum) throw new Error("Transaction confirmed, but expected funds were not received. Inspect before retrying");
  }
  if (action.label === "Finalize recovery") {
    const snapshot = await inspectAccount(client, action.account, action.chainId);
    if (snapshot.owners.length !== 1 || snapshot.threshold !== 1n || !same(snapshot.owners[0], action.expectedOwner!)) {
      throw new Error("New ownership not confirmed");
    }
    const recovery = snapshot.recoveries.find(r => same(r.module, action.recovery!.module));
    if (!recovery || recovery.pending.executeAfter !== 0n) throw new Error("Recovery has not cleared");
  }
  return receipt;
}
async function receivedBalance(client: PublicClient, effect: NonNullable<PreparedAction["receive"]>) {
  return effect.token ? client.readContract({ address: effect.token, abi: erc20Abi,
    functionName: "balanceOf", args: [effect.recipient] }) : client.getBalance({ address: effect.recipient });
}
export async function approveSafeProposal(client: PublicClient, provider: EIP1193Provider, action: PreparedAction, onSubmitted: (hash: Hex, expectation?: ReceiptExpectation) => void) {
  const { sender } = await connectedWallet(provider, action.chainId);
  const snapshot = await inspectAccount(client, action.account, action.chainId);
  if (!snapshot.owners.some(o => same(o, sender)) || snapshot.nonce !== action.safeNonce) throw new Error("Invalid owner or stale proposal");
  const hash = await safeHash(client, action);
  return sendAction(client, provider, { kind: "direct", chainId: action.chainId, account: action.account,
    label: "Approve Safe proposal", call: { to: action.account, value: 0n,
      data: encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }) } }, onSubmitted);
}
