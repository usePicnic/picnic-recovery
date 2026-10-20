import { keccak256, toBytes, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import singletons from "../catalog/safe-singletons.json";
import { safeAbi, recoveryAbi } from "./abi";
import { address, assertChain, same, SENTINEL } from "./client";
import type { AccountSnapshot, RecoveryState } from "./types";

// Gnosis canonical v0.0.1 runtime, verified against the public deployment.
export const RECOVERY_RUNTIME = "0xd1d497d06956a300c318dd3df28e7cbaf64dc509bf9e8674753c4f69fd50746a";
export const SAFE_SINGLETONS = [
  "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", // SafeL2 1.4.1
  "0x41675C099F32341bf84BFc5382aF534df5C7461a", // Safe 1.4.1
  "0x3E5c63644E683549055b9Be8653de26E0B4CD36E", // SafeL2 1.3.0
  "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552", // Safe 1.3.0
];
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const MODULE_GUARD_SLOT = keccak256(toBytes("module_manager.module_guard.address"));
export function recoveryPeriod(code?: Hex): bigint | undefined {
  if (!code || code.length !== 27214) return;
  const offset = 2 + 0x2bac * 2;
  const normalized = `${code.slice(0, offset)}${(604800n).toString(16).padStart(64, "0")}${code.slice(offset + 64)}` as Hex;
  if (keccak256(normalized) !== RECOVERY_RUNTIME) return;
  const period = BigInt(`0x${code.slice(offset, offset + 64)}`);
  return period > 0n ? period : undefined;
}
export async function listModules(client: PublicClient, target: Address, blockNumber?: bigint) {
  const modules: Address[] = [];
  let cursor: Address = SENTINEL;
  const visited = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const [items, next] = await client.readContract({
      address: target, abi: safeAbi, functionName: "getModulesPaginated",
      args: [cursor, 50n], blockNumber,
    });
    for (const item of items) {
      if (visited.has(item.toLowerCase())) throw new Error("Invalid module pagination");
      visited.add(item.toLowerCase());
      modules.push(item);
    }
    if (same(next, SENTINEL)) return modules;
    if (!items.length || same(next, cursor)) throw new Error("Incomplete module pagination");
    cursor = next;
  }
  throw new Error("Module pagination limit exceeded");
}
export async function inspectRecovery(client: PublicClient, safe: Address, module: Address, blockNumber?: bigint): Promise<RecoveryState> {
  const [code, guardians, threshold, nonce, pending] = await Promise.all([
    client.getCode({ address: module, blockNumber }),
    client.readContract({ address: module, abi: recoveryAbi, functionName: "getGuardians", args: [safe], blockNumber }),
    client.readContract({ address: module, abi: recoveryAbi, functionName: "threshold", args: [safe], blockNumber }),
    client.readContract({ address: module, abi: recoveryAbi, functionName: "nonce", args: [safe], blockNumber }),
    client.readContract({ address: module, abi: recoveryAbi, functionName: "getRecoveryRequest", args: [safe], blockNumber }),
  ]);
  const runtimeHash = keccak256(code ?? "0x");
  const period = recoveryPeriod(code);
  return { module, runtimeHash, supported: period !== undefined, period, guardians, threshold, nonce, pending };
}
export async function inspectAccount(client: PublicClient, raw: string, chainId: number): Promise<AccountSnapshot> {
  await assertChain(client, chainId);
  const account = address(raw);
  const block = await client.getBlock();
  const blockNumber = block.number;
  const code = await client.getCode({ address: account, blockNumber });
  if (!code || code === "0x") return {
    address: account, chainId, block: blockNumber, timestamp: block.timestamp, version: "EOA", owners: [account], threshold: 1n,
    nonce: BigInt(await client.getTransactionCount({ address: account, blockNumber })), modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [],
    nativeBalance: await client.getBalance({ address: account, blockNumber }),
    warnings: ["No deployed contract: only a wallet controlling this exact address can send. A counterfactual Safe cannot be recovered as an EOA."],
  };
  const [version, owners, threshold, nonce, modules, guardRaw, moduleGuardRaw, nativeBalance, singleton] = await Promise.all([
    client.readContract({ address: account, abi: safeAbi, functionName: "VERSION", blockNumber }),
    client.readContract({ address: account, abi: safeAbi, functionName: "getOwners", blockNumber }),
    client.readContract({ address: account, abi: safeAbi, functionName: "getThreshold", blockNumber }),
    client.readContract({ address: account, abi: safeAbi, functionName: "nonce", blockNumber }),
    listModules(client, account, blockNumber),
    client.getStorageAt({ address: account, slot: GUARD_SLOT, blockNumber }),
    client.getStorageAt({ address: account, slot: MODULE_GUARD_SLOT, blockNumber }),
    client.getBalance({ address: account, blockNumber }),
    client.getStorageAt({ address: account, slot: "0x0", blockNumber }),
  ]);
  const warnings: string[] = [];
  const master = slotAddress(singleton);
  const deployment = singletons.find(s => same(s.address, master));
  if (!deployment) warnings.push("Unrecognized Safe singleton: transactions disabled");
  else {
    const runtime = await client.getCode({ address: master, blockNumber });
    if (!runtime || keccak256(runtime) !== deployment.codeHash || version !== deployment.version) warnings.push("Safe singleton bytecode/version mismatch: transactions disabled");
  }
  if (!["1.3.0", "1.4.1"].includes(version)) warnings.push("Unverified Safe version: transactions disabled");
  if (!owners.length || threshold < 1n || threshold > BigInt(owners.length)) throw new Error("Invalid Safe ownership");
  const guard = slotAddress(guardRaw);
  const moduleGuard = slotAddress(moduleGuardRaw);
  if (guard !== zeroAddress) warnings.push(`Guard installed: ${guard}`);
  if (moduleGuard !== zeroAddress) warnings.push(`Module guard installed: ${moduleGuard}`);
  const recoveries: RecoveryState[] = [];
  for (const module of modules) {
    // Only known runtime is interpreted as a supported recovery module.
    const moduleCode = await client.getCode({ address: module, blockNumber });
    if (recoveryPeriod(moduleCode) !== undefined) {
      recoveries.push(await inspectRecovery(client, account, module, blockNumber));
    }
  }
  return { address: account, chainId, block: blockNumber, timestamp: block.timestamp,
    version, owners, threshold, nonce, modules, guard, moduleGuard, recoveries, nativeBalance, warnings };
}
function slotAddress(value?: Hex): Address {
  return value ? `0x${value.slice(-40)}` as Address : zeroAddress;
}
export function assertSupportedSafe(snapshot: AccountSnapshot) {
  if (snapshot.version === "EOA") throw new Error("This route requires a deployed Safe");
  if (snapshot.warnings.some(w => w.includes("transactions disabled"))) throw new Error(snapshot.warnings.join("; "));
}
