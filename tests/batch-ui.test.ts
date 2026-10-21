import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address } from "viem";
import { PlanView, Leftovers, BatchMigration, batchHasFollowups } from "../src/components/BatchMigration";
import { RecoveryPanel } from "../src/components/RecoveryPanel";
import { BasketContentsView } from "../src/components/BasketContents";
import { DestinationMessage } from "../src/components/DestinationMessage";
import { planBatch, batchPartAction, type BatchFact } from "../src/core/batch";
import type { AccountSnapshot, Receive } from "../src/core/types";
import type { MigrationItem } from "../src/components/migration";

vi.mock("../src/components/ChainLogo", () => ({ ChainLogo: () => null }));
const safe = "0x1111111111111111111111111111111111111111" as Address;
const dest = "0x2222222222222222222222222222222222222222" as Address;
const usdc = "0x3333333333333333333333333333333333333333" as Address;
const owner = "0x9999999999999999999999999999999999999999" as Address;
const guardian = "0x5555555555555555555555555555555555555555" as Address;
const MS141 = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2" as Address;
const snapshot: AccountSnapshot = { address: safe, chainId: 137, block: 10n, timestamp: 100n, version: "1.4.1", owners: [owner], threshold: 1n, nonce: 3n, modules: [], guard: zeroAddress,
  moduleGuard: zeroAddress, recoveries: [{ module: usdc, runtimeHash: "0x", supported: true, guardians: [guardian], threshold: 1n, nonce: 0n, pending: { guardiansApprovalCount: 0n, newThreshold: 0n, executeAfter: 0n, newOwners: [] } }],
  nativeBalance: 0n, warnings: [], passkey: "detected" };
const facts: BatchFact[] = [
  { id: "137:token:usdc", kind: "token", label: "USDC", token: usdc, balance: 125_500_000n },
  { id: "137:native", kind: "native", label: "POL", balance: 5n },
  { id: "137:baskets", kind: "unidentified", label: "Unidentified baskets" },
];
const amount = (r: Receive) => r.token ? `${Number(r.minimum) / 1e6} USDC` : `${r.minimum} POL`;

describe("batch review presentation", () => {
  const plan = planBatch({ snapshot, destination: dest, facts, multisend: MS141 });
  const action = batchPartAction({ snapshot, plan, part: 0, label: "Batch" });
  it("leads with human amounts and future-tense outcomes, with technical details collapsed", () => {
    const html = renderToStaticMarkup(createElement(PlanView, { plan, snapshot, action, wallet: owner, lang: "pt", sent: 0, items: [], openItem: () => {}, amount, safeTxHash: `0x${"ab".repeat(32)}` }));
    expect(html).toContain("125.5 USDC");
    expect(html).toContain("5 POL");
    expect(html).toContain("Vai para o destino");
    expect(html).not.toMatch(/Recebido no destino|Nada fica de fora|tudo acontece/);
    expect(html).toContain("Uma confirmação de transação, sem assinatura separada");
    // DELEGATECALL, nonce, Safe hash and calldata only appear inside the collapsed technical section.
    const [main, technical] = html.split("Detalhes técnicos");
    expect(main).not.toMatch(/DELEGATECALL|Nonce|Hash da Safe|0xabab/);
    expect(technical).toMatch(/DELEGATECALL/);
    expect(technical).toContain("0xabab");
    // Excluded assets stay visible with their next step.
    expect(html).toContain("Fora desta transação");
    expect(html).toContain("Unidentified baskets");
  });
  it("keeps leftovers visible after a confirmed batch instead of declaring the network done", () => {
    const html = renderToStaticMarkup(createElement(Leftovers, { plan, items: [], lang: "en", openItem: () => {} }));
    expect(html).toContain("Still to do on this network");
    expect(html).toContain("Not in this batch: withdraw individually");
  });
  it("keeps a queued card follow-up visible even when every entry was included", () => {
    const queued = { ...plan, parts: [["card"]], entries: [{ ...plan.entries[0], id: "card", label: "Card USDC", outcome: "queued" as const, later: ["Wait for the cooldown"] }] };
    expect(batchHasFollowups(queued)).toBe(true);
    const html = renderToStaticMarkup(createElement(Leftovers, { plan: queued, items: [], lang: "pt", openItem: () => {} }));
    expect(html).toContain("pedido criado");
    expect(html).toContain("depois da espera");
  });
  it("blocks a guardian destination with an explicit inline message in the batch flow", () => {
    const items: MigrationItem[] = [{ id: "137:token:usdc", kind: "token", chainId: 137, symbol: "USDC", name: "USD Coin", tab: "transfer", order: 0, selectable: true, amount: { value: 1n, decimals: 6 } }];
    const html = renderToStaticMarkup(createElement(BatchMigration, { lang: "en", busy: false, run: async () => {}, account: safe, wallet: owner, items, chosen: new Set(["137:token:usdc"]),
      destination: guardian, guardians: [guardian], overrides: {}, uncertain: false, provider: async () => { throw new Error("no"); },
      baskets: { contents: {}, retry: () => {}, prioritize: () => {}, refresh: () => {} }, onSubmitted: () => {}, onConfirmed: () => {}, openItem: () => {}, editSelection: () => {} }));
    expect(html).toContain("recovery guardian of this account");
    expect(html).toMatch(/<button type="button" class="next-step" disabled="">/);
    expect(html).not.toMatch(/everything happens or nothing changes/);
    expect(renderToStaticMarkup(createElement(DestinationMessage, { id: "x", problem: "guardian", lang: "pt" }))).toContain("guardião de recuperação");
  });
});

describe("network selection in Move funds", () => {
  it("keeps unselected networks visible with collapsed counts and no migrate action", () => {
    const items: MigrationItem[] = [100, 137].map(chainId => ({ id: `${chainId}:native`, kind: "native", chainId, symbol: "NATIVE", name: "Native coin", tab: "transfer", order: 0, selectable: true, amount: { value: 1n, decimals: 18 } }));
    const html = renderToStaticMarkup(createElement(BatchMigration, { lang: "en", busy: false, run: async () => {}, account: safe, wallet: owner, items, chosen: new Set(["137:native"]),
      destination: dest, guardians: [], overrides: {}, uncertain: false, provider: async () => { throw new Error("no"); }, select: () => {},
      baskets: { contents: {}, retry: () => {}, prioritize: () => {}, refresh: () => {} }, onSubmitted: () => {}, onConfirmed: () => {}, openItem: () => {}, editSelection: () => {} }));
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/<details class="network-assets">/g)).toHaveLength(2);
    expect(html).toContain("Gnosis"); expect(html).toContain("Polygon");
    expect(html).toContain("0 of 1 assets selected"); expect(html).toContain("1 of 1 assets selected");
    expect(html).not.toContain("Migrate Gnosis →</button>");
    expect(html).toContain("Migrate Polygon →</button>");
  });
});

describe("guardian new-owner input", () => {
  it("shows the guardian error immediately and disables recovery review", () => {
    const html = renderToStaticMarkup(createElement(RecoveryPanel, { snapshot, wallet: owner, lang: "en", busy: false, owner: guardian, setOwner: () => {}, networkIds: [137], selectNetwork: () => {}, prepare: () => {}, review: () => {} }));
    expect(html).toContain("This address is a guardian of this account");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/<button disabled="">Approve in wallet<\/button>/);
  });
});

describe("basket contents view", () => {
  it("shows token symbols, balances and partial state honestly", () => {
    const html = renderToStaticMarkup(createElement(BasketContentsView, { lang: "en", contents: { nftId: 9n, owner: safe, wallet: dest, status: "partial", checked: 10, total: 12, failed: 2, unreadable: 1,
      holdings: [{ key: "k", token: usdc, category: "token", name: "USD Coin", symbol: "USDC", balance: 25_000_000n, decimals: 6, assetIds: [], types: ["token"] },
        { key: "s", category: "position", name: "Autofarm pool", balance: 3n, assetIds: [], types: ["IAutofarmDeposit"] }] }, retry: () => {} }));
    expect(html).toContain("USDC"); expect(html).toContain(">25<");
    expect(html).toContain("Partial read: 2 checks unanswered");
    expect(html).toContain("Positions needing a protocol exit");
    expect(html).toContain("does not mean zero");
    expect(renderToStaticMarkup(createElement(BasketContentsView, { lang: "pt" }))).toContain("na fila de leitura");
  });
});
