import { useState, type ReactNode } from "react";
import { type Address } from "viem";
import { chains, chainById } from "../catalog/chains";
import { hasAssets, type NetworkDiagnosis, type TokenHolding } from "../core/diagnosis";
import { validateRpc } from "../core/client";
import { rpcFor, type CustomTokenState, type RpcOverrides } from "./useDiagnosis";
import { DiagnosisOverview } from "./DiagnosisOverview";
import { LinkedAccounts } from "./LinkedAccounts";
import { AssetTable } from "./AssetTable";
import { ChainLogo } from "./ChainLogo";
import { diagnosisAction, diagnosisNext, needsAttention, withCustomHoldings } from "./diagnosisFlow";

type Props = {
  account: string; wallet?: Address; picnicAccount?: Address; identifying?: boolean; lang: "pt" | "en"; busy: boolean;
  results: NetworkDiagnosis[]; recovery?: ReactNode; overrides: RpcOverrides;
  setRpc: (id: number, value: string) => void; rescan: (id?: number) => void; retryPending: (id: number) => void;
  open: (result: NetworkDiagnosis, step: 1 | 2 | 3, tab?: string, token?: TokenHolding) => void;
  custom: CustomTokenState[]; addCustom: Parameters<typeof AssetTable>[0]["addCustom"]; baskets?: Parameters<typeof AssetTable>[0]["baskets"];
  removeCustom: (chainId: number, token: Address) => void; retryCustom: (chainId: number, token: Address) => void;
};
export function DiagnosisPanel({ account, wallet, picnicAccount, identifying, lang, busy, results, recovery, overrides, setRpc, rescan, retryPending, open, custom, addCustom, removeCustom, retryCustom, baskets }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const finished = results.filter(r => !["queued", "scanning"].includes(r.status)).length;
  const scanning = results.length > 0 && finished < results.length;
  const loading = scanning || custom.some(item => item.status === "loading");
  const waitingToContinue = loading || !!identifying || busy;
  const networkResults = withCustomHoldings(results, custom);
  const ordered = networkResults.sort((a, b) => Number(hasAssets(b)) - Number(hasAssets(a)) || Number(!!b.snapshot?.recoveries.length) - Number(!!a.snapshot?.recoveries.length) || chains.findIndex(c => c.id === a.chainId) - chains.findIndex(c => c.id === b.chainId));
  const pending = ordered.filter(result => needsAttention(result, wallet));
  const incomplete = pending.filter(result => result.status === "partial" || result.status === "unavailable");
  const otherPending = pending.filter(result => !incomplete.includes(result) || ["recover", "waiting", "finalize", "owner-required", "unsupported"].includes(diagnosisAction(result, wallet)));
  const customErrors = custom.filter(item => item.status === "error");
  const pendingCount = otherPending.length + (incomplete.length > 0 ? 1 : 0) + customErrors.length;
  const continuation = diagnosisNext(results, wallet, custom);
  const [view, setView] = useState<"assets" | "pending">("assets");
  return <section className="panel diagnosis">
    <p className="eyebrow">{t("PASSO 0 / DIAGNÓSTICO AUTOMÁTICO", "STEP 0 / AUTOMATIC DIAGNOSIS")}</p>
    <h2>{t("Uma conta. Todas as redes.", "One account. Every network.")}</h2>
    <LinkedAccounts compact account={account} wallet={wallet} picnicAccount={picnicAccount} identifying={identifying} results={results} busy={busy} lang={lang} />
    {results.length > 0 && <DiagnosisOverview results={results} custom={custom} pendingCount={pendingCount} lang={lang} />}
    {recovery}
    {(results.length > 0 || identifying) && !recovery && <div className="diagnosis-continue">
      <p className="small muted">{waitingToContinue ? t("Aguarde a consulta terminar para continuar.", "Wait for the scan to finish before continuing.")
        : continuation ? continuation.step === 1 ? t("A seguir: recuperar ou confirmar o acesso à conta.", "Next: recover or confirm account access.") : t("A seguir: preparar o destino e o saldo para as taxas.", "Next: prepare the destination and fee balance.")
        : t("Ainda não foi possível verificar uma conta compatível. Confira as pendências e tente atualizar a consulta em Avançado.", "A supported account could not be verified yet. Review the issues and retry the scan under Advanced.")}</p>
      <button className="next-step" aria-busy={waitingToContinue} disabled={waitingToContinue || !continuation} onClick={() => { if (continuation) open(continuation.result, continuation.step); }}>
        {waitingToContinue && <span className="scan-spinner" aria-hidden="true" />}
        {waitingToContinue ? t("Aguarde a verificação…", "Checking your accounts…") : t("Próximo passo →", "Next step →")}
      </button>
    </div>}
    {results.length > 0 && <details className="diagnosis-details">
      <summary>{t("Ver ativos e pendências em detalhe", "View assets and issues in detail")}{pendingCount > 0 && <span className="tab-count">{pendingCount}</span>}</summary>
    <div className="diagnosis-tabs" role="tablist" aria-label={t("Resultado do diagnóstico", "Diagnosis results")}>
      {(["assets", "pending"] as const).map((id, i) => <button key={id} type="button" role="tab" id={`diagnosis-${id}-tab`} aria-controls={`diagnosis-${id}`} aria-selected={view === id} tabIndex={view === id ? 0 : -1}
        onClick={() => setView(id)} onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - i;
          setView(next === 0 ? "assets" : "pending");
          (event.currentTarget.parentElement?.querySelectorAll("button")[next] as HTMLButtonElement | undefined)?.focus();
        }}>{id === "assets" ? t("Ativos", "Assets") : <>{t("Pendências", "Needs attention")} <span className="tab-count">{pendingCount}</span></>}</button>)}
    </div>
    <div id="diagnosis-assets" role="tabpanel" aria-labelledby="diagnosis-assets-tab" hidden={view !== "assets"}>
      <AssetTable lang={lang} busy={busy} ready={results.length > 0} results={results} custom={custom} open={open} addCustom={addCustom} removeCustom={removeCustom} retryCustom={retryCustom} showActions={false} baskets={baskets} />
    </div>
    <div id="diagnosis-pending" role="tabpanel" aria-labelledby="diagnosis-pending-tab" hidden={view !== "pending"}>
      <p className="small muted">{t("O que precisa de atenção antes de continuar.", "What needs attention before continuing.")}</p>
      {pending.length + customErrors.length > 0 ? <ul className="network-list">
        {otherPending.map(result => <NetworkRow key={result.chainId} result={result} wallet={wallet} lang={lang} />)}
        {incomplete.length > 0 && <li className="network-row">
          <strong>{t("Concluir a verificação de saldos", "Complete balance verification")}</strong>
          <p className="small">{t("Parte das consultas não pôde ser concluída. Os saldos encontrados continuam na tabela; os demais são desconhecidos, não zero. Tente novamente apenas o que falta, sem apagar os resultados.", "Some checks could not be completed. Confirmed balances remain in the table; the others are unknown, not zero. Retry only what is missing, keeping the results already found.")}</p>
          <div className="pending-networks">{incomplete.map(result => <span className="network-cell small" key={result.chainId}><ChainLogo id={result.chainId} size={20} />{chainById(result.chainId).name}</span>)}</div>
          <details open><summary>{t("Ver o que falta em cada rede", "See what is missing on each network")}</summary>
            <ul className="network-list">{incomplete.map(result => <NetworkRow key={result.chainId} result={result} wallet={wallet} lang={lang} />)}</ul>
            <div className="row">{incomplete.map(result => <button key={result.chainId} className="secondary" disabled={busy || loading} onClick={() => retryPending(result.chainId)}>{t("Tentar concluir", "Retry remaining checks on")} {chainById(result.chainId).name}</button>)}</div>
          </details>
        </li>}
        {customErrors.map(item => <li className="network-row" key={`${item.chainId}:${item.address}`}><strong>{t("Verificar token adicionado", "Check added token")}</strong>
          <p className="small">{chainById(item.chainId).name} · <span className="mono">{item.address}</span></p>
          <p className="small muted">{t("O saldo não pôde ser confirmado. Veja o motivo e tente novamente em Ativos → Gerenciar tokens adicionados.", "The balance could not be confirmed. See the reason and retry under Assets → Manage added tokens.")}</p></li>)}
      </ul> : <p className="empty-assets">{!results.length ? t("Conecte uma carteira para verificar as pendências.", "Connect a wallet to check for issues.") : loading ? t("As pendências aparecerão conforme a consulta avançar.", "Items needing attention will appear as the scan progresses.") : t("Nenhuma pendência identificada nas verificações realizadas.", "No issues identified in the completed checks.")}</p>}
    </div>
    </details>}
    <details className="diagnosis-coverage"><summary>{t("O que esta consulta cobre", "What this scan covers")}</summary>
    <p className="note">{t("A consulta cobre o saldo nativo, tokens do catálogo local, tokens que você adicionar, investimentos conhecidos e propriedade de cestas. Não é um inventário universal: ativos fora do catálogo, conteúdo interno das cestas e contas com outro endereço podem exigir inspeção adicional. Resultados parciais nunca significam saldo zero.", "The scan covers native balances, local-catalogue tokens, tokens you add, known investments and basket ownership. Assets outside the catalogue, basket contents and other account addresses may need further inspection. Partial results never mean zero balance.")}</p>
    </details>
    <details><summary>{t("Avançado: RPCs de consulta", "Advanced: read RPCs")}</summary>
      <button className="text-button" disabled={busy || loading || !results.length} onClick={() => rescan()}>{t("Atualizar diagnóstico", "Refresh diagnosis")}</button>
      <p className="small muted">{t("Sem RPC próprio, as consultas usam RPCs públicos e podem alternar entre eles após confirmar a rede (chain ID). Um RPC informado aqui é usado sozinho, também para transações. As URLs não são salvas nem exportadas.", "Without a custom RPC, reads use public RPCs and may switch between them after confirming the chain ID. An RPC entered here is used alone, also for transactions. URLs are not saved or exported.")}</p>
      {chains.map(chain => <RpcField key={`${chain.id}:${rpcFor(chain.id, overrides)}`} label={chain.name} value={rpcFor(chain.id, overrides)} disabled={busy} apply={value => setRpc(chain.id, value)} lang={lang} />)}
    </details>
  </section>;
}

function NetworkRow({ result, wallet, lang }: {
  result: NetworkDiagnosis; wallet?: Address; lang: "pt" | "en";
}) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const chain = chainById(result.chainId), action = diagnosisAction(result, wallet);
  const waiting = result.snapshot?.recoveries.find(r => r.pending.executeAfter > 0n);
  const done = result.status !== "queued" && result.status !== "scanning";
  const messages = {
    unverified: t("Aguardando verificação da conta.", "Awaiting account verification."),
    unsupported: t("Contrato identificado, mas esta versão exige revisão antes de movimentar.", "Contract found, but this version needs review before moving funds."),
    waiting: t("Recovery em andamento. Aguarde o prazo do contrato.", "Recovery in progress. Wait for the contract delay."),
    finalize: t("O prazo do recovery terminou. Revise a finalização.", "The recovery delay has elapsed. Review finalization."),
    connect: t("Conecte a carteira que controla esta conta.", "Connect the wallet that controls this account."),
    prepare: t("A carteira conectada controla esta conta.", "The connected wallet controls this account."),
    recover: t("Há recuperação configurada. Use um guardian válido ou conecte uma carteira owner.", "Recovery is configured. Use a valid guardian or connect an owner wallet."),
    "owner-required": t("A carteira conectada não controla esta conta. É necessária a carteira owner.", "The connected wallet does not control this account. An owner wallet is required."),
    "no-findings": t("Nenhum saldo encontrado nos contratos que responderam. Leituras não verificadas estão indicadas abaixo.", "No balance found in contracts that answered. Unverified reads are listed below."),
  };
  const unchecked = done && result.totalTokens > result.checkedTokens ? result.totalTokens - result.checkedTokens : 0;
  // Precisely what is unknown. Each line is a reason the scan is not complete.
  const gaps = [
    result.failedTokens > 0 && t(`${result.failedTokens} token(s) do catálogo sem resposta do RPC: saldo desconhecido, não zero.`, `${result.failedTokens} catalogue token(s) got no RPC answer: balance unknown, not zero.`),
    unchecked > 0 && t(`A consulta parou após ${result.checkedTokens} de ${result.totalTokens} tokens; ${unchecked} não foram consultados.`, `The scan stopped after ${result.checkedTokens} of ${result.totalTokens} tokens; ${unchecked} were not checked.`),
    ...result.issues.map(issue => `${t("Não verificado", "Not verified")}: ${issue}`),
  ].filter((line): line is string => !!line);
  const unreadable = result.unreadableTokens.length;
  const repinned = result.tokenBlocks && result.snapshot && result.tokenBlocks.to !== result.snapshot.block;
  const title = action === "waiting" ? t("Aguardar o prazo de recuperação", "Wait for the recovery delay")
    : action === "finalize" ? t("Finalizar a recuperação", "Finalize recovery")
    : action === "recover" ? t("Recuperar o acesso", "Recover access")
    : action === "owner-required" || action === "connect" ? t("Confirmar a carteira que controla a conta", "Confirm the wallet controlling the account")
    : action === "unsupported" ? t("Revisar a compatibilidade da conta", "Review account compatibility")
    : result.status === "partial" || result.status === "unavailable" ? t("Concluir a verificação", "Complete verification")
    : unreadable > 0 ? t("Conferir saldos não verificados", "Review unverified balances")
    : t("Conferir o tipo de acesso", "Review account access");
  return <li className="network-row">
    <div className="network-head">
      <strong>{title}</strong>
      <span className="network-cell small"><ChainLogo id={chain.id} size={20} />{chain.name}</span>
    </div>
    <p className="diagnosis-next">{result.status === "unavailable" ? t("A rede não respondeu ou a conta não pôde ser interpretada. Tente novamente ou configure outro RPC.", "The network did not respond or the account could not be interpreted. Retry or configure another RPC.") : messages[action === "fund" ? "prepare" : action]}</p>
    {result.snapshot?.passkey === "unknown" && <p className="small muted">{t("O tipo de acesso não pôde ser confirmado. Não identificamos um signer de passkey compatível.", "The access type could not be confirmed. No supported passkey signer was identified.")}</p>}
    {result.cards.length > 0 && <p className="note">{t("Este endereço é uma Safe de cartão. Recupere o controlador antes de retirar pelo cartão.", "This address is a card Safe. Recover its controller before withdrawing through the card.")}</p>}
    {waiting && <p className="small">{t("Finalização a partir de", "Earliest finalization")}: {new Date(Number(waiting.pending.executeAfter) * 1000).toLocaleString(lang)}</p>}
    <details className="pending-details" open={result.status === "partial" || result.status === "unavailable"}><summary>{t("Ver detalhes", "View details")}</summary>
    <p className="small muted network-meta">
      {result.totalTokens > 0 && <span>{result.checkedTokens}/{result.totalTokens} {t("tokens consultados", "tokens checked")}</span>}
      {result.sources.length > 0 && <span>{t("Fonte", "Source")}: {result.sources.join(", ")}</span>}
    </p>
    {gaps.length > 0 && <div className="gaps" role="note"><strong>{t("O que ainda não foi verificado", "What is still unverified")}</strong><ul>{gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></div>}
    {unreadable > 0 && <details className="small"><summary>{t(`${unreadable} contrato(s) do catálogo recusam a leitura de saldo`, `${unreadable} catalogue contract(s) refuse balance reads`)}</summary>
      <p className="small muted">{t("O próprio contrato reverte balanceOf neste bloco (por exemplo, um token desativado). A rede respondeu; o saldo nesses contratos é desconhecido.", "The contract itself reverts balanceOf at this block (for example, a disabled token). The network answered; the balance in these contracts is unknown.")}</p>
      {result.unreadableTokens.slice(0, 20).map(token => <p key={token.address} className="small mono">{token.symbol ?? token.name} · {token.address}</p>)}
    </details>}
    {repinned && <p className="small muted">{t(`Saldos de tokens lidos nos blocos ${result.tokenBlocks!.from}–${result.tokenBlocks!.to}; a conta foi lida no bloco ${result.snapshot!.block}. O RPC não mantinha o estado antigo, então os tokens foram lidos em um bloco mais recente.`, `Token balances read at blocks ${result.tokenBlocks!.from}–${result.tokenBlocks!.to}; the account was read at block ${result.snapshot!.block}. The RPC no longer kept that state, so tokens were read at a newer block.`)}</p>}
    {result.cards.map(card => card.controllers.map(controller => <p key={`${card.address}:${controller}`} className="small">{t("Controlador", "Controller")}: <span className="mono">{controller}</span></p>))}
    </details>
  </li>;
}

function RpcField({ label, value, apply, disabled, lang }: { label: string; value: string; apply: (value: string) => void; disabled: boolean; lang: "pt" | "en" }) {
  const [draft, setDraft] = useState(value), [error, setError] = useState("");
  return <div className="rpc-field"><label className="field"><span>{label} RPC</span><input type="url" value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} /></label>
    <button className="outline" disabled={disabled || draft === value} onClick={() => { try { apply(validateRpc(draft)); setError(""); } catch { setError(lang === "pt" ? "Use HTTPS ou um RPC local válido." : "Use HTTPS or a valid local RPC."); } }}>{lang === "pt" ? "Aplicar" : "Apply"}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
