import type { ReceiptExpectation } from "./receipts";
import type { Address, Hex } from "viem";

export type Call = { to: Address; value: bigint; data: Hex };
export type PendingRecovery = {
  guardiansApprovalCount: bigint;
  newThreshold: bigint;
  executeAfter: bigint;
  newOwners: readonly Address[];
};
export type RecoveryState = {
  module: Address;
  runtimeHash: Hex;
  supported: boolean;
  guardians: readonly Address[];
  threshold: bigint;
  nonce: bigint;
  pending: PendingRecovery;
  period?: bigint;
};
export type AccountSnapshot = {
  address: Address;
  chainId: number;
  block: bigint;
  timestamp: bigint;
  version: string;
  owners: readonly Address[];
  threshold: bigint;
  nonce: bigint;
  modules: Address[];
  guard: Address;
  moduleGuard: Address;
  recoveries: RecoveryState[];
  passkey?: "detected" | "not-detected" | "unknown";
  nativeBalance: bigint;
  warnings: string[];
};
export type Receive = { token: Address | null; recipient: Address; minimum: bigint };
export type PreparedAction = {
  kind: "direct" | "safe";
  chainId: number;
  account: Address;
  call: Call;
  label: string;
  details?: string[];
  safeNonce?: bigint;
  // Safe operation: 0 = CALL (default). 1 = DELEGATECALL, only ever to an
  // approved MultiSendCallOnly with exactly `batch.calls` as CALL children.
  operation?: 0 | 1;
  batch?: { calls: Call[]; labels: string[] };
  recovery?: { module: Address; nonce: bigint; pendingAfter: bigint };
  expectedOwner?: Address;
  expectedSender?: Address;
  approval?: { module: Address; nonce: bigint; owner: Address };
  receive?: Receive;
  // Further effects a batch must prove: every ERC-20/native receipt and every
  // card queue entry. `receive` stays the single-action form.
  receives?: Receive[];
  queued?: { module: Address; txHash: Hex }[];
  // Recipients that must never receive funds (e.g. known recovery guardians).
  // Fresh guardians of the source Safe are added again immediately before sending.
  forbiddenRecipients?: Address[];
  // Includes delayed destinations whose funds are only queued in this action.
  destinations?: Address[];
  revalidate?: () => Promise<void>;
};
export type StoredAccount = { address: Address; chainId: number; label: string };
export type Progress = {
  version: 1;
  accounts: StoredAccount[];
  transactions: { chainId: number; hash: Hex; account: Address; label: string; status: "pending" | "confirmed" | "reverted"; expectation?: ReceiptExpectation }[];
};
