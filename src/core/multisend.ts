import { encodeFunctionData, decodeFunctionData, encodePacked, keccak256, parseAbi, size, sliceHex, hexToBigInt, hexToNumber, getAddress, concatHex, type Address, type Hex, type PublicClient } from "viem";
import catalogue from "../catalog/multisend.json";
import { same } from "./client";
import type { Call } from "./types";

// Safe MultiSendCallOnly: the only DELEGATECALL target this app ever builds.
// Each child is executed with CALL from the Safe's own context, so a child can
// move only what the Safe could move with an ordinary call. MultiSend (which
// also allows nested DELEGATECALL) is deliberately absent.
export const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);
export type MultiSendDeployment = { version: string; address: Address; codeHash: Hex; chains: number[] };
export const multiSendDeployments = catalogue.deployments as MultiSendDeployment[];
// Bounds keep the review screen and the persisted expectation readable.
export const MAX_BATCH_CALLS = 200;

export function approvedMultiSend(chainId: number, target: string) {
  return multiSendDeployments.find(d => d.chains.includes(chainId) && same(d.address, target));
}
export function multiSendCandidates(chainId: number) {
  return multiSendDeployments.filter(d => d.chains.includes(chainId));
}
// Packed per child: uint8 operation (always 0 = CALL) · address to ·
// uint256 value · uint256 data length · bytes data.
export function packMultiSend(calls: readonly Call[]): Hex {
  if (!calls.length) throw new Error("A batch needs at least one call");
  if (calls.length > MAX_BATCH_CALLS) throw new Error(`A batch can contain at most ${MAX_BATCH_CALLS} calls`);
  return concatHex(calls.map(call => {
    if (call.value < 0n) throw new Error("Invalid call value");
    return encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, getAddress(call.to), call.value, BigInt(size(call.data)), call.data]);
  }));
}
export type UnpackedCall = Call & { operation: number };
export function unpackMultiSend(packed: Hex): UnpackedCall[] {
  const calls: UnpackedCall[] = [];
  const total = size(packed);
  let offset = 0;
  while (offset < total) {
    if (offset + 85 > total) throw new Error("Malformed multisend payload");
    const operation = hexToNumber(sliceHex(packed, offset, offset + 1));
    const to = getAddress(sliceHex(packed, offset + 1, offset + 21));
    const value = hexToBigInt(sliceHex(packed, offset + 21, offset + 53));
    const length = hexToBigInt(sliceHex(packed, offset + 53, offset + 85));
    if (offset + 85 + Number(length) > total) throw new Error("Malformed multisend payload");
    const data = length === 0n ? "0x" : sliceHex(packed, offset + 85, offset + 85 + Number(length));
    calls.push({ operation, to, value, data });
    offset += 85 + Number(length);
  }
  return calls;
}
export function multiSendCall(chainId: number, target: Address, calls: readonly Call[]): Call {
  if (!approvedMultiSend(chainId, target)) throw new Error("Batch target is not an approved MultiSendCallOnly deployment on this network");
  return { to: target, value: 0n, data: encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packMultiSend(calls)] }) };
}
// Reject anything other than the exact children reviewed, all CALL-only, to
// targets other than the Safe itself and the multisend contract.
export function assertBatchPayload(chainId: number, safe: Address, call: Call, expected: readonly Call[]) {
  const deployment = approvedMultiSend(chainId, call.to);
  if (!deployment) throw new Error("DELEGATECALL is only allowed to an approved MultiSendCallOnly deployment");
  if (call.value !== 0n) throw new Error("A batch must not carry value at the Safe level");
  const decoded = decodeFunctionData({ abi: multiSendAbi, data: call.data });
  const children = unpackMultiSend(decoded.args[0]);
  if (children.length !== expected.length || children.length === 0) throw new Error("Batch payload does not match the reviewed calls");
  children.forEach((child, i) => {
    const want = expected[i];
    if (child.operation !== 0) throw new Error("Batch children must use CALL only");
    if (same(child.to, safe) || multiSendDeployments.some(d => same(d.address, child.to))) throw new Error("Batch children cannot call the Safe or a multisend contract");
    if (!same(child.to, want.to) || child.value !== want.value || child.data.toLowerCase() !== want.data.toLowerCase()) throw new Error("Batch payload does not match the reviewed calls");
  });
  return deployment;
}
// Runtime proof at the selected RPC: address in the bundled registry and the
// deployed bytecode hash equal to the registry's codeHash.
export async function verifyMultiSendRuntime(client: PublicClient, chainId: number, target: Address) {
  const deployment = approvedMultiSend(chainId, target);
  if (!deployment) throw new Error("Not an approved MultiSendCallOnly deployment on this network");
  const code = await client.getCode({ address: target });
  if (!code || code === "0x" || keccak256(code) !== deployment.codeHash) throw new Error("MultiSendCallOnly runtime is missing or does not match the Safe registry on this network");
  return deployment;
}
// First verified deployment on this network, preferring the newest version.
// RPC failures propagate: "not deployed" and "not verified" are different states.
export async function findMultiSend(client: PublicClient, chainId: number) {
  for (const deployment of multiSendCandidates(chainId)) {
    const code = await client.getCode({ address: deployment.address });
    if (code && code !== "0x" && keccak256(code) === deployment.codeHash) return deployment;
  }
}
