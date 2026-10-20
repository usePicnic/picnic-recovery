import { useState, type FormEvent, type ReactNode } from "react";
import { formatUnits, type Address } from "viem";
import { chains, chainById } from "../catalog/chains";
import { products } from "../catalog/products";
import { same } from "../core/client";
import { hasPosition, type NetworkDiagnosis, type TokenHolding } from "../core/diagnosis";
import type { CustomTokenState } from "./useDiagnosis";
import { ChainLogo } from "./ChainLogo";

type Lang = "pt" | "en";
type Open = (result: NetworkDiagnosis, step: 1 | 2 | 3, tab?: string, token?: TokenHolding) => void;
type AddResult = Promise<"invalid-address" | "duplicate" | "catalogue" | "cancelled" | "not-contract" | "no-balance" | "rpc" | undefined>;
type Props = {
  lang: Lang; busy: boolean; ready: boolean; results: NetworkDiagnosis[]; custom: CustomTokenState[]; open: Open;
  showActions?: boolean;
  addCustom: (chainId: number, token: string) => AddResult; removeCustom: (chainId: number, token: Address) => void; retryCustom: (chainId: number, token: Address) => void;
};
type Row = { key: string; chainId: number; symbol: string; name: string; badge?: string; balance: ReactNode; action?: ReactNode; order: number };

// Grouped whole part, at most six fraction digits; the exact value stays in the title.
export function formatAmount(value: bigint, decimals: number | undefined, lang: Lang) {
  if (decimals === undefined) return `${value.toString()} ${lang === "pt" ? "unidades brutas" : "raw units"}`;
  const [whole, fraction = ""] = formatUnits(value, decimals).split(".");
  const shown = fraction.slice(0, 6).replace(/0+$/, "");
  if (value > 0n && whole === "0" && !shown) return lang === "pt" ? "< 0,000001" : "< 0.000001";
  const grouped = BigInt(whole).toLocaleString(lang === "pt" ? "pt-BR" : "en-US");
  return shown ? `${grouped}${lang === "pt" ? "," : "."}${shown}` : grouped;
}
function Amount({ value, decimals, lang }: { value: bigint; decimals?: number; lang: Lang }) {
  return <span title={decimals === undefined ? undefined : formatUnits(value, decimals)}>{formatAmount(value, decimals, lang)}</span>;
}
const PAGE = 40;

export function AssetTable({ lang, busy, ready, results, custom, open, addCustom, removeCustom, retryCustom, showActions = true }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [all, setAll] = useState(false);
  const rows: Row[] = [];
  const order = (chainId: number) => chains.findIndex(c => c.id === chainId) * 10;
  for (const result of results) {
    const chain = chainById(result.chainId), canOpen = !!result.snapshot && !busy;
    const withdraw = (holding?: TokenHolding) => <button className="table-action" disabled={!canOpen} onClick={() => open(result, 3, "transfer", holding)}>{t("Retirar", "Withdraw")}</button>;
    const invest = <button className="table-action secondary" disabled={!canOpen} onClick={() => open(result, 3, "invest")}>{t("Ver investimento", "View investment")}</button>;
    if ((result.nativeBalance ?? 0n) > 0n) rows.push({ key: `${chain.id}:native`, chainId: chain.id, symbol: chain.nativeCurrency.symbol, name: chain.nativeCurrency.name, badge: t("Moeda nativa", "Native coin"),
      balance: <Amount value={result.nativeBalance!} decimals={chain.nativeCurrency.decimals} lang={lang} />, action: withdraw(), order: order(chain.id) });
    // Product shares are shown once, as the investment, not again as a plain token.
    const shown = new Set<string>();
    for (const position of result.positions.filter(hasPosition)) {
      shown.add(position.product.address.toLowerCase());
      const pending = position.balance === 0n;
      rows.push({ key: `${chain.id}:position:${position.product.id}`, chainId: chain.id, symbol: position.product.name.split("·").at(-1)!.trim(), name: position.product.name,
        badge: pending ? t("Pedido em andamento", "Request in progress") : t("Investimento", "Investment"),
        balance: pending ? <span className="muted">{t("Ver pedido", "See request")}</span> : <Amount value={position.balance} decimals={position.decimals} lang={lang} />, action: invest, order: order(chain.id) + 1 });
    }
    for (const token of result.tokens) {
      if (shown.has(token.address.toLowerCase())) continue;
      const product = products.some(p => p.chainId === chain.id && same(p.address, token.address));
      rows.push({ key: `${chain.id}:${token.address}`, chainId: chain.id, symbol: token.symbol ?? token.name, name: token.name, badge: product ? t("Investimento", "Investment") : undefined,
        balance: <Amount value={token.balance} decimals={token.verifiedDecimals} lang={lang} />, action: product ? invest : withdraw(token), order: order(chain.id) + 2 });
    }
    if ((result.basketCount ?? 0n) > 0n) rows.push({ key: `${chain.id}:baskets`, chainId: chain.id, symbol: t("Cestas", "Baskets"), name: t("Cestas antigas da Picnic", "Legacy Picnic baskets"), badge: t("Legado", "Legacy"),
      balance: result.basketCount!.toString(), action: <button className="table-action secondary" disabled={!canOpen} onClick={() => open(result, 3, "legacy")}>{t("Ver cestas", "View baskets")}</button>, order: order(chain.id) + 3 });
    if ((result.strategyCount ?? 0) > 0) rows.push({ key: `${chain.id}:mamo`, chainId: chain.id, symbol: "MAMO", name: t("Estratégias MAMO", "MAMO strategies"), badge: t("Investimento", "Investment"),
      balance: String(result.strategyCount), action: invest, order: order(chain.id) + 3 });
  }
  for (const item of custom) {
    const result = results.find(r => r.chainId === item.chainId), key = `${item.chainId}:custom:${item.address}`;
    const remove = <button className="text-button" disabled={busy} onClick={() => removeCustom(item.chainId, item.address)} aria-label={`${t("Remover", "Remove")} ${item.address}`}>{t("Remover", "Remove")}</button>;
    const symbol = item.token?.symbol ?? `${item.address.slice(0, 6)}…${item.address.slice(-4)}`;
    const errors = {
      "invalid-address": t("Endereço inválido.", "Invalid address."),
      "not-contract": t("Não há contrato neste endereço nesta rede.", "No contract at this address on this network."),
      "no-balance": t("O contrato não respondeu a balanceOf: não parece ser um ERC-20.", "The contract did not answer balanceOf: it does not look like an ERC-20."),
      rpc: t("A rede não respondeu. Saldo não verificado.", "The network did not answer. Balance unverified."),
    };
    rows.push({ key, chainId: item.chainId, symbol, name: item.token?.name ?? item.address, badge: t("Adicionado por você", "Added by you"), order: order(item.chainId) + 4,
      balance: item.status === "loading" ? <span className="muted" role="status">{t("Verificando…", "Checking…")}</span>
        : item.status === "error" ? <span className="table-error">{errors[item.error ?? "rpc"]}</span>
        : <Amount value={item.token!.balance} decimals={item.token!.verifiedDecimals} lang={lang} />,
      action: <span className="table-actions">
        {item.status === "ready" && item.token!.balance > 0n && result && <button className="table-action" disabled={!result.snapshot || busy} onClick={() => open(result, 3, "transfer", item.token)}>{t("Retirar", "Withdraw")}</button>}
        {item.status === "ready" && item.token!.balance === 0n && <span className="muted small">{t("Sem saldo nesta conta", "No balance in this account")}</span>}
        {item.status === "error" && <button className="text-button" disabled={busy} onClick={() => retryCustom(item.chainId, item.address)}>{t("Tentar de novo", "Retry")}</button>}
        {remove}
      </span> });
  }
  rows.sort((a, b) => a.order - b.order);
  const visible = all ? rows : rows.slice(0, PAGE);
  const scanning = results.some(r => r.status === "queued" || r.status === "scanning");
  return <section className="assets" aria-labelledby="assets-title">
    <div className="section-title"><h3 id="assets-title">{t("Ativos encontrados", "Assets found")}</h3>{rows.length > 0 && <span className="chip">{rows.length} {t(rows.length === 1 ? "item" : "itens", rows.length === 1 ? "item" : "items")}</span>}</div>
    {rows.length > 0 ? <div className="table-wrap"><table className="asset-table">
      <caption className="sr-only">{t("Ativos por token e rede", "Assets by token and network")}</caption>
      <thead><tr><th scope="col">Token</th><th scope="col">{t("Rede", "Network")}</th><th scope="col" className="numeric">{t("Saldo", "Balance")}</th>{showActions && <th scope="col"><span className="sr-only">{t("Ação", "Action")}</span></th>}</tr></thead>
      <tbody>{visible.map(row => <tr key={row.key}>
        <th scope="row" data-label="Token"><span className="token-text"><strong>{row.symbol}</strong><small>{row.name !== row.symbol ? row.name : ""}{row.badge && <em className="token-badge">{row.badge}</em>}</small></span></th>
        <td data-label={t("Rede", "Network")}><span className="network-cell"><ChainLogo id={row.chainId} />{chainById(row.chainId).name}</span></td>
        <td data-label={t("Saldo", "Balance")} className="numeric">{row.balance}</td>
        {showActions && <td className="action-cell">{row.action}</td>}
      </tr>)}</tbody>
    </table></div> : <p className="empty-assets">{!ready ? t("Conecte uma carteira para ver os ativos.", "Connect a wallet to see assets.") : scanning ? t("Procurando ativos em todas as redes…", "Looking for assets on every network…") : t("Nenhum ativo encontrado nas redes verificadas. Veja abaixo o que não pôde ser verificado.", "No assets found on the checked networks. See below what could not be verified.")}</p>}
    {rows.length > PAGE && <button className="text-button" onClick={() => setAll(!all)}>{all ? t("Mostrar menos", "Show fewer") : t(`Mostrar todos (${rows.length})`, `Show all (${rows.length})`)}</button>}
    {ready && scanning && rows.length > 0 && <p className="small muted" role="status">{t("Mais ativos podem aparecer enquanto as redes são consultadas.", "More assets may appear while networks are being checked.")}</p>}
    <CustomTokenForm lang={lang} busy={busy || !ready} add={addCustom} />
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

function CustomTokenForm({ lang, busy, add }: { lang: Lang; busy: boolean; add: (chainId: number, token: string) => AddResult }) {
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
  return <details className="custom-token">
    <summary>{t("Não encontrou um token? Adicione pelo contrato", "Missing a token? Add it by contract")}</summary>
    <form onSubmit={submit}>
      <p className="small muted">{t("Leitura direta na rede escolhida: casas decimais e saldo vêm do próprio contrato. O token fica só nesta sessão.", "Read directly from the chosen network: decimals and balance come from the contract itself. The token is kept only for this session.")}</p>
      <div className="custom-token-fields">
        <label className="field"><span>{t("Rede", "Network")}</span><select value={chainId} disabled={busy || submitting} onChange={e => setChainId(Number(e.target.value))}>{chains.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="field grow"><span>{t("Endereço do contrato do token", "Token contract address")}</span><input value={token} disabled={busy || submitting} placeholder="0x…" spellCheck={false} autoComplete="off" onChange={e => { setToken(e.target.value); setMessage(""); }} /></label>
        <button type="submit" className="outline" disabled={busy || submitting || !token.trim()}>{submitting ? t("Adicionando…", "Adding…") : t("Adicionar", "Add")}</button>
      </div>
      {message && <p className="small table-error" role="alert">{message}</p>}
    </form>
  </details>;
}
