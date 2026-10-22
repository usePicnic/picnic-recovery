import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { RecoveryPreparation } from "../src/components/RecoveryPreparation";
import { recoveryPermissions } from "../src/core/recoveryPreparation";
import { emptyDiagnosis } from "../src/core/diagnosis";
import type { AccountSnapshot, RecoveryState } from "../src/core/types";
vi.mock("../src/components/ChainLogo", () => ({ ChainLogo: () => null }));
const safe = "0x1111111111111111111111111111111111111111" as Address;
const guardian = "0x2222222222222222222222222222222222222222" as Address;
const owner = "0x3333333333333333333333333333333333333333" as Address;
const next = "0x4444444444444444444444444444444444444444" as Address;
const module = "0x5555555555555555555555555555555555555555" as Address;
const recovery: RecoveryState = { module, runtimeHash: "0x", supported: true, guardians: [guardian], threshold: 2n, nonce: 0n, period: 600n,
  pending: { executeAfter: 0n, newOwners: [], newThreshold: 0n, guardiansApprovalCount: 0n } };
const snapshot: AccountSnapshot = { address: safe, chainId: 100, block: 1n, timestamp: 100n, version: "1.4.1", owners: [owner], threshold: 1n, nonce: 0n, modules: [module], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [recovery], nativeBalance: 0n, warnings: [], passkey: "detected" };
const data = { snapshot, gas: 1n, approvals: { [module]: { count: 1n, approved: false } } };
describe("recovery preparation permissions", () => {
  it("requires a funded guardian and verified, valid new owner before approval", () => {
    expect(recoveryPermissions(data, recovery, guardian, next).approve).toBe(true);
    for (const target of ["", "invalid", safe, guardian]) expect(recoveryPermissions(data, recovery, guardian, target).approve).toBe(false);
    expect(recoveryPermissions(data, recovery, owner, next).approve).toBe(false);
    expect(recoveryPermissions({ ...data, gas: 0n }, recovery, guardian, next).approve).toBe(false);
    expect(recoveryPermissions({ ...data, approvals: {} }, recovery, guardian, next).approve).toBe(false);
    expect(recoveryPermissions(data, { ...recovery, supported: false }, guardian, next).approve).toBe(false);
  });
  it("does not repeat approval and waits for the onchain threshold before starting", () => {
    expect(recoveryPermissions(data, recovery, guardian, next).start).toBe(false);
    const approved = { ...data, approvals: { [module]: { count: 2n, approved: true } } };
    const permissions = recoveryPermissions(approved, recovery, guardian, next);
    expect(permissions.approve).toBe(false); expect(permissions.start).toBe(true);
  });
  it("finalizes only after fresh chain time reaches the delay; cancellation requires owner", () => {
    const pending = { ...recovery, pending: { executeAfter: 200n, newOwners: [next], newThreshold: 1n, guardiansApprovalCount: 2n } };
    expect(recoveryPermissions(data, pending, guardian, next).finalize).toBe(false);
    const ready = { ...data, snapshot: { ...snapshot, timestamp: 200n } };
    expect(recoveryPermissions(ready, pending, guardian, next).finalize).toBe(true);
    expect(recoveryPermissions(ready, pending, guardian, next).cancel).toBe(false);
    expect(recoveryPermissions(ready, pending, owner, next).cancel).toBe(true);
    expect(recoveryPermissions(ready, pending, guardian, next).approve).toBe(false);
    expect(recoveryPermissions(ready, { ...pending, pending: { ...pending.pending, newThreshold: 2n } }, guardian, next).finalize).toBe(false);
  });
  it("appears only for passkey or pending recovery and lists every relevant network", () => {
    const props = { account: safe, wallet: guardian, owner: "", setOwner: vi.fn(), overrides: {}, busy: false, blocked: false, lang: "pt" as const, connect: vi.fn(), run: vi.fn(), perform: vi.fn(), onSnapshot: vi.fn() };
    const result = { ...emptyDiagnosis(100, safe), status: "complete" as const, snapshot };
    expect(renderToStaticMarkup(createElement(RecoveryPreparation, { ...props, results: [{ ...result, snapshot: { ...snapshot, passkey: "not-detected" } }] }))).toBe("");
    const html = renderToStaticMarkup(createElement(RecoveryPreparation, { ...props, results: [result, { ...result, chainId: 137, snapshot: { ...snapshot, chainId: 137 } }] }));
    expect(html).toContain("Recuperar acesso"); expect(html).toContain("Recuperação em Gnosis"); expect(html).toContain("Recuperação em Polygon");
  });
});

it("keeps the new-owner field available when only another module has a pending recovery", () => {
  const pending = { ...recovery, module: next, pending: { executeAfter: 200n, newOwners: [next], newThreshold: 1n, guardiansApprovalCount: 1n } };
  const html = renderToStaticMarkup(createElement(RecoveryPreparation, { account: safe, wallet: guardian, owner: "", setOwner: vi.fn(), overrides: {}, busy: false, blocked: false, lang: "pt", connect: vi.fn(), run: vi.fn(), perform: vi.fn(), onSnapshot: vi.fn(),
    results: [{ ...emptyDiagnosis(100, safe), status: "complete", snapshot: { ...snapshot, recoveries: [recovery, pending] } }] }));
  expect(html).toContain('id="recovery-new-owner"');
  expect(html).toContain('required=""');
});
