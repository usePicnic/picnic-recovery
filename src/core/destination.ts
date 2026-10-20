import type { Address } from "viem";
import { address, same } from "./client";
import type { AccountSnapshot } from "./types";

// Migration UI policy: keep the connected signing wallet separate from the
// receiving wallet, and never send funds to a recovery guardian of the source
// account (a guardian key is a recovery authority, not a destination).
export type DestinationProblem = "missing" | "invalid" | "connected" | "source" | "guardian";
export function destinationError(destination: string, source: string, wallet?: Address, guardians: readonly string[] = []): DestinationProblem | undefined {
  if (!destination.trim()) return "missing";
  try {
    const recipient = address(destination);
    if (guardians.some(guardian => same(guardian, recipient))) return "guardian";
    if (wallet && same(recipient, wallet)) return "connected";
    if (same(recipient, source)) return "source";
  } catch { return "invalid"; }
}

// Every guardian known from snapshots of this exact source account, on any
// network, connected or not. Snapshots of another account are ignored.
export function knownGuardians(snapshots: readonly (AccountSnapshot | undefined)[], source: string): Address[] {
  const found = new Map<string, Address>();
  for (const snapshot of snapshots) {
    if (!snapshot || !same(snapshot.address, source)) continue;
    for (const recovery of snapshot.recoveries) for (const guardian of recovery.guardians) found.set(guardian.toLowerCase(), guardian);
  }
  return [...found.values()];
}

export function assertSeparateRecipient(recipient: string, wallet?: Address, guardians: readonly string[] = []) {
  const normalized = address(recipient);
  if (guardians.some(guardian => same(guardian, normalized))) throw new Error("The destination is a recovery guardian of this account. Choose a wallet that is not a guardian");
  if (wallet && same(normalized, wallet)) throw new Error("Use a destination wallet different from the connected signing wallet");
}

// New owner proposed in a recovery: must differ from the Safe and its guardians.
export function newOwnerError(owner: string, snapshot: AccountSnapshot): "invalid" | "guardian" | "source" | undefined {
  if (!owner.trim()) return;
  try {
    const value = address(owner);
    if (same(value, snapshot.address)) return "source";
    if (snapshot.recoveries.some(r => r.guardians.some(g => same(g, value)))) return "guardian";
  } catch { return "invalid"; }
}
