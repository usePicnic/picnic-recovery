import { decodeFunctionData, encodeFunctionData, encodePacked, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { delayAbi, erc20Abi } from "./abi";
import { same } from "./client";
import { assertSupportedSafe, inspectAccount, listModules } from "./inspect";
import { safeAction } from "./actions";
import type { AccountSnapshot, Call, PreparedAction } from "./types";

const DELAY_IMPLEMENTATIONS = [
  "0x22d903fd45f441f51bcad198d14eba8a75ea1ef0",
  "0x4a97e65188a950dd4b0f21f9b5434daee0bbf9f5",
];
export type CardDelay = {
  address: Address; card: Address; controllers: Address[];
  head: bigint; tail: bigint; cooldown: bigint; expiration: bigint;
};
export type QueuedCall = Call & { nonce: bigint; operation: number; createdAt: bigint; hash: Hex };
export function proxyImplementation(code?: Hex): Address | undefined {
  const match = code?.match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i);
  return match ? `0x${match[1]}` as Address : undefined;
}
export function queueStatus(createdAt: bigint, cooldown: bigint, expiration: bigint, now: bigint) {
  if (now < createdAt + cooldown) return "waiting";
  if (expiration !== 0n && now > createdAt + cooldown + expiration) return "expired";
  return "ready";
}
export const queueHash = (call: Call, operation = 0) => keccak256(
  encodePacked(["address", "uint256", "bytes", "uint8"], [call.to, call.value, call.data, operation]),
);
export async function inspectCard(client: PublicClient, card: Address, chainId: number): Promise<CardDelay[]> {
  const snapshot = await inspectAccount(client, card, chainId);
  assertSupportedSafe(snapshot);
  const results: CardDelay[] = [];
  for (const module of snapshot.modules) {
    const code = await client.getCode({ address: module });
    const implementation = proxyImplementation(code);
    if (!implementation || !DELAY_IMPLEMENTATIONS.some(a => same(a, implementation))) continue;
    const [avatar, target, controllers, head, tail, cooldown, expiration] = await Promise.all([
      client.readContract({ address: module, abi: delayAbi, functionName: "avatar" }),
      client.readContract({ address: module, abi: delayAbi, functionName: "target" }),
      listModules(client, module),
      client.readContract({ address: module, abi: delayAbi, functionName: "txNonce" }),
      client.readContract({ address: module, abi: delayAbi, functionName: "queueNonce" }),
      client.readContract({ address: module, abi: delayAbi, functionName: "txCooldown" }),
      client.readContract({ address: module, abi: delayAbi, functionName: "txExpiration" }),
    ]);
    if (!same(avatar, card) || !same(target, card)) throw new Error("Delay does not target the selected card Safe");
    results.push({ address: module, card, controllers, head, tail, cooldown, expiration });
  }
  return results;
}
export function enqueueCard(
  delay: CardDelay, call: Call, chainId: number, controller: Address, controllingSafe?: AccountSnapshot,
): PreparedAction {
  if (!delay.controllers.some(a => same(a, controller))) throw new Error("Account is not an enabled card controller");
  const enqueue: Call = { to: delay.address, value: 0n, data: encodeFunctionData({
    abi: delayAbi, functionName: "execTransactionFromModule", args: [call.to, call.value, call.data, 0],
  }) };
  if (controllingSafe) {
    if (!same(controllingSafe.address, controller) || controllingSafe.chainId !== chainId) throw new Error("Wrong controlling Safe");
    if (controllingSafe.version === "EOA") return { kind: "direct", account: delay.card, chainId, call: enqueue, label: "Queue card withdrawal", expectedSender: controller };
    return safeAction(controllingSafe, enqueue, "Queue card withdrawal");
  }
  return { kind: "direct", account: delay.card, chainId, call: enqueue, label: "Queue card withdrawal", expectedSender: controller };
}
async function firstBlockAt(client: PublicClient, timestamp: bigint, end: bigint) {
  let lo = 0n, hi = end;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await client.getBlock({ blockNumber: mid });
    if (block.timestamp < timestamp) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}
export async function readQueue(client: PublicClient, delay: CardDelay): Promise<QueuedCall[]> {
  if (delay.head === delay.tail) return [];
  if (delay.tail - delay.head > 1000n) throw new Error("Queue exceeds interactive scan limit; narrow the pending range");
  const createdAt = await client.readContract({ address: delay.address, abi: delayAbi, functionName: "getTxCreatedAt", args: [delay.head] });
  const block = await client.getBlock();
  const from = await firstBlockAt(client, createdAt, block.number);
  const calls: QueuedCall[] = [];
  let step = 5000n, start = from;
  while (start <= block.number) {
    const end = start + step - 1n < block.number ? start + step - 1n : block.number;
    try {
      const logs = await client.getContractEvents({ address: delay.address, abi: delayAbi,
        eventName: "TransactionAdded", fromBlock: start, toBlock: end, strict: true });
      for (const log of logs) {
        const { queueNonce, txHash, to, value, data, operation } = log.args;
        if (queueNonce < delay.head || queueNonce >= delay.tail) continue;
        const [storedHash, at] = await Promise.all([
          client.readContract({ address: delay.address, abi: delayAbi, functionName: "getTxHash", args: [queueNonce], blockNumber: block.number }),
          client.readContract({ address: delay.address, abi: delayAbi, functionName: "getTxCreatedAt", args: [queueNonce], blockNumber: block.number }),
        ]);
        const call = { to, value, data };
        if (storedHash !== txHash || queueHash(call, operation) !== txHash) throw new Error("Queue hash mismatch");
        calls.push({ ...call, operation, nonce: queueNonce, hash: txHash, createdAt: at });
      }
      start = end + 1n;
    } catch (error) {
      if (step <= 100n) throw error;
      step /= 2n;
    }
  }
  const unique = [...new Map(calls.map(c => [c.nonce.toString(), c])).values()]
    .sort((a, b) => a.nonce < b.nonce ? -1 : 1);
  if (BigInt(unique.length) !== delay.tail - delay.head) throw new Error("Queue discovery incomplete; try an archive RPC");
  return unique;
}
export function queuedTransfer(queued: QueuedCall): NonNullable<PreparedAction["receive"]> {
  if (queued.operation !== 0) throw new Error("Only ordinary calls can be executed here");
  if (queued.data === "0x" && queued.value > 0n) return { token: null, recipient: queued.to, minimum: queued.value };
  const decoded = decodeFunctionData({ abi: erc20Abi, data: queued.data });
  if (decoded.functionName !== "transfer" || queued.value !== 0n || decoded.args[1] <= 0n) throw new Error("Queue entry is not an asset transfer; use its protocol-specific recovery route");
  return { token: queued.to, recipient: decoded.args[0], minimum: decoded.args[1] };
}
export async function skipExpiredCard(client: PublicClient, delay: CardDelay, chainId: number): Promise<PreparedAction> {
  const check = async () => {
    const current = (await inspectCard(client, delay.card, chainId)).find(d => same(d.address, delay.address));
    if (!current || current.head !== delay.head || current.tail !== delay.tail) throw new Error("Queue changed; inspect again");
    const at = await client.readContract({ address: delay.address, abi: delayAbi, functionName: "getTxCreatedAt", args: [current.head] });
    if (queueStatus(at, current.cooldown, current.expiration, (await client.getBlock()).timestamp) !== "expired") throw new Error("Queue head has not expired");
  };
  await check();
  return { kind: "direct", account: delay.card, chainId, label: "Skip consecutive expired card requests (does not withdraw funds)",
    revalidate: check, call: { to: delay.address, value: 0n, data: encodeFunctionData({ abi: delayAbi, functionName: "skipExpired" }) } };
}
export async function dispatchCard(client: PublicClient, delay: CardDelay, queued: QueuedCall, chainId: number): Promise<PreparedAction> {
  const check = async () => {
  const current = (await inspectCard(client, delay.card, chainId)).find(d => same(d.address, delay.address));
  if (!current || current.head !== queued.nonce) throw new Error("Queue head changed");
  const at = await client.readContract({ address: delay.address, abi: delayAbi, functionName: "getTxCreatedAt", args: [queued.nonce] });
  const hash = await client.readContract({ address: delay.address, abi: delayAbi, functionName: "getTxHash", args: [queued.nonce] });
  if (hash !== queueHash(queued, queued.operation) || at !== queued.createdAt) throw new Error("Queued call changed");
  if (queueStatus(at, current.cooldown, current.expiration, (await client.getBlock()).timestamp) !== "ready") throw new Error("Queued withdrawal is not executable");
  if (queued.operation !== 0) throw new Error("Delegatecall queue entries require a separately verified route");
  };
  await check();
  const receive = queuedTransfer(queued);
  if (same(receive.recipient, delay.card)) throw new Error("Destination must differ from card Safe");
  return { kind: "direct", chainId, account: delay.card, label: "Execute queued card withdrawal", receive, revalidate: check,
    call: { to: delay.address, value: 0n, data: encodeFunctionData({ abi: delayAbi, functionName: "executeNextTx",
      args: [queued.to, queued.value, queued.data, 0] }) } };
}
