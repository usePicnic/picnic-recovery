import {
  concatHex, encodeFunctionData, getAddress, pad, zeroAddress, createWalletClient, custom,
  type Address, type Hex, type PublicClient, type EIP1193Provider,
} from "viem";
import { safeAbi, recoveryAbi, erc20Abi } from "./abi";
import { verifyReceipt, safeReceiptSucceeded, type ReceiptExpectation } from "./receipts";
import { address, assertChain, same } from "./client";
import { assertSupportedSafe, inspectAccount, inspectRecovery } from "./inspect";
import { assertRecoveryOwner } from "./destination";
import { assertBatchPayload, multiSendCall, verifyMultiSendRuntime } from "./multisend";
import type { AccountSnapshot, Call, PreparedAction, Receive } from "./types";

export { safeReceiptSucceeded };
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
// One Safe transaction: DELEGATECALL to an approved MultiSendCallOnly whose
// CALL children are exactly `calls`. A single child stays a plain CALL.
// An EOA has no delegatecall context: callers must use individual actions.
export function safeBatchAction(snapshot: AccountSnapshot, multisend: Address, calls: Call[], labels: string[], label: string): PreparedAction {
  if (snapshot.version === "EOA") throw new Error("A legacy EOA account cannot batch; use individual withdrawals");
  assertSupportedSafe(snapshot);
  if (!calls.length || calls.length !== labels.length) throw new Error("Invalid batch");
  if (calls.length === 1) return { ...safeAction(snapshot, calls[0], label), operation: 0, batch: { calls, labels } };
  const call = multiSendCall(snapshot.chainId, multisend, calls);
  assertBatchPayload(snapshot.chainId, snapshot.address, call, calls);
  return { kind: "safe", chainId: snapshot.chainId, account: snapshot.address, call, operation: 1, batch: { calls, labels }, safeNonce: snapshot.nonce, label };
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
    assertRecoveryOwner(pending.newOwners[0], snapshot);
    return { kind: "direct", chainId: snapshot.chainId, account: snapshot.address,
      call: { to: module, value: 0n, data: encodeFunctionData({ abi: recoveryAbi, functionName: "finalizeRecovery", args: [snapshot.address] }) },
      label: "Finalize recovery", recovery: binding, expectedOwner: pending.newOwners[0] };
  }
  if (pending.executeAfter !== 0n) throw new Error("A recovery is already pending. Review it before proceeding");
  const owner = address(proposedOwner ?? "");
  assertRecoveryOwner(owner, snapshot);
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
export const operationOf = (action: PreparedAction) => action.operation ?? 0;
// The operation is part of both the Safe hash and execTransaction calldata.
export const safeArgs = (call: Call, operation: 0 | 1 = 0) => [
  call.to, call.value, call.data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress,
] as const;
export async function safeHash(client: PublicClient, action: PreparedAction): Promise<Hex> {
  if (action.kind !== "safe" || action.safeNonce === undefined) throw new Error("Not a Safe proposal");
  return client.readContract({ address: action.account, abi: safeAbi, functionName: "getTransactionHash",
    args: [...safeArgs(action.call, operationOf(action)), action.safeNonce] });
}
// Safe signature encoding v=1 ("pre-validated"): valid when msg.sender is that
// owner, or when the owner registered the hash on-chain with approveHash.
export const prevalidatedSignature = (owner: Address) => concatHex([pad(owner, { size: 32 }), pad("0x", { size: 32 }), "0x01"]);
// `senderSigns`: the sender's approval is the typed-data signature, or (when
// omitted for a threshold-1 owner) the pre-validated msg.sender signature.
export async function safeExecution(client: PublicClient, action: PreparedAction, sender: Address, ownerSignature?: Hex, senderIsOwnerExecutor = false): Promise<Call> {
  const snapshot = await inspectAccount(client, action.account, action.chainId);
  assertSupportedSafe(snapshot);
  if (snapshot.nonce !== action.safeNonce) throw new Error("Safe nonce changed. Inspect and review again");
  const hash = await safeHash(client, action);
  const senderApproves = (owner: Address) => same(owner, sender) && (!!ownerSignature || senderIsOwnerExecutor);
  const allowed: Address[] = [];
  for (const owner of snapshot.owners) {
    if (senderApproves(owner) || await client.readContract({
      address: action.account, abi: safeAbi, functionName: "approvedHashes", args: [owner, hash],
    }) !== 0n) allowed.push(owner);
  }
  if (BigInt(allowed.length) < snapshot.threshold) throw new Error("More owner approvals are required. Approve this exact proposal with the other owners");
  const signatures = concatHex(allowed.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .slice(0, Number(snapshot.threshold))
    .map(owner => same(owner, sender) && ownerSignature ? ownerSignature : prevalidatedSignature(owner)));
  return { to: action.account, value: 0n,
    data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...safeArgs(action.call, operationOf(action)), signatures] }) };
}
export const recoveryTypes = {
  ExecuteRecovery: [
    { name: "wallet", type: "address" }, { name: "newOwners", type: "address[]" },
    { name: "newThreshold", type: "uint256" }, { name: "nonce", type: "uint256" },
  ],
} as const;
export async function connectedWallet(provider: EIP1193Provider, chainId: number, progress?: (stage: "wallet" | "network") => void) {
  progress?.("wallet");
  const wallet = createWalletClient({ transport: custom(provider, { retryCount: 0 }) });
  // Connection is already authorized in step 0. Do not request permission again.
  const accounts = await wallet.getAddresses();
  if (!accounts[0]) throw new Error("The selected wallet is disconnected or locked. Reconnect it in Diagnosis");
  if (await wallet.getChainId() !== chainId) {
    progress?.("network");
    await wallet.switchChain({ id: chainId });
    if (await wallet.getChainId() !== chainId) throw new Error("Wallet is on a different network");
  }
  return { wallet, sender: getAddress(accounts[0]) };
}
async function assertFresh(client: PublicClient, action: PreparedAction) {
  await assertChain(client, action.chainId);
  if (action.recovery) {
    const snapshot = await inspectAccount(client, action.account, action.chainId);
    assertSupportedSafe(snapshot);
    const state = snapshot.recoveries.find(r => same(r.module, action.recovery!.module));
    if (!state?.supported || state.nonce !== action.recovery.nonce || state.pending.executeAfter !== action.recovery.pendingAfter) {
      throw new Error("Recovery state changed. Inspect and review again");
    }
    for (const owner of [action.expectedOwner, action.approval?.owner].filter((a): a is Address => !!a)) assertRecoveryOwner(owner, snapshot);
    if (action.recovery.pendingAfter && action.expectedOwner &&
      (state.pending.newOwners.length !== 1 || !same(state.pending.newOwners[0], action.expectedOwner) || state.pending.newThreshold !== 1n)) {
      throw new Error("Pending recovery target changed");
    }
  }
}
export const actionReceives = (action: PreparedAction): Receive[] => [...action.receive ? [action.receive] : [], ...action.receives ?? []];
export function assertAllowedRecipients(action: PreparedAction, forbidden: readonly string[]) {
  const blocked = [...(action.recovery ? [action.expectedOwner, action.approval?.owner].filter((a): a is Address => !!a) : []), ...actionReceives(action).map(effect => effect.recipient), ...action.destinations ?? [], ...action.nfts?.map(nft => nft.recipient) ?? []]
    .find(recipient => forbidden.some(address => same(address, recipient)));
  if (blocked) throw new Error("The destination is a recovery guardian of this account. Choose a wallet that is not a guardian");
}
// Static payload rules, checked when reviewing and again before sending.
export function assertActionShape(action: PreparedAction) {
  const operation = operationOf(action);
  if (operation !== 0 && operation !== 1) throw new Error("Unsupported Safe operation");
  if (operation === 1) {
    if (action.kind !== "safe" || !action.batch) throw new Error("DELEGATECALL is only used for a reviewed Safe batch");
    assertBatchPayload(action.chainId, action.account, action.call, action.batch.calls);
  }
}
export function receiptExpectation(action: PreparedAction, hash?: Hex): ReceiptExpectation {
  const tokens = (action.receives ?? []).filter((r): r is Receive & { token: Address } => !!r.token);
  const native = (action.receives ?? []).filter(r => !r.token);
  return {
    ...(action.kind === "safe" ? { safe: action.account, safeHash: hash } : {}),
    ...(operationOf(action) === 1 ? { operation: 1 as const, multisend: action.call.to, calls: action.batch!.calls.length } : {}),
    ...(action.receive?.token ? { receive: { token: action.receive.token, recipient: action.receive.recipient, minimum: action.receive.minimum.toString() } } : {}),
    ...(tokens.length ? { receives: tokens.map(r => ({ token: r.token, recipient: r.recipient, minimum: r.minimum.toString() })) } : {}),
    ...(native.length && action.kind === "safe" ? { native: native.map(r => ({ recipient: r.recipient, minimum: r.minimum.toString() })) } : {}),
    ...(action.nfts?.length ? { nfts: action.nfts.map(nft => ({ ...nft, tokenId: nft.tokenId.toString() })) } : {}),
    ...(action.queued?.length ? { queued: action.queued } : {}),
  };
}
// Aggregate so two children paying the same asset to one recipient are summed.
function balanceEffects(action: PreparedAction) {
  const map = new Map<string, Receive>();
  for (const effect of actionReceives(action)) {
    const key = `${effect.token?.toLowerCase() ?? "native"}:${effect.recipient.toLowerCase()}`;
    const entry = map.get(key);
    map.set(key, entry ? { ...entry, minimum: entry.minimum + effect.minimum } : effect);
  }
  return [...map.values()];
}
export type SendHooks = { onSubmitted: (hash: Hex, expectation?: ReceiptExpectation) => void; onSigning?: (stage: "wallet" | "network" | "validation" | "simulation" | "signature" | "transaction") => void };
export async function sendAction(
  client: PublicClient, provider: EIP1193Provider, action: PreparedAction,
  hooks: SendHooks["onSubmitted"] | SendHooks,
) {
  const { onSubmitted, onSigning } = typeof hooks === "function" ? { onSubmitted: hooks, onSigning: undefined } : hooks;
  assertActionShape(action);
  assertAllowedRecipients(action, action.forbiddenRecipients ?? []);
  const { wallet, sender } = await connectedWallet(provider, action.chainId, onSigning);
  const assertSigner = async () => {
    if (await wallet.getChainId() !== action.chainId || !same((await wallet.getAddresses())[0] ?? "", sender)) throw new Error("Wallet account or network changed");
  };
  onSigning?.("validation");
  if (action.expectedSender && !same(sender, action.expectedSender)) throw new Error("Connected wallet does not control the selected account");
  await assertFresh(client, action);
  await action.revalidate?.();
  if (operationOf(action) === 1) await verifyMultiSendRuntime(client, action.chainId, action.call.to);
  let call = action.call;
  if (action.approval) {
    const { module, owner, nonce } = action.approval;
    const state = await inspectRecovery(client, action.account, module);
    if (state.guardians.some(g => same(g, owner))) throw new Error("The new owner cannot be a recovery guardian of this account");
    if (!state.guardians.some(g => same(g, sender))) throw new Error("Connected wallet is not a recovery guardian");
    await assertSigner();
    onSigning?.("signature");
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
    assertSupportedSafe(snapshot);
    if (snapshot.nonce !== action.safeNonce) throw new Error("Safe nonce changed. Inspect and review again");
    // Fresh guardians of this exact Safe, even when they are not connected.
    assertAllowedRecipients(action, snapshot.recoveries.flatMap(r => r.guardians));
    const owner = snapshot.owners.some(o => same(o, sender));
    // Threshold 1 and the connected wallet is a current owner: it sends the
    // execTransaction itself, so the pre-validated msg.sender signature
    // suffices and the wallet shows only the transaction. Multi-owner Safes keep
    // the explicit typed-data signature plus on-chain approvals of the others.
    const executor = owner && snapshot.threshold === 1n;
    let signature: Hex | undefined;
    if (owner && !executor) {
      await assertSigner();
      onSigning?.("signature");
      signature = await wallet.signTypedData({
        account: sender, domain: { chainId: action.chainId, verifyingContract: action.account },
        primaryType: "SafeTx", types: safeTypes,
        message: { ...action.call, operation: operationOf(action), safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: action.safeNonce! },
      });
    }
    call = await safeExecution(client, action, sender, signature, executor);
  }
  // A direct eth_call of a multisend outside the Safe's delegatecall context
  // would simulate the wrong thing; batches are simulated as the whole Safe execution.
  onSigning?.("simulation");
  if (action.kind === "safe" && operationOf(action) === 0) await client.call({ account: action.account, ...action.call });
  await client.call({ account: sender, ...call });
  const gas = await client.estimateGas({ account: sender, ...call });
  const effects = balanceEffects(action);
  const before = await Promise.all(effects.map(effect => receivedBalance(client, effect)));
  await assertFresh(client, action);
  await action.revalidate?.();
  const expectation = receiptExpectation(action, action.kind === "safe" ? await safeHash(client, action) : undefined);
  await assertSigner();
  onSigning?.("transaction");
  const hash = await wallet.sendTransaction({ account: sender, chain: null, ...call, gas: gas * 120n / 100n });
  onSubmitted(hash, expectation); // Persist before waiting: a timeout must not trigger a retry.
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180_000 });
  verifyReceipt(receipt, expectation);
  for (const [i, effect] of effects.entries()) {
    let delta = await receivedBalance(client, effect) - before[i];
    if (!effect.token && same(effect.recipient, sender)) delta += receipt.gasUsed * receipt.effectiveGasPrice;
    if (delta < effect.minimum) throw new Error("Transaction confirmed, but expected funds were not received. Inspect before retrying");
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
async function receivedBalance(client: PublicClient, effect: Receive) {
  return effect.token ? client.readContract({ address: effect.token, abi: erc20Abi,
    functionName: "balanceOf", args: [effect.recipient] }) : client.getBalance({ address: effect.recipient });
}
export async function approveSafeProposal(client: PublicClient, provider: EIP1193Provider, action: PreparedAction, onSubmitted: (hash: Hex, expectation?: ReceiptExpectation) => void) {
  assertActionShape(action);
  const { sender } = await connectedWallet(provider, action.chainId);
  if (action.expectedSender && !same(sender, action.expectedSender)) throw new Error("Wallet account or network changed");
  const snapshot = await inspectAccount(client, action.account, action.chainId);
  if (!snapshot.owners.some(o => same(o, sender)) || snapshot.nonce !== action.safeNonce) throw new Error("Invalid owner or stale proposal");
  assertAllowedRecipients(action, [...action.forbiddenRecipients ?? [], ...snapshot.recoveries.flatMap(r => r.guardians)]);
  if (operationOf(action) === 1) await verifyMultiSendRuntime(client, action.chainId, action.call.to);
  const hash = await safeHash(client, action);
  return sendAction(client, provider, { kind: "direct", chainId: action.chainId, account: action.account,
    expectedSender: sender, label: "Approve Safe proposal", call: { to: action.account, value: 0n,
      data: encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }) } }, onSubmitted);
}
