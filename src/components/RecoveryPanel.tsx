import type { Address } from "viem";
import type { AccountSnapshot } from "../core/types";
import { same } from "../core/client";
import { NetworkSelect } from "./NetworkSelect";

type Props = {
  snapshot: AccountSnapshot; wallet?: Address; lang: "pt" | "en"; busy: boolean;
  owner: string; setOwner: (value: string) => void; networkIds: number[]; selectNetwork: (id: number) => void;
  prepare: () => void; review: (module: Address, operation: "approve" | "start" | "finalize" | "cancel") => void;
};
export function RecoveryPanel({ snapshot, wallet, lang, busy, owner, setOwner, networkIds, selectNetwork, prepare, review }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  if (snapshot.passkey !== "detected") return null;
  return <section className="recovery-substep" aria-labelledby="recovery-title">
    <p className="eyebrow">{t("DIAGNÓSTICO / CONTA COM PASSKEY", "DIAGNOSIS / PASSKEY ACCOUNT")}</p>
    <h3 id="recovery-title">{t("Recuperar acesso", "Recover access")}</h3>
    <p className="small">{t("Identificamos um signer de passkey nesta conta. Use a carteira guardian configurada para recuperar o acesso, ou conecte uma carteira que já seja owner.", "A passkey signer was identified on this account. Use its configured guardian wallet to recover access, or connect a wallet that is already an owner.")}</p>
    <NetworkSelect label={t("Conta com passkey na rede", "Passkey account network")} value={snapshot.chainId} ids={networkIds} disabled={busy} onChange={selectNetwork} />
    <p className="note">{t("A passkey original é vinculada ao domínio onde foi criada. Esta ferramenta usa o guardian configurado; nunca cole sua chave privada ou seed aqui.", "The original passkey is tied to its creation domain. This tool uses the configured guardian; never paste a private key or seed here.")}</p>
    {wallet && <p className="small">{snapshot.recoveries.some(r => r.guardians.some(g => same(g, wallet))) ? t("Guardian identificado na carteira conectada.", "The connected wallet is a configured guardian.") : t("A carteira conectada não foi identificada como guardian nesta consulta.", "The connected wallet was not identified as a guardian in this inspection.")}</p>}
    {snapshot.recoveries.length === 0 && <p className="note">{t("Nenhum módulo de recuperação compatível foi identificado. É necessária uma carteira owner ou outra rota de recuperação.", "No supported recovery module was identified. An owner wallet or another recovery route is required.")}</p>}
    {snapshot.recoveries.map(r => <div key={r.module} className="recovery-box">
      <p className="small">{t("Aprovações necessárias", "Required approvals")}: {r.threshold.toString()} · {t("Espera", "Delay")}: {Number(r.period ?? 0n) / 86400} {t("dias", "days")}</p>
      {r.pending.executeAfter > 0n ? <>
        <strong>{t("Recuperação em andamento", "Recovery in progress")}</strong>
        <p className="small">{t("Novo owner", "New owner")}: <span className="mono">{r.pending.newOwners.join(", ")}</span></p>
        <p className="small">{t("Finalização a partir de", "Earliest finalization")}: {new Date(Number(r.pending.executeAfter) * 1000).toLocaleString(lang)}</p>
        <div className="row"><button disabled={busy || snapshot.timestamp < r.pending.executeAfter} onClick={() => review(r.module, "finalize")}>{t("Revisar finalização", "Review finalization")}</button>
          <button className="outline" disabled={busy} onClick={() => review(r.module, "cancel")}>{t("Cancelar com owner atual", "Cancel with current owner")}</button></div>
      </> : <>
        <label className="field"><span>{t("Nova carteira que você controla", "New wallet you control")}</span><input disabled={busy} value={owner} onChange={event => setOwner(event.target.value)} placeholder="0x…" /></label>
        <p className="small muted">{t("A nova carteira deve ser diferente dos guardiões. A assinatura autoriza a troca de controle da Safe.", "The new wallet must differ from the guardians. The signature authorizes a change of Safe control.")}</p>
        <div className="row"><button disabled={busy} onClick={() => review(r.module, "approve")}>{t("Revisar aprovação", "Review approval")}</button>
          <button className="outline" disabled={busy} onClick={() => review(r.module, "start")}>{t("Iniciar após aprovações", "Start after approvals")}</button></div>
      </>}
    </div>)}
    <details><summary>{t("Detalhes da conta", "Account details")}</summary>
      <p className="small">Safe {snapshot.version} · {t("Assinaturas", "Signatures")}: {snapshot.threshold.toString()}/{snapshot.owners.length}</p>
      {snapshot.owners.map(value => <p className="mono small" key={value}>{value}</p>)}
      {snapshot.warnings.map(warning => <p className="note" key={warning}>{warning}</p>)}
    </details>
    <p className="small muted">{t("As transações de recuperação também pagam taxas. Confira e abasteça a carteira na etapa de preparação, se necessário.", "Recovery transactions also require fees. Check and fund the wallet in the preparation step if needed.")}</p>
    <button className="next-step" disabled={busy} onClick={prepare}>{t("Preparar carteiras →", "Prepare wallets →")}</button>
  </section>;
}
