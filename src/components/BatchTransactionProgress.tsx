import { chainById } from "../catalog/chains";
import { basketReadProgress, type migrationProgress, type ConfirmedBatch } from "./batchProgress";
import type { MigrationItem } from "./migration";

export function BatchTransactionProgress({ history, progress, chainId, lang, active, awaitingReceipt, uncertain, items = [], stageLabel }: {
  history: ConfirmedBatch[]; progress: ReturnType<typeof migrationProgress>; chainId: number; lang: "pt" | "en";
  active: boolean; awaitingReceipt: boolean; uncertain: boolean;
  items?: MigrationItem[]; stageLabel?: string;
}) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const { confirmed, parts, totalAssets, totalTransactions, estimated, blocked, followups } = progress;
  if (!totalAssets && !history.length) return null;
  const explorer = chainById(chainId).blockExplorers?.default.url;
  const byId = new Map(items.map(item => [item.id, item]));
  return <section className="transaction-progress" aria-label={t("Transações desta rede", "Transactions on this network")}>
    <div className="transaction-progress-heading" role="status"><strong>{t(`${confirmed.size} de ${totalAssets} ativos migrados`, `${confirmed.size} of ${totalAssets} assets migrated`)}</strong>
      <span>{estimated ? t(`${history.length} confirmada(s) · cerca de ${totalTransactions} transações no total`, `${history.length} confirmed · about ${totalTransactions} transactions in total`)
        : t(`${history.length} de ${totalTransactions} transações confirmadas`, `${history.length} of ${totalTransactions} transactions confirmed`)}</span></div>
    <progress value={history.length} max={Math.max(1, totalTransactions)} aria-label={t("Transações confirmadas", "Confirmed transactions")} />
    <p className="small muted">{parts.length ? t("Cada transação precisa de uma confirmação na carteira. Continue aqui após cada confirmação.", "Each transaction needs one wallet confirmation. Continue here after each confirmation.")
      : estimated ? t("O restante será verificado antes de preparar a próxima transação.", "Remaining assets will be checked before preparing the next transaction.")
      : blocked.length || followups.length ? t("As transações disponíveis terminaram. Os itens pendentes abaixo continuam na origem ou dependem de outra etapa.", "Available transactions are finished. The pending items below remain at the source or need another step.")
      : t("Todas as transações desta sequência foram confirmadas.", "All transactions in this sequence are confirmed.")}</p>
    <ol className="transaction-sequence">
      {history.map((tx, index) => <li key={tx.hash} className="tx-confirmed"><span className="tx-number" aria-hidden="true">✓</span><div>
        <strong>{t(`Transação ${index + 1}`, `Transaction ${index + 1}`)}</strong><span>{t("Confirmada", "Confirmed")} · {tx.assets.length} {t("ativos processados", "assets processed")}</span></div>
        {explorer && <a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{t("Ver recibo ↗", "View receipt ↗")}</a>}</li>)}
      {parts.map((ids, index) => <li key={`remaining-${index}`} className={index === 0 ? "tx-next" : "tx-waiting"} aria-current={index === 0 ? "step" : undefined}>
        <span className="tx-number" aria-hidden="true">{history.length + index + 1}</span><div><strong>{t(`Transação ${history.length + index + 1} de ${totalTransactions}`, `Transaction ${history.length + index + 1} of ${totalTransactions}`)}{estimated ? ` · ${t("estimada", "estimated")}` : ""}</strong>
          <span>{index === 0 ? uncertain ? t("Resultado pendente de verificação", "Result awaiting verification") : awaitingReceipt ? t("Aguardando confirmação na rede", "Waiting for on-chain confirmation") : active ? t("Em preparação / confirmação na carteira", "Preparing / confirming in wallet") : t("Próxima", "Next") : t("Aguardando a anterior", "Waiting for previous transaction")} · {ids.length} {t("ativos", "assets")}</span>
          {index === 0 && active && <div className="tx-work" role="status">
            <span><span className="scan-spinner" aria-hidden="true" />{stageLabel ?? t("Preparando transação…", "Preparing transaction…")}</span>
            <div className="tx-progress-indeterminate" role="progressbar" aria-label={stageLabel ?? t("Preparação da transação", "Transaction preparation")} />
          </div>}
          <BasketReadMeter items={ids.flatMap(id => { const item = byId.get(id); return item ? [item] : []; })} lang={lang} transaction={history.length + index + 1} />
        </div></li>)}
    </ol>
    {(blocked.length > 0 || followups.length > 0) && <p className="transaction-exclusions">{t(`${blocked.length + followups.length} ativo(s) com pendências, fora das próximas transações.`, `${blocked.length + followups.length} asset(s) need attention outside the upcoming transactions.`)}</p>}
  </section>;
}

function BasketReadMeter({ items, lang, transaction }: { items: MigrationItem[]; lang: "pt" | "en"; transaction: number }) {
  const p = basketReadProgress(items);
  if (!p.total) return null;
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const pending = p.loading + p.queued > 0;
  return <div className={`tx-inventory${p.failed ? " tx-inventory-partial" : ""}`}>
    <span>{p.loading > 0 && <span className="scan-spinner" aria-hidden="true" />}{t(`Conteúdo: ${p.complete} de ${p.total} cestas consultadas`, `Contents: ${p.complete} of ${p.total} baskets checked`)}</span>
    <progress value={p.value} max={p.total} aria-label={t(`Leitura das cestas da transação ${transaction}`, `Basket reads for transaction ${transaction}`)} />
    {pending && <small>{t(`${p.loading} em leitura · ${p.queued} na fila`, `${p.loading} reading · ${p.queued} queued`)}{p.checks > 0 ? t(` · ${p.checked}/${p.checks} verificações em andamento`, ` · ${p.checked}/${p.checks} ongoing checks`) : ""}</small>}
    {p.failed > 0 && <small className="table-error">{t(`${p.failed} cesta(s) com leitura incompleta. Veja os detalhes dos ativos.`, `${p.failed} basket(s) with incomplete reads. See asset details.`)}</small>}
    {pending && <small>{t("Consulta em segundo plano; não impede a próxima transação.", "Background read; it does not block the next transaction.")}</small>}
  </div>;
}
