import { useState } from "react";
import { formatUnits, type Address } from "viem";
import { chains, chainById } from "../catalog/chains";
import { hasAssets, nextAction, type NetworkDiagnosis, type TokenHolding, type WalletGas } from "../core/diagnosis";
import { validateRpc } from "../core/client";
import { rpcFor, type RpcOverrides } from "./useDiagnosis";

type Props = {
  account: string; setAccount: (value: string) => void; onUseWallet: () => void; wallet?: Address; lang: "pt" | "en"; busy: boolean;
  results: NetworkDiagnosis[]; gas: Record<number, WalletGas>; overrides: RpcOverrides;
  setRpc: (id: number, value: string) => void; rescan: (id?: number) => void;
  open: (result: NetworkDiagnosis, step: 1 | 2 | 3, tab?: string, token?: TokenHolding) => void;
};
export function DiagnosisPanel({ account, setAccount, onUseWallet, wallet, lang, busy, results, gas, overrides, setRpc, rescan, open }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const finished = results.filter(r => !["queued", "scanning"].includes(r.status)).length;
  const ordered = [...results].sort((a, b) => Number(hasAssets(b)) - Number(hasAssets(a)) || Number(!!b.snapshot?.recoveries.length) - Number(!!a.snapshot?.recoveries.length) || a.chainId - b.chainId);
  return <section className="panel diagnosis">
    <p className="eyebrow">{t("PASSO 0 / DIAGNÓSTICO AUTOMÁTICO", "STEP 0 / AUTOMATIC DIAGNOSIS")}</p>
    <h2>{t("Uma conta. Todas as redes.", "One account. Every network.")}</h2>
    <p>{t("Conecte sua carteira: o endereço é preenchido e a consulta de todas as redes começa automaticamente, sem assinatura. Você também pode informar outro endereço para consultar.", "Connect your wallet: its address is filled in and every network is checked automatically, without a signature. You can also enter another address to inspect.")}</p>
    <label className="field"><span>{t("Endereço da conta Picnic ou carteira antiga", "Picnic account or legacy wallet address")}</span><input value={account} disabled={busy} placeholder="0x…" spellCheck={false} onChange={e => setAccount(e.target.value)} /></label>
    {wallet && account.toLowerCase() !== wallet.toLowerCase() && <button className="text-button" disabled={busy} onClick={onUseWallet}>{t("Usar a carteira conectada", "Use connected wallet")}</button>}
    <p className="small muted">{t("A carteira conectada pode ser só a chave de acesso. Use o endereço da conta que guarda os ativos. Cartões e contas com outro endereço precisam ser consultados também.", "The connected wallet may only be your signing key. Use the account holding the assets. Cards and accounts with a different address must also be inspected.")}</p>
    {results.length > 0 && <>
      <div className="diagnosis-progress" role="status" aria-live="polite">{finished < results.length
        ? t(`Verificando ${results.length} redes em segundo plano · ${finished} concluídas`, `Checking ${results.length} networks in the background · ${finished} finished`)
        : t("Consulta concluída. Confira os próximos passos abaixo.", "Scan finished. Review your next steps below.")}</div>
      <div className="diagnosis-results">{ordered.map(result => {
        const chain = chainById(result.chainId), action = nextAction(result, wallet, gas[result.chainId]);
        const waiting = result.snapshot?.recoveries.find(r => r.pending.executeAfter > 0n);
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
          "no-findings": t("Nenhum saldo encontrado no catálogo consultado neste endereço.", "No balance found in the scanned catalogue at this address."),
        };
        return <article className="diagnosis-row" key={result.chainId}>
          <div className="section-title"><h3>{chain.name}</h3><span className={`chip ${result.status === "partial" || result.status === "unavailable" ? "diagnosis-warning" : ""}`}>
            {result.status === "queued" ? t("Na fila", "Queued") : result.status === "scanning" ? t("Consultando…", "Scanning…") : result.status === "partial" ? t("Consulta parcial", "Partial scan") : result.status === "unavailable" ? t("Não verificada", "Unverified") : t("Verificada", "Checked")}
          </span></div>
          {result.nativeBalance !== undefined && <p className="small">{t("Saldo nativo", "Native balance")}: <strong>{formatUnits(result.nativeBalance, chain.nativeCurrency.decimals)} {chain.nativeCurrency.symbol}</strong> · {result.tokens.length} {t("tokens com saldo", "tokens with balance")} · {result.positions.length} {t("investimentos/pedidos", "investments/requests")}</p>}
          {(result.basketCount ?? 0n) > 0n && <p>{result.basketCount!.toString()} {t("cesta(s) antiga(s) para inspecionar", "legacy basket(s) to inspect")}</p>}
          {(result.strategyCount ?? 0) > 0 && <p>{result.strategyCount} {t("estratégia(s) MAMO para inspecionar", "MAMO strategies to inspect")}</p>}
          {result.cards.length > 0 && <p className="note">{t("Este endereço é uma Safe de cartão. Recupere o controlador antes de retirar pelo cartão.", "This address is a card Safe. Recover its controller before withdrawing through the card.")}</p>}
          <p className="diagnosis-next">{result.status === "unavailable" ? t("A rede não respondeu ou a conta não pôde ser interpretada. Tente novamente ou configure outro RPC.", "The network did not respond or the account could not be interpreted. Retry or configure another RPC.") : messages[action]}</p>
          {waiting && <p className="small">{t("Finalização a partir de", "Earliest finalization")}: {new Date(Number(waiting.pending.executeAfter) * 1000).toLocaleString(lang)}</p>}
          {wallet && <p className="small muted">{t("Gás da carteira conectada", "Connected wallet gas")}: {gas[chain.id]?.balance !== undefined ? `${formatUnits(gas[chain.id].balance!, chain.nativeCurrency.decimals)} ${chain.nativeCurrency.symbol}` : gas[chain.id]?.error ? t("não verificado", "unverified") : t("consultando…", "checking…")}</p>}
          {result.totalTokens > 0 && <p className="small muted">{result.checkedTokens}/{result.totalTokens} {t("tokens consultados", "tokens checked")}{result.failedTokens > 0 ? ` · ${result.failedTokens} ${t("não verificados", "unverified")}` : ""}</p>}
          {result.tokens.length > 0 && <details><summary>{t("Ver tokens encontrados", "View discovered tokens")} ({result.tokens.length})</summary>{result.tokens.map(token => <div className="diagnosis-token" key={token.address}>
            <span>{token.symbol ?? token.name} · {token.verifiedDecimals === undefined ? `${token.balance} raw` : formatUnits(token.balance, token.verifiedDecimals)}</span>
            <button className="text-button" disabled={busy} onClick={() => open(result, 3, "transfer", token)}>{t("Revisar retirada", "Review withdrawal")}</button>
          </div>)}</details>}
          <div className="row">
            {result.snapshot && action !== "unsupported" && <button className="outline" disabled={busy} onClick={() => open(result, ["waiting", "finalize", "recover", "owner-required", "connect"].includes(action) ? 1 : 2)}>{["waiting", "finalize", "recover"].includes(action) ? t("Ver recuperação", "View recovery") : t("Ver próximos passos", "View next steps")}</button>}
            {result.positions.length > 0 && <button className="text-button" disabled={busy} onClick={() => open(result, 3, "invest")}>{t("Ver investimentos", "View investments")}</button>}
            {(result.basketCount ?? 0n) > 0n && <button className="text-button" disabled={busy} onClick={() => open(result, 3, "legacy")}>{t("Ver cestas", "View baskets")}</button>}
            {result.cards.map(card => card.controllers.map(controller => <button key={`${card.address}:${controller}`} className="text-button" disabled={busy} onClick={() => setAccount(controller)}>{t("Diagnosticar controlador", "Diagnose controller")}: {controller.slice(0, 8)}…</button>))}
            {["partial", "unavailable"].includes(result.status) && <button className="text-button" disabled={busy} onClick={() => rescan(chain.id)}>{t("Tentar novamente", "Retry")}</button>}
          </div>
          {result.issues.length > 0 && <details><summary>{t("O que não foi verificado", "What could not be verified")} ({result.issues.length})</summary>{result.issues.map((issue, i) => <p className="small mono" key={i}>{issue}</p>)}</details>}
        </article>;
      })}</div>
      <button className="text-button" disabled={busy} onClick={() => rescan()}>{t("Atualizar diagnóstico de todas as redes", "Refresh all networks")}</button>
    </>}
    <p className="note">{t("A consulta cobre o saldo nativo, tokens do catálogo local, investimentos conhecidos e propriedade de cestas. Não é um inventário universal: ativos fora do catálogo, conteúdo interno das cestas e contas com outro endereço podem exigir inspeção adicional. Resultados parciais nunca significam saldo zero.", "The scan covers native balances, local-catalogue tokens, known investments and basket ownership. Assets outside the catalogue, basket contents and other account addresses may need further inspection. Partial results never mean zero balance.")}</p>
    <details><summary>{t("Avançado: RPCs de consulta", "Advanced: read RPCs")}</summary>
      <p className="small muted">{t("Os RPCs recebem consultas públicas do endereço informado. As URLs não são salvas nem exportadas.", "RPCs receive public queries for the entered address. URLs are not saved or exported.")}</p>
      {chains.map(chain => <RpcField key={`${chain.id}:${rpcFor(chain.id, overrides)}`} label={chain.name} value={rpcFor(chain.id, overrides)} disabled={busy} apply={value => setRpc(chain.id, value)} lang={lang} />)}
    </details>
  </section>;
}
function RpcField({ label, value, apply, disabled, lang }: { label: string; value: string; apply: (value: string) => void; disabled: boolean; lang: "pt" | "en" }) {
  const [draft, setDraft] = useState(value), [error, setError] = useState("");
  return <div className="rpc-field"><label className="field"><span>{label} RPC</span><input type="url" value={draft} disabled={disabled} onChange={e => setDraft(e.target.value)} /></label>
    <button className="outline" disabled={disabled || draft === value} onClick={() => { try { apply(validateRpc(draft)); setError(""); } catch { setError(lang === "pt" ? "Use HTTPS ou um RPC local válido." : "Use HTTPS or a valid local RPC."); } }}>{lang === "pt" ? "Aplicar" : "Apply"}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
