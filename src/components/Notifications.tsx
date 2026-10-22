import { useEffect, useRef, useState } from "react";
import { chainById } from "../catalog/chains";
import type { TransactionRecord } from "../core/pendingReceipts";
import type { ReceiptCheck } from "./usePendingReceipts";

export function Notifications({ transactions, checks, check, busy, lang }: {
  transactions: TransactionRecord[]; checks: Record<string, ReceiptCheck>; check: (hash: string) => void; busy: boolean; lang: "pt" | "en";
}) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const pending = transactions.filter(tx => tx.status === "pending").length;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={root} className="notifications">
    <button ref={trigger} type="button" className="quiet notification-bell" aria-label={t(`Notificações${pending ? `: ${pending} pendente(s)` : ""}`, `Notifications${pending ? `: ${pending} pending` : ""}`)} aria-expanded={open} aria-controls="notifications-panel" onClick={() => setOpen(!open)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
      {pending > 0 && <span className="notification-count" aria-hidden="true">{pending}</span>}
    </button>
    {open && <section id="notifications-panel" className="notifications-panel" aria-label={t("Notificações", "Notifications")}>
      <div className="notifications-heading"><h2>{t("Notificações", "Notifications")}</h2><button className="text-button" onClick={() => { setOpen(false); trigger.current?.focus(); }}>{t("Fechar", "Close")}</button></div>
      {!transactions.length ? <p className="muted">{t("Nenhuma transação nesta conta ainda.", "No transactions for this account yet.")}</p> : <ul>{[...transactions].reverse().map(tx => {
        const chain = chainById(tx.chainId), state = checks[tx.hash];
        return <li key={`${tx.chainId}:${tx.hash}`}>
          <strong>{tx.status === "confirmed" ? t("Transação confirmada", "Transaction confirmed") : tx.status === "reverted" ? t("Transação revertida", "Transaction reverted") : t("Verificando transação enviada", "Checking submitted transaction")}</strong>
          <span className="muted">{chain.name} · {tx.hash.slice(0, 8)}…{tx.hash.slice(-6)}</span>
          {tx.status === "pending" && <><p>{state?.status === "checking" ? t("Conferindo o recibo e os efeitos na rede…", "Checking the receipt and on-chain effects…") : state?.status === "error" ? t("Não foi possível validar o resultado. Confira os detalhes antes de continuar.", "The result could not be verified. Review the details before continuing.") : t("Aguardando confirmação. A consulta se atualiza automaticamente.", "Awaiting confirmation. This check updates automatically.")}</p>
            {state?.message && <details><summary>{t("Detalhes da verificação", "Verification details")}</summary><p className="table-error">{state.message}</p></details>}
            <button className="text-button" disabled={busy || state?.status === "checking"} onClick={() => check(tx.hash)}>{state?.status === "checking" ? t("Verificando…", "Checking…") : t("Conferir recibo", "Check receipt")}</button></>}
          {chain.blockExplorers && <a href={`${chain.blockExplorers.default.url}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{t("Ver na rede", "View on explorer")}</a>}
        </li>;
      })}</ul>}
    </section>}
  </div>;
}
