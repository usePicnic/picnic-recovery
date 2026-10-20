import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { DiagnosisPanel } from "../src/components/DiagnosisPanel";
import { emptyDiagnosis } from "../src/core/diagnosis";
import type { AccountSnapshot } from "../src/core/types";
import { diagnosisNext, needsAttention } from "../src/components/diagnosisFlow";
import { RecoveryPanel } from "../src/components/RecoveryPanel";

vi.mock("../src/components/WalletProvider", () => ({ WalletButton: () => null }));
vi.mock("../src/components/ChainLogo", () => ({ ChainLogo: () => null }));
const account = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const snapshot: AccountSnapshot = { address: account, chainId: 100, block: 10n, timestamp: 100n, version: "EOA", owners: [account], threshold: 1n, nonce: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 0n, warnings: [] };

it("keeps custom-token holdings in diagnosis without checking gas or offering withdrawals", () => {
  const result = { ...emptyDiagnosis(100, account), status: "complete" as const, snapshot, nativeBalance: 0n };
  const html = renderToStaticMarkup(createElement(DiagnosisPanel, {
    account, wallet: account, lang: "pt", busy: false, results: [result], overrides: {},
    custom: [{ chainId: 100, address: token, status: "ready", token: {
      chainId: 100, address: token, name: "TEST", symbol: "TEST", balance: 1_000_000n, verifiedDecimals: 6, account, block: 10n, custom: true,
    } }],
    setAccount: () => {}, onUseWallet: () => {}, setRpc: () => {}, rescan: () => {}, open: () => {},
    addCustom: async () => undefined, removeCustom: () => {}, retryCustom: () => {},
  }));
  expect(html).not.toContain("Gás da carteira");
  expect(html).not.toContain("Adicionar saldo para taxas");
  expect(html).not.toContain("Nenhum saldo encontrado");
  expect(html.match(/<tr>/g)).toHaveLength(2); // header + one custom holding
  expect(html).not.toContain("token-mark");
  expect(html).not.toContain(">Retirar<");
  expect(html).toContain("Próximo passo");
});

it("waits for every network and custom-token read before choosing the next step", () => {
  const result = { ...emptyDiagnosis(100, account), status: "complete" as const, snapshot, nativeBalance: 1n };
  expect(diagnosisNext([result, emptyDiagnosis(1, account)], account, [])).toBeUndefined();
  expect(diagnosisNext([result], account, [{ chainId: 100, address: token, status: "loading" }])).toBeUndefined();
  expect(diagnosisNext([result], account, [])?.step).toBe(2);
  expect(diagnosisNext([{ ...result, snapshot: undefined, status: "unavailable" }], account, [])).toBeUndefined();
});

it("keeps incomplete and unknown balances in pending items, without listing healthy empty networks", () => {
  const result = { ...emptyDiagnosis(100, account), status: "complete" as const, snapshot, nativeBalance: 0n };
  expect(needsAttention(result, account)).toBe(false);
  expect(needsAttention({ ...result, status: "partial" }, account)).toBe(true);
  expect(needsAttention({ ...result, unreadableTokens: [{ chainId: 100, address: token, name: "unknown" }] }, account)).toBe(true);
  expect(needsAttention({ ...result, nativeBalance: 1n }, account)).toBe(false);
  expect(needsAttention({ ...result, snapshot: { ...snapshot, version: "1.4.1", passkey: "unknown" } }, account)).toBe(true);
});

it("prioritizes access recovery over an already-controlled network holding assets", () => {
  const owned = { ...emptyDiagnosis(100, account), status: "complete" as const, snapshot, nativeBalance: 1n };
  const other = { ...owned, chainId: 1, snapshot: { ...snapshot, chainId: 1, version: "1.4.1", passkey: "detected" as const, owners: [token] } };
  const next = diagnosisNext([owned, other], account, []);
  expect(next?.step).toBe(1);
  expect(next?.result.chainId).toBe(1);
  expect(diagnosisNext([{ ...other, snapshot: { ...other.snapshot, passkey: "not-detected" } }], account, [])?.step).toBe(2);
});

it("only renders the recovery sub-step for a positively identified passkey account", () => {
  const props = { wallet: account, lang: "pt" as const, busy: false, owner: "", setOwner: () => {}, networkIds: [100], selectNetwork: () => {}, prepare: () => {}, review: () => {} };
  expect(renderToStaticMarkup(createElement(RecoveryPanel, { ...props, snapshot }))).toBe("");
  expect(renderToStaticMarkup(createElement(RecoveryPanel, { ...props, snapshot: { ...snapshot, version: "1.4.1", passkey: "unknown" } }))).toBe("");
  expect(renderToStaticMarkup(createElement(RecoveryPanel, { ...props, snapshot: { ...snapshot, version: "1.4.1", passkey: "detected" } }))).toContain("Recuperar acesso");
});
