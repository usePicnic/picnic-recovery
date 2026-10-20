import { useState, type FormEvent, type ReactNode } from "react";
import { formatUnits, type Address } from "viem";
import { chains, chainById } from "../catalog/chains";
import type { NetworkDiagnosis, TokenHolding } from "../core/diagnosis";
import type { CustomTokenState } from "./useDiagnosis";
import { ChainLogo } from "./ChainLogo";
import { NetworkSelect } from "./NetworkSelect";
import { migrationItems, type MigrationItem } from "./migration";
import { formatAmount } from "./format";
import { BasketContentsView } from "./BasketContents";
import type { BasketContentsState } from "./useBasketContents";

type Lang = "pt" | "en";
type Open = (result: NetworkDiagnosis, step: 1 | 2 | 3, tab?: string, token?: TokenHolding) => void;
export type AddResult = Promise<"invalid-address" | "duplicate" | "catalogue" | "cancelled" | "not-contract" | "no-balance" | "rpc" | undefined>;
type Props = {
  lang: Lang; busy: boolean; ready: boolean; results: NetworkDiagnosis[]; custom: CustomTokenState[]; open: Open;
  showActions?: boolean; openItem?: (item: MigrationItem, result: NetworkDiagnosis) => void;
  // Move funds: only the assets selected in Prepare wallets.
  selected?: ReadonlySet<string>;
  baskets?: BasketContentsState;
  addCustom: (chainId: number, token: string) => AddResult; removeCustom: (chainId: number, token: Address) => void; retryCustom: (chainId: number, token: Address) => void;
};

export { formatAmount };
function Amount({ value, decimals, lang }: { value: bigint; decimals?: number; lang: Lang }) {
  return <span title={decimals === undefined ? undefined : formatUnits(value, decimals)}>{formatAmount(value, decimals, lang)}</span>;
}
const customErrors = (lang: Lang) => {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  return {
    "invalid-address": t("Endereço inválido.", "Invalid address."),
    "not-contract": t("Não há contrato neste endereço nesta rede.", "No contract at this address on this network."),
    "no-balance": t("O contrato não respondeu a balanceOf: não parece ser um ERC-20.", "The contract did not answer balanceOf: it does not look like an ERC-20."),
    rpc: t("A rede não respondeu. Saldo não verificado.", "The network did not answer. Balance unverified."),
  };
};
// Shared by the asset tables and the preparation checklist.
export function ItemText({ item, lang, extra }: { item: MigrationItem; lang: Lang; extra?: ReactNode }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const symbol = item.kind === "baskets" ? item.basketId !== undefined ? `${t("Cesta", "Basket")} #${item.basketId}` : t("Cestas a identificar", "Baskets to identify") : item.kind === "card" && item.pending ? t("Retirada do cartão", "Card withdrawal") : item.symbol;
  const name = item.kind === "baskets" ? t("Cestas antigas da Picnic", "Legacy Picnic baskets") : item.kind === "mamo" ? item.strategy ? item.name : t("Estratégias MAMO", "MAMO strategies") : item.name;
  const badge = { native: t("Moeda nativa", "Native coin"), investment: t("Investimento", "Investment"), request: t("Pedido em andamento", "Request in progress"),
    card: t("Cartão", "Card"), legacy: t("Cesta", "Basket"), custom: t("Adicionado por você", "Added by you") }[item.badge ?? "native"];
  return <span className="token-text"><strong>{symbol}</strong><small>{name !== symbol ? name : ""}{item.badge && <em className="token-badge">{badge}</em>}{extra}</small></span>;
}
export function ItemBalance({ item, lang }: { item: MigrationItem; lang: Lang }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  if (item.custom?.status === "loading") return <span className="muted" role="status">{t("Verificando…", "Checking…")}</span>;
  if (item.custom?.status === "error") return <span className="table-error">{customErrors(lang)[item.custom.error ?? "rpc"]}</span>;
  if (item.pending) return <span className="muted">{t("Ver pedido", "See request")}</span>;
  if (item.kind === "baskets" && item.basketId === undefined) return <>{item.count} {t("cestas", "baskets")}</>;
  if (item.amount) return <Amount value={item.amount.value} decimals={item.amount.decimals} lang={lang} />;
  return <>{item.count ?? ""}</>;
}
const PAGE = 40;

export function AssetTable({ lang, busy, ready, results, custom, open, addCustom, removeCustom, retryCustom, selected, showActions = true, openItem, baskets }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [all, setAll] = useState(false);
  const rows = migrationItems(results, custom, baskets?.contents).filter(item => !selected || selected.has(item.id));
  const action = (item: MigrationItem) => {
    const result = results.find(r => r.chainId === item.chainId), canOpen = !!result?.snapshot && !busy;
    const go = (tab: string, holding?: TokenHolding) => { if (result) { if (openItem) openItem(item, result); else open(result, 3, tab, holding); } };
    if (item.custom) return <span className="table-actions">
      {item.selectable && <button className="table-action" disabled={!canOpen} onClick={() => go("transfer", item.holding)}>{t("Retirar", "Withdraw")}</button>}
      {item.custom.status === "ready" && item.amount?.value === 0n && <span className="muted small">{t("Sem saldo nesta conta", "No balance in this account")}</span>}
      {item.custom.status === "error" && <button className="text-button" disabled={busy} onClick={() => retryCustom(item.chainId, item.custom!.address)}>{t("Tentar de novo", "Retry")}</button>}
      {!selected && <button className="text-button" disabled={busy} onClick={() => removeCustom(item.chainId, item.custom!.address)} aria-label={`${t("Remover", "Remove")} ${item.custom.address}`}>{t("Remover", "Remove")}</button>}
    </span>;
    return <button className="table-action" disabled={!canOpen} onClick={() => go(item.tab, item.holding)}>{item.pending ? t("Ver pedido", "View request") : item.kind === "baskets" && item.basketId === undefined ? t("Identificar", "Identify") : t("Retirar", "Withdraw")}</button>;
  };
  const visible = all ? rows : rows.slice(0, PAGE);
  const scanning = results.some(r => r.status === "queued" || r.status === "scanning");
  return <section className="assets" aria-labelledby="assets-title">
    <div className="section-title"><h3 id="assets-title">{selected ? t("Ativos selecionados", "Selected assets") : t("Ativos encontrados", "Assets found")}</h3>{rows.length > 0 && <span className="chip">{rows.length} {t(rows.length === 1 ? "item" : "itens", rows.length === 1 ? "item" : "items")}</span>}</div>
    {rows.length > 0 ? <div className="table-wrap"><table className="asset-table">
      <caption className="sr-only">{t("Ativos por token e rede", "Assets by token and network")}</caption>
      <thead><tr><th scope="col">{t("Ativo", "Asset")}</th><th scope="col">{t("Rede", "Network")}</th><th scope="col" className="numeric">{t("Saldo", "Balance")}</th>{showActions && <th scope="col"><span className="sr-only">{t("Ação", "Action")}</span></th>}</tr></thead>
      <tbody>{visible.map(row => <tr key={row.id}>
        <th scope="row" data-label={t("Ativo", "Asset")}><ItemText item={row} lang={lang} />
          {row.basketId !== undefined && baskets && <BasketContentsView compact contents={row.contents} lang={lang} retry={() => baskets.retry([row.basketId!])} />}</th>
        <td data-label={t("Rede", "Network")}><span className="network-cell"><ChainLogo id={row.chainId} />{chainById(row.chainId).name}</span></td>
        <td data-label={t("Saldo", "Balance")} className="numeric"><ItemBalance item={row} lang={lang} /></td>
        {showActions && <td className="action-cell">{action(row)}</td>}
      </tr>)}</tbody>
    </table></div> : <p className="empty-assets">{selected ? t("Nenhum ativo selecionado. Volte a Preparar carteiras para escolher o que migrar.", "No assets selected. Go back to Prepare wallets to choose what to move.")
      : !ready ? t("Conecte uma carteira para ver os ativos.", "Connect a wallet to see assets.") : scanning ? t("Procurando ativos em todas as redes…", "Looking for assets on every network…") : t("Nenhum ativo encontrado nas redes verificadas. Veja abaixo o que não pôde ser verificado.", "No assets found on the checked networks. See below what could not be verified.")}</p>}
    {rows.length > PAGE && <button className="text-button" onClick={() => setAll(!all)}>{all ? t("Mostrar menos", "Show fewer") : t(`Mostrar todos (${rows.length})`, `Show all (${rows.length})`)}</button>}
    {ready && scanning && rows.length > 0 && !selected && <p className="small muted" role="status">{t("Mais ativos podem aparecer enquanto as redes são consultadas.", "More assets may appear while networks are being checked.")}</p>}
    {!selected && <CustomTokenForm lang={lang} busy={busy || !ready} add={addCustom} />}
    {!showActions && custom.length > 0 && <details className="custom-token-management">
      <summary>{t("Gerenciar tokens adicionados", "Manage added tokens")}</summary>
      {custom.map(item => <div className="row small" key={`${item.chainId}:${item.address}`}>
        <span>{item.token?.symbol ?? `${item.address.slice(0, 6)}…${item.address.slice(-4)}`} · {chainById(item.chainId).name}</span>
        {item.status === "error" && <button className="text-button" disabled={busy} onClick={() => retryCustom(item.chainId, item.address)}>{t("Tentar de novo", "Retry")}</button>}
        <button className="text-button" disabled={busy} onClick={() => removeCustom(item.chainId, item.address)} aria-label={`${t("Remover", "Remove")} ${item.address}`}>{t("Remover", "Remove")}</button>
      </div>)}
    </details>}
  </section>;
}

export function CustomTokenForm({ lang, busy, add }: { lang: Lang; busy: boolean; add: (chainId: number, token: string) => AddResult }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [chainId, setChainId] = useState(chains[0].id), [token, setToken] = useState(""), [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const messages = {
    "invalid-address": t("Informe um endereço de contrato válido (0x…).", "Enter a valid contract address (0x…)."),
    duplicate: t("Este token já está na tabela.", "This token is already in the table."),
    catalogue: t("Este token já faz parte da consulta automática desta rede. Se tiver saldo, ele aparece na tabela.", "This token is already part of this network’s automatic scan. If it has a balance, it appears in the table."),
    cancelled: t("A conta ou o RPC mudou durante a consulta. Adicione o token novamente.", "The account or RPC changed during the lookup. Add the token again."),
    "not-contract": "", "no-balance": "", rpc: "",
  };
  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage(""); setSubmitting(true);
    try {
      const outcome = await add(chainId, token);
      if (outcome) setMessage(messages[outcome]); else setToken("");
    } catch { setMessage(t("Não foi possível adicionar o token. Tente novamente.", "Could not add the token. Try again.")); } finally { setSubmitting(false); }
  }
  return <details className="custom-token custom-token-editor">
    <summary>{t("Não encontrou um token? Adicione pelo contrato", "Missing a token? Add it by contract")}</summary>
    <form onSubmit={submit}>
      <div className="custom-token-heading"><span className="custom-token-plus" aria-hidden="true">+</span><div><h3>{t("Adicionar token", "Add token")}</h3><p>{t("Escolha a rede e informe o contrato do token.", "Choose the network and enter the token contract.")}</p></div></div>
      <div className="custom-token-fields">
        <NetworkSelect label={t("Rede do token", "Token network")} value={chainId} disabled={busy || submitting} onChange={id => { setChainId(id); setMessage(""); }} />
        <label className="field grow"><span>{t("Endereço do contrato do token", "Token contract address")}</span><input className="token-contract-input" value={token} disabled={busy || submitting} placeholder="0x…" spellCheck={false} autoComplete="off" onChange={e => { setToken(e.target.value); setMessage(""); }} /></label>
      </div>
      <div className="custom-token-footer"><p>{t("Saldo e casas decimais são verificados na rede. O token fica só nesta sessão.", "Balance and decimals are checked on-chain. This token is saved only for this session.")}</p>
        <button type="submit" className="add-token-button" disabled={busy || submitting || !token.trim()}>{submitting ? <span className="scan-spinner" aria-hidden="true" /> : <span aria-hidden="true">+</span>}{submitting ? t("Adicionando…", "Adding…") : t("Adicionar token", "Add token")}</button></div>
      {message && <p className="small table-error" role="alert">{message}</p>}
    </form>
  </details>;
}
