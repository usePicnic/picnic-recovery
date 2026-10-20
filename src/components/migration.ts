import type { CardDelay } from "../core/card";
import type { MamoPosition } from "../core/mamo";
import type { Address } from "viem";
import { chains, chainById } from "../catalog/chains";
import { products } from "../catalog/products";
import { same } from "../core/client";
import { hasPosition, nextAction, type NetworkDiagnosis, type TokenHolding } from "../core/diagnosis";
import type { CustomTokenState } from "./useDiagnosis";
import type { BasketContents } from "../core/basket-contents";
import type { BatchSource } from "../core/batch";

// One row model for the diagnosis table, the preparation selection and the
// move-funds table, so what is shown and what is selected always agree.
// IDs are stable across rescans and RPC changes:
//   <chain>:native · <chain>:token:<lowercase address> · <chain>:position:<product id>
//   <chain>:baskets:<NFT> · <chain>:mamo:<strategy> · 100:card:<Safe>:<asset>
// A product share token is always its position ID, even if only the plain token
// balance was readable. A custom token shares the token namespace, so it can
// never duplicate a catalogue token.
export type AssetTab = "transfer" | "invest" | "legacy" | "card";
export type AssetBadge = "native" | "investment" | "request" | "legacy" | "custom" | "card";
export type AssetKind = "native" | "position" | "token" | "baskets" | "mamo" | "custom" | "card";
export type MigrationItem = {
  id: string; kind: AssetKind; chainId: number; symbol: string; name: string; badge?: AssetBadge; tab: AssetTab; order: number;
  amount?: { value: bigint; decimals?: number }; count?: string; pending?: boolean;
  holding?: TokenHolding; custom?: CustomTokenState; card?: CardDelay; basketId?: bigint; strategy?: MamoPosition;
  // On-chain contents of an identified basket wallet (read in the background).
  contents?: BasketContents;
  // Verified holdings and pending requests can be selected for migration.
  selectable: boolean;
};

export const nativeId = (chainId: number) => `${chainId}:native`;
export const positionId = (chainId: number, product: string) => `${chainId}:position:${product}`;
export const basketsId = (chainId: number, nft?: bigint) => `${chainId}:baskets${nft === undefined ? "" : `:${nft}`}`;
export const mamoId = (chainId: number, strategy?: string) => `${chainId}:mamo${strategy ? `:${strategy.toLowerCase()}` : ""}`;
export const cardId = (card: string, asset: string) => `100:card:${card.toLowerCase()}:${asset.toLowerCase()}`;
export function tokenId(chainId: number, token: string) {
  const product = products.find(p => p.chainId === chainId && same(p.address, token));
  return product ? positionId(chainId, product.id) : `${chainId}:token:${token.toLowerCase()}`;
}
// The item a manual transfer form refers to (empty token = native coin).
export const transferId = (chainId: number, token: string) => token.trim() ? tokenId(chainId, token.trim()) : nativeId(chainId);
export const chainOf = (id: string) => Number(id.split(":")[0]);

const order = (chainId: number) => chains.findIndex(c => c.id === chainId) * 10;

export function migrationItems(results: readonly NetworkDiagnosis[], custom: readonly CustomTokenState[], baskets: Readonly<Record<string, BasketContents>> = {}): MigrationItem[] {
  const items = new Map<string, MigrationItem>();
  const add = (item: MigrationItem) => { if (!items.has(item.id)) items.set(item.id, item); };
  for (const result of results) {
    const chain = chainById(result.chainId);
    if ((result.nativeBalance ?? 0n) > 0n) add({ id: nativeId(chain.id), kind: "native", chainId: chain.id, symbol: chain.nativeCurrency.symbol, name: chain.nativeCurrency.name, badge: "native",
      tab: "transfer", amount: { value: result.nativeBalance!, decimals: chain.nativeCurrency.decimals }, order: order(chain.id), selectable: !!result.snapshot });
    // Product shares are shown once, as the investment, not again as a plain token.
    for (const position of result.positions.filter(hasPosition)) {
      const pending = position.balance === 0n;
      add({ id: positionId(chain.id, position.product.id), kind: "position", chainId: chain.id, symbol: position.product.name.split("·").at(-1)!.trim(), name: position.product.name,
        badge: pending ? "request" : "investment", tab: "invest", pending, amount: pending ? undefined : { value: position.balance, decimals: position.decimals },
        order: order(chain.id) + 1, selectable: !!result.snapshot });
    }
    for (const token of result.tokens) {
      const id = tokenId(chain.id, token.address), product = id.includes(":position:");
      add({ id, kind: product ? "position" : "token", chainId: chain.id, symbol: token.symbol ?? token.name, name: token.name, badge: product ? "investment" : undefined, tab: product ? "invest" : "transfer",
        amount: { value: token.balance, decimals: token.verifiedDecimals }, holding: product ? undefined : token, order: order(chain.id) + 2, selectable: !!result.snapshot });
    }
    for (const nft of result.basketIds ?? []) add({ id: basketsId(chain.id, nft), kind: "baskets", chainId: chain.id, symbol: `#${nft}`, name: "Picnic", badge: "legacy", tab: "legacy", basketId: nft,
      count: "1 NFT", contents: baskets[String(nft)] && same(baskets[String(nft)].owner, result.account) ? baskets[String(nft)] : undefined, order: order(chain.id) + 3, selectable: !!result.snapshot });
    const remaining = (result.basketCount ?? 0n) - BigInt(result.basketIds?.length ?? 0);
    if (remaining > 0n) add({ id: basketsId(chain.id), kind: "baskets", chainId: chain.id, symbol: "", name: "", badge: "legacy", tab: "legacy",
      count: remaining.toString(), order: order(chain.id) + 3, selectable: !!result.snapshot });
    for (const strategy of result.strategies ?? []) add({ id: mamoId(chain.id, strategy.address), kind: "mamo", chainId: chain.id, symbol: "MAMO", name: `${strategy.address.slice(0, 6)}…${strategy.address.slice(-4)}`, badge: "investment", tab: "invest", strategy,
      amount: { value: strategy.balance, decimals: strategy.decimals }, order: order(chain.id) + 3, selectable: !!result.snapshot });
    if (!result.strategies && (result.strategyCount ?? 0) > 0) add({ id: mamoId(chain.id), kind: "mamo", chainId: chain.id, symbol: "MAMO", name: "", badge: "investment", tab: "invest",
      count: String(result.strategyCount), order: order(chain.id) + 3, selectable: !!result.snapshot });
    for (const card of result.linkedCards ?? []) {
      const delay = card.cards.find(d => d.delayVersion === "v5" && d.controllers.some(controller => same(controller, result.account)));
      if (!delay) continue;
      const base = { kind: "card" as const, chainId: chain.id, badge: "card" as const, tab: "card" as const, card: delay, order: order(chain.id) + 4, selectable: !!result.snapshot };
      if ((card.nativeBalance ?? 0n) > 0n) add({ ...base, id: cardId(card.account, "native"), symbol: chain.nativeCurrency.symbol, name: chain.nativeCurrency.name, amount: { value: card.nativeBalance!, decimals: chain.nativeCurrency.decimals } });
      for (const token of card.tokens) add({ ...base, id: cardId(card.account, token.address), symbol: token.symbol ?? token.name, name: token.name, holding: token, amount: { value: token.balance, decimals: token.verifiedDecimals } });
      if (delay.tail > delay.head) add({ ...base, id: cardId(card.account, "queue"), symbol: "", name: "", pending: true });
    }
  }
  for (const item of custom) {
    const result = results.find(r => r.chainId === item.chainId);
    const ready = item.status === "ready" && !!item.token && !!result && same(item.token.account, result.account);
    add({ id: tokenId(item.chainId, item.address), kind: "custom", chainId: item.chainId, symbol: item.token?.symbol ?? `${item.address.slice(0, 6)}…${item.address.slice(-4)}`,
      name: item.token?.name ?? item.address, badge: "custom", tab: "transfer", custom: item, holding: ready ? item.token : undefined,
      amount: ready ? { value: item.token!.balance, decimals: item.token!.verifiedDecimals } : undefined, order: order(item.chainId) + 4,
      selectable: ready && item.token!.balance > 0n && !!result?.snapshot });
  }
  return [...items.values()].sort((a, b) => a.order - b.order);
}

// Selection is scoped to one source account. `decided` stores explicit choices.
// Until a network is touched (or the selection is committed by entering Move
// funds), its undecided items default to selected. Afterwards, newly found
// items arrive unselected and flagged as new: nothing is included implicitly,
// and a manually excluded ID stays excluded across rescans.
export type Selection = { account: string; decided: Record<string, boolean>; touched: number[]; committed: boolean };
export const emptySelection = (account: string): Selection => ({ account: account.trim().toLowerCase(), decided: {}, touched: [], committed: false });
export const forAccount = (state: Selection, account: string) => state.account === account.trim().toLowerCase() ? state : emptySelection(account);
const touched = (state: Selection, chainId: number) => state.committed || state.touched.includes(chainId);
export function isSelected(state: Selection, item: MigrationItem) {
  if (!item.selectable) return false;
  return state.decided[item.id] ?? !touched(state, item.chainId);
}
export const isNew = (state: Selection, item: MigrationItem) => item.selectable && state.decided[item.id] === undefined && touched(state, item.chainId);
// Move funds gates on exclusion, not on presence: a network that is being
// rescanned after a transaction keeps its committed choices, while new and
// manually unticked assets stay out.
export function isExcluded(state: Selection, items: readonly MigrationItem[], id: string) {
  const item = items.find(entry => entry.id === id);
  return item?.selectable ? !isSelected(state, item) : state.decided[id] === false;
}
export const selectedIds = (state: Selection, items: readonly MigrationItem[]) => new Set(items.filter(item => isSelected(state, item)).map(item => item.id));

// Freeze the defaults of the affected networks before changing anything, so
// touching one item never flips its undecided neighbours.
function materialize(state: Selection, items: readonly MigrationItem[], chainIds: readonly number[]): Selection {
  const decided = { ...state.decided };
  for (const item of items) if (item.selectable && chainIds.includes(item.chainId) && decided[item.id] === undefined) decided[item.id] = isSelected(state, item);
  return { ...state, decided, touched: [...new Set([...state.touched, ...chainIds])] };
}
export function setSelected(state: Selection, items: readonly MigrationItem[], ids: readonly string[], value: boolean): Selection {
  const targets = items.filter(item => item.selectable && ids.includes(item.id));
  const next = materialize(state, items, [...new Set(targets.map(item => item.chainId))]);
  const decided = { ...next.decided };
  for (const item of targets) decided[item.id] = value;
  return { ...next, decided };
}
export const commitSelection = (state: Selection, items: readonly MigrationItem[]): Selection =>
  ({ ...materialize(state, items, chains.map(c => c.id)), committed: true });

// Native fee balance of the connected sender. Results are tied to the exact
// chain/RPC/sender/source context and request that produced them.
export type GasEntry = { key: string; request: number; status: "loading" | "ready" | "error"; balance?: bigint; block?: bigint };
export type GasState = Record<number, GasEntry>;
export const gasKey = (chainId: number, rpc: string, wallet: string, account: string) => [chainId, rpc, wallet.toLowerCase(), account.trim().toLowerCase()].join("|");
export const gasStarted = (state: GasState, chainId: number, key: string, request: number): GasState => ({ ...state, [chainId]: { key, request, status: "loading" } });
export function gasSettled(state: GasState, chainId: number, key: string, request: number, outcome: { balance: bigint; block: bigint } | "error"): GasState {
  const entry = state[chainId];
  if (!entry || entry.key !== key || entry.request !== request) return state;
  return { ...state, [chainId]: outcome === "error" ? { key, request, status: "error" } : { key, request, status: "ready", ...outcome } };
}
export const gasFor = (state: GasState, chainId: number, key: string) => state[chainId]?.key === key ? state[chainId] : undefined;

export type Readiness = "scanning" | "unavailable" | "unsupported" | "recovery" | "connect" | "owner" | "gas-loading" | "gas-error" | "fund" | "ready";
export function readiness(result: NetworkDiagnosis | undefined, wallet: Address | undefined, gas: GasEntry | undefined): Readiness {
  if (!result || result.status === "queued" || result.status === "scanning") return "scanning";
  if (!result.snapshot) return "unavailable";
  const action = nextAction(result, wallet);
  if (action === "unsupported") return "unsupported";
  if (action === "waiting" || action === "finalize") return "recovery";
  if (action === "connect" || !wallet) return "connect";
  if (!result.snapshot.owners.some(owner => same(owner, wallet))) return "owner";
  if (!gas || gas.status === "loading") return "gas-loading";
  if (gas.status === "error") return "gas-error";
  return gas.balance === 0n ? "fund" : "ready";
}

// The batch planner's input: exactly the selected rows of one network.
export function batchSources(items: readonly MigrationItem[], chainId: number): BatchSource[] {
  return items.filter(item => item.chainId === chainId).map((item): BatchSource => {
    const label = item.kind === "baskets" ? item.basketId !== undefined ? `Basket #${item.basketId}` : "Unidentified baskets" : item.symbol || item.name;
    const product = item.kind === "position" ? products.find(p => positionId(p.chainId, p.id) === item.id) : undefined;
    if (item.kind === "native") return { id: item.id, kind: "native", label };
    if (product) return { id: item.id, kind: "position", label: product.name, product };
    if ((item.kind === "token" || item.kind === "custom") && item.holding) return { id: item.id, kind: "token", label, token: item.holding.address as Address };
    if (item.kind === "mamo" && item.strategy) return { id: item.id, kind: "mamo", label: `MAMO ${item.name}`, strategy: item.strategy.address };
    if (item.kind === "baskets" && item.basketId !== undefined) return { id: item.id, kind: "basket", label, nftId: item.basketId, contents: item.contents };
    if (item.kind === "card" && item.card) {
      if (item.pending) return { id: item.id, kind: "card-queue", label: "Card requests", delay: item.card };
      return { id: item.id, kind: "card", label: `Card ${label}`, delay: item.card, asset: item.id.endsWith(":native") ? "native" : item.holding!.address as Address };
    }
    return { id: item.id, kind: "unidentified", label };
  });
}
