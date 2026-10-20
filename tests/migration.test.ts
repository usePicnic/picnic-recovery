import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { getAddress, zeroAddress, type Address } from "viem";
import { products } from "../src/catalog/products";
import { emptyDiagnosis, type NetworkDiagnosis } from "../src/core/diagnosis";
import type { AccountSnapshot } from "../src/core/types";
import type { CustomTokenState } from "../src/components/useDiagnosis";
import {
  commitSelection, emptySelection, forAccount, gasFor, gasKey, gasSettled, gasStarted, isExcluded, isNew, isSelected, migrationItems,
  readiness, selectedIds, setSelected, transferId, type Selection,
} from "../src/components/migration";
import { AssetTable } from "../src/components/AssetTable";
import { PrepareMigration } from "../src/components/PrepareMigration";
import { destinationError, assertSeparateRecipient } from "../src/core/destination";

vi.mock("../src/components/ChainLogo", () => ({ ChainLogo: () => null }));
const account = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x3333333333333333333333333333333333333333" as Address;
const usdc = "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83" as Address;
const custom = "0x2222222222222222222222222222222222222222" as Address;
const sdai = products.find(p => p.id === "sdai")!;
const covered = products.find(p => p.id === "covered-sdai")!;
const snap = (chainId: number, owners: Address[] = [account]): AccountSnapshot => ({ address: account, chainId, block: 10n, timestamp: 100n, version: "1.4.1", owners,
  threshold: 1n, nonce: 0n, modules: [], guard: zeroAddress, moduleGuard: zeroAddress, recoveries: [], nativeBalance: 0n, warnings: [], passkey: "not-detected" });
const gnosis = (patch: Partial<NetworkDiagnosis> = {}): NetworkDiagnosis => ({
  ...emptyDiagnosis(100, account), status: "complete", phase: "done", snapshot: snap(100), nativeBalance: 5n * 10n ** 18n,
  tokens: [
    { chainId: 100, address: usdc, name: "USD Coin", symbol: "USDC", balance: 1_000_000n, verifiedDecimals: 6 },
    // The sDAI product share also appears as a token: listed once, as the investment.
    { chainId: 100, address: sdai.address.toLowerCase(), name: "Savings xDAI", symbol: "sDAI", balance: 7n, verifiedDecimals: 18 },
  ],
  positions: [{ product: sdai, balance: 7n, decimals: 18 }, { product: covered, balance: 0n, decimals: 18, pending: 3n }],
  ...patch,
});
const polygon = (patch: Partial<NetworkDiagnosis> = {}): NetworkDiagnosis => ({ ...emptyDiagnosis(137, account), status: "complete", phase: "done", snapshot: snap(137), nativeBalance: 1n, basketCount: 2n, ...patch });
const base = (): NetworkDiagnosis => ({ ...emptyDiagnosis(8453, account), status: "complete", phase: "done", snapshot: snap(8453), strategyCount: 1 });
const customToken = (status: CustomTokenState["status"], balance = 9n, address: Address = custom): CustomTokenState => ({ chainId: 100, address, status,
  token: status === "ready" ? { chainId: 100, address, name: "Mine", symbol: "MINE", balance, verifiedDecimals: 0, account, block: 10n, custom: true } : undefined,
  error: status === "error" ? "rpc" : undefined });

describe("migration item identity", () => {
  it("gives native, ERC-20, product, basket, MAMO and custom holdings stable deduplicated IDs", () => {
    const ids = migrationItems([gnosis(), polygon(), base()], [customToken("ready")]).map(item => item.id);
    expect(ids).toEqual([
      "100:native", "100:position:sdai", "100:position:covered-sdai", `100:token:${usdc}`, `100:token:${custom}`,
      "137:native", "137:baskets", "8453:mamo",
    ]);
    // Address case and an unreadable position do not change identity.
    const tokenOnly = migrationItems([gnosis({ positions: [], tokens: gnosis().tokens.map(t => ({ ...t, address: getAddress(t.address) })) })], []).map(item => item.id);
    expect(tokenOnly).toEqual(["100:native", `100:token:${usdc}`, "100:position:sdai"]);
    expect(transferId(100, "")).toBe("100:native");
    expect(transferId(100, getAddress(usdc))).toBe(`100:token:${usdc}`);
    expect(transferId(100, sdai.address)).toBe("100:position:sdai");
  });

  it("never lets a custom token duplicate a catalogue holding, and only verified nonzero ones are selectable", () => {
    const duplicate = migrationItems([gnosis()], [customToken("ready", 1n, getAddress(usdc))]);
    expect(duplicate.filter(item => item.id === `100:token:${usdc}`)).toHaveLength(1);
    expect(duplicate.find(item => item.id === `100:token:${usdc}`)?.custom).toBeUndefined();
    for (const state of [customToken("loading"), customToken("error"), customToken("ready", 0n)]) {
      expect(migrationItems([gnosis()], [state]).find(item => item.id === `100:token:${custom}`)?.selectable).toBe(false);
    }
    // A custom token read for another account is not this account's holding.
    const foreign = customToken("ready");
    foreign.token = { ...foreign.token!, account: other };
    expect(migrationItems([gnosis()], [foreign]).find(item => item.id === `100:token:${custom}`)?.selectable).toBe(false);
  });
});

describe("selection reconciliation", () => {
  const items = migrationItems([gnosis(), polygon()], []);
  it("selects everything by default and keeps neighbours when one item is excluded", () => {
    let state = emptySelection(account);
    expect(selectedIds(state, items).size).toBe(items.length);
    state = setSelected(state, items, [`100:token:${usdc}`], false);
    expect([...selectedIds(state, items)]).toEqual(["100:native", "100:position:sdai", "100:position:covered-sdai", "137:native", "137:baskets"]);
    state = setSelected(state, items, items.map(item => item.id), false);
    expect(selectedIds(state, items).size).toBe(0);
  });

  it("does not reselect manual exclusions or silently include new assets after a rescan", () => {
    let state = setSelected(emptySelection(account), items, ["100:native"], false);
    // Rescan: the network is briefly empty, then reappears with a newly found token.
    expect(selectedIds(state, migrationItems([{ ...emptyDiagnosis(100, account), status: "scanning" }, polygon()], [])).has("100:native")).toBe(false);
    const rescanned = migrationItems([gnosis(), polygon()], [customToken("ready")]);
    const found = rescanned.find(item => item.id === `100:token:${custom}`)!;
    expect(isSelected(state, rescanned.find(item => item.id === "100:native")!)).toBe(false);
    expect(isSelected(state, found)).toBe(false);
    expect(isNew(state, found)).toBe(true);
    // An untouched network still follows the default until Move funds commits it.
    const later = migrationItems([gnosis(), polygon({ tokens: [{ chainId: 137, address: other, name: "X", balance: 1n, verifiedDecimals: 0 }] })], []);
    expect(isSelected(state, later.find(item => item.id === `137:token:${other}`)!)).toBe(true);
    state = commitSelection(state, later);
    const afterCommit = migrationItems([gnosis(), polygon({ tokens: [{ chainId: 137, address: usdc, name: "Y", balance: 1n, verifiedDecimals: 0 }] })], []);
    const late = afterCommit.find(item => item.id === `137:token:${usdc}`)!;
    expect(isSelected(state, late)).toBe(false);
    expect(isNew(state, late)).toBe(true);
    expect(selectedIds(state, afterCommit).has("137:baskets")).toBe(true);
  });

  it("keeps Move funds gates stable while a network is rescanned after a transaction", () => {
    const state = commitSelection(setSelected(emptySelection(account), items, ["137:baskets"], false), items);
    const during = migrationItems([gnosis(), { ...emptyDiagnosis(137, account), status: "scanning" }], []);
    expect(isExcluded(state, during, "137:baskets")).toBe(true);
    expect(isExcluded(state, during, "137:native")).toBe(false);
    // Not found by diagnosis (e.g. a zero-balance product read later): not excluded.
    expect(isExcluded(state, during, "100:position:aave-eure")).toBe(false);
    // Found only after commit: excluded until explicitly selected.
    const late = migrationItems([gnosis(), polygon()], [customToken("ready")]);
    expect(isExcluded(state, late, `100:token:${custom}`)).toBe(true);
    expect(isExcluded(setSelected(state, late, [`100:token:${custom}`], true), late, `100:token:${custom}`)).toBe(false);
  });

  it("resets for a different source account only", () => {
    const state: Selection = setSelected(emptySelection(account), items, ["100:native"], false);
    expect(forAccount(state, getAddress(account))).toBe(state);
    expect(forAccount(state, other)).toEqual(emptySelection(other));
    expect(selectedIds(forAccount(state, other), items).size).toBe(items.length);
  });

  it("filters the Move funds table to the selection", () => {
    const results = [gnosis(), polygon()];
    const selected = selectedIds(setSelected(emptySelection(account), migrationItems(results, []), ["100:native", "137:native", "137:baskets", "100:position:covered-sdai"], false), migrationItems(results, []));
    const html = renderToStaticMarkup(createElement(AssetTable, { lang: "en", busy: false, ready: true, results, custom: [], selected, open: () => {},
      addCustom: async () => undefined, removeCustom: () => {}, retryCustom: () => {} }));
    expect(html.match(/<tr>/g)).toHaveLength(3); // header + USDC + sDAI
    expect(html).toContain("USDC");
    expect(html).not.toContain("Baskets");
    expect(html).not.toContain("Add token");
    const none = renderToStaticMarkup(createElement(AssetTable, { lang: "en", busy: false, ready: true, results, custom: [], selected: new Set<string>(), open: () => {},
      addCustom: async () => undefined, removeCustom: () => {}, retryCustom: () => {} }));
    expect(none).toContain("No assets selected");
  });
});

describe("fee checks and readiness", () => {
  it("ignores results from a superseded request or a previous chain/RPC/wallet/account context", () => {
    const key = gasKey(100, "https://a", account, account), changed = gasKey(100, "https://b", account, account);
    let state = gasStarted({}, 100, key, 1);
    state = gasStarted(state, 100, key, 2);
    expect(gasSettled(state, 100, key, 1, { balance: 5n, block: 1n })).toBe(state);
    expect(gasSettled(state, 100, changed, 2, { balance: 5n, block: 1n })).toBe(state);
    state = gasSettled(state, 100, key, 2, { balance: 0n, block: 3n });
    expect(gasFor(state, 100, key)).toMatchObject({ status: "ready", balance: 0n, block: 3n });
    expect(gasFor(state, 100, changed)).toBeUndefined();
    expect(gasFor(state, 100, gasKey(100, "https://a", other, account))).toBeUndefined();
    expect(gasKey(100, "x", getAddress(account), account)).toBe(gasKey(100, "x", account, account.toUpperCase().replace("0X", "0x")));
  });

  it("requires an owner wallet and a verified nonzero fee balance; a positive balance is the only ready state", () => {
    const result = gnosis(), key = "k";
    const ready = { key, request: 1, status: "ready" as const, balance: 1n, block: 1n };
    expect(readiness({ ...result, status: "scanning" }, account, ready)).toBe("scanning");
    expect(readiness(result, undefined, undefined)).toBe("connect");
    expect(readiness(result, other, ready)).toBe("owner");
    expect(readiness(result, account, undefined)).toBe("gas-loading");
    expect(readiness(result, account, { key, request: 1, status: "error" })).toBe("gas-error");
    expect(readiness(result, account, { ...ready, balance: 0n })).toBe("fund");
    expect(readiness(result, account, ready)).toBe("ready");
    expect(readiness({ ...result, status: "partial" }, account, ready)).toBe("ready");
    const pending = { ...snap(100), recoveries: [{ module: other, runtimeHash: "0x" as const, supported: true, guardians: [], threshold: 1n, nonce: 0n, pending: { guardiansApprovalCount: 1n, newThreshold: 1n, executeAfter: 200n, newOwners: [] } }] };
    expect(readiness({ ...result, snapshot: pending }, account, ready)).toBe("recovery");
  });

  it("validates one global destination against the source account", () => {
    expect(destinationError("", account)).toBe("missing");
    expect(destinationError("0x123", account)).toBe("invalid");
    expect(destinationError(getAddress(account), account)).toBe("source");
    expect(destinationError(other, account)).toBeUndefined();
    expect(destinationError(other, account, other)).toBe("connected");
    expect(destinationError(` ${getAddress(usdc)} `, account, usdc)).toBe("connected");
    expect(destinationError(other, account, usdc)).toBeUndefined();
    expect(() => assertSeparateRecipient(` ${getAddress(usdc)} `, usdc)).toThrow(/connected signing wallet/);
    expect(() => assertSeparateRecipient(other, usdc)).not.toThrow();
  });
});

describe("Prepare wallets view", () => {
  const props = (results: NetworkDiagnosis[], selection: Selection, wallet: Address | undefined = account) => ({
    lang: "en" as const, busy: false, account, wallet, results, items: migrationItems(results, []), selection, select: () => {}, overrides: {},
    destination: other, setDestination: () => {}, rescan: () => {}, addCustom: async () => undefined, retryCustom: () => {}, run: async () => {}, next: () => {}, connect: () => {},
  });
  it("shows every network and asset together; unselected networks do not block", () => {
    // The connected wallet does not own the Polygon account; that network is unticked.
    const results = [gnosis(), polygon({ snapshot: snap(137, [other]) })];
    const items = migrationItems(results, []);
    const selection = setSelected(emptySelection(account), items, ["137:native", "137:baskets"], false);
    const html = renderToStaticMarkup(createElement(PrepareMigration, props(results, selection)));
    expect(html).not.toContain("Use my connected wallet as destination");
    expect(html).toContain("destination wallet different from the connected wallet");
    expect(html).toContain("Gnosis");
    expect(html).toContain("Polygon");
    expect(html).toContain("4</strong> of 6 assets selected");
    expect(html).toContain("Not moving now");
    // Fee check for Gnosis starts automatically; continuing waits for it.
    expect(html).toContain("Gnosis: Checking fee balance");
    expect(html).not.toContain("Polygon: The connected wallet does not control");
    expect(html).toMatch(/<button class="next-step" disabled="">/);
  });

  it("discloses incomplete readings instead of treating them as empty", () => {
    const results = [gnosis(), { ...emptyDiagnosis(1, account), status: "unavailable" as const, phase: "done" as const }];
    const html = renderToStaticMarkup(createElement(PrepareMigration, props(results, emptySelection(account))));
    expect(html).toContain("Networks with incomplete readings");
    expect(html).toContain("does not mean a zero balance");
    const none = renderToStaticMarkup(createElement(PrepareMigration, props([gnosis()], setSelected(emptySelection(account), migrationItems([gnosis()], []), migrationItems([gnosis()], []).map(i => i.id), false))));
    expect(none).toContain("Select at least one asset to continue.");
  });
});


describe("one asset list across custody locations", () => {
  const card = "0x4444444444444444444444444444444444444444" as Address;
  const delay = { address: other, card, controllers: [account], head: 0n, tail: 1n, cooldown: 60n, expiration: 0n };
  it("keeps wallet and card token balances separate and routes the card row through its verified Delay", () => {
    const result = gnosis({ linkedCards: [{ ...gnosis({ account: card, nativeBalance: 0n, positions: [], cards: [delay] }), snapshot: { ...snap(100), address: card } }] });
    const items = migrationItems([result], []);
    const walletToken = items.find(i => i.id === `100:token:${usdc}`)!;
    const cardToken = items.find(i => i.id === `100:card:${card}:${usdc}`)!;
    expect(walletToken.tab).toBe("transfer");
    expect(cardToken.tab).toBe("card");
    expect(cardToken.card).toEqual(delay);
    expect(cardToken.holding?.address).toBe(usdc);
    expect(items.find(i => i.id === `100:card:${card}:queue`)?.pending).toBe(true);
    const selection = setSelected(emptySelection(account), items, [cardToken.id], false);
    expect(selectedIds(selection, items).has(walletToken.id)).toBe(true);
    expect(selectedIds(selection, items).has(cardToken.id)).toBe(false);
    expect(migrationItems([gnosis({ linkedCards: [{ ...result.linkedCards![0], cards: [{ ...delay, controllers: [other] }] }] })], []).some(i => i.kind === "card")).toBe(false);
  });
  it("lists known basket NFTs and MAMO positions individually and leaves unidentified baskets explicit", () => {
    const strategies = [{ address: other, owner: account, token: custom, staking: usdc, balance: 23n, decimals: 6 }];
    const items = migrationItems([polygon({ basketCount: 3n, basketIds: [8n, 12n] }), { ...base(), strategies }], []);
    expect(items.filter(i => i.kind === "baskets").map(i => i.id)).toEqual(["137:baskets:8", "137:baskets:12", "137:baskets"]);
    expect(items.find(i => i.id === "137:baskets")?.count).toBe("1");
    expect(items.find(i => i.id === `8453:mamo:${other}`)?.amount).toEqual({ value: 23n, decimals: 6 });
    expect(items.some(i => i.id === "8453:mamo")).toBe(false);
  });
  it("renders tokens, card balances, investments and baskets in the same asset table", () => {
    const results = [gnosis({ linkedCards: [{ ...gnosis({ account: card, nativeBalance: 0n, positions: [], cards: [delay] }), snapshot: { ...snap(100), address: card } }] }), polygon({ basketIds: [8n, 12n] })];
    const html = renderToStaticMarkup(createElement(AssetTable, { lang: "en", busy: false, ready: true, results, custom: [], open: () => {}, openItem: () => {},
      addCustom: async () => undefined, removeCustom: () => {}, retryCustom: () => {} }));
    expect(html).toContain("Card"); expect(html).toContain("Basket #8"); expect(html).toContain("USDC"); expect(html).toContain("sDAI");
    expect(html.match(/<table /g)).toHaveLength(1);
    expect(html).not.toContain("View investment"); expect(html).not.toContain("View baskets");
  });
});
