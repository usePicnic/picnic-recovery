import type { Address, PublicClient } from "viem";
import { recoveryAbi } from "./abi";
import { address, assertChain, same } from "./client";
import { newOwnerError } from "./destination";
import { inspectAccount, assertSupportedSafe } from "./inspect";
import type { AccountSnapshot, RecoveryState } from "./types";

export type RecoveryPreparation = {
  snapshot: AccountSnapshot; gas: bigint;
  approvals: Record<string, { count: bigint; approved: boolean }>;
};
export async function readRecoveryPreparation(client: PublicClient, account: Address, chainId: number, wallet: Address, owner: string): Promise<RecoveryPreparation> {
  await assertChain(client, chainId);
  const snapshot = await inspectAccount(client, account, chainId);
  assertSupportedSafe(snapshot);
  const gas = await client.getBalance({ address: wallet, blockNumber: snapshot.block });
  const approvals: RecoveryPreparation["approvals"] = {};
  if (owner.trim() && !newOwnerError(owner, snapshot)) await Promise.all(snapshot.recoveries.filter(r => r.supported && r.threshold > 0n && !r.pending.executeAfter).map(async r => {
    const args = [account, [address(owner)], 1n] as const;
    const [count, approved] = await Promise.all([
      client.readContract({ address: r.module, abi: recoveryAbi, functionName: "getRecoveryApprovals", args, blockNumber: snapshot.block }),
      client.readContract({ address: r.module, abi: recoveryAbi, functionName: "hasGuardianApproved", args: [account, wallet, [address(owner)], 1n], blockNumber: snapshot.block }),
    ]);
    approvals[r.module.toLowerCase()] = { count, approved };
  }));
  return { snapshot, gas, approvals };
}
export function recoveryPermissions(data: RecoveryPreparation, recovery: RecoveryState, wallet: Address | undefined, proposedOwner: string) {
  const owner = !!wallet && data.snapshot.owners.some(a => same(a, wallet));
  const guardian = !!wallet && recovery.guardians.some(a => same(a, wallet));
  const validOwner = !!proposedOwner.trim() && !newOwnerError(proposedOwner, data.snapshot);
  const approvals = data.approvals[recovery.module.toLowerCase()];
  const pending = recovery.pending.executeAfter > 0n;
  const compatible = recovery.supported && recovery.threshold > 0n;
  const funded = !!wallet && data.gas > 0n;
  return {
    owner, guardian, validOwner, approvals, pending, funded, compatible,
    approve: compatible && funded && guardian && !pending && validOwner && !!approvals && !approvals.approved,
    start: compatible && funded && !pending && validOwner && !!approvals && approvals.count >= recovery.threshold,
    finalize: compatible && funded && pending && recovery.pending.executeAfter <= data.snapshot.timestamp && recovery.pending.newOwners.length === 1 && recovery.pending.newThreshold === 1n,
    cancel: compatible && funded && owner && pending,
  };
}
