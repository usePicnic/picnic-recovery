import { useEffect, useRef, useState } from "react";
import type { Address, EIP1193Provider, Hex } from "viem";
import { chainById, chains } from "../catalog/chains";
import { publicClient, same } from "../core/client";
import { inspectAccount } from "../core/inspect";
import { approveSafeProposal, safeHash, sendAction } from "../core/actions";
import { batchPartAction, includedEntries, planBatch, readBatchFacts, screenAssetTransfers, type BatchEntry, type BatchPlan } from "../core/batch";
import { approvedMultiSend, findMultiSend } from "../core/multisend";
import { destinationError } from "../core/destination";
import type { ReceiptExpectation } from "../core/receipts";
import type { AccountSnapshot, PreparedAction, Receive, Progress, MigrationReceipt } from "../core/types";
import { batchSources, positionId, type MigrationItem } from "./migration";
import { products } from "../catalog/products";
import { rpcFor, type RpcOverrides } from "./useDiagnosis";
import type { BasketContentsState } from "./useBasketContents";
import { BasketContentsView } from "./BasketContents";
import { ChainLogo } from "./ChainLogo";
import { NetworkAssetInventory } from "./NetworkAssetInventory";
import { DestinationMessage } from "./DestinationMessage";
import { formatAmount, shortAddress } from "./format";
import { displayError } from "../core/errors";

import { confirmedBatches, migrationProgress } from "./batchProgress";
import { BatchTransactionProgress } from "./BatchTransactionProgress";

type Lang = "pt" | "en";
export type SubmittedRecord = { chainId: number; account: Address; label: string; hash: Hex; expectation?: ReceiptExpectation; migration?: MigrationReceipt };
type Props = {
  transactions?: Progress["transactions"];
  lang: Lang; busy: boolean; run: (task: () => Promise<void>) => Promise<void>;
  account: Address; wallet?: Address; items: MigrationItem[]; chosen: ReadonlySet<string>; destination: string;
  guardians: readonly Address[]; overrides: RpcOverrides; uncertain: boolean; provider: () => Promise<EIP1193Provider>;
  baskets: BasketContentsState; onSubmitted: (record: SubmittedRecord) => void; onConfirmed: (chainId: number, hash: Hex) => void;
  select?: (ids: string[], value: boolean) => void; openItem: (item: MigrationItem) => void;
};
type Stage = "reading" | "screening" | "wallet" | "network" | "validation" | "simulation" | "signature" | "transaction" | "receipt";
type ChainState = {
  status: "idle" | "reading" | "ready" | "sending" | "error";
  // The reviewed plan, valid only for the context key it was read under.
  plan?: BatchPlan; action?: PreparedAction; snapshot?: AccountSnapshot; safeTxHash?: Hex; key?: string;
  error?: string; stage?: Stage;
  // History survives rescans that empty the network after sending.
  confirmed?: Hex; submitted?: Hex; lastPlan?: BatchPlan; remainingParts?: string[][]; done?: boolean;
};
type Meta = { symbol: string; decimals?: number };
const idle = (): ChainState => ({ status: "idle" });

// Primary Move funds flow: an explicit transaction sequence for each network.
// Nothing is read for review, signed or sent without an explicit click.
export function BatchMigration(props: Props) {
  const { lang, busy, run, account, wallet, items, chosen, destination, guardians, overrides, uncertain, baskets } = props;
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [state, setState] = useState<Record<number, ChainState>>({});
  const [expandedNetworks, setExpandedNetworks] = useState<Record<number, boolean>>({});
  const selected = items.filter(item => chosen.has(item.id));
  const history = (id: number) => confirmedBatches(props.transactions ?? [], id, account, destination);
  // A network stays listed after its batch, even if a rescan finds it empty.
  const networks = chains.map(c => c.id).filter(id => items.some(item => item.chainId === id) || history(id).length || state[id]?.lastPlan);
  const destinationProblem = destinationError(destination, account, wallet, guardians);
  const entry = (id: number): ChainState => state[id] ?? idle();
  const patch = (id: number, value: Partial<ChainState>) => setState(old => ({ ...old, [id]: { ...old[id] ?? idle(), ...value } }));
  // Everything a review depends on, per network. A change discards any
  // unsent review and any read still in flight for the old context.
  const contextKey = (id: number) => JSON.stringify([account.toLowerCase(), wallet?.toLowerCase(), destination.trim().toLowerCase(), rpcFor(id, overrides),
    guardians.map(g => g.toLowerCase()).sort(), selected.filter(item => item.chainId === id).map(item => item.id).sort()]);
  const keys = networks.map(id => `${id}=${contextKey(id)}`).join("|");
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const latest = useRef<Record<number, string>>({});
  latest.current = Object.fromEntries(networks.map(id => [id, contextKey(id)]));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setState(old => {
      let changed = false;
      const next = { ...old };
      for (const [id, s] of Object.entries(old)) {
        if ((s.status === "ready" || s.status === "reading" || s.status === "error") && s.key !== contextKey(Number(id))) {
          next[Number(id)] = { ...s, status: "idle", plan: undefined, action: undefined, safeTxHash: undefined, stage: undefined, error: undefined, key: undefined, done: false, remainingParts: undefined };
          changed = true;
        }
      }
      return changed ? next : old;
    });
  }, [keys]);
  // A receipt checked after a timeout completes the same step; it must not
  // remain in the upcoming sequence or be offered for resubmission.
  useEffect(() => {
    setState(old => {
      let changed = false;
      const next = { ...old };
      for (const [id, s] of Object.entries(old)) {
        const tx = props.transactions?.find(tx => tx.hash === s.submitted);
        if (!tx || tx.status === "pending" || !s.lastPlan) continue;
        changed = true;
        next[Number(id)] = { ...s, submitted: undefined, error: undefined,
          remainingParts: tx.status === "confirmed" ? s.lastPlan.parts.slice(1) : s.lastPlan.parts,
          done: tx.status === "confirmed" && s.lastPlan.parts.length <= 1 };
      }
      return changed ? next : old;
    });
  }, [props.transactions]);
  const current = networks.find(id => selected.some(item => item.chainId === id) && !entry(id).done);
  const anyReading = Object.values(state).some(s => s.status === "reading" || s.status === "sending");

  // Human labels for amounts, from what diagnosis and basket reads verified.
  const meta = (chainId: number, token: Address | null): Meta => {
    const chain = chainById(chainId);
    if (!token) return { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals };
    for (const item of items) {
      if (item.chainId !== chainId) continue;
      if (item.holding && same(item.holding.address, token)) return { symbol: item.holding.symbol ?? item.holding.name, decimals: item.holding.verifiedDecimals };
      const product = item.kind === "position" ? products.find(p => positionId(p.chainId, p.id) === item.id) : undefined;
      // Share transfers use the product token; unstaking forwards the staking token, which shares its precision.
      if (product && (same(product.address, token) || (product.kind === "staking" && item.amount))) return { symbol: item.symbol, decimals: item.amount?.decimals };
      if (item.strategy && same(item.strategy.token, token)) return { symbol: "MAMO", decimals: item.strategy.decimals };
      const held = item.contents?.holdings.find(h => h.token && same(h.token, token));
      if (held) return { symbol: held.symbol ?? held.name, decimals: held.decimals };
    }
    return { symbol: shortAddress(token) };
  };
  const amount = (chainId: number, r: Receive) => { const m = meta(chainId, r.token); return `${formatAmount(r.minimum, m.decimals, lang)} ${m.symbol}`; };

  function migrate(chainId: number, approveOnly = false) {
    if (inFlight.current || busy || uncertain) return;
    const key = contextKey(chainId);
    const fresh = () => mounted.current && latest.current[chainId] === key;
    // Runs as a busy task: no other preparation, send or navigation overlaps it.
    return run(async () => {
      inFlight.current = true;
      patch(chainId, { status: "reading", stage: "reading", error: undefined, plan: undefined, action: undefined, safeTxHash: undefined, key });
      let sending = false;
      try {
        if (destinationProblem) throw new Error(t("Corrija o destino antes de migrar.", "Fix the destination before migrating."));
        const chain = chainById(chainId);
        const client = publicClient(chain, rpcFor(chainId, overrides));
        const sources = batchSources(selected, chainId);
        const multicall = chain.contracts?.multicall3?.address;
        const snapshot = await inspectAccount(client, account, chainId);
        if (!same(snapshot.address, account)) throw new Error("Source account changed");
        const multisend = snapshot.version === "EOA" ? undefined : (await findMultiSend(client, chainId))?.address;
        const facts = await readBatchFacts(client, snapshot, sources, multicall);
        // Validate destination/account constraints before probing any transfer.
        const initial = planBatch({ snapshot, destination, facts, multisend, guardians });
        patch(chainId, { stage: "screening" });
        const checked = initial.unavailable ? facts : await screenAssetTransfers(client, snapshot, facts, initial.destination, wallet, multisend);
        const plan = planBatch({ snapshot, destination, facts: checked, multisend, guardians });
        const included = includedEntries(plan, 0), sent = history(chainId).length;
        let action: PreparedAction | undefined, safeTxHash: Hex | undefined;
        if (!plan.unavailable && included.length) {
          const parts = plan.parts.length + sent;
          action = batchPartAction({ snapshot, plan, part: 0, forbiddenRecipients: [...guardians],
            label: `Batch migration · ${chain.name}${parts > 1 ? ` · part ${sent + 1}/${parts}` : ""}`,
            reread: async () => readBatchFacts(client, await inspectAccount(client, account, chainId), sources, multicall) });
          action.expectedSender = wallet;
          safeTxHash = await safeHash(client, action);
        }
        if (!fresh()) {
          if (!mounted.current) return;
          throw new Error(t("A conta ou a seleção mudou. Clique em migrar novamente.", "The account or selection changed. Click migrate again."));
        }
        const prepared: ChainState = { ...entry(chainId), status: "ready", stage: undefined, plan, action, snapshot, safeTxHash, key, done: !action, remainingParts: plan.parts };
        patch(chainId, prepared);
        // The click authorizes opening the selected wallet. No second UI gate.
        if (action) { sending = true; await send(chainId, prepared, approveOnly); }
      } catch (error) {
        if (fresh() && !sending) patch(chainId, { status: "error", stage: undefined, error: displayError(error, lang) });
        throw error;
      } finally { inFlight.current = false; }
    });
  }
  async function send(chainId: number, s: ChainState, approveOnly: boolean) {
    const { action, plan } = s;
    if (!action || !plan) return;
    let submitted: Hex | undefined;
    patch(chainId, { status: "sending", stage: "wallet", error: undefined });
    try {
      const client = publicClient(chainById(chainId), rpcFor(chainId, overrides));
      const onSubmitted = (hash: Hex, expectation?: ReceiptExpectation) => {
        submitted = hash;
        patch(chainId, { stage: "receipt", submitted: approveOnly ? undefined : hash });
        props.onSubmitted({ chainId, account: action.account, label: approveOnly ? `Approve ${action.label}` : action.label, hash, expectation,
          migration: approveOnly ? undefined : { destination: plan.destination, assets: includedEntries(plan, 0).map(e => ({ id: e.id, label: e.label, outcome: e.outcome ?? "received" })) } });
      };
      const receipt = approveOnly ? await approveSafeProposal(client, await props.provider(), action, onSubmitted)
        : await sendAction(client, await props.provider(), action, { onSubmitted, onSigning: stage => patch(chainId, { stage }) });
      props.onConfirmed(chainId, receipt.transactionHash);
      if (approveOnly) { patch(chainId, { status: "ready", stage: undefined }); return; }
      // Transferred NFTs no longer belong to this Safe; diagnosis removes them.
      // Keep the existing content cache instead of reloading every basket.
      // Finish this transaction sequence; blocked assets and later steps remain
      // visible separately and keep the network from being labelled complete.
      const leftovers = plan.parts.length > 1;
      patch(chainId, { status: "idle", stage: undefined, plan: undefined, action: undefined, safeTxHash: undefined, key: undefined,
        confirmed: receipt.transactionHash, submitted: undefined, lastPlan: plan, remainingParts: plan.parts.slice(1), done: !leftovers });
    } catch (error) {
      const message = displayError(error, lang);
      // Once submitted, this reviewed transaction is never offered again: the
      // pending receipt must be checked first (no automatic resubmission).
      if (submitted) patch(chainId, { status: "idle", stage: undefined, plan: undefined, action: undefined, safeTxHash: undefined, key: undefined, lastPlan: plan, remainingParts: plan.parts,
        error: t(`Transação enviada (${shortAddress(submitted)}), mas o resultado não foi confirmado: ${message}. Confira o recibo antes de continuar.`, `Transaction submitted (${shortAddress(submitted)}), but its result was not confirmed: ${message}. Check the receipt before continuing.`) });
      else patch(chainId, { status: "ready", stage: undefined, error: message });
      throw error;
    }
  }

  const stageText: Record<Stage, string> = {
    reading: t("Lendo saldos atuais na rede…", "Reading current balances on-chain…"),
    screening: t("Simulando a migração de cada ativo…", "Simulating each asset migration…"),
    wallet: t("Conectando à carteira selecionada…", "Connecting to the selected wallet…"),
    network: t("Confirme a troca de rede na sua carteira…", "Confirm the network switch in your wallet…"),
    validation: t("Validando permissões e saldos…", "Validating permissions and balances…"),
    simulation: t("Simulando a transação e calculando a taxa…", "Simulating the transaction and estimating the fee…"),
    signature: t("Confirme a assinatura na sua carteira…", "Confirm the signature in your wallet…"),
    transaction: t("Confirme a transação na sua carteira…", "Confirm the transaction in your wallet…"),
    receipt: t("Transação enviada. Aguardando confirmação na rede…", "Transaction sent. Waiting for on-chain confirmation…"),
  };
  return <section className="panel batch" aria-labelledby="batch-title">
    <p className="eyebrow">{t("PASSO 2 / MOVER O DINHEIRO", "STEP 2 / MOVE FUNDS")}</p>
    <h2 id="batch-title">{t("Uma rede. Uma transação por vez.", "One network. One transaction at a time.")}</h2>
    <p>{t("Confirme cada transação na carteira e continue até concluir as redes selecionadas. Uma rede pode precisar de várias transações.",
      "Confirm each transaction in your wallet and continue until the selected networks are complete. A network may need several transactions.")}</p>
    <div className="batch-destination">
      <div><span className="small muted">{t("Destino em todas as redes", "Destination on every network")}</span><p className="mono">{destination || "—"}</p></div>
    </div>
    {destinationProblem && <DestinationMessage id="batch-destination-error" problem={destinationProblem} lang={lang} />}
    {!networks.length && <p className="empty-assets">{t("Nenhum ativo selecionado. Volte a Preparar carteiras para escolher o que migrar.", "No assets selected. Go back to Prepare wallets to choose what to move.")}</p>}
    <ol className="batch-steps">
      {networks.map((chainId, index) => {
        const chain = chainById(chainId), s = entry(chainId), own = selected.filter(item => item.chainId === chainId), available = items.filter(item => item.chainId === chainId);
        const options = available.filter(item => item.selectable), all = options.length > 0 && own.length === options.length;
        const isCurrent = chainId === current, working = s.status === "reading" || s.status === "sending";
        const confirmed = history(chainId), sent = confirmed.length;
        const progress = migrationProgress({ history: confirmed, items: own, plan: s.plan ?? s.lastPlan, remainingParts: s.plan?.parts ?? s.remainingParts });
        const completed = s.done && !progress.parts.length && !batchHasFollowups(s.plan ?? s.lastPlan);
        const transactionLabel = t(`Transação ${sent + 1} de ${progress.totalTransactions}`, `Transaction ${sent + 1} of ${progress.totalTransactions}`);
        const label = s.done ? completed ? t("Concluída", "Done") : t("Há etapas pendentes", "Follow-up steps remain") : s.status === "ready" ? t("Pronta para migrar", "Ready to migrate") : s.status === "reading" ? t("Lendo…", "Reading…")
          : s.status === "sending" ? t("Enviando…", "Sending…") : s.status === "error" ? t("Precisa de atenção", "Needs attention")
          : !own.length ? t("Não será migrada agora", "Not moving now") : sent ? t(`${progress.parts.length} transação(ões) restante(s)`, `${progress.parts.length} transaction(s) remaining`) : isCurrent ? t("Próxima", "Next") : t("Aguardando", "Waiting");
        const tone = completed ? "ok" : s.done ? "partial" : s.status === "error" ? "blocked" : working ? "loading" : sent ? "partial" : isCurrent ? "current" : "idle";
        return <li key={chainId} className={`batch-step ${tone}`} aria-current={isCurrent ? "step" : undefined} aria-labelledby={`batch-${chainId}`}>
          <div className="batch-step-head">
            {!props.select && <span className="batch-index" aria-hidden="true">{completed ? "✓" : index + 1}</span>}
            {props.select && <input type="checkbox" aria-label={t(`Migrar ${chain.name}`, `Migrate ${chain.name}`)} checked={all} disabled={busy || anyReading || uncertain || completed || !options.length}
              ref={el => { if (el) el.indeterminate = own.length > 0 && !all; }} onChange={() => {
                patch(chainId, { done: false, plan: undefined, lastPlan: undefined, remainingParts: undefined });
                props.select!(options.map(item => item.id), !all);
              }} />}
            <button type="button" className="network-inventory-toggle" aria-expanded={!!expandedNetworks[chainId]} aria-controls={`network-inventory-${chainId}`}
              aria-label={t(`${expandedNetworks[chainId] ? "Ocultar" : "Ver"} ${available.length} ativos em ${chain.name}`, `${expandedNetworks[chainId] ? "Hide" : "View"} ${available.length} assets on ${chain.name}`)}
              disabled={!available.length} onClick={() => setExpandedNetworks(old => ({ ...old, [chainId]: !old[chainId] }))}>
              <ChainLogo id={chainId} size={24} />
              <span className="network-inventory-title"><strong id={`batch-${chainId}`}>{chain.name}</strong><small>{t(`${own.length} de ${available.length} ativos selecionados`, `${own.length} of ${available.length} assets selected`)}</small></span>
              {available.length > 0 && <span className="network-inventory-chevron" aria-hidden="true">{expandedNetworks[chainId] ? "▾" : "▸"}</span>}
            </button>
            <span className={`status-pill ${completed ? "ok" : s.status === "error" ? "blocked" : working ? "loading" : "idle"}`}>{label}</span>
          </div>
          <NetworkAssetInventory id={`network-inventory-${chainId}`} name={chain.name} items={available} expanded={!!expandedNetworks[chainId]} lang={lang} retry={id => baskets.retry([id])} />
          {s.error && <p className="small table-error" role="alert">{s.error}</p>}
          {(own.length > 0 || sent > 0) && <BatchTransactionProgress history={confirmed} progress={progress} chainId={chainId} lang={lang} active={working} awaitingReceipt={s.stage === "receipt"} items={own} stageLabel={s.stage ? stageText[s.stage] : undefined}
            uncertain={uncertain && !!props.transactions?.some(tx => tx.chainId === chainId && same(tx.account, account) && tx.status === "pending")} />}
          {s.lastPlan && !s.plan && <Leftovers showParts={false} plan={s.lastPlan} items={items} lang={lang} openItem={props.openItem} />}
          {s.plan?.entries.some(e => e.transferBlocked) && <BlockedTransfers plan={s.plan} lang={lang} />}
          {s.plan && <details className="network-assets"><summary>{t("Detalhes da transação", "Transaction details")}</summary><PlanView plan={s.plan} snapshot={s.snapshot!} action={s.action} safeTxHash={s.safeTxHash} wallet={wallet} lang={lang} sent={sent}
            items={own} openItem={props.openItem} amount={r => amount(chainId, r)} /></details>}
          {(!s.done || progress.blocked.length > 0) && (own.length > 0 || s.action) && <div className="batch-actions">
            {(own.length > 0 || s.action) && <button type="button" className={isCurrent ? "next-step" : "outline"}
              disabled={busy || anyReading || !!destinationProblem || uncertain}
              onClick={() => void migrate(chainId)}>{working ? s.stage ? stageText[s.stage] : t("Preparando…", "Preparing…")
                : s.done ? t("Verificar ativos bloqueados novamente", "Check blocked assets again") : progress.totalTransactions > 0 ? `${sent > 0 ? t("Continuar", "Continue") : t("Iniciar", "Start")} · ${transactionLabel.toLowerCase()} →` : t(`Migrar ${chain.name} →`, `Migrate ${chain.name} →`)}</button>}
            {s.snapshot && s.snapshot.threshold > 1n && s.action && <button type="button" className="outline" disabled={busy || uncertain || !!destinationProblem}
              onClick={() => void migrate(chainId, true)}>{t("Registrar minha aprovação", "Register my approval")}</button>}
          </div>}
        </li>;
      })}
    </ol>
  </section>;
}
export function BlockedTransfers({ plan, lang }: { plan: BatchPlan; lang: Lang }) {
  const blocked = plan.entries.filter(entry => entry.transferBlocked);
  if (!blocked.length) return null;
  return <div className="batch-blocked-transfers migration-error" role="alert">
    <strong>{lang === "pt" ? "Estes ativos não entram na migração" : "These assets are not included in the migration"}</strong>
    <p className="small">{lang === "pt" ? "A transferência falhou na simulação. O saldo permanece na conta de origem; os demais ativos podem ser migrados." : "The transfer failed in simulation. The balance remains in the source account; the other assets can be migrated."}</p>
    <ul>{blocked.map(entry => <li key={entry.id}>{entry.label}</li>)}</ul>
  </div>;
}
export const batchHasFollowups = (plan?: BatchPlan) => !!plan?.entries.some(e => e.status === "individual" || e.status === "later" || e.later.length > 0);
const laterOf = (plan: BatchPlan) => plan.entries.filter(e => e.status === "later" || (e.status === "included" && e.later.length));
function outcomeText(e: BatchEntry, lang: Lang) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  return e.outcome === "basket" ? t(e.receives.length ? "Retira BRL e transfere o NFT" : "Transfere o NFT da cesta", e.receives.length ? "Withdraw BRL and transfer the NFT" : "Transfer the basket NFT")
    : e.outcome === "shares" ? t("As cotas vão para o destino, sem resgate", "Shares will go to the destination, not redeemed")
    : e.outcome === "queued" ? t("Cria o pedido de saque do cartão; os fundos chegam só depois da espera", "Creates the card withdrawal request; funds arrive only after the waiting period")
    : t("Vai para o destino", "Will go to the destination");
}
function statusText(e: BatchEntry, lang: Lang) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  return e.transferBlocked ? t("Transferência bloqueada · saldo permanece na conta", "Transfer blocked · balance remains in the account") : e.status === "individual" ? t("Fora deste lote: retire individualmente", "Not in this batch: withdraw individually")
    : e.status === "later" ? t("Fora deste lote: depende de uma etapa posterior", "Not in this batch: needs a later step")
    : e.status === "empty" ? t("Sem saldo agora", "No balance now") : t("Neste lote", "In this batch");
}
function Notes({ entry: e, lang }: { entry: BatchEntry; lang: Lang }) {
  const lines = [...e.notes, ...e.later];
  if (!lines.length) return null;
  return <details className="batch-notes small"><summary>{lang === "pt" ? "Por quê / detalhes (inglês)" : "Why / details"}</summary><ul>{lines.map(line => <li key={line}>{line}</li>)}</ul></details>;
}

// After a confirmed batch: what was not part of it stays visible with its next step.
export function Leftovers({ plan, items, lang, openItem, showParts = true }: { showParts?: boolean; plan: BatchPlan; items: MigrationItem[]; lang: Lang; openItem: (item: MigrationItem) => void }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const rest = plan.entries.filter(e => e.status === "individual" || e.status === "later");
  const remainingParts = showParts ? Math.max(0, plan.parts.length - 1) : 0;
  if (!rest.length && !remainingParts && !plan.entries.some(e => e.status === "included" && e.later.length)) return null;
  return <div className={`batch-later${rest.some(entry => entry.transferBlocked) ? " has-blocked" : ""}`}>
    <strong>{t("Ainda falta nesta rede", "Still to do on this network")}</strong>
    {remainingParts > 0 && <p className="small">{t(`${remainingParts} parte(s) do lote ainda não enviada(s). Revise o que resta para continuar.`, `${remainingParts} batch part(s) not sent yet. Review what remains to continue.`)}</p>}
    <ul className="batch-entries">{rest.map(e => { const item = items.find(i => i.id === e.id); return <li key={e.id}>
      <div className={`batch-entry-head${e.transferBlocked ? " migration-error" : ""}`}><strong>{e.label}</strong><em className="token-badge">{statusText(e, lang)}</em>
        {item && e.status === "individual" && !e.transferBlocked && <button type="button" className="table-action" onClick={() => openItem(item)}>{t("Abrir", "Open")}</button>}</div>
      <Notes entry={e} lang={lang} /></li>; })}</ul>
    {plan.entries.some(e => e.status === "included" && e.later.length) && <ul className="small">{plan.entries.filter(e => e.status === "included" && e.later.length).map(e => <li key={e.id}>
      {e.outcome === "queued" ? t(`${e.label}: pedido criado. Execute-o pela linha do cartão depois da espera.`, `${e.label}: request created. Execute it from the card row after the waiting period.`)
        : t(`${e.label}: há uma etapa posterior opcional (detalhes no item).`, `${e.label}: an optional later step remains (see item details).`)}</li>)}</ul>}
  </div>;
}

export function PlanView({ plan, snapshot, action, safeTxHash, wallet, lang, sent, items, openItem, amount }: {
  plan: BatchPlan; snapshot: AccountSnapshot; action?: PreparedAction; safeTxHash?: Hex; wallet?: Address; lang: Lang; sent: number;
  items: MigrationItem[]; openItem: (item: MigrationItem) => void; amount: (r: Receive) => string;
}) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const chain = chainById(plan.chainId);
  const now = includedEntries(plan, 0);
  const outside = plan.entries.filter(e => e.status === "individual" || e.status === "later" || (plan.unavailable && e.status !== "empty"));
  const empty = plan.entries.filter(e => e.status === "empty");
  const owner = !!wallet && snapshot.owners.some(o => same(o, wallet));
  const multisend = action?.operation === 1 ? approvedMultiSend(plan.chainId, action.call.to) : undefined;
  const item = (id: string) => items.find(i => i.id === id);
  return <div className="batch-plan">
    {plan.unavailable && <div className="note" role="note"><strong>{plan.unavailable === "eoa" ? t("Conta antiga sem Safe: sem transação agrupada", "Legacy account without a Safe: no grouped transaction")
      : plan.unavailable === "multisend" ? t("Lote indisponível nesta rede", "Batch unavailable on this network") : t("Conta exige revisão de compatibilidade", "Account needs a compatibility review")}</strong>
      <p className="small">{plan.unavailable === "eoa" ? t("Uma carteira comum não agrupa operações com segurança. Retire cada ativo individualmente; cada retirada é uma transação própria.", "A plain wallet cannot safely group operations. Withdraw each asset individually; each withdrawal is its own transaction.")
        : plan.unavailable === "multisend" ? t("O contrato oficial de lote da Safe não foi verificado nesta rede pelo RPC. Retire cada ativo individualmente.", "Safe's official batch contract could not be verified on this network through the RPC. Withdraw each asset individually.")
        : t("Retire individualmente após a revisão.", "Withdraw individually after review.")}</p></div>}
    {now.length > 0 && action && <>
      <h3>{t("Nesta transação", "In this transaction")}{plan.parts.length > 1 || sent > 0 ? ` · ${t("parte", "part")} ${sent + 1} ${t("de", "of")} ${sent + plan.parts.length}` : ""}</h3>
      {plan.parts.length > 1 && <p className="note small" role="note">{t(`Exceção: este lote é grande demais para uma única transação segura e foi dividido em ${plan.parts.length} partes. Cada parte é revisada e confirmada separadamente; as demais aparecem depois desta.`, `Exception: this batch is too large for one safe transaction and was split into ${plan.parts.length} parts. Each part is reviewed and confirmed separately; the others follow this one.`)}</p>}
      <ul className="batch-entries">{now.map(e => <li key={e.id} className={`batch-entry ${e.outcome}`}>
        <div className="batch-entry-head"><strong>{e.label}</strong><em className={`token-badge outcome-${e.outcome}`}>{outcomeText(e, lang)}</em></div>
        {e.receives.length > 0 && <ul className="batch-amounts">{e.receives.map((r, i) => <li key={i}><span className="numeric">{amount(r)}</span></li>)}</ul>}
        {e.outcome === "queued" && <p className="small">{t("Os fundos do cartão não chegam nesta transação. Depois da espera do contrato, execute o pedido pela linha do cartão.", "Card funds do not arrive in this transaction. After the contract waiting period, execute the request from the card row.")}</p>}
        {e.outcome === "basket" && <p className="small">{t(e.receives.length ? "O BRL vai para o destino. Depois, o NFT vai para o mesmo endereço com os demais ativos dentro, na mesma transação." : "O NFT vai para o destino com todos os ativos dentro.", e.receives.length ? "BRL goes to the destination. Then the NFT goes to the same address with the remaining assets inside, in the same transaction." : "The NFT goes to the destination with all its assets inside.")}</p>}
        {item(e.id)?.basketId !== undefined && <BasketContentsView contents={item(e.id)!.contents} lang={lang} compact />}
        <Notes entry={e} lang={lang} />
      </li>)}</ul>
      <dl className="batch-facts">
        <dt>{t("Rede", "Network")}</dt><dd>{chain.name}</dd>
        <dt>{t("De", "From")}</dt><dd className="mono">{plan.account}</dd>
        <dt>{t("Para", "To")}</dt><dd className="mono">{plan.destination}</dd>
        <dt>{t("Na sua carteira", "In your wallet")}</dt><dd>{snapshot.threshold === 1n && owner ? t("Uma confirmação de transação, sem assinatura separada. A carteira conectada paga a taxa.", "One transaction confirmation, no separate signature. The connected wallet pays the fee.")
          : snapshot.threshold > 1n ? t(`Esta Safe exige ${snapshot.threshold} de ${snapshot.owners.length} owners. Cada owner aprova esta mesma transação; o envio final só funciona com as aprovações completas.`, `This Safe requires ${snapshot.threshold} of ${snapshot.owners.length} owners. Each owner approves this same transaction; the final execution only works once approvals are complete.`)
          : t("A carteira conectada não é owner desta Safe.", "The connected wallet is not an owner of this Safe.")}</dd>
      </dl>
      <p className="small muted">{t("Antes do envio, a transação inteira é simulada com os saldos atuais; se a simulação falhar, nada é enviado. Depois da confirmação, o recibo é conferido para cada ativo; qualquer diferença aparece aqui antes de você repetir algo.",
        "Before sending, the whole transaction is simulated with current balances; if the simulation fails, nothing is sent. After confirmation, the receipt is checked for every asset; any difference is shown here before you repeat anything.")}</p>
      <details className="batch-advanced small"><summary>{t("Detalhes técnicos", "Technical details")}</summary>
        <dl className="batch-facts">
          <dt>{t("Bloco lido", "Block read")}</dt><dd>{plan.block.toString()} ({plan.chainId})</dd>
          <dt>{t("Execução", "Execution")}</dt><dd>{multisend ? `DELEGATECALL → MultiSendCallOnly ${multisend.version} ${multisend.address} (${t("código verificado", "runtime verified")}) · ${action.batch?.calls.length} CALL` : "CALL"}</dd>
          <dt>{t("Nonce da Safe", "Safe nonce")}</dt><dd>{action.safeNonce?.toString()}</dd>
          {safeTxHash && <><dt>{t("Hash da Safe", "Safe hash")}</dt><dd className="mono">{safeTxHash}</dd></>}
        </dl>
        <ol className="batch-calls">{action.batch?.calls.map((call, i) => <li key={i}>{action.batch!.labels[i]} <span className="mono muted">→ {call.to}{call.value ? ` · ${call.value} wei` : ""}</span></li>)}</ol>
        <ul>{now.flatMap(e => e.receives.map((r, i) => <li key={`${e.id}:${i}`} className="mono">{r.token ?? chain.nativeCurrency.symbol} · {t("mínimo bruto", "raw minimum")} {r.minimum.toString()}</li>))}</ul>
        <p className="mono break">{action.call.data}</p>
      </details>
    </>}
    {now.length === 0 && !plan.unavailable && <p className="small muted">{sent > 0 ? t("Nenhum saldo restante para agrupar nesta rede.", "No balance left to group on this network.") : t("Nada para agrupar agora nesta rede.", "Nothing to group now on this network.")}</p>}
    {outside.length > 0 && <div className="batch-group"><h4>{t("Fora desta transação", "Not in this transaction")}</h4><ul className="batch-entries">{outside.map(e => <li key={e.id}>
      <div className="batch-entry-head"><strong>{e.label}</strong><em className="token-badge">{plan.unavailable ? t("Retire individualmente", "Withdraw individually") : statusText(e, lang)}</em>
        {item(e.id) && !e.transferBlocked && (e.status === "individual" || plan.unavailable) && <button type="button" className="table-action" onClick={() => openItem(item(e.id)!)}>{t("Abrir", "Open")}</button>}</div>
      <Notes entry={e} lang={lang} /></li>)}</ul></div>}
    {laterOf(plan).some(e => e.status === "included") && <p className="small">{t("Alguns itens deste lote têm uma etapa posterior (pedidos do cartão, recompensas ou resgates). Ela continua listada depois da confirmação.", "Some items in this batch have a later step (card requests, rewards or redemptions). It stays listed after confirmation.")}</p>}
    {empty.length > 0 && <p className="small muted">{t("Sem saldo agora", "No balance now")}: {empty.map(e => e.label).join(", ")}</p>}
  </div>;
}
