import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { DiagnosisPanel } from "../src/components/DiagnosisPanel";
import { emptyDiagnosis } from "../src/core/diagnosis";
import type { AccountSnapshot } from "../src/core/types";

vi.mock("../src/components/WalletProvider", () => ({ WalletButton: () => null }));
vi.mock("../src/components/ChainLogo", () => ({ ChainLogo: () => null }));
const account = "0x1111111111111111111111111111111111111111" as Address;
const token = "0x2222222222222222222222222222222222222222" as Address;
const snapshot: AccountSnapshot = { address: account, chainId: 100, block: 10n, timestamp: 100n, version: "EOA", owners: [account], threshold: 1n, nonce: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 0n, warnings: [] };

it("guides a custom-token-only owner to fund gas, without duplicating the asset row", () => {
  const result = { ...emptyDiagnosis(100, account), status: "complete" as const, snapshot, nativeBalance: 0n };
  const html = renderToStaticMarkup(createElement(DiagnosisPanel, {
    account, wallet: account, lang: "pt", busy: false, results: [result], gas: { 100: { address: account, balance: 0n } }, overrides: {},
    custom: [{ chainId: 100, address: token, status: "ready", token: {
      chainId: 100, address: token, name: "TEST", symbol: "TEST", balance: 1_000_000n, verifiedDecimals: 6, account, block: 10n, custom: true,
    } }],
    setAccount: () => {}, onUseWallet: () => {}, setRpc: () => {}, rescan: () => {}, open: () => {},
    addCustom: async () => undefined, removeCustom: () => {}, retryCustom: () => {},
  }));
  expect(html).toContain("precisa de XDAI para taxas");
  expect(html).not.toContain("Nenhum saldo encontrado");
  expect(html.match(/<tr>/g)).toHaveLength(2); // header + one custom holding
});
