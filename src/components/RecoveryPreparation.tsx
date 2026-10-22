import { useEffect, useRef, useState } from "react";
import { formatUnits, type Address } from "viem";
import { chainById } from "../catalog/chains";
import { same, publicClient } from "../core/client";
import { knownGuardians, newOwnerError } from "../core/destination";
import { displayError } from "../core/errors";
import type { NetworkDiagnosis } from "../core/diagnosis";
import type { AccountSnapshot } from "../core/types";
import { readRecoveryPreparation, recoveryPermissions, type RecoveryPreparation as Checks } from "../core/recoveryPreparation";
import { rpcFor, type RpcOverrides } from "./useDiagnosis";
import { ChainLogo } from "./ChainLogo";

type Operation = "approve" | "start" | "finalize" | "cancel";
type Props = {
  guardians?: readonly Address[]; account: string; results: NetworkDiagnosis[]; wallet?: Address; owner: string; setOwner: (value: string) => void;
  overrides: RpcOverrides; busy: boolean; blocked: boolean; lang: "pt" | "en"; connect: () => void;
  run: (task: () => Promise<void>) => Promise<void>;
  onSnapshot: (snapshot: AccountSnapshot) => void;
  perform: (snapshot: AccountSnapshot, module: Address, operation: Operation, owner: string) => Promise<void>;
};
export function RecoveryPreparation(props: Props) {
  const { account, results, wallet, owner, setOwner, lang } = props;
  const ownerInput = useRef<HTMLInputElement>(null);
  const editOwner = () => { ownerInput.current?.scrollIntoView({ behavior: "smooth", block: "center" }); ownerInput.current?.focus({ preventScroll: true }); };
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const detected = results.flatMap(r => r.snapshot && (r.snapshot.passkey === "detected" || r.snapshot.recoveries.some(m => m.supported && m.pending.executeAfter > 0n)) ? [r.snapshot] : []);
  // Keep the recovery handoff visible when finalization removes the passkey owner.
  const [tracked, setTracked] = useState<{ account: string; snapshots: AccountSnapshot[] }>({ account, snapshots: [] });
  const retained = tracked.account === account ? tracked.snapshots : [];
  const trackedIds = new Set([...retained, ...detected].map(s => s.chainId));
  const refreshed = results.flatMap(r => r.snapshot && trackedIds.has(r.chainId) ? [r.snapshot] : []);
  const snapshots = [...new Map([...retained, ...detected, ...refreshed].map(s => [s.chainId, s])).values()];
  const fingerprint = snapshots.map(s => `${s.chainId}:${s.block}`).join("|");
  useEffect(() => { setTracked({ account, snapshots }); }, [account, fingerprint]);
  if (!snapshots.length) return null;
  const guardians = knownGuardians(results.map(r => r.snapshot), account);
  const needsOwner = snapshots.some(s => s.passkey === "detected" && !s.owners.some(a => wallet && same(a, wallet)) && s.recoveries.some(r => r.supported && r.threshold > 0n && !r.pending.executeAfter));
  return <section className="recovery-preparation" aria-labelledby="prepare-recovery-title">
    <h3 id="prepare-recovery-title">{t("Recuperar acesso", "Recover access")}</h3>
    <p>{t("Contas com passkey podem ser recuperadas usando o guardian configurado. A recuperação troca a carteira que controla a conta; seus ativos continuam nela.", "Passkey accounts can be recovered using their configured guardian. Recovery changes the wallet controlling the account; your assets stay in it.")}</p>
    {needsOwner && <label className="field"><span>{t("Nova carteira que vai controlar a conta", "New wallet to control the account")}</span><input ref={ownerInput} id="recovery-new-owner" aria-describedby="recovery-new-owner-help" required value={owner} disabled={props.busy} onChange={e => setOwner(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" /></label>}
    <p id="recovery-new-owner-help" className="small muted">{t("A nova carteira deve ser sua e diferente de todos os guardians. Cada rede tem suas próprias aprovações e prazo.", "The new wallet must be yours and different from every guardian. Each network has its own approvals and waiting period.")}</p>
    {snapshots.map(snapshot => <RecoveryNetwork key={`${account}:${snapshot.chainId}`} {...props} guardians={guardians} editOwner={editOwner} initial={snapshot} />)}
  </section>;
}
function RecoveryNetwork({ initial, editOwner, guardians = [], wallet, owner, overrides, busy, blocked, lang, connect, run, perform, onSnapshot }: Props & { initial: AccountSnapshot; editOwner: () => void }) {
  const chain = chainById(initial.chainId), rpc = rpcFor(chain.id, overrides);
  const key = `${initial.address}:${chain.id}:${wallet ?? ""}:${owner.trim().toLowerCase()}:${rpc}`;
  const [state, setState] = useState<{ key: string; data?: Checks; error?: string; loading?: boolean }>();
  const latest = useRef(key); latest.current = key;
  const request = useRef(0), mounted = useRef(true);
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const data = state?.key === key ? state.data : undefined;
  async function refresh() {
    if (!wallet) return;
    const id = ++request.current;
    setState(old => ({ key, data: old?.key === key ? old.data : undefined, loading: true }));
    try {
      const data = await readRecoveryPreparation(publicClient(chain, rpc, 12_000), initial.address, chain.id, wallet, owner);
      if (mounted.current && latest.current === key && id === request.current) { setState({ key, data }); onSnapshot(data.snapshot); }
    } catch (e) { if (mounted.current && latest.current === key && id === request.current) setState({ key, error: displayError(e, lang) }); }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  useEffect(() => {
    if (busy || !wallet) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await refresh(); if (!disposed) timer = setTimeout(() => void tick(), 15_000); };
    timer = setTimeout(() => void tick(), 300);
    return () => { disposed = true; clearTimeout(timer); request.current++; };
  }, [key, busy]);
  const snapshot = data?.snapshot ?? initial;
  const connectedOwner = !!wallet && snapshot.owners.some(a => same(a, wallet));
  const pending = snapshot.recoveries.some(r => r.pending.executeAfter > 0n);
  const problem = newOwnerError(owner, snapshot, guardians);
  const disabled = busy || blocked || !data || !!state?.loading;
  const act = (module: Address, mode: Operation) => void run(async () => {
    if (disabled || !data) return;
    // The send path revalidates this snapshot and the wallet before any signature.
    await perform(data.snapshot, module, mode, owner);
    await refresh();
  });
  return <article className="recovery-network" aria-label={t(`Recuperação em ${chain.name}`, `Recovery on ${chain.name}`)}>
    <div className="recovery-network-heading"><span className="network-cell"><ChainLogo id={chain.id} /><strong>{chain.name}</strong></span>
      <button type="button" className="text-button" disabled={busy || !wallet || !!state?.loading} onClick={() => void refresh()}>{state?.loading ? t("Atualizando…", "Updating…") : t("Atualizar acesso e taxas", "Refresh access and fees")}</button></div>
    {!wallet ? <p>{t("Conecte o guardian configurado para esta conta.", "Connect this account’s configured guardian.")} <button className="text-button" onClick={connect}>{t("Ir para a conexão", "Go to connection")}</button></p>
      : state?.key === key && state.error ? <p className="table-error" role="alert">{t("Não foi possível verificar o acesso e as taxas: ", "Could not verify access and fees: ")}{state.error}</p>
      : !data ? <p className="small muted" role="status"><span className="scan-spinner" aria-hidden="true" /> {t("Verificando guardian, aprovações e saldo para taxas…", "Checking guardian, approvals and fee balance…")}</p> : <>
      {connectedOwner && !pending ? <p className="recovery-access-ok">{t("Acesso confirmado. Esta carteira já controla a conta.", "Access confirmed. This wallet already controls the account.")}</p> : <>
      <p className="small">{t("Carteira que paga as taxas", "Wallet paying fees")}: <span className="mono">{wallet}</span> · {formatUnits(data.gas, chain.nativeCurrency.decimals)} {chain.nativeCurrency.symbol}</p>
      {data.gas === 0n && <p className="table-error" role="alert">{t(`Envie ${chain.nativeCurrency.symbol} nesta rede para ${wallet} antes de recuperar.`, `Send ${chain.nativeCurrency.symbol} on this network to ${wallet} before recovering.`)}</p>}
      {blocked && <p className="small table-error">{t("Uma transação enviada aguarda verificação. Acompanhe no sininho antes de continuar.", "A submitted transaction awaits verification. Follow notifications before continuing.")}</p>}
      {snapshot.passkey !== "detected" && !pending ? <p>{t("A conta agora é controlada por:", "The account is now controlled by:")} {snapshot.owners.map(a => <span className="mono" key={a}>{a} </span>)}<button className="text-button" onClick={connect} disabled={busy}>{t("Conectar a nova carteira no diagnóstico", "Connect the owner wallet in diagnosis")}</button></p>
      : !snapshot.recoveries.some(r => r.supported && r.threshold > 0n) ? <p className="table-error">{t("Nenhum módulo de recuperação compatível foi encontrado. É necessário um owner ou outra rota de recuperação.", "No supported recovery module was found. An owner or another recovery route is required.")}</p>
      : snapshot.recoveries.filter(r => r.supported && r.threshold > 0n).map(r => {
        const allowed = recoveryPermissions(data, r, wallet, owner, guardians);
        const guardianTarget = r.pending.newOwners.some(owner => newOwnerError(owner, snapshot, guardians) === "guardian");
        return <div className="recovery-module" key={r.module}>
          <p className="small muted">{t("Módulo", "Module")}: <span className="mono">{r.module}</span></p>
          {allowed.pending ? <>
            <strong>{guardianTarget ? t("Recuperação bloqueada", "Recovery blocked") : snapshot.timestamp < r.pending.executeAfter ? t("Aguardando o prazo de recuperação", "Waiting for recovery delay") : t("Pronta para finalizar", "Ready to finalize")}</strong>
            <p className="small">{t("Nova carteira", "New wallet")}: {r.pending.newOwners.map(a => <span className="mono" key={a}>{a} </span>)}</p>
            <p className="small">{t("Finalização a partir de", "Earliest finalization")}: {new Date(Number(r.pending.executeAfter) * 1000).toLocaleString(lang)}. {t("Verificação automática a cada 15 segundos.", "Checked automatically every 15 seconds.")}</p>
            {(r.pending.newOwners.length !== 1 || r.pending.newThreshold !== 1n) && <p className="table-error">{t("Esta recuperação envolve múltiplos owners e precisa de revisão fora deste fluxo.", "This recovery involves multiple owners and needs review outside this flow.")}</p>}
            {guardianTarget && <p className="table-error" role="alert">{t("Recuperação bloqueada: a nova carteira é um guardian. Não finalize esta recuperação. O owner atual pode cancelá-la.", "Recovery blocked: the new wallet is a guardian. Do not finalize this recovery. The current owner can cancel it.")}</p>}
            <div className="row"><button disabled={disabled || !allowed.finalize} onClick={() => act(r.module, "finalize")}>{t("Finalizar na carteira", "Finalize in wallet")}</button>
              {allowed.owner && <button className="text-button" disabled={disabled || !allowed.cancel} onClick={() => act(r.module, "cancel")}>{t("Cancelar recuperação", "Cancel recovery")}</button>}</div>
          </> : <>
            <p>{allowed.guardian ? t("Guardian confirmado.", "Guardian confirmed.") : t("A carteira conectada não é guardian desta conta.", "The connected wallet is not this account’s guardian.")}</p>
            {!allowed.guardian && <button className="text-button" disabled={busy} onClick={connect}>{t("Conectar um guardian no diagnóstico", "Connect a guardian in diagnosis")}</button>}
            {owner.trim() && problem && <p className="table-error" role="alert">{problem === "guardian" ? t("A nova carteira não pode ser um guardian.", "The new wallet cannot be a guardian.") : problem === "source" ? t("A nova carteira não pode ser a própria Safe.", "The new wallet cannot be the Safe itself.") : t("Informe um endereço válido para a nova carteira.", "Enter a valid new wallet address.")}</p>}
            {owner.trim() ? <p className="small recovery-target">{t("Nova carteira", "New wallet")}: <span className="mono">{owner.trim()}</span> <button type="button" className="text-button" disabled={busy} onClick={editOwner}>{t("Alterar", "Change")}</button></p> : <div className="recovery-next-action"><p>{t("Informe uma nova carteira sua para controlar esta Safe. Ela não pode ser o guardian conectado nem qualquer outro guardian da conta.", "Enter another wallet you own to control this Safe. It cannot be the connected guardian or any other guardian of this account.")}</p><button type="button" disabled={busy} onClick={editOwner}>{t("Definir nova carteira", "Set new wallet")}</button></div>}
            <p className="small">{allowed.approvals && <>{t("Aprovações", "Approvals")}: {allowed.approvals.count.toString()}/{r.threshold.toString()} · </>}{t("Prazo após iniciar", "Delay after starting")}: {r.period === undefined ? t("não verificado", "unverified") : `${Number(r.period) / 86400} ${t("dias", "days")}`}</p>
            {allowed.approvals?.approved && <p className="small">{t("Este guardian já aprovou a nova carteira.", "This guardian already approved the new wallet.")}</p>}
            {!!owner.trim() && <>
              {allowed.approvals && allowed.approvals.count >= r.threshold ? <>
                <p className="small">{t("Aprovações concluídas. Inicie a recuperação para começar a contar o prazo.", "Approvals complete. Start recovery to begin the waiting period.")}</p>
                <button disabled={disabled || !allowed.start} onClick={() => act(r.module, "start")}>{t("Iniciar recuperação", "Start recovery")}</button>
              </> : allowed.approvals?.approved ? <p className="small" role="status">{t(`Aguardando mais ${r.threshold - allowed.approvals.count} aprovação(ões) de outros guardians para iniciar.`, `Waiting for ${r.threshold - allowed.approvals.count} more guardian approval(s) before starting.`)}</p> : <>
                {allowed.validOwner && allowed.guardian && <p className="small">{t("Primeiro, aprove a nova carteira. Depois, você poderá iniciar o prazo de recuperação.", "First, approve the new wallet. Then you can start the recovery waiting period.")}</p>}
                <button disabled={disabled || !allowed.approve} onClick={() => act(r.module, "approve")}>{t("Aprovar na carteira", "Approve in wallet")}</button>
              </>}
            </>}
          </>}
        </div>;
      })}</>}
    </>}
  </article>;
}
