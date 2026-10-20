import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatUnits, type Address, type EIP1193Provider, type Hex } from "viem";
import { chains, chainById } from "./catalog/chains";
import { products } from "./catalog/products";
import { address, assertChain, parseAmount, publicClient, same } from "./core/client";
import { inspectAccount } from "./core/inspect";
import { assertSeparateRecipient } from "./core/destination";
import { recoveryAction, safeAction, sendAction, transferCall, approveSafeProposal, safeReceiptSucceeded } from "./core/actions";
import { verifyTokenReceipt, type ReceiptExpectation } from "./core/receipts";
import { erc20Abi } from "./core/abi";
import { inspectCard, enqueueCard, readQueue, dispatchCard, skipExpiredCard, queueStatus, type CardDelay, type QueuedCall } from "./core/card";
import { inspectPosition, redeemPosition, claimCovered, settleCovered, claimStader, claimStakingRewards, recoverCoveredDeposit, findCoveredRequests, type Position } from "./core/investments";
import { useAccount } from "wagmi";
import { ConnectKitProvider } from "connectkit";
import { PrepareMigration } from "./components/PrepareMigration";
import { basketsId, chainOf, commitSelection, emptySelection, forAccount, isExcluded, mamoId, migrationItems, positionId, selectedIds, setSelected, transferId, type Selection } from "./components/migration";
import { DiagnosisPanel } from "./components/DiagnosisPanel";
import { RecoveryPanel } from "./components/RecoveryPanel";
import { AssetTable } from "./components/AssetTable";
import { useDiagnosis, rpcFor, type RpcOverrides } from "./components/useDiagnosis";
import { type NetworkDiagnosis, type TokenHolding } from "./core/diagnosis";
import { StockTokens } from "./components/StockTokens";
import { LegacyPanel } from "./components/LegacyPanel";
import { CallDetails } from "./components/CallDetails";
import { ChainLogo } from "./components/ChainLogo";
import { discoverMamo, withdrawMamo, type MamoPosition } from "./core/mamo";
import { readProgress, saveProgress, downloadProgress, parseProgress } from "./core/progress";
import type { AccountSnapshot, PreparedAction } from "./core/types";

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}
function Chip({ children }: { children: ReactNode }) { return <span className="chip">{children}</span>; }
export function App() {
  const [lang, setLang] = useState<"pt" | "en">("pt");
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [chainId, setChainId] = useState(100);
  const chain = chainById(chainId);
  const [rpcOverrides, setRpcOverrides] = useState<RpcOverrides>({});
  const rpc = rpcFor(chainId, rpcOverrides);
  const [account, setAccount] = useState(() => readProgress().accounts.at(-1)?.address ?? "");
  const [followWallet, setFollowWallet] = useState(true);
  const [snapshot, setSnapshot] = useState<AccountSnapshot>();
  const [progress, setProgress] = useState(readProgress);
  const connection = useAccount();
  const walletAddress = connection.address;
  const diagnosis = useDiagnosis(account, rpcOverrides);
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  // What to move, chosen in Prepare wallets and enforced in Move funds.
  const items = migrationItems(diagnosis.results, diagnosis.customTokens);
  const [selectionState, setSelectionState] = useState<Selection>(() => emptySelection(account));
  const selection = forAccount(selectionState, account);
  const chosen = selectedIds(selection, items);
  const excluded = (id: string) => isExcluded(selection, items, id);
  const rescanning = (id: number) => diagnosis.results.some(r => r.chainId === id && (r.status === "queued" || r.status === "scanning"));
  // A network being rescanned after a transaction keeps its place in Move funds.
  const chosenChains = chains.map(c => c.id).filter(id => [...chosen].some(item => chainOf(item) === id)
    || rescanning(id) && Object.entries(selection.decided).some(([item, value]) => value && chainOf(item) === id));
  // A different source account never inherits another account's choices.
  useEffect(() => { setSelectionState(old => forAccount(old, account)); }, [account]);
  // Entering Move funds freezes the defaults: assets found later are not included implicitly.
  useEffect(() => { if (step === 3) setSelectionState(old => commitSelection(forAccount(old, account), items)); }, [step, account]);
  const [tab, setTab] = useState("transfer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<PreparedAction>();
  const [reviewed, setReviewed] = useState(false);
  const [lastHash, setLastHash] = useState<Hex | undefined>(() => readProgress().transactions.find(tx => tx.status === "pending")?.hash);
  const [uncertain, setUncertain] = useState(() => readProgress().transactions.some(tx => tx.status === "pending"));
  const [owner, setOwner] = useState("");
  const [destination, setDestination] = useState("");
  const [token, setToken] = useState("");
  const [amount, setAmount] = useState("");
  const [mamoPositions, setMamoPositions] = useState<MamoPosition[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [positionFailures, setPositionFailures] = useState<string[]>([]);
  const [coveredRequests, setCoveredRequests] = useState<{ id: bigint; shares: bigint }[]>([]);
  const [scanProgress, setScanProgress] = useState("");
  const scanController = useRef<AbortController | undefined>(undefined);
  const [requestId, setRequestId] = useState("");
  const [cardAddress, setCardAddress] = useState("");
  const [cardDelay, setCardDelay] = useState<CardDelay>();
  const [queue, setQueue] = useState<QueuedCall[]>([]);
  const importRef = useRef<HTMLInputElement>(null);
  const client = useMemo(() => {
    try { return publicClient(chain, rpc); } catch { return undefined; }
  }, [chain, rpc]);
  useEffect(() => { try { saveProgress(progress); } catch { setError("Local progress could not be saved. Export it before closing this page."); } }, [progress]);
  useEffect(() => { setReview(undefined); setReviewed(false); }, [destination, token, amount, owner, requestId, cardAddress]);
  useEffect(() => { document.documentElement.lang = lang === "pt" ? "pt-BR" : "en"; }, [lang]);
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    if (import.meta.env.DEV && ["127.0.0.1", "localhost"].includes(location.hostname) && new URLSearchParams(location.search).get("demo") === "1") {
      void import("./devProvider").then(m => { if (!disposed) { cleanup = m.announceDemoWallet(); setDemo(true); } });
    }
    return () => { disposed = true; cleanup?.(); };
  }, []);
  async function provider(): Promise<EIP1193Provider> {
    const selected = await connection.connector?.getProvider();
    if (!selected) throw new Error(t("Conecte sua carteira primeiro.", "Connect your wallet first."));
    return selected as EIP1193Provider;
  }
  function goToStep(next: 0 | 1 | 2 | 3) {
    setStep(next > 0 && !snapshot ? 0 : next === 1 && snapshot?.passkey !== "detected" ? 0 : next); setReview(undefined); setReviewed(false);
  }
  useEffect(() => { setReview(undefined); setReviewed(false); }, [walletAddress, connection.connector?.uid, connection.chainId]);
  function requireClient() { if (!client) throw new Error(t("Informe um RPC válido.", "Enter a valid RPC.")); return client; }
  function requireSnapshot() {
    if (!snapshot || snapshot.chainId !== chainId || !same(snapshot.address, account)) throw new Error(t("Consulte a conta primeiro.", "Inspect the account first."));
    return snapshot;
  }
  async function run(task: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await task(); } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }
  function resetInspection() {
    setSnapshot(undefined); setReview(undefined); setPositions([]); setCoveredRequests([]); setScanProgress(""); setMamoPositions([]); setPositionFailures([]);
    setCardDelay(undefined); setQueue([]); setReviewed(false); setStep(0);
  }
  function selectAccount(value: string, fromWallet = false) {
    setFollowWallet(fromWallet); setAccount(value); resetInspection();
  }
  useEffect(() => {
    // Follow the connected address by default, including account switches.
    // An explicitly selected Safe/card remains the target when its signer connects.
    if (!walletAddress || !followWallet || busy || same(account, walletAddress)) return;
    setAccount(walletAddress); resetInspection(); setError(""); setNotice("");
  }, [walletAddress, followWallet, busy, account]);
  function openDiagnosis(result: NetworkDiagnosis, next: 1 | 2 | 3, assetTab?: string, holding?: TokenHolding) {
    if (!result.snapshot || !same(result.account, account)) return;
    resetInspection(); setChainId(result.chainId); setSnapshot(result.snapshot); setStep(next === 1 && result.snapshot.passkey !== "detected" ? 2 : next);
    setPositions(result.positions); setTab(assetTab ?? "transfer");
    setToken(holding?.address ?? ""); setAmount(holding?.verifiedDecimals !== undefined ? formatUnits(holding.balance, holding.verifiedDecimals) : "");
    setError(""); setNotice("");
    setProgress(old => ({ ...old, accounts: old.accounts.some(a => a.chainId === result.chainId && same(a.address, result.account))
      ? old.accounts : [...old.accounts, { chainId: result.chainId, address: result.account, label: `Account ${short(result.account)}` }].slice(-100) }));
  }
  function openReview(action: PreparedAction) {
    if (action.receive) assertSeparateRecipient(action.receive.recipient, walletAddress);
    if (uncertain) throw new Error(t("Confira a transação pendente antes de preparar outra.", "Check the pending transaction before preparing another."));
    setReview(action); setReviewed(false);
  }
  async function refresh() {
    const found = await inspectAccount(requireClient(), account, chainId);
    setSnapshot(found);
    setProgress(old => ({ ...old, accounts: old.accounts.some(a => a.chainId === chainId && same(a.address, found.address))
      ? old.accounts : [...old.accounts, { chainId, address: found.address, label: `${found.version === "EOA" ? "Wallet" : "Safe"} ${short(found.address)}` }].slice(-100) }));
  }
  function submitted(hash: Hex, expectation?: ReceiptExpectation) {
    setLastHash(hash); setUncertain(true);
    const next = { ...progress, transactions: [...progress.transactions, {
      chainId, account: review?.account ?? address(account), hash, label: review?.label ?? "Transaction", status: "pending" as const, expectation,
    }].slice(-1000) };
    setProgress(next);
    saveProgress(next);
  }
  async function execute(approveOnly = false) {
    if (!review || !reviewed || uncertain) return;
    if (review.receive) assertSeparateRecipient(review.receive.recipient, walletAddress);
    const receipt = approveOnly ? await approveSafeProposal(requireClient(), await provider(), review, submitted)
      : await sendAction(requireClient(), await provider(), review, submitted);
    setProgress(old => ({ ...old, transactions: old.transactions.map(tx => tx.hash === receipt.transactionHash ? { ...tx, status: "confirmed" } : tx) }));
    setUncertain(false); setReview(undefined); setReviewed(false);
    setNotice(t("Execução confirmada. Atualize as posições para conferir as próximas etapas.", "Execution confirmed. Refresh positions to check the next steps."));
    await refresh();
    diagnosis.rescan(chainId);
  }
  async function prepareTransfer(card = false) {
    assertSeparateRecipient(destination, walletAddress);
    const safe = requireSnapshot();
    const selectedId = transferId(chainId, token);
    if (!card && excluded(selectedId)) throw new Error(t("Este ativo foi desmarcado em Preparar carteiras. Selecione-o lá para movê-lo.", "This asset was unticked in Prepare wallets. Select it there to move it."));
    const coin = token.trim() ? address(token) : null;
    const decimals = coin ? await requireClient().readContract({ address: coin, abi: erc20Abi, functionName: "decimals" }) : 18;
    const value = parseAmount(amount, decimals);
    if (same(destination, card ? cardDelay?.card ?? "" : safe.address)) throw new Error("Destination must differ from source account");
    const call = transferCall(coin, destination, value);
    if (card) {
      if (!cardDelay) throw new Error("Inspect the card first");
      openReview(enqueueCard(cardDelay, call, chainId, safe.address, safe));
    } else {
      openReview({ ...safeAction(safe, call, t("Transferir ativo", "Transfer asset")),
        receive: { token: coin, recipient: address(destination), minimum: value } });
    }
  }
  async function scanPositions() {
    const safe = requireSnapshot();
    const found: Position[] = [], failed: string[] = [];
    const results = await Promise.allSettled(products.filter(p => p.chainId === chainId).map(p => inspectPosition(requireClient(), safe.address, p)));
    const selected = products.filter(p => p.chainId === chainId);
    results.forEach((r, i) => {
      if (r.status === "fulfilled") found.push(r.value);
      else failed.push(`${selected[i].name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    });
    if (chainId === 8453) {
      try {
        const strategies = await discoverMamo(requireClient(), safe.address);
        setMamoPositions(strategies.flatMap(r => r.status === "fulfilled" ? [r.value] : []));
        strategies.forEach(r => { if (r.status === "rejected") failed.push(`MAMO: ${String(r.reason)}`); });
      } catch (e) { failed.push(`MAMO registry: ${String(e)}`); }
    }
    setPositions(found); setPositionFailures(failed);
  }
  const nav = [
    ["transfer", t("Saldo e tokens", "Balance and tokens")], ["card", t("Cartão", "Card")],
    ["invest", t("Investimentos", "Investments")], ["legacy", t("Cestas antigas", "Legacy baskets")],
  ];
  const explorer = chain.blockExplorers?.default.url;
  const visiblePositions = positions.filter(p => !excluded(positionId(chainId, p.product.id)));
  return <ConnectKitProvider theme="minimal" mode="light" options={{
    language: lang === "pt" ? "pt-BR" : "en-US", hideBalance: true,
    hideNoWalletCTA: true, hideRecentBadge: true, enforceSupportedChains: false,
    disableSiweRedirect: true, embedGoogleFonts: false,
  }}><div className="shell">
    <header>
      <a className="brand" href="./"><img className="brand-logo" src="./brand/picnic-wordmark.svg" alt="picnic" width="90" height="29" /><span className="brand-sub">recovery</span></a>
      <div className="header-actions"><Chip>{t("Direto na blockchain", "Directly on-chain")}</Chip>
        <button className="quiet" onClick={() => setLang(lang === "pt" ? "en" : "pt")} aria-label="Change language">{lang === "pt" ? "EN" : "PT"}</button>
      </div>
    </header>
    <main>
      {demo && <p role="status" className="message warning">DEMO · Local Anvil wallet · No real funds</p>}
      <section className="hero">
        <p className="eyebrow">{t("SEU ACESSO INDEPENDENTE", "YOUR INDEPENDENT ACCESS")}</p>
        <h1>{t("Seu dinheiro.", "Your money.")}<br /><em>{t("Nas suas mãos.", "In your hands.")}</em></h1>
        <p className="intro">{t("Recupere sua carteira e retire seus ativos sem depender dos servidores da Picnic. Suas chaves ficam na sua carteira.", "Recover your wallet and withdraw assets without Picnic's servers. Your keys stay in your wallet.")}</p>
        <div className="hero-foot"><span>↗ {t("Sem login Picnic", "No Picnic login")}</span><span>↗ Open source</span><span>↗ {t("Executável localmente", "Runs locally")}</span></div>
      </section>
      <div className="workspace">
        <aside>
          <p className="eyebrow">{t("SEU CAMINHO", "YOUR PATH")}</p>
          <nav className="steps" aria-label={t("Etapas", "Steps")}>
            {([
              [0, t("Diagnóstico", "Diagnosis"), t("Todas as redes, automaticamente", "All networks, automatically")],
              [2, t("Preparar carteiras", "Prepare wallets"), t("Destino e saldo para taxas", "Destination and fee balance")],
              [3, t("Mover o dinheiro", "Move funds"), t("Saldos e investimentos", "Balances and investments")],
            ] as const).map(([target, title, subtitle], index) => <button key={target} disabled={busy} aria-current={(step <= 1 ? 0 : step) === target ? "step" : undefined} className={(step <= 1 ? 0 : step) === target ? "nav-active" : ""} onClick={() => goToStep(target)}>
              <span className="step-number">{index}</span><span>{title}<small>{subtitle}</small></span>
            </button>)}
          </nav>
          <div className="saved"><p className="eyebrow">{t("CONTAS SALVAS", "SAVED ACCOUNTS")}</p>
            {progress.accounts.length === 0 && <p className="muted small">{t("As contas consultadas ficam salvas neste navegador.", "Inspected accounts are saved in this browser.")}</p>}
            {[...new Map(progress.accounts.map(a => [a.address.toLowerCase(), a])).values()].map(a => <button key={a.address} className="saved-account" disabled={busy} onClick={() => selectAccount(a.address)}>{short(a.address)}<small>{t("Diagnosticar em todas as redes", "Diagnose across all networks")}</small></button>)}
            <div className="row"><button className="text-button" onClick={() => downloadProgress(progress)}>{t("Exportar progresso", "Export progress")}</button>
              <button className="text-button" disabled={busy} onClick={() => importRef.current?.click()}>{t("Importar", "Import")}</button></div>
            <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={e => {
              const file = e.target.files?.[0]; if (file) void run(async () => { const imported = parseProgress(await file.text()); setProgress(imported); const pending = imported.transactions.find(tx => tx.status === "pending"); setLastHash(pending?.hash); setUncertain(Boolean(pending)); resetInspection(); });
            }} />
          </div>
          <a className="source-link" href="https://github.com/usePicnic/picnic-recovery" target="_blank" rel="noreferrer">GitHub ↗</a>
        </aside>
        <div className="content">
          {step <= 1 ? <DiagnosisPanel account={account} setAccount={value => selectAccount(value)} onUseWallet={() => { if (walletAddress) selectAccount(walletAddress, true); }}
            wallet={walletAddress} lang={lang} busy={busy} results={diagnosis.results} overrides={rpcOverrides}
            setRpc={(id, value) => { resetInspection(); setRpcOverrides(old => ({ ...old, [id]: value })); }}
            rescan={diagnosis.rescan} open={openDiagnosis} custom={diagnosis.customTokens} addCustom={diagnosis.addCustomToken}
            removeCustom={diagnosis.removeCustomToken} retryCustom={diagnosis.retryCustomToken}
            recovery={step === 1 && snapshot?.passkey === "detected" ? <RecoveryPanel snapshot={snapshot} wallet={walletAddress} lang={lang} busy={busy} owner={owner} setOwner={setOwner}
              networkIds={diagnosis.results.filter(r => r.snapshot?.passkey === "detected").map(r => r.chainId)}
              selectNetwork={id => { const result = diagnosis.results.find(r => r.chainId === id); if (result) openDiagnosis(result, 1); }}
              prepare={() => goToStep(2)} review={(module, operation) => void run(async () => openReview(recoveryAction(requireSnapshot(), module, operation, operation === "approve" || operation === "start" ? owner : undefined)))} /> : undefined} /> : <section className="panel compact account-context">
            <div>{step === 3 && <span className="small muted">{chain.name}</span>}<p className="mono small">{snapshot?.address ?? t("Conta ainda não consultada", "Account not inspected yet")}</p>
              <p className="small muted">{t("Carteira conectada", "Connected wallet")}: <span className="mono">{walletAddress ?? t("nenhuma", "none")}</span></p></div>
            <button className="text-button" disabled={busy} onClick={() => goToStep(0)}>{t("Trocar carteira ou voltar ao diagnóstico", "Change wallet or back to diagnosis")}</button>
          </section>}
          {step > 1 && diagnosis.results.some(r => r.status === "scanning" || r.status === "queued") && <p className="small muted" role="status">{t("O diagnóstico das outras redes continua em segundo plano.", "Diagnosis of the other networks continues in the background.")}</p>}
          {error && <div className="message error" role="alert">{error}</div>}
          {notice && <div className="message success" role="status">{notice}</div>}
          {uncertain && <div className="message warning" role="alert">
            <strong>{t("Uma transação foi enviada. Confira o resultado antes de repetir.", "A transaction was submitted. Check its result before repeating.")}</strong>
            {lastHash && <><p className="mono">{lastHash}</p><button className="outline" disabled={busy} onClick={() => run(async () => {
              const record = progress.transactions.find(tx => tx.hash === lastHash);
              if (!record) throw new Error("Pending transaction record not found");
              const receiptClient = publicClient(chainById(record.chainId), rpcFor(record.chainId, rpcOverrides));
              await assertChain(receiptClient, record.chainId);
              const receipt = await receiptClient.getTransactionReceipt({ hash: lastHash });
              if (receipt.status === "success") {
                if (record.expectation?.safe) safeReceiptSucceeded(receipt.logs, record.expectation.safe, record.expectation.safeHash);
                if (record.expectation?.receive) verifyTokenReceipt(receipt, record.expectation.receive);
              }
              setNotice(`${t("Recibo", "Receipt")}: ${receipt.status}. ${t("Atualize a conta e confira o resultado da operação.", "Refresh the account and verify the operation result.")}`);
              setProgress(old => ({ ...old, transactions: old.transactions.map(tx => tx.hash === lastHash ? { ...tx, status: receipt.status === "success" ? "confirmed" : "reverted" } : tx) }));
              const other = progress.transactions.find(tx => tx.hash !== lastHash && tx.status === "pending");
              setUncertain(Boolean(other)); setLastHash(other?.hash); setReview(undefined);
              if (same(record.account, account)) diagnosis.rescan(record.chainId);
              if (record.chainId === chainId && snapshot) await refresh();
            })}>{t("Conferir recibo", "Check receipt")}</button></>}
          </div>}
          {step === 2 && <PrepareMigration lang={lang} busy={busy} account={account} wallet={walletAddress} results={diagnosis.results} items={items}
            selection={selection} select={(ids, value) => setSelectionState(old => setSelected(forAccount(old, account), items, ids, value))} overrides={rpcOverrides}
            destination={destination} setDestination={setDestination} rescan={diagnosis.rescan} addCustom={diagnosis.addCustomToken} retryCustom={diagnosis.retryCustomToken}
            run={run} connect={() => goToStep(0)} next={() => {
              const target = chosenChains.includes(chainId) ? chainId : chosenChains[0];
              const result = diagnosis.results.find(r => r.chainId === target);
              if (result) openDiagnosis(result, 3, items.find(item => chosen.has(item.id) && item.chainId === target)?.tab);
            }} />}
          {step === 3 && <section className="panel compact">
            <p className="eyebrow">{t("PASSO 2 / MOVER O DINHEIRO", "STEP 2 / MOVE FUNDS")}</p>
            <h2>{t("Retire os ativos, no seu ritmo.", "Withdraw assets at your pace.")}</h2>
            <p>{t("Escolha de onde retirar. Alguns investimentos e o cartão têm uma espera antes de concluir. Revise cada operação e mantenha gás para as próximas etapas.", "Choose where to withdraw from. Some investments and the card require a waiting period. Review each operation and keep gas for the next steps.")}</p>
            <div className="move-networks" role="group" aria-label={t("Redes selecionadas", "Selected networks")}>
              {chains.filter(c => chosenChains.includes(c.id)).map(c => <button key={c.id} type="button" disabled={busy} aria-pressed={c.id === chainId} className={c.id === chainId ? "is-current" : ""} onClick={() => {
                const result = diagnosis.results.find(r => r.chainId === c.id);
                if (result) openDiagnosis(result, 3, items.find(item => chosen.has(item.id) && item.chainId === c.id)?.tab);
              }}><ChainLogo id={c.id} size={20} />{c.name}<span className="tab-count">{[...chosen].filter(id => chainOf(id) === c.id).length}</span></button>)}
              <button type="button" className="text-button" disabled={busy} onClick={() => goToStep(2)}>{t("Editar seleção", "Edit selection")}</button>
            </div>
            {!chosenChains.includes(chainId) && chosen.size > 0 && !rescanning(chainId) && <p className="note">{t(`Nenhum ativo de ${chain.name} está selecionado. Escolha uma das redes acima.`, `No ${chain.name} asset is selected. Choose one of the networks above.`)}</p>}
            <AssetTable lang={lang} busy={busy} ready={diagnosis.results.length > 0} results={diagnosis.results} custom={diagnosis.customTokens} selected={chosen}
              open={openDiagnosis} addCustom={diagnosis.addCustomToken} removeCustom={diagnosis.removeCustomToken} retryCustom={diagnosis.retryCustomToken} />
            <nav className="asset-tabs" aria-label={t("Origem dos ativos", "Asset source")}>{nav.map(([id, label]) => <button key={id} disabled={busy} aria-current={tab === id ? "page" : undefined} className={tab === id ? "nav-active" : ""} onClick={() => { setTab(id); setReview(undefined); }}>{label}</button>)}</nav>
          </section>}
          {step === 3 && (tab === "transfer" || tab === "card") && <section className="panel">
            <p className="eyebrow">{tab === "card" ? t("CARTÃO", "CARD") : t("SALDO E TOKENS", "BALANCE AND TOKENS")}</p><h2>{tab === "card" ? t("Retire o saldo do cartão.", "Withdraw card funds.") : t("Escolha o destino dos seus ativos.", "Choose where your assets go.")}</h2>
            {tab === "card" && <><Field label={t("Safe do cartão (Gnosis)", "Card Safe (Gnosis)")}><input disabled={busy} value={cardAddress} onChange={e => { setCardAddress(e.target.value); setCardDelay(undefined); setQueue([]); }} placeholder="0x…" /></Field>
              <button className="outline" disabled={busy || chainId !== 100} onClick={() => run(async () => {
                const delays = await inspectCard(requireClient(), address(cardAddress), chainId);
                if (delays.length !== 1) throw new Error("Expected one verified card delay module");
                setCardDelay(delays[0]); setQueue(await readQueue(requireClient(), delays[0]));
              })}>{t("Consultar cartão e fila", "Inspect card and queue")}</button>
              {cardDelay && <><p className="small">{t("Módulo de espera", "Delay module")}: <span className="mono">{cardDelay.address}</span></p>
                <p>{t("Controladores", "Controllers")}: {cardDelay.controllers.map(short).join(", ")} · {t("Espera", "Cooldown")}: {cardDelay.cooldown.toString()}s</p>
                <button className="text-button" disabled={busy || !queue.length} onClick={() => run(async () => openReview(await skipExpiredCard(requireClient(), cardDelay, chainId)))}>{t("Revisar descarte dos pedidos expirados", "Review skipping expired requests")}</button>
                {queue.map(q => <div className="queue-row" key={q.nonce.toString()}>
                  <strong>#{q.nonce.toString()} · {queueStatus(q.createdAt, cardDelay.cooldown, cardDelay.expiration, snapshot?.timestamp ?? 0n)}</strong>
                  <p className="mono small">{q.to}</p><details><summary>{t("Ver chamada", "View call")}</summary><code>{q.data}</code><p>{q.value.toString()} wei</p></details>
                  <button className="outline" disabled={busy || q.nonce !== cardDelay.head} onClick={() => run(async () => openReview(await dispatchCard(requireClient(), cardDelay, q, chainId)))}>{t("Revisar execução", "Review execution")}</button>
                </div>)}
              </>}
            </>}
            {chainId === 56 && <StockTokens select={setToken} busy={busy} lang={lang} />}
            <div className="grid two"><Field label={t("Token ERC-20 (vazio = moeda nativa)", "ERC-20 token (empty = native coin)")}><input disabled={busy} value={token} onChange={e => setToken(e.target.value)} placeholder={`0x… / ${chain.nativeCurrency.symbol}`} /></Field>
              <Field label={t("Quantidade", "Amount")}><input disabled={busy} value={amount} inputMode="decimal" onChange={e => setAmount(e.target.value)} placeholder="0.00" /></Field></div>
            <p className="small muted">{t("Use uma carteira de destino diferente da carteira conectada.", "Use a destination wallet different from the connected wallet.")}</p>
            <Field label={t("Endereço de destino", "Destination address")}><input disabled={busy} value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" /></Field>
            <p className="small muted">{t("O envio acontece nesta rede, sem conversão. Para começar, escolha uma pequena quantidade.", "The transfer stays on this network, with no conversion. Start with a small amount.")}</p>
            <button disabled={busy || !snapshot || (tab === "card" && !cardDelay)} onClick={() => run(() => prepareTransfer(tab === "card"))}>{tab === "card" ? t("Revisar retirada com espera", "Review delayed withdrawal") : t("Revisar transferência", "Review transfer")}</button>
          </section>}
          {step === 3 && tab === "invest" && <section className="panel">
            <p className="eyebrow">{t("POSIÇÕES E RESGATES", "POSITIONS & REDEMPTIONS")}</p><h2>{t("Saia pelo contrato do investimento.", "Exit through the investment contract.")}</h2>
            <p>{t("Consulte as posições desta Safe. Resgates em etapas continuam aqui quando a espera terminar.", "Inspect this Safe's positions. Multi-step redemptions can be resumed here after the waiting period.")}</p>
            <button className="outline" disabled={busy || !snapshot} onClick={() => run(scanPositions)}>{t("Consultar posições", "Inspect positions")}</button>
            <div className="grid two"><Field label={t("Quantidade de cotas para resgatar", "Shares to redeem")}><input disabled={busy} value={amount} onChange={e => setAmount(e.target.value)} placeholder={t("Vazio = disponível", "Empty = available")} inputMode="decimal" /></Field>
              <Field label={t("Destino (vazio = esta Safe)", "Destination (empty = this Safe)")}><input disabled={busy} value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" /></Field></div>
            {positions.length > visiblePositions.length && <p className="small muted">{t("Posições desmarcadas em Preparar carteiras ficam ocultas.", "Positions unticked in Prepare wallets are hidden.")}</p>}
            {visiblePositions.map(p => <article className="position" key={p.product.id}>
              <div className="section-title"><h3>{p.product.name}</h3><strong>{formatUnits(p.balance, p.decimals)}</strong></div>
              <p className="mono small muted">{p.product.address}</p>
              {p.product.note && <p className="note">{p.product.note}</p>}
              {p.available !== undefined && <p>{t("Disponível para resgate agora", "Redeemable now")}: {formatUnits(p.available, p.decimals)}</p>}
              {p.pending !== undefined && <p>{t("Cotas aguardando", "Pending shares")}: {formatUnits(p.pending, p.decimals)} · {t("Disponíveis para claim", "Claimable")}: {formatUnits(p.claimable ?? 0n, p.decimals)}</p>}
              <div className="row"><button className="outline" disabled={busy || p.balance === 0n} onClick={() => run(async () => {
                const safe = requireSnapshot();
                if (destination) assertSeparateRecipient(destination, walletAddress);
                openReview(await redeemPosition(requireClient(), safe, p.product, amount ? parseAmount(amount, p.decimals) : p.available !== undefined && p.available < p.balance ? p.available : p.balance, destination || safe.address));
              })}>{p.product.kind === "receipt" ? t("Transferir posição", "Transfer position") : t("Revisar resgate", "Review redemption")}</button>
                {!["staking", "receipt"].includes(p.product.kind) && <button className="text-button" disabled={busy || !destination || !p.balance} onClick={() => run(async () => {
                  const safe = requireSnapshot(), recipient = address(destination);
                  if (same(recipient, safe.address)) throw new Error("Choose an external destination for the position transfer");
                  const units = amount ? parseAmount(amount, p.decimals) : p.balance;
                  openReview({ ...safeAction(safe, transferCall(p.product.address, recipient, units), t("Transferir posição sem resgatar", "Transfer position without redemption")), receive: { token: p.product.address, recipient, minimum: units } });
                })}>{t("Transferir posição ao destino", "Transfer position to destination")}</button>}
                {p.product.kind === "staking" && <button className="text-button" disabled={busy} onClick={() => run(async () => openReview(claimStakingRewards(requireSnapshot(), p.product)))}>{t("Receber recompensas", "Claim rewards")}</button>}
                {p.product.kind === "covered" && <button className="outline" disabled={busy || !p.claimable} onClick={() => run(async () => openReview(await claimCovered(requireClient(), requireSnapshot(), p.product)))}>{t("Receber sDAI", "Claim sDAI")}</button>}
                <a href={p.product.source} target="_blank" rel="noreferrer" className="text-button">{t("Contrato / fonte ↗", "Contract / source ↗")}</a>
              </div>
              {p.product.kind === "covered" && <div className="row">
                <button className="text-button" disabled={busy || !p.pendingDeposit} onClick={() => run(async () => openReview(await recoverCoveredDeposit(requireClient(), requireSnapshot(), p.product, true)))}>{t("Cancelar depósito pendente", "Cancel pending deposit")}</button>
                <button className="text-button" disabled={busy || !p.claimableDeposit} onClick={() => run(async () => openReview(await recoverCoveredDeposit(requireClient(), requireSnapshot(), p.product, false)))}>{t("Receber cotas já liquidadas", "Claim settled deposit shares")}</button>
              </div>}
              {p.product.kind === "covered" && <details><summary>{t("Liquidar um pedido pendente", "Settle a pending request")}</summary>
                <div className="row"><button className="outline" disabled={busy} onClick={() => run(async () => {
                  const controller = new AbortController(); scanController.current = controller; setCoveredRequests([]); setScanProgress(t("Consultando histórico…", "Scanning history…"));
                  try { const found = await findCoveredRequests(requireClient(), requireSnapshot().address, p.product, controller.signal, (at, end) => setScanProgress(`${at} / ${end}`)); setCoveredRequests(found); setScanProgress(`${t("Pedidos pendentes encontrados", "Pending requests found")}: ${found.length}`); }
                  finally { scanController.current = undefined; }
                })}>{t("Buscar todos os pedidos on-chain", "Find all requests on-chain")}</button>
                  {busy && scanController.current && <button className="quiet" onClick={() => scanController.current?.abort()}>{t("Interromper busca", "Stop scan")}</button>}</div>
                {scanProgress && <p className="small" role="status">{scanProgress}</p>}
                {coveredRequests.map(r => <button key={r.id.toString()} className="text-button" disabled={busy} onClick={() => setRequestId(r.id.toString())}>#{r.id.toString()} · {formatUnits(r.shares, p.decimals)}</button>)}
                <Field label={t("ID do pedido (último conhecido abaixo; pode haver outros)", "Request ID (latest shown below; others may exist)")}><input disabled={busy} value={requestId} onChange={e => setRequestId(e.target.value)} placeholder={p.requestId?.toString()} /></Field>
                <button className="outline" disabled={busy || !requestId} onClick={() => run(async () => openReview(await settleCovered(requireClient(), requireSnapshot(), p.product, BigInt(requestId))))}>{t("Verificar e revisar liquidação", "Check and review settlement")}</button>
              </details>}
              {p.requests?.map((r, i) => <div className="queue-row" key={`${r.requestTime}:${i}`}>
                <p>{formatUnits(r.amount, 18)} POL · {new Date(Number(r.withdrawalTime) * 1000).toLocaleString(lang)}</p>
                <button className="outline" disabled={busy} onClick={() => run(async () => openReview(await claimStader(requireClient(), requireSnapshot(), p.product, i)))}>{t("Revisar claim", "Review claim")}</button>
              </div>)}
            </article>)}
            {!excluded(mamoId(chainId)) && mamoPositions.map(p => <article className="position" key={p.address}>
              <h3>MAMO strategy · {formatUnits(p.balance, p.decimals)}</h3><p className="mono small">{p.address}</p>
              <div className="row"><button disabled={busy || !p.balance} onClick={() => run(async () => openReview(await withdrawMamo(requireClient(), requireSnapshot(), p.address)))}>{t("Retirar MAMO", "Withdraw MAMO")}</button>
                <button className="outline" disabled={busy} onClick={() => run(async () => openReview(await withdrawMamo(requireClient(), requireSnapshot(), p.address, true)))}>{t("Receber recompensas", "Claim rewards")}</button></div>
            </article>)}
            {positionFailures.length > 0 && <details className="message warning"><summary>{t("Consulta parcial — posições não verificadas", "Partial scan — unverified positions")} ({positionFailures.length})</summary>{positionFailures.map(f => <p key={f} className="small">{f}</p>)}</details>}
          </section>}
          {step === 3 && tab === "legacy" && excluded(basketsId(chainId)) && <section className="panel compact"><p className="note">{t("As cestas antigas desta rede não estão selecionadas. Selecione-as em Preparar carteiras para movê-las.", "Legacy baskets on this network are not selected. Select them in Prepare wallets to move them.")}</p></section>}
          {step === 3 && tab === "legacy" && !excluded(basketsId(chainId)) && <LegacyPanel key={`${chainId}:${snapshot?.address ?? ""}:${rpc}`} client={client} snapshot={snapshot} busy={busy} lang={lang} run={run} review={openReview} invalidate={() => setReview(undefined)} />}
          {review && <section className="panel review" aria-label={t("Revisão da transação", "Transaction review")}>
            <p className="eyebrow">{t("ANTES DE ASSINAR", "BEFORE YOU SIGN")}</p><h2>{review.label}</h2>
            <dl><dt>{t("Rede", "Network")}</dt><dd>{chain.name} ({review.chainId})</dd><dt>{t("Conta", "Account")}</dt><dd className="mono">{review.account}</dd>
              <dt>{t("Contrato chamado", "Called contract")}</dt><dd className="mono">{review.call.to}</dd><dt>{t("Valor nativo", "Native value")}</dt><dd>{formatUnits(review.call.value, 18)} {chain.nativeCurrency.symbol}</dd>
              {review.expectedOwner && <><dt>{t("Novo owner", "New owner")}</dt><dd className="mono">{review.expectedOwner}</dd></>}
              {review.receive && <><dt>{t("Recebimento esperado", "Expected receipt")}</dt><dd className="mono">{review.receive.recipient}<br />Token: {review.receive.token ?? chain.nativeCurrency.symbol}<br />{t("Mínimo (unidades brutas)", "Minimum (raw units)")}: {review.receive.minimum.toString()}</dd></>}
            </dl>
            {review.details?.map(detail => <p className="mono small" key={detail}>{detail}</p>)}
            {!review.approval && <CallDetails call={review.call} />}
            <details><summary>{t("Dados da chamada", "Call data")}</summary><code>{review.approval ? t("A assinatura EIP-712 será vinculada à rede, módulo, Safe, novo owner e nonce.", "The EIP-712 signature is bound to chain, module, Safe, new owner and nonce.") : review.call.data}</code></details>
            <p className="small">{t("A operação será simulada antes do envio. Sua carteira mostrará o gas, pago por você.", "The operation is simulated before sending. Your wallet will show the gas you pay.")}</p>
            <label className="checkbox"><input type="checkbox" disabled={busy} checked={reviewed} onChange={e => setReviewed(e.target.checked)} />{t("Conferi a rede, o destino e o efeito desta operação.", "I checked the network, destination and effect of this operation.")}</label>
            <div className="row"><button disabled={busy || !reviewed || uncertain} onClick={() => run(() => execute())}>{busy ? t("Aguardando…", "Waiting…") : t("Assinar na minha carteira", "Sign in my wallet")}</button>
              {review.kind === "safe" && snapshot && snapshot.threshold > 1n && <button className="outline" disabled={busy || !reviewed || uncertain} onClick={() => run(() => execute(true))}>{t("Registrar minha aprovação", "Register my approval")}</button>}
              <button className="quiet" disabled={busy} onClick={() => setReview(undefined)}>{t("Voltar", "Back")}</button></div>
          </section>}
          {progress.transactions.length > 0 && <section className="panel compact"><h3>{t("Transações deste navegador", "Transactions from this browser")}</h3>
            {progress.transactions.filter(tx => tx.chainId === chainId).slice(-8).reverse().map(tx => <p className="small" key={tx.hash}><a href={`${explorer}/tx/${tx.hash}`} target="_blank" rel="noreferrer">{short(tx.hash)} ↗</a> · {tx.label}</p>)}
          </section>}
        </div>
      </div>
    </main>
    <footer><span>picnic recovery · {t("Código aberto. Controle seu.", "Open source. Your control.")}</span><span>{t("Sem rastreamento · Sem custódia de chaves", "No tracking · No key custody")}</span></footer>
  </div></ConnectKitProvider>;
}
