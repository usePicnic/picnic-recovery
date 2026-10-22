import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { DiagnosisPanel } from "../src/components/DiagnosisPanel";
import { emptyDiagnosis } from "../src/core/diagnosis";
import type { AccountSnapshot } from "../src/core/types";
import { diagnosisNext, needsAttention } from "../src/components/diagnosisFlow";
import { LinkedAccounts } from "../src/components/LinkedAccounts";
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
    setRpc: () => {}, rescan: () => {}, retryPending: () => {}, open: () => {},
    addCustom: async () => undefined, removeCustom: () => {}, retryCustom: () => {},
  }));
  expect(html).not.toContain("Gás da carteira");
  expect(html).not.toContain("Adicionar saldo para taxas");
  expect(html).not.toContain("Nenhum saldo encontrado");
  expect(html.match(/<tr>/g)).toHaveLength(2); // header + one custom holding
  expect(html).not.toContain("token-mark");
  expect(html).not.toContain(">Retirar<");
  expect(html).toContain("Próximo passo");
  expect(html).toContain("Carteira que assina");
  expect(html).not.toContain("Endereço a consultar");
  expect(html).not.toContain("Voltar para a carteira conectada");
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

it("labels the signer, identified Picnic Safe and verified v5 card in one account component", () => {
  const card = "0x3333333333333333333333333333333333333333" as Address;
  const linked = { ...emptyDiagnosis(100, card), cards: [{address:token,card,controllers:[account],delayVersion:"v5" as const,head:0n,tail:0n,cooldown:60n,expiration:0n}] };
  const result = {...emptyDiagnosis(100,account),linkedCards:[linked]};
  const props = {account,wallet:token,picnicAccount:account,results:[result],busy:false,lang:"pt" as const};
  const html = renderToStaticMarkup(createElement(LinkedAccounts,props));
  expect(html).toContain("Carteira que assina"); expect(html).toContain("Picnic Safe"); expect(html).toContain("Safe do cartão");
  expect(html.match(/class="linked-accounts"/g)).toHaveLength(1); expect(html).toContain(card);
  const unrelated = {...result,linkedCards:[{...linked,cards:[{...linked.cards[0],controllers:[token]}]}]};
  expect(renderToStaticMarkup(createElement(LinkedAccounts,{...props,results:[unrelated]}))).not.toContain('data-account-kind="card-safe"');
  expect(renderToStaticMarkup(createElement(LinkedAccounts,{...props,picnicAccount:undefined}))).not.toContain('data-account-kind="picnic-safe"');
});

it("keeps the overview and next action before a large collapsed inventory", () => {
  const result = { ...emptyDiagnosis(137, account), status: "complete" as const, snapshot: { ...snapshot, chainId: 137 }, nativeBalance: 1n,
    basketCount: 149n, basketIds: Array.from({ length: 149 }, (_, i) => BigInt(i)) };
  const html = renderToStaticMarkup(createElement(DiagnosisPanel, {
    account, wallet: account, lang: "pt", busy: false, results: [result], overrides: {}, custom: [],
    setRpc: () => {}, rescan: () => {}, retryPending: () => {}, open: () => {}, addCustom: async () => undefined, removeCustom: () => {}, retryCustom: () => {},
  }));
  expect(html).toContain('aria-label="Resumo do diagnóstico"');
  expect(html).toContain("Tudo verificado.");
  expect(html).toContain('<dd>150<small>em 1 rede(s)</small>');
  expect(html).toContain('<details class="diagnosis-details">');
  expect(html.indexOf('class="diagnosis-continue"')).toBeLessThan(html.indexOf('class="diagnosis-details"'));
  expect(html).toContain('<details class="account-overview-details">');
  expect(html).toContain(account); // full address is still available in expanded details
  expect(html).not.toContain('class="next-step" aria-busy="false" disabled');
});

it("keeps loading and incomplete reads visible in the overview while details are collapsed", () => {
  const results = [
    { ...emptyDiagnosis(100, account), status: "partial" as const, snapshot, totalTokens: 100, checkedTokens: 100, failedTokens: 2 },
    { ...emptyDiagnosis(137, account), status: "scanning" as const, totalTokens: 200, checkedTokens: 50 },
  ];
  const html = renderToStaticMarkup(createElement(DiagnosisPanel, {
    account, wallet: account, lang: "pt", busy: false, results, overrides: {}, custom: [],
    setRpc: () => {}, rescan: () => {}, retryPending: () => {}, open: () => {}, addCustom: async () => undefined, removeCustom: () => {}, retryCustom: () => {},
  }));
  const overview = html.slice(0, html.indexOf('class="diagnosis-details"'));
  expect(overview).toContain('Consulta incompleta');
  expect(overview).not.toContain("Tudo verificado.");
  expect(overview).toContain('Saldos não verificados são desconhecidos, não zero');
  expect(overview).toContain('value="150" max="300"');
  expect(overview).toContain('aria-busy="true" disabled=""');
  expect(overview).toContain('Aguarde a verificação');
});
