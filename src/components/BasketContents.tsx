import type { BasketContents, BasketHolding } from "../core/basket-contents";
import { formatAmount, shortAddress } from "./format";

type Lang = "pt" | "en";
// One presentation of a basket wallet's contents, shared by diagnosis,
// Prepare wallets, Move funds and the batch review. Loading and partial states
// are explicit: an unread chunk is unknown, never an empty basket.
export function BasketContentsView({ contents, lang, retry, compact = false }: { contents?: BasketContents; lang: Lang; retry?: () => void; compact?: boolean }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  if (!contents || contents.status === "queued") return <p className="basket-status muted small" role="status"><span className="scan-dot" aria-hidden="true" />{t("Conteúdo na fila de leitura…", "Contents queued for reading…")}</p>;
  if (contents.status === "error") return <p className="basket-status small table-error" role="alert">{t("Não foi possível ler o conteúdo da cesta.", "The basket contents could not be read.")} {retry && <button type="button" className="text-button" onClick={retry}>{t("Tentar de novo", "Retry")}</button>}</p>;
  const loading = contents.status === "loading";
  const tokens = contents.holdings.filter(h => h.category !== "position"), stakes = contents.holdings.filter(h => h.category === "position");
  const shown = compact ? tokens.slice(0, 4) : tokens;
  return <div className="basket-contents">
    <p className="basket-status small" role="status">
      {loading ? <><span className="scan-spinner" aria-hidden="true" />{t(`Lendo conteúdo… ${contents.checked} de ${contents.total} verificações`, `Reading contents… ${contents.checked} of ${contents.total} checks`)}</>
        : contents.status === "partial" ? <span className="table-error">{t(`Leitura parcial: ${contents.failed} verificações sem resposta.`, `Partial read: ${contents.failed} checks unanswered.`)}</span>
        : tokens.length || stakes.length ? <span className="muted">{t("Ativos encontrados no catálogo legado", "Assets found in the legacy catalogue")}</span>
        : <span className="muted">{t("Nenhum saldo confirmado nos contratos consultados", "No balance confirmed in the queried contracts")}</span>}
      {contents.status === "partial" && retry && <button type="button" className="text-button" onClick={retry}>{t("Ler o que falta", "Read the rest")}</button>}
    </p>
    {shown.length > 0 && <ul className="basket-holdings">{shown.map(h => <Holding key={h.key} holding={h} lang={lang} />)}</ul>}
    {compact && tokens.length > shown.length && <p className="small muted">{t(`+ ${tokens.length - shown.length} outros ativos`, `+ ${tokens.length - shown.length} more assets`)}</p>}
    {!!contents.unreadable && <details className="small muted"><summary>{t(`${contents.unreadable} contratos sem saldo verificável`, `${contents.unreadable} contracts with unverifiable balances`)}</summary>
      <p>{t("Esses contratos não retornaram um saldo válido. Isso não significa saldo zero; apenas os ativos confirmados entram na migração.", "These contracts did not return a valid balance. This does not mean zero; only confirmed assets are included in migration.")}</p>
    </details>}
    {stakes.length > 0 && <div className="basket-stakes small"><strong>{t("Posições que exigem saída no protocolo", "Positions needing a protocol exit")}</strong>
      <ul className="basket-holdings">{stakes.map(h => <Holding key={h.key} holding={h} lang={lang} />)}</ul></div>}
    {contents.wallet && !compact && <p className="small muted">{t("Carteira da cesta", "Basket wallet")}: <span className="mono">{contents.wallet}</span>{contents.block !== undefined ? ` · ${t("bloco", "block")} ${contents.block}` : ""}</p>}
  </div>;
}
function Holding({ holding, lang }: { holding: BasketHolding; lang: Lang }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const badge = { token: undefined, native: t("Nativa", "Native"), receipt: t("Recibo de protocolo", "Protocol receipt"), position: t("Precisa sair do protocolo", "Needs protocol exit") }[holding.category];
  return <li>
    <span className="token-text"><strong>{holding.symbol ?? holding.name}</strong><small>{holding.name !== holding.symbol ? holding.name : ""}{badge && <em className="token-badge">{badge}</em>}{holding.token && <span className="mono" title={holding.token}> {shortAddress(holding.token)}</span>}</small></span>
    <span className="numeric">{holding.category === "position" ? `${holding.balance.toString()} ${t("unid.", "units")}` : formatAmount(holding.balance, holding.decimals, lang)}</span>
  </li>;
}
