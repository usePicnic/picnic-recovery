import type { ReactNode } from "react";
import type { NetworkDiagnosis } from "../core/diagnosis";
import type { CustomTokenState } from "./useDiagnosis";
import { migrationItems } from "./migration";
import { chainById } from "../catalog/chains";
import { ChainLogo } from "./ChainLogo";

export function DiagnosisOverview({ results, custom, pendingCount, lang, heading }: {
  results: NetworkDiagnosis[]; custom: CustomTokenState[]; pendingCount: number; heading?: ReactNode; lang: "pt" | "en";
}) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const reading = (r: NetworkDiagnosis) => r.status === "queued" || r.status === "scanning";
  const finished = results.filter(r => !reading(r)).length;
  const assets = migrationItems(results, custom).filter(item => item.selectable && !item.pending);
  const assetNetworks = new Set(assets.map(item => item.chainId)).size;
  const reads = results.flatMap(r => [r, ...r.linkedCards ?? []]);
  const total = reads.reduce((n, r) => n + r.totalTokens, 0);
  const checked = reads.reduce((n, r) => n + Math.min(r.checkedTokens, r.totalTokens), 0);
  return <section className="diagnosis-overview" aria-label={t("Resumo do diagnóstico", "Diagnosis overview")}>
    <div className="overview-status">{heading}
    <dl className="overview-stats">
      <div><dt>{t("Ativos encontrados", "Assets found")}</dt><dd>{assets.length}<small>{t(`em ${assetNetworks} rede(s)`, `on ${assetNetworks} network(s)`)}</small></dd></div>
      <div><dt>{t("Redes consultadas", "Networks checked")}</dt><dd>{finished}<small>/ {results.length}</small></dd></div>
      <div className={pendingCount ? "overview-attention" : ""}><dt>{t("Pendências", "Needs attention")}</dt><dd>{pendingCount}<small>{finished < results.length ? t("até agora", "so far") : t("para conferir", "to review")}</small></dd></div>
    </dl>
    </div>
    {finished < results.length && <div className="asset-loading overview-loading">
      <div className="asset-loading-label"><span role="status">{t("Consultando as redes…", "Checking networks…")}</span><span>{total ? t(`${checked.toLocaleString(lang)} / ${total.toLocaleString(lang)} tokens`, `${checked.toLocaleString(lang)} / ${total.toLocaleString(lang)} tokens`) : t("Identificando contas e saldos", "Identifying accounts and balances")}</span></div>
      <progress value={total ? checked : undefined} max={total || 1} aria-label={t("Progresso da consulta de tokens", "Token scan progress")} />
    </div>}
    <ul className="overview-networks" aria-label={t("Situação por rede", "Network status")}>
      {results.map(r => {
        const label = reading(r) ? t("Consultando", "Checking") : r.status === "complete" ? t("Consultada", "Checked") : t("Consulta incompleta", "Incomplete scan");
        const found = assets.filter(item => item.chainId === r.chainId).length;
        return <li key={r.chainId} className={reading(r) ? "reading" : r.status === "complete" ? "checked" : "incomplete"} title={`${chainById(r.chainId).name}: ${label}`}>
          <span className="overview-network-head"><ChainLogo id={r.chainId} size={22} /><span aria-label={label}>{reading(r) ? "…" : r.status === "complete" ? "✓" : "!"}</span></span>
          <span className="overview-network-name">{chainById(r.chainId).name}</span>
          <strong className="overview-network-count">{found || r.status === "complete" ? <>{found} <small>{t("ativos", "assets")}</small></> : <small>{reading(r) ? t("Consultando…", "Checking…") : t("Não verificado", "Unverified")}</small>}</strong>
        </li>;
      })}
    </ul>
    {pendingCount > 0 && <p className="overview-pending-note">{t("Há verificações pendentes. Saldos não verificados são desconhecidos, não zero. Confira os detalhes abaixo.", "Some checks need attention. Unverified balances are unknown, not zero. Review the details below.")}</p>}
  </section>;
}
