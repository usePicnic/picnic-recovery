import { beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address, type EIP1193Provider, type PublicClient } from "viem";
import { recoveryAction, sendAction } from "../src/core/actions";
import { inspectAccount, inspectRecovery } from "../src/core/inspect";
import { recoveryPermissions } from "../src/core/recoveryPreparation";
import type { AccountSnapshot, RecoveryState } from "../src/core/types";
vi.mock("../src/core/inspect", async original => ({ ...await original<typeof import("../src/core/inspect")>(), inspectAccount: vi.fn(), inspectRecovery: vi.fn() }));
const safe = "0x1111111111111111111111111111111111111111" as Address;
const guardian = "0x2222222222222222222222222222222222222222" as Address;
const next = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as Address;
const module = "0x4444444444444444444444444444444444444444" as Address;
const otherModule = "0x5555555555555555555555555555555555555555" as Address;
const recovery: RecoveryState = { module, runtimeHash: "0x", supported: true, guardians: [guardian], threshold: 1n, nonce: 0n,
 pending: { executeAfter: 0n, newOwners: [], newThreshold: 0n, guardiansApprovalCount: 0n } };
const snapshot: AccountSnapshot = { address: safe, chainId: 100, block: 1n, timestamp: 200n, version: "1.4.1", owners: [safe], threshold: 1n, nonce: 0n, modules: [module], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [recovery], warnings: [], nativeBalance: 0n, passkey: "detected" };
const withGuardian = (): AccountSnapshot => ({ ...snapshot, recoveries: [recovery, { ...recovery, module: otherModule, guardians: [next.toUpperCase() as Address] }] });
const pending = (target: Address): RecoveryState => ({ ...recovery, pending: { executeAfter: 100n, newOwners: [target], newThreshold: 1n, guardiansApprovalCount: 1n } });
function transport(onSignature?: () => void) {
 const request = vi.fn(async ({ method }: { method: string }) => {
  if (method === "eth_accounts") return [guardian];
  if (method === "eth_chainId") return "0x64";
  if (method === "eth_signTypedData_v4") { onSignature?.(); return `0x${"11".repeat(65)}`; }
  throw new Error(`Unexpected wallet request: ${method}`);
 });
 return { request, provider: { request, on: vi.fn(), removeListener: vi.fn() } as unknown as EIP1193Provider };
}
const client = () => ({ getChainId: vi.fn(async () => 100), call: vi.fn(async () => ({})), estimateGas: vi.fn(async () => 21000n) });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(inspectAccount).mockResolvedValue(snapshot); vi.mocked(inspectRecovery).mockResolvedValue(recovery); });
describe("Candide 0.1.0 guardian recovery exclusion", () => {
 it("rejects guardians from any module for approval and start, regardless of casing", () => {
  for (const mode of ["approve", "start"] as const) expect(() => recoveryAction(withGuardian(), module, mode, next)).toThrow(/guardian/);
 });
 it("blocks finalizing an already-pending recovery to a guardian while retaining cancellation", () => {
  const state = { ...snapshot, recoveries: [pending(guardian)] };
  expect(() => recoveryAction(state, module, "finalize")).toThrow(/guardian/);
  expect(() => recoveryAction(state, module, "cancel")).not.toThrow();
  const permissions = recoveryPermissions({ snapshot: state, gas: 1n, approvals: {} }, state.recoveries[0], guardian, next);
  expect(permissions.finalize).toBe(false);
  expect(recoveryPermissions({ snapshot, gas: 1n, approvals: {} }, pending(next), guardian, next, [next]).finalize).toBe(false);
 });
 it("rechecks fresh guardians before asking for any signature", async () => {
  const action = recoveryAction(snapshot, module, "approve", next), wallet = transport();
  vi.mocked(inspectAccount).mockResolvedValue(withGuardian());
  await expect(sendAction(client() as unknown as PublicClient, wallet.provider, action, () => {})).rejects.toThrow(/guardian/);
  expect(wallet.request.mock.calls.map(c => c[0].method)).not.toContain("eth_signTypedData_v4");
  expect(wallet.request.mock.calls.map(c => c[0].method)).not.toContain("eth_sendTransaction");
 });
 it("refuses to submit an approval if the target becomes a guardian while signing", async () => {
  const action = recoveryAction(snapshot, module, "approve", next);
  const wallet = transport(() => vi.mocked(inspectAccount).mockResolvedValue(withGuardian()));
  await expect(sendAction(client() as unknown as PublicClient, wallet.provider, action, () => {})).rejects.toThrow(/guardian/);
  expect(wallet.request.mock.calls.map(c => c[0].method)).toContain("eth_signTypedData_v4");
  expect(wallet.request.mock.calls.map(c => c[0].method)).not.toContain("eth_sendTransaction");
 });
 it("rechecks again after simulation and before submitting start", async () => {
  const action = recoveryAction(snapshot, module, "start", next), wallet = transport(), reader = client();
  reader.call.mockImplementation(async () => { vi.mocked(inspectAccount).mockResolvedValue(withGuardian()); return {}; });
  await expect(sendAction(reader as unknown as PublicClient, wallet.provider, action, () => {})).rejects.toThrow(/guardian/);
  expect(reader.call).toHaveBeenCalled();
  expect(wallet.request.mock.calls.map(c => c[0].method)).not.toContain("eth_sendTransaction");
 });
 it("blocks a newly added guardian at finalization and known guardians from other networks", async () => {
  const state = { ...snapshot, recoveries: [pending(next)] }, action = recoveryAction(state, module, "finalize"), wallet = transport();
  vi.mocked(inspectAccount).mockResolvedValue({ ...withGuardian(), recoveries: [pending(next), withGuardian().recoveries[1]] });
  await expect(sendAction(client() as unknown as PublicClient, wallet.provider, action, () => {})).rejects.toThrow(/guardian/);
  await expect(sendAction(client() as unknown as PublicClient, wallet.provider, { ...action, forbiddenRecipients: [next] }, () => {})).rejects.toThrow(/guardian/);
  expect(wallet.request.mock.calls.map(c => c[0].method)).not.toContain("eth_sendTransaction");
 });
});
