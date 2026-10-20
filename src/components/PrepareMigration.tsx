import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, type Address } from "viem";
import { chains, chainById } from "../catalog/chains";
import { address, assertChain, publicClient, same } from "../core/client";
import type { NetworkDiagnosis } from "../core/diagnosis";
import { rpcFor, type CustomTokenState, type RpcOverrides } from "./useDiagnosis";
import { ChainLogo } from "./ChainLogo";
import { CustomTokenForm, ItemBalance, ItemText, type AddResult } from "./AssetTable";
import { gasFor, gasKey, gasSettled, gasStarted, isNew, isSelected, readiness, type GasEntry, type GasState, type MigrationItem, type Readiness, type Selection } from "./migration";

type Lang = "pt" | "en";
type Props = {
  lang: Lang; busy: boolean; account: string; wallet?: Address; results: NetworkDiagnosis[]; items: MigrationItem[];
  selection: Selection; select: (ids: string[], value: boolean) => void; overrides: RpcOverrides;
  destination: string; setDestination: (value: string) => void;
  rescan: (id?: number) => void; addCustom: (chainId: number, token: string) => AddResult; retryCustom: (chainId: number, token: Address) => void;
  run: (task: () => Promise<void>) => Promise<void>; next: () => void; connect: () => void;
};

// One endpoint, one block. The balance is shown with its block: it is a
// snapshot, not a budget. Each operation is still estimated before sending.
async function readGas(chainId: number, rpc: string, wallet: Address) {
  const client = publicClient(chainById(chainId), rpc);
  await assertChain(client, chainId);
  const block = await client.getBlockNumber();
  return { balance: await client.getBalance({ address: wallet, blockNumber: block }), block };
}

export function destinationError(destination: string, account: string) {
  if (!destination.trim()) return "missing" as const;
  try { return same(address(destination), account) ? "source" as const : undefined; } catch { return "invalid" as const; }
}

export function PrepareMigration({ lang, busy, account, wallet, results, items, selection, select, overrides, destination, setDestination, rescan, addCustom, retryCustom, run, next, connect }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [gas, setGas] = useState<GasState>({});
  const gasRef = useRef(gas);
  gasRef.current = gas;
  const requests = useRef(0);
  const keyFor = useCallback((chainId: number) => wallet ? gasKey(chainId, rpcFor(chainId, overrides), wallet, account) : undefined, [wallet, overrides, account]);
  const check = useCallback((chainId: number) => {
    const key = keyFor(chainId);
    if (!wallet || !key) return;
    const request = ++requests.current;
    setGas(old => gasStarted(old, chainId, key, request));
    // A result is applied only to the context and latest request that produced it.
    readGas(chainId, rpcFor(chainId, overrides), wallet).then(
      outcome => setGas(old => gasSettled(old, chainId, key, request, outcome)),
      () => setGas(old => gasSettled(old, chainId, key, request, "error")));
  }, [keyFor, wallet, overrides]);

  const selectable = items.filter(item => item.selectable);
  const chosen = selectable.filter(item => isSelected(selection, item));
  const resultFor = (chainId: number) => results.find(r => r.chainId === chainId);
  const groups = chains.map(chain => ({ chain, result: resultFor(chain.id), items: items.filter(item => item.chainId === chain.id) }))
    .filter(group => group.items.length > 0);
  const selectedChains = [...new Set(chosen.map(item => item.chainId))];
  const entryFor = (chainId: number): GasEntry | undefined => { const key = keyFor(chainId); return key ? gasFor(gas, chainId, key) : undefined; };
  const status = (chainId: number) => readiness(resultFor(chainId), wallet, entryFor(chainId));
  // Fee checks only for selected networks whose owner check passed.
  const needed = selectedChains.filter(id => readiness(resultFor(id), wallet, undefined) === "gas-loading");
  const neededKeys = needed.map(id => `${id}=${keyFor(id)}`).join(",");
  useEffect(() => {
    for (const id of needed) { const key = keyFor(id); if (key && !gasFor(gasRef.current, id, key)) check(id); }
    // Keys capture chain, RPC, wallet and source account.
  }, [neededKeys]);

  const incomplete = results.filter(r => r.status === "partial" || r.status === "unavailable");
  const emptyIncomplete = incomplete.filter(r => !groups.some(g => g.chain.id === r.chainId));
  const scanning = results.filter(r => r.status === "queued" || r.status === "scanning");
  const blocked = selectedChains.map(id => ({ id, state: status(id) })).filter(entry => entry.state !== "ready");
  const destinationProblem = destinationError(destination, account);
  const canContinue = chosen.length > 0 && blocked.length === 0 && !destinationProblem && !busy;

  const labels: Record<Readiness, string> = {
    scanning: t("Consultando a rede…", "Checking network…"),
    unavailable: t("Rede sem resposta", "Network did not answer"),
    unsupported: t("Conta exige revisão de compatibilidade", "Account needs a compatibility review"),
    recovery: t("Recuperação de acesso pendente", "Access recovery pending"),
    connect: t("Conecte a carteira que controla a conta", "Connect the wallet controlling the account"),
    owner: t("A carteira conectada não controla esta conta", "The connected wallet does not control this account"),
    "gas-loading": t("Conferindo saldo para taxas…", "Checking fee balance…"),
    "gas-error": t("Saldo para taxas não verificado", "Fee balance not verified"),
    fund: t("Sem saldo para taxas", "No fee balance"),
    ready: t("Pronta", "Ready"),
  };
  const tone = (state: Readiness) => state === "ready" ? "ok" : state === "gas-loading" || state === "scanning" ? "loading" : "blocked";

  return <section className="panel prepare">
    <p className="eyebrow">{t("PASSO 1 / PREPARAR CARTEIRAS", "STEP 1 / PREPARE WALLETS")}</p>
    <h2>{t("Escolha o que migrar. Confira as taxas.", "Choose what to move. Check the fees.")}</h2>
    <p>{t("Todos os ativos encontrados, em todas as redes. Desmarque o que não quer mover agora. Em cada rede selecionada, a carteira conectada assina e paga o gás na moeda nativa daquela rede.", "Every asset found, on every network. Untick what you do not want to move now. On each selected network, the connected wallet signs and pays gas in that network's native coin.")}</p>

    {wallet ? <div className="funding-card prepare-wallet">
      <div><span className="small muted">{t("Carteira que assina e paga as taxas", "Wallet signing and paying fees")}</span>
        <p className="mono">{wallet}</p></div>
      <button className="text-button" disabled={busy} onClick={() => run(() => navigator.clipboard.writeText(wallet))}>{t("Copiar endereço", "Copy address")}</button>
    </div> : <p className="note">{t("Nenhuma carteira conectada. A conexão é feita no passo 0.", "No wallet connected. Connect it in step 0.")} <button className="text-button" disabled={busy} onClick={connect}>{t("Ir para a conexão →", "Go to connection →")}</button></p>}

    <div className="migration-toolbar" role="status" aria-live="polite">
      <p><strong>{chosen.length}</strong> {t(`de ${selectable.length} ativos selecionados`, `of ${selectable.length} assets selected`)} · <strong>{selectedChains.length}</strong> {t(selectedChains.length === 1 ? "rede" : "redes", selectedChains.length === 1 ? "network" : "networks")}</p>
      <div className="row">
        <button className="text-button" disabled={busy || chosen.length === selectable.length} onClick={() => select(selectable.map(item => item.id), true)}>{t("Selecionar tudo", "Select all")}</button>
        <button className="text-button" disabled={busy || chosen.length === 0} onClick={() => select(selectable.map(item => item.id), false)}>{t("Limpar seleção", "Select none")}</button>
        <button className="text-button" disabled={busy || !wallet || needed.length === 0} onClick={() => needed.forEach(check)}>{t("Atualizar taxas", "Refresh fees")}</button>
      </div>
    </div>
    {scanning.length > 0 && <p className="small muted" role="status">{t(`${scanning.length} rede(s) ainda em consulta. Ativos encontrados depois de você editar a seleção chegam desmarcados.`, `${scanning.length} network(s) still being checked. Assets found after you edit the selection arrive unselected.`)}</p>}

    {groups.length === 0 && <p className="empty-assets">{scanning.length ? t("Procurando ativos em todas as redes…", "Looking for assets on every network…") : t("Nenhum ativo verificado para migrar. Confira as leituras incompletas abaixo.", "No verified assets to move. Check the incomplete readings below.")}</p>}
    <div className="migration-networks">
      {groups.map(({ chain, result, items: own }) => {
        const options = own.filter(item => item.selectable), picked = options.filter(item => isSelected(selection, item));
        const all = options.length > 0 && picked.length === options.length, some = picked.length > 0;
        const state = some ? status(chain.id) : undefined, entry = entryFor(chain.id);
        const partial = result?.status === "partial" || result?.status === "unavailable";
        return <article key={chain.id} className={`migration-network${some ? " is-selected" : ""}`} aria-labelledby={`network-${chain.id}`}>
          <div className="migration-network-head">
            <label className="group-check">
              <input type="checkbox" checked={all} disabled={busy || options.length === 0} aria-describedby={`network-${chain.id}-count`}
                ref={el => { if (el) el.indeterminate = some && !all; }} onChange={() => select(options.map(item => item.id), !all)} />
              <ChainLogo id={chain.id} size={28} />
              <span><strong id={`network-${chain.id}`}>{chain.name}</strong><small id={`network-${chain.id}-count`}>{t(`${picked.length} de ${options.length} selecionados`, `${picked.length} of ${options.length} selected`)}</small></span>
            </label>
            {state ? <span className={`status-pill ${tone(state)}`}>{state === "gas-loading" || state === "scanning" ? <span className="scan-spinner" aria-hidden="true" /> : null}{labels[state]}</span>
              : <span className="status-pill idle">{t("Não será migrada agora", "Not moving now")}</span>}
          </div>
          <ul className="migration-assets">
            {own.map(item => <li key={item.id} className={item.selectable ? "" : "is-disabled"}>
              <label>
                <input type="checkbox" checked={isSelected(selection, item)} disabled={busy || !item.selectable} onChange={event => select([item.id], event.target.checked)} />
                <ItemText item={item} lang={lang} extra={isNew(selection, item) ? <em className="token-badge new">{t("Novo · não selecionado", "New · not selected")}</em> : undefined} />
                <span className="migration-balance"><ItemBalance item={item} lang={lang} /></span>
              </label>
              {item.custom?.status === "error" && <button className="text-button" disabled={busy} onClick={() => retryCustom(item.chainId, item.custom!.address)}>{t("Tentar de novo", "Retry")}</button>}
            </li>)}
          </ul>
          {partial && <div className="gaps" role="note"><strong>{t("Leitura incompleta nesta rede", "Incomplete reading on this network")}</strong>
            <p className="small">{t("Alguns saldos não puderam ser verificados: são desconhecidos, não zero. Outros ativos podem aparecer ao repetir.", "Some balances could not be verified: they are unknown, not zero. More assets may appear when retrying.")}</p>
            <button className="text-button" disabled={busy} onClick={() => rescan(chain.id)}>{t("Consultar a rede de novo", "Check the network again")}</button></div>}
          {some && state && <FeeLine chainId={chain.id} state={state} entry={entry} wallet={wallet} busy={busy} lang={lang} retry={() => check(chain.id)} connect={connect} />}
        </article>;
      })}
    </div>

    {emptyIncomplete.length > 0 && <div className="gaps" role="note"><strong>{t("Redes com leitura incompleta", "Networks with incomplete readings")}</strong>
      <p className="small">{t("Nenhum ativo verificado ainda nestas redes, mas a leitura não terminou. Isso não significa saldo zero.", "No verified assets yet on these networks, but the reading did not finish. This does not mean a zero balance.")}</p>
      <div className="pending-networks">{emptyIncomplete.map(r => <span className="network-cell small" key={r.chainId}><ChainLogo id={r.chainId} size={20} />{chainById(r.chainId).name}
        <button className="text-button" disabled={busy} onClick={() => rescan(r.chainId)}>{t("Tentar de novo", "Retry")}</button></span>)}</div>
    </div>}
    <CustomTokenForm lang={lang} busy={busy || !results.length} add={addCustom} />

    <label className="field"><span>{t("Destino dos ativos (todas as redes)", "Asset destination (all networks)")}</span><input disabled={busy} value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" aria-invalid={!!destination && !!destinationProblem} /></label>
    {destination && destinationProblem && <p className="small table-error" role="alert">{destinationProblem === "source" ? t("O destino deve ser diferente da conta de origem.", "The destination must differ from the source account.") : t("Informe um endereço válido (0x…).", "Enter a valid address (0x…).")}</p>}
    {wallet && <button className="text-button" disabled={busy || same(wallet, account)} onClick={() => setDestination(wallet)}>{t("Usar minha carteira conectada como destino", "Use my connected wallet as destination")}</button>}
    <p className="small muted">{t("O mesmo endereço precisa conseguir receber em cada rede selecionada. Você confere o destino e o efeito em cada operação antes de assinar; nada é enviado automaticamente.", "The same address must be able to receive on each selected network. You review the destination and effect of every operation before signing; nothing is sent automatically.")}</p>
    <p className="note">{t("Um saldo positivo para taxas não garante todas as retiradas: cada operação é simulada e estimada de novo antes do envio, e a carteira mostra a taxa. Em uma conta antiga sem Safe, a própria conta paga as taxas: deixe uma reserva de gás ao retirar a moeda nativa. Se a conta exigir mais de uma assinatura, os outros owners também precisam aprovar.", "A positive fee balance does not guarantee every withdrawal: each operation is simulated and estimated again before sending, and your wallet shows the fee. For a legacy account without a Safe, the account itself pays fees: leave a gas reserve when withdrawing native coins. If the account requires more than one signature, the other owners must also approve.")}</p>

    <div className="diagnosis-continue">
      <div className="small muted">{chosen.length === 0 ? <p>{t("Selecione ao menos um ativo para continuar.", "Select at least one asset to continue.")}</p>
        : blocked.length > 0 ? <><p>{t("Antes de continuar, resolva ou desmarque:", "Before continuing, resolve or untick:")}</p>
          <ul className="blockers">{blocked.map(entry => <li key={entry.id}>{chainById(entry.id).name}: {labels[entry.state]}</li>)}</ul></>
        : destinationProblem ? <p>{t("Informe um destino válido para continuar.", "Enter a valid destination to continue.")}</p>
        : <p>{t("Tudo pronto. Você revisa e assina cada operação no próximo passo.", "All set. You review and sign each operation in the next step.")}</p>}</div>
      <button className="next-step" disabled={!canContinue} onClick={next}>{t("Continuar para mover o dinheiro →", "Continue to move funds →")}</button>
    </div>
  </section>;
}

function FeeLine({ chainId, state, entry, wallet, busy, lang, retry, connect }: {
  chainId: number; state: Readiness; entry?: GasEntry; wallet?: Address; busy: boolean; lang: Lang; retry: () => void; connect: () => void;
}) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const chain = chainById(chainId), symbol = chain.nativeCurrency.symbol;
  const balance = entry?.status === "ready" && entry.balance !== undefined ? `${formatUnits(entry.balance, chain.nativeCurrency.decimals)} ${symbol}` : undefined;
  return <div className={`migration-fee ${state}`}>
    {state === "ready" && <p>{t("Saldo para taxas", "Fee balance")}: <strong>{balance}</strong> <span className="muted">· {t("bloco", "block")} {entry?.block?.toString()}</span></p>}
    {state === "fund" && <p>{t(`Envie ${symbol} na rede ${chain.name} para a carteira conectada. Tokens e saldo em outra rede não pagam estas taxas.`, `Send ${symbol} on ${chain.name} to the connected wallet. Tokens and balances on another network do not pay these fees.`)} <span className="muted">({t("bloco", "block")} {entry?.block?.toString()})</span></p>}
    {state === "gas-loading" && <p className="muted">{t(`Lendo o saldo de ${symbol} da carteira conectada…`, `Reading the connected wallet's ${symbol} balance…`)}</p>}
    {state === "gas-error" && <p>{t("A rede não respondeu. O saldo para taxas é desconhecido.", "The network did not answer. The fee balance is unknown.")}</p>}
    {state === "owner" && <p>{t("Conecte uma carteira owner desta conta no passo 0, ou desmarque esta rede.", "Connect an owner wallet of this account in step 0, or untick this network.")} <button className="text-button" disabled={busy} onClick={connect}>{t("Ir para a conexão →", "Go to connection →")}</button></p>}
    {state === "connect" && <p><button className="text-button" disabled={busy} onClick={connect}>{t("Conectar carteira no passo 0 →", "Connect wallet in step 0 →")}</button></p>}
    {state === "recovery" && <p>{t("Conclua a recuperação no diagnóstico antes de mover fundos nesta rede, ou desmarque-a.", "Finish recovery in diagnosis before moving funds on this network, or untick it.")}</p>}
    {state === "unsupported" && <p>{t("Esta versão de conta exige revisão antes de movimentar. Desmarque esta rede para seguir com as outras.", "This account version needs review before moving funds. Untick this network to continue with the others.")}</p>}
    {state === "scanning" && <p className="muted">{t("Aguarde a consulta desta rede terminar.", "Wait for this network's check to finish.")}</p>}
    {wallet && ["ready", "fund", "gas-error"].includes(state) && <button className="text-button" disabled={busy} onClick={retry}>{state === "gas-error" ? t("Tentar de novo", "Retry") : t("Atualizar", "Refresh")}</button>}
  </div>;
}
