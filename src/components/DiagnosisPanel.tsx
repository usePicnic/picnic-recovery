import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { chains, chainById } from "../catalog/chains";
import { hasAssets, nextAction, type NetworkDiagnosis, type TokenHolding, type WalletGas } from "../core/diagnosis";
import { validateRpc } from "../core/client";
import { rpcFor, type CustomTokenState, type RpcOverrides } from "./useDiagnosis";
import { WalletButton } from "./WalletProvider";
import { AssetTable } from "./AssetTable";
import { ChainLogo } from "./ChainLogo";

type Props = {
  account: string; setAccount: (value: string) => void; onUseWallet: () => void; wallet?: Address; lang: "pt" | "en"; busy: boolean;
  results: NetworkDiagnosis[]; gas: Record<number, WalletGas>; overrides: RpcOverrides;
  setRpc: (id: number, value: string) => void; rescan: (id?: number) => void;
  open: (result: NetworkDiagnosis, step: 1 | 2 | 3, tab?: string, token?: TokenHolding) => void;
  custom: CustomTokenState[]; addCustom: Parameters<typeof AssetTable>[0]["addCustom"];
  removeCustom: (chainId: number, token: Address) => void; retryCustom: (chainId: number, token: Address) => void;
};
export function DiagnosisPanel({ account, setAccount, onUseWallet, wallet, lang, busy, results, gas, overrides, setRpc, rescan, open, custom, addCustom, removeCustom, retryCustom }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const finished = results.filter(r => !["queued", "scanning"].includes(r.status)).length;
  // Custom balances participate in network guidance without duplicating their
  // separate table rows or changing the automatic catalogue's coverage counts.
  const networkResults = results.map(result => ({
    ...result,
    tokens: [...result.tokens, ...custom.flatMap(item => item.status === "ready" && item.token && item.chainId === result.chainId
      && item.token.account.toLowerCase() === result.account.toLowerCase() && item.token.balance > 0n ? [item.token] : [])],
  }));
  const ordered = networkResults.sort((a, b) => Number(hasAssets(b)) - Number(hasAssets(a)) || Number(!!b.snapshot?.recoveries.length) - Number(!!a.snapshot?.recoveries.length) || chains.findIndex(c => c.id === a.chainId) - chains.findIndex(c => c.id === b.chainId));
  const separate = !!account && (!wallet || account.toLowerCase() !== wallet.toLowerCase());
  const [manual, setManual] = useState(separate);
  return <section className="panel diagnosis">
    <p className="eyebrow">{t("PASSO 0 / DIAGNÓSTICO AUTOMÁTICO", "STEP 0 / AUTOMATIC DIAGNOSIS")}</p>
    <h2>{t("Uma conta. Todas as redes.", "One account. Every network.")}</h2>
    <div className="connect-card">
      <div>
        <strong>{wallet ? t("Carteira conectada", "Wallet connected") : t("Comece conectando sua carteira", "Start by connecting your wallet")}</strong>
        <p>{wallet ? <span className="mono">{wallet}</span> : t("O endereço é lido da carteira e as 10 redes são consultadas automaticamente. Só leitura: nenhuma assinatura é pedida.", "The address is read from your wallet and all 10 networks are checked automatically. Read-only: no signature is requested.")}</p>
      </div>
      <WalletButton busy={busy} lang={lang} primary={!wallet} />
    </div>
    {separate && account && <p className="note">{t("Consultando outro endereço", "Inspecting a different address")}: <span className="mono">{account}</span>
      {wallet && <> · <button className="text-button" disabled={busy} onClick={onUseWallet}>{t("Voltar para a carteira conectada", "Back to the connected wallet")}</button></>}</p>}
    <details className="advanced-account" open={manual} onToggle={e => setManual(e.currentTarget.open)}>
      <summary>{t("Avançado: consultar uma Safe, cartão ou controlador com outro endereço", "Advanced: inspect a Safe, card or controller at another address")}</summary>
      <p className="small muted">{t("A carteira que assina pode não ser a conta que guarda os ativos. Informe aqui o endereço da Safe, do cartão ou do controlador. A consulta continua sendo só leitura.", "The signing wallet may not be the account holding the assets. Enter the Safe, card or controller address here. The scan remains read-only.")}</p>
      <label className="field"><span>{t("Endereço a consultar", "Address to inspect")}</span><input value={account} disabled={busy} placeholder="0x…" spellCheck={false} autoComplete="off" onChange={e => setAccount(e.target.value)} /></label>
    </details>
    {results.length > 0 && <div className="diagnosis-progress" role="status" aria-live="polite">{finished < results.length
      ? t(`Verificando ${results.length} redes em segundo plano · ${finished} concluídas`, `Checking ${results.length} networks in the background · ${finished} finished`)
      : t("Consulta concluída. Confira os ativos e os próximos passos.", "Scan finished. Review assets and next steps.")}</div>}
    <AssetTable lang={lang} busy={busy} ready={results.length > 0} results={results} custom={custom} open={open} addCustom={addCustom} removeCustom={removeCustom} retryCustom={retryCustom} />
    {results.length > 0 && <section className="networks" aria-labelledby="networks-title">
      <div className="section-title"><h3 id="networks-title">{t("Redes e próximos passos", "Networks and next steps")}</h3>
        <button className="text-button" disabled={busy} onClick={() => rescan()}>{t("Atualizar todas", "Refresh all")}</button></div>
      <ul className="network-list">{ordered.map(result => <NetworkRow key={result.chainId} result={result} wallet={wallet} gas={gas[result.chainId]} lang={lang} busy={busy} open={open} rescan={rescan} setAccount={setAccount} />)}</ul>
    </section>}
    <p className="note">{t("A consulta cobre o saldo nativo, tokens do catálogo local, tokens que você adicionar, investimentos conhecidos e propriedade de cestas. Não é um inventário universal: ativos fora do catálogo, conteúdo interno das cestas e contas com outro endereço podem exigir inspeção adicional. Resultados parciais nunca significam saldo zero.", "The scan covers native balances, local-catalogue tokens, tokens you add, known investments and basket ownership. Assets outside the catalogue, basket contents and other account addresses may need further inspection. Partial results never mean zero balance.")}</p>
    <details><summary>{t("Avançado: RPCs de consulta", "Advanced: read RPCs")}</summary>
      <p className="small muted">{t("Sem RPC próprio, as consultas usam RPCs públicos e podem alternar entre eles após confirmar a rede (chain ID). Um RPC informado aqui é usado sozinho, também para transações. As URLs não são salvas nem exportadas.", "Without a custom RPC, reads use public RPCs and may switch between them after confirming the chain ID. An RPC entered here is used alone, also for transactions. URLs are not saved or exported.")}</p>
      {chains.map(chain => <RpcField key={`${chain.id}:${rpcFor(chain.id, overrides)}`} label={chain.name} value={rpcFor(chain.id, overrides)} disabled={busy} apply={value => setRpc(chain.id, value)} lang={lang} />)}
    </details>
  </section>;
}

function NetworkRow({ result, wallet, gas, lang, busy, open, rescan, setAccount }: {
  result: NetworkDiagnosis; wallet?: Address; gas?: WalletGas; lang: "pt" | "en"; busy: boolean;
  open: Props["open"]; rescan: (id?: number) => void; setAccount: (value: string) => void;
}) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const chain = chainById(result.chainId), action = nextAction(result, wallet, gas);
  const waiting = result.snapshot?.recoveries.find(r => r.pending.executeAfter > 0n);
  const done = result.status !== "queued" && result.status !== "scanning";
  const messages = {
    unverified: t("Aguardando verificação da conta.", "Awaiting account verification."),
    unsupported: t("Contrato identificado, mas esta versão exige revisão antes de movimentar.", "Contract found, but this version needs review before moving funds."),
    waiting: t("Recovery em andamento. Aguarde o prazo do contrato.", "Recovery in progress. Wait for the contract delay."),
    finalize: t("O prazo do recovery terminou. Revise a finalização.", "The recovery delay has elapsed. Review finalization."),
    connect: t("Conecte sua carteira para verificar acesso e gás nesta rede.", "Connect your wallet to check access and gas on this network."),
    fund: t(`A carteira conectada é owner, mas precisa de ${chain.nativeCurrency.symbol} para taxas.`, `Your connected wallet is an owner, but needs ${chain.nativeCurrency.symbol} for fees.`),
    prepare: t("A carteira conectada é owner. Prepare o destino e confira as taxas.", "Your connected wallet is an owner. Prepare the destination and check fees."),
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
  const status = result.status === "queued" ? t("Na fila", "Queued") : result.status === "scanning" ? t("Consultando…", "Scanning…")
    : result.status === "partial" ? t("Consulta parcial", "Partial scan") : result.status === "unavailable" ? t("Não verificada", "Unverified") : t("Verificada", "Checked");
  return <li className="network-row">
    <div className="network-head">
      <span className="network-cell"><ChainLogo id={chain.id} size={26} /><strong>{chain.name}</strong></span>
      <span className={`chip ${result.status === "partial" || result.status === "unavailable" ? "diagnosis-warning" : result.status === "complete" ? "diagnosis-ok" : ""}`}>{status}</span>
    </div>
    <p className="diagnosis-next">{result.status === "unavailable" ? t("A rede não respondeu ou a conta não pôde ser interpretada. Tente novamente ou configure outro RPC.", "The network did not respond or the account could not be interpreted. Retry or configure another RPC.") : messages[action]}</p>
    {result.cards.length > 0 && <p className="note">{t("Este endereço é uma Safe de cartão. Recupere o controlador antes de retirar pelo cartão.", "This address is a card Safe. Recover its controller before withdrawing through the card.")}</p>}
    {waiting && <p className="small">{t("Finalização a partir de", "Earliest finalization")}: {new Date(Number(waiting.pending.executeAfter) * 1000).toLocaleString(lang)}</p>}
    <p className="small muted network-meta">
      {result.totalTokens > 0 && <span>{result.checkedTokens}/{result.totalTokens} {t("tokens consultados", "tokens checked")}</span>}
      {wallet && <span>{t("Gás da carteira", "Wallet gas")}: {gas?.balance !== undefined ? `${formatUnits(gas.balance, chain.nativeCurrency.decimals)} ${chain.nativeCurrency.symbol}` : gas?.error ? t("não verificado", "unverified") : t("consultando…", "checking…")}</span>}
      {result.sources.length > 0 && <span>{t("Fonte", "Source")}: {result.sources.join(", ")}</span>}
    </p>
    {gaps.length > 0 && <div className="gaps" role="note"><strong>{t("O que ainda não foi verificado", "What is still unverified")}</strong><ul>{gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul></div>}
    {unreadable > 0 && <details className="small"><summary>{t(`${unreadable} contrato(s) do catálogo recusam a leitura de saldo`, `${unreadable} catalogue contract(s) refuse balance reads`)}</summary>
      <p className="small muted">{t("O próprio contrato reverte balanceOf neste bloco (por exemplo, um token desativado). A rede respondeu; o saldo nesses contratos é desconhecido.", "The contract itself reverts balanceOf at this block (for example, a disabled token). The network answered; the balance in these contracts is unknown.")}</p>
      {result.unreadableTokens.slice(0, 20).map(token => <p key={token.address} className="small mono">{token.symbol ?? token.name} · {token.address}</p>)}
    </details>}
    {repinned && <p className="small muted">{t(`Saldos de tokens lidos nos blocos ${result.tokenBlocks!.from}–${result.tokenBlocks!.to}; a conta foi lida no bloco ${result.snapshot!.block}. O RPC não mantinha o estado antigo, então os tokens foram lidos em um bloco mais recente.`, `Token balances read at blocks ${result.tokenBlocks!.from}–${result.tokenBlocks!.to}; the account was read at block ${result.snapshot!.block}. The RPC no longer kept that state, so tokens were read at a newer block.`)}</p>}
    <div className="row">
      {result.snapshot && action !== "unsupported" && <button className="outline" disabled={busy} onClick={() => open(result, ["waiting", "finalize", "recover", "owner-required", "connect"].includes(action) ? 1 : 2)}>{["waiting", "finalize", "recover"].includes(action) ? t("Ver recuperação", "View recovery") : t("Ver próximos passos", "View next steps")}</button>}
      {result.cards.map(card => card.controllers.map(controller => <button key={`${card.address}:${controller}`} className="text-button" disabled={busy} onClick={() => setAccount(controller)}>{t("Diagnosticar controlador", "Diagnose controller")}: {controller.slice(0, 8)}…</button>))}
      {["partial", "unavailable"].includes(result.status) && <button className="text-button" disabled={busy} onClick={() => rescan(chain.id)}>{t("Tentar novamente", "Retry")}</button>}
    </div>
  </li>;
}

function RpcField({ label, value, apply, disabled, lang }: { label: string; value: string; apply: (value: string) => void; disabled: boolean; lang: "pt" | "en" }) {
  const [draft, setDraft] = useState(value), [error, setError] = useState("");
  return <div className="rpc-field"><label className="field"><span>{label} RPC</span><input type="url" value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} /></label>
    <button className="outline" disabled={disabled || draft === value} onClick={() => { try { apply(validateRpc(draft)); setError(""); } catch { setError(lang === "pt" ? "Use HTTPS ou um RPC local válido." : "Use HTTPS or a valid local RPC."); } }}>{lang === "pt" ? "Aplicar" : "Apply"}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
