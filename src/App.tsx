import { displayError } from "./core/errors";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatUnits, type Address, type EIP1193Provider, type Hex } from "viem";
import { chains, chainById } from "./catalog/chains";
import { products } from "./catalog/products";
import { address, assertChain, parseAmount, publicClient, same } from "./core/client";
import { inspectAccount } from "./core/inspect";
import { assertSeparateRecipient, destinationError, knownGuardians } from "./core/destination";
import { recoveryAction, safeAction, sendAction, transferCall, approveSafeProposal } from "./core/actions";
import { verifyReceipt, type ReceiptExpectation } from "./core/receipts";
import { erc20Abi } from "./core/abi";
import { inspectCard, enqueueCard, readQueue, dispatchCard, skipExpiredCard, queueStatus, type CardDelay, type QueuedCall } from "./core/card";
import { inspectPosition, redeemPosition, claimCovered, settleCovered, claimStader, claimStakingRewards, recoverCoveredDeposit, findCoveredRequests, type Position } from "./core/investments";
import { useAccount } from "wagmi";
import { ConnectKitProvider } from "connectkit";
import { PrepareMigration } from "./components/PrepareMigration";
import { BatchMigration, type SubmittedRecord } from "./components/BatchMigration";
import { DestinationMessage } from "./components/DestinationMessage";
import { BasketContentsView } from "./components/BasketContents";
import { useBasketContents } from "./components/useBasketContents";
import { chainOf, commitSelection, emptySelection, forAccount, isExcluded, migrationItems, positionId, selectedIds, setSelected, transferId, type Selection, type MigrationItem } from "./components/migration";
import { DiagnosisPanel } from "./components/DiagnosisPanel";
import { RecoveryPanel } from "./components/RecoveryPanel";
import { CardAssetForm } from "./components/CardAssetForm";
import { ItemText } from "./components/AssetTable";
import { useConnectedAccount } from "./components/useConnectedAccount";
import { useDiagnosis, rpcFor, type RpcOverrides } from "./components/useDiagnosis";
import { type NetworkDiagnosis, type TokenHolding } from "./core/diagnosis";
import { LegacyPanel } from "./components/LegacyPanel";
import { CallDetails } from "./components/CallDetails";
import { ChainLogo } from "./components/ChainLogo";
import { discoverMamo, inspectMamo, withdrawMamo, type MamoPosition } from "./core/mamo";
import { readProgress, saveProgress } from "./core/progress";
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
  const [snapshot, setSnapshot] = useState<AccountSnapshot>();
  const [progress, setProgress] = useState(readProgress);
  const connection = useAccount();
  const walletAddress = connection.address;
  const connectedAccount = useConnectedAccount(walletAddress, true, rpcOverrides);
  const diagnosis = useDiagnosis(account, rpcOverrides);
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  // Every known guardian of this source account (any network, connected or
  // not). Sending re-reads the source Safe's guardians again.
  // What to move, chosen in Prepare wallets and enforced in Move funds.
  // Contents of identified legacy baskets, read in a bounded background queue.
  const baskets = useBasketContents(diagnosis.account, diagnosis.results, rpcOverrides);
  const items = migrationItems(diagnosis.results, diagnosis.customTokens, baskets.contents);
  const [selectionState, setSelectionState] = useState<Selection>(() => emptySelection(account));
  const selection = forAccount(selectionState, account);
  const chosen = selectedIds(selection, items);
  const excluded = (id: string) => isExcluded(selection, items, id);
  const guardians = knownGuardians([...diagnosis.results.map(r => r.snapshot), snapshot], account);
  const rescanning = (id: number) => diagnosis.results.some(r => r.chainId === id && (r.status === "queued" || r.status === "scanning"));
  // A network being rescanned after a transaction keeps its place in Move funds.
  const chosenChains = chains.map(c => c.id).filter(id => [...chosen].some(item => chainOf(item) === id)
    || rescanning(id) && Object.entries(selection.decided).some(([item, value]) => value && chainOf(item) === id));
  // A different source account never inherits another account's choices.
  useEffect(() => { setSelectionState(old => forAccount(old, account)); }, [account]);
  // Entering Move funds freezes the defaults: assets found later are not included implicitly.
  useEffect(() => { if (step === 3) setSelectionState(old => commitSelection(forAccount(old, account), items)); }, [step, account]);
  const [tab, setTab] = useState("transfer");
  const [activeItem, setActiveItem] = useState<MigrationItem>();
  const assetRequest = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [review, setReview] = useState<PreparedAction>();
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
  const client = useMemo(() => {
    try { return publicClient(chain, rpc); } catch { return undefined; }
  }, [chain, rpc]);
  useEffect(() => { try { saveProgress(progress); } catch { setError("Local progress could not be saved. Keep transaction hashes from your wallet before closing this page."); } }, [progress]);
  useEffect(() => { setReview(undefined); }, [destination, token, amount, owner, requestId, cardAddress]);
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
    setActiveItem(undefined);
    setStep(next > 0 && !snapshot ? 0 : next === 1 && snapshot?.passkey !== "detected" ? 0 : next); setReview(undefined);
  }
  useEffect(() => { setReview(undefined); }, [walletAddress, connection.connector?.uid, connection.chainId]);
  function requireClient() { if (!client) throw new Error(t("Informe um RPC válido.", "Enter a valid RPC.")); return client; }
  function requireSnapshot() {
    if (!snapshot || snapshot.chainId !== chainId || !same(snapshot.address, account)) throw new Error(t("Consulte a conta primeiro.", "Inspect the account first."));
    return snapshot;
  }
  const runningTask = useRef(false);
  async function run(task: () => Promise<void>) {
    if (runningTask.current) return;
    runningTask.current = true;
    setBusy(true); setError(""); setNotice("");
    try { await task(); } catch (e) {
      setError(displayError(e, lang));
    } finally { runningTask.current = false; setBusy(false); }
  }
  function resetInspection() {
    assetRequest.current++; setActiveItem(undefined);
    setSnapshot(undefined); setReview(undefined); setPositions([]); setCoveredRequests([]); setScanProgress(""); setMamoPositions([]); setPositionFailures([]);
    setCardDelay(undefined); setQueue([]); setStep(0);
  }
  useEffect(() => {
    // Follow the connected address, including account switches.
    if (!walletAddress || busy) return;
    const target = connectedAccount?.account ?? walletAddress;
    if (same(account, target)) return;
    setAccount(target); resetInspection(); setError(""); setNotice("");
  }, [walletAddress, connectedAccount?.account, busy, account]);
  function openDiagnosis(result: NetworkDiagnosis, next: 1 | 2 | 3, assetTab?: string, holding?: TokenHolding) {
    if (!result.snapshot || !same(result.account, account)) return;
    resetInspection(); setChainId(result.chainId); setSnapshot(result.snapshot); setStep(next === 1 && result.snapshot.passkey !== "detected" ? 2 : next);
    setPositions(result.positions); setTab(assetTab ?? "transfer");
    setToken(holding?.address ?? ""); setAmount(holding?.verifiedDecimals !== undefined ? formatUnits(holding.balance, holding.verifiedDecimals) : "");
    setError(""); setNotice("");
    setProgress(old => ({ ...old, accounts: old.accounts.some(a => a.chainId === result.chainId && same(a.address, result.account))
      ? old.accounts : [...old.accounts, { chainId: result.chainId, address: result.account, label: `Account ${short(result.account)}` }].slice(-100) }));
  }
  async function openReview(prepared: PreparedAction) {
    const action = { ...prepared, forbiddenRecipients: [...prepared.forbiddenRecipients ?? [], ...guardians] };
    if (action.receive) assertSeparateRecipient(action.receive.recipient, walletAddress, guardians);
    if (uncertain) throw new Error(t("Confira a transação pendente antes de preparar outra.", "Check the pending transaction before preparing another."));
    setReview(action);
    await execute(false, action);
  }
  async function refresh() {
    const found = await inspectAccount(requireClient(), account, chainId);
    setSnapshot(found);
    setProgress(old => ({ ...old, accounts: old.accounts.some(a => a.chainId === chainId && same(a.address, found.address))
      ? old.accounts : [...old.accounts, { chainId, address: found.address, label: `${found.version === "EOA" ? "Wallet" : "Safe"} ${short(found.address)}` }].slice(-100) }));
  }
  // Persisted before waiting for the receipt, with every expected effect, so a
  // timeout or reload never leads to an automatic resubmission.
  const progressRef = useRef(progress); progressRef.current = progress;
  function record({ chainId: txChain, account: txAccount, label, hash, expectation }: SubmittedRecord) {
    setLastHash(hash); setUncertain(true);
    const next = { ...progressRef.current, transactions: [...progressRef.current.transactions, {
      chainId: txChain, account: txAccount, hash, label, status: "pending" as const, expectation,
    }].slice(-1000) };
    progressRef.current = next;
    setProgress(next);
    saveProgress(next);
  }
  function confirmed(hash: Hex) {
    setProgress(old => {
      const next = { ...old, transactions: old.transactions.map(tx => tx.hash === hash ? { ...tx, status: "confirmed" as const } : tx) };
      progressRef.current = next;
      return next;
    });
    setUncertain(false); setLastHash(undefined);
  }
  async function execute(approveOnly = false, action = review) {
    if (!action || uncertain) return;
    if (action.receive) assertSeparateRecipient(action.receive.recipient, walletAddress, guardians);
    const onSubmitted = (hash: Hex, expectation?: ReceiptExpectation) => record({ chainId: action.chainId, account: action.account, label: action.label, hash, expectation });
    const receipt = approveOnly ? await approveSafeProposal(requireClient(), await provider(), action, onSubmitted)
      : await sendAction(requireClient(), await provider(), action, onSubmitted);
    confirmed(receipt.transactionHash);
    setReview(undefined);
    setNotice(t("Execução confirmada. Atualize as posições para conferir as próximas etapas.", "Execution confirmed. Refresh positions to check the next steps."));
    await refresh();
    diagnosis.rescan(chainId);
  }
  async function prepareTransfer(card = false) {
    assertSeparateRecipient(destination, walletAddress, guardians);
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
      await openReview(enqueueCard(cardDelay, call, chainId, safe.address, safe));
    } else {
      await openReview({ ...safeAction(safe, call, t("Transferir ativo", "Transfer asset")),
        receive: { token: coin, recipient: address(destination), minimum: value } });
    }
  }
  const explorer = chain.blockExplorers?.default.url;
  // Card withdrawals leave the card Safe; other transfers leave the source account.
  const transferProblem = destinationError(destination, tab === "card" ? cardDelay?.card ?? account : snapshot?.address ?? account, walletAddress, guardians);
  const investProblem = destination.trim() ? destinationError(destination, snapshot?.address ?? account, walletAddress, guardians) : undefined;
  const visiblePositions = positions.filter(p => activeItem?.id === positionId(chainId, p.product.id) && !excluded(activeItem.id));
  function openAsset(item: MigrationItem, result: NetworkDiagnosis) {
    if (!chosen.has(item.id)) return;
    openDiagnosis(result, 3, item.tab, item.holding); setActiveItem(item);
    if (item.strategy) setMamoPositions([item.strategy]);
    if (item.card) { setCardAddress(item.card.card); setCardDelay(item.card); }
    const request = assetRequest.current;
    if (item.card || item.tab === "invest") void run(async () => {
      const reader = publicClient(chainById(result.chainId), rpcFor(result.chainId, rpcOverrides));
      if (item.card) {
        const delays = await inspectCard(reader, item.card.card, result.chainId);
        const delay = delays.find(d => d.delayVersion === "v5" && same(d.address, item.card!.address) && d.controllers.some(c => same(c, result.account)));
        if (!delay) throw new Error("Card controller changed; inspect the card again");
        const calls = await readQueue(reader, delay);
        if (request === assetRequest.current) { setCardDelay(delay); setQueue(calls); }
      } else if (item.strategy) {
        const position = await inspectMamo(reader, result.account, item.strategy.address);
        if (request === assetRequest.current) setMamoPositions([position]);
      } else {
        const product = products.find(p => positionId(p.chainId, p.id) === item.id);
        if (product) { const position = await inspectPosition(reader, result.account, product); if (request === assetRequest.current) setPositions([position]); }
        else if (item.kind === "mamo") { const found = await discoverMamo(reader, result.account); if (request === assetRequest.current) { setMamoPositions(found.flatMap(r => r.status === "fulfilled" ? [r.value] : [])); setPositionFailures(found.flatMap(r => r.status === "rejected" ? [String(r.reason)] : [])); } }
      }
    });
  }
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
          <a className="source-link" href="https://github.com/usePicnic/picnic-recovery" target="_blank" rel="noreferrer">GitHub ↗</a>
        </aside>
        <div className="content">
          {step <= 1 ? <DiagnosisPanel account={account}
            picnicAccount={connectedAccount?.status === "ready" && connectedAccount.account && !same(connectedAccount.account, walletAddress ?? "") ? connectedAccount.account : undefined}
            identifying={connectedAccount?.status === "loading"}
            wallet={walletAddress} lang={lang} busy={busy || connectedAccount?.status === "loading"} results={diagnosis.results} overrides={rpcOverrides}
            setRpc={(id, value) => { resetInspection(); setRpcOverrides(old => ({ ...old, [id]: value })); }}
            rescan={diagnosis.rescan} retryPending={diagnosis.retryPending} open={openDiagnosis} custom={diagnosis.customTokens} addCustom={diagnosis.addCustomToken}
            removeCustom={diagnosis.removeCustomToken} retryCustom={diagnosis.retryCustomToken} baskets={baskets}
            recovery={step === 1 && snapshot?.passkey === "detected" ? <RecoveryPanel snapshot={snapshot} wallet={walletAddress} lang={lang} busy={busy} owner={owner} setOwner={setOwner}
              networkIds={diagnosis.results.filter(r => r.snapshot?.passkey === "detected").map(r => r.chainId)}
              selectNetwork={id => { const result = diagnosis.results.find(r => r.chainId === id); if (result) openDiagnosis(result, 1); }}
              prepare={() => goToStep(2)} review={(module, operation) => void run(async () => openReview(recoveryAction(requireSnapshot(), module, operation, operation === "approve" || operation === "start" ? owner : undefined)))} /> : undefined} /> : <section className="panel compact account-context">
            <div>{step === 3 && <span className="small muted">{chain.name}</span>}<p className="mono small">{snapshot?.address ?? t("Conta ainda não consultada", "Account not inspected yet")}</p>
              <p className="small muted">{t("Carteira conectada", "Connected wallet")}: <span className="mono">{walletAddress ?? t("nenhuma", "none")}</span></p></div>
            <button className="text-button" disabled={busy} onClick={() => goToStep(0)}>{t("Trocar carteira ou voltar ao diagnóstico", "Change wallet or back to diagnosis")}</button>
          </section>}
          {step > 1 && diagnosis.results.some(r => r.status === "scanning" || r.status === "queued") && <p className="small muted" role="status">{t("O diagnóstico das outras redes continua em segundo plano.", "Diagnosis of the other networks continues in the background.")}</p>}
          {step <= 1 && connectedAccount?.status === "error" && <p className="message warning" role="alert">{t("Não foi possível verificar a conta Picnic vinculada. Confira o RPC da Gnosis em Avançado; os saldos da carteira conectada não incluem necessariamente os da Picnic.", "The linked Picnic account could not be verified. Check the Gnosis RPC under Advanced; the connected wallet's balances may not include your Picnic funds.")}</p>}
          {error && <div className="message error" role="alert">{error}</div>}
          {notice && <div className="message success" role="status">{notice}</div>}
          {uncertain && <div className="message warning" role="alert">
            <strong>{t("Uma transação foi enviada. Confira o resultado antes de repetir.", "A transaction was submitted. Check its result before repeating.")}</strong>
            {lastHash && <><p className="mono">{lastHash}</p><button className="outline" disabled={busy} onClick={() => run(async () => {
              const record = progressRef.current.transactions.find(tx => tx.hash === lastHash);
              if (!record) throw new Error("Pending transaction record not found");
              const receiptClient = publicClient(chainById(record.chainId), rpcFor(record.chainId, rpcOverrides));
              await assertChain(receiptClient, record.chainId);
              const receipt = await receiptClient.getTransactionReceipt({ hash: lastHash });
              // Same full verification as an awaited receipt: Safe hash, every token and queue entry.
              if (receipt.status === "success") verifyReceipt(receipt, record.expectation ?? {});
              setNotice(`${t("Recibo", "Receipt")}: ${receipt.status}. ${t("Atualize a conta e confira o resultado da operação.", "Refresh the account and verify the operation result.")}`);
              setProgress(old => ({ ...old, transactions: old.transactions.map(tx => tx.hash === lastHash ? { ...tx, status: receipt.status === "success" ? "confirmed" : "reverted" } : tx) }));
              const other = progressRef.current.transactions.find(tx => tx.hash !== lastHash && tx.status === "pending");
              setUncertain(Boolean(other)); setLastHash(other?.hash); setReview(undefined);
              if (same(record.account, account)) diagnosis.rescan(record.chainId);
              if (record.chainId === chainId && snapshot) await refresh();
            })}>{t("Conferir recibo", "Check receipt")}</button></>}
          </div>}
          {step === 2 && <PrepareMigration lang={lang} busy={busy} account={account} wallet={walletAddress} results={diagnosis.results} items={items}
            selection={selection} select={(ids, value) => setSelectionState(old => setSelected(forAccount(old, account), items, ids, value))} overrides={rpcOverrides}
            destination={destination} setDestination={setDestination} rescan={diagnosis.rescan} addCustom={diagnosis.addCustomToken} retryCustom={diagnosis.retryCustomToken}
            run={run} connect={() => goToStep(0)} guardians={guardians} retryBasket={id => baskets.retry([id])} next={() => {
              const target = chosenChains.includes(chainId) ? chainId : chosenChains[0];
              const result = diagnosis.results.find(r => r.chainId === target);
              if (result) openDiagnosis(result, 3, items.find(item => chosen.has(item.id) && item.chainId === target)?.tab);
            }} />}
          {(step === 0 || step === 2) && <CardAssetForm key={account} lang={lang} disabled={busy || !diagnosis.account} add={diagnosis.addCard} />}
          {step === 3 && diagnosis.account && <BatchMigration lang={lang} busy={busy} run={run} account={diagnosis.account} wallet={walletAddress} items={items} chosen={chosen}
            select={(ids, value) => { setActiveItem(undefined); setSelectionState(old => setSelected(forAccount(old, account), items, ids, value)); }}
            destination={destination} guardians={guardians} overrides={rpcOverrides} uncertain={uncertain} provider={provider} baskets={baskets}
            onSubmitted={record} onConfirmed={(id, hash) => { confirmed(hash); diagnosis.rescan(id); }}
            openItem={item => { const result = diagnosis.results.find(r => r.chainId === item.chainId); if (result) openAsset(item, result); }}
            editSelection={() => { setActiveItem(undefined); goToStep(2); }} />}
          {step === 3 && activeItem && <section className="panel compact active-asset"><div className="network-cell"><ChainLogo id={activeItem.chainId} /><ItemText item={activeItem} lang={lang} /></div><button className="text-button" disabled={busy} onClick={() => { setActiveItem(undefined); setReview(undefined); }}>{t("Fechar detalhes", "Close details")}</button></section>}
          {step === 3 && activeItem && (tab === "transfer" || tab === "card") && <section className="panel">
            <p className="eyebrow">{tab === "card" ? t("CARTÃO", "CARD") : t("SALDO E TOKENS", "BALANCE AND TOKENS")}</p><h2>{tab === "card" ? t("Retire o saldo do cartão.", "Withdraw card funds.") : t("Escolha o destino dos seus ativos.", "Choose where your assets go.")}</h2>
            {tab === "card" && <>
              {cardDelay && <><p className="small">{t("Módulo de espera", "Delay module")}: <span className="mono">{cardDelay.address}</span></p>
                <p>{t("Controladores", "Controllers")}: {cardDelay.controllers.map(short).join(", ")} · {t("Espera", "Cooldown")}: {cardDelay.cooldown.toString()}s</p>
                {activeItem.pending && <><button className="text-button" disabled={busy || !queue.length} onClick={() => run(async () => openReview(await skipExpiredCard(requireClient(), cardDelay, chainId)))}>{t("Revisar descarte dos pedidos expirados", "Review skipping expired requests")}</button>
                {queue.map(q => <div className="queue-row" key={q.nonce.toString()}>
                  <strong>#{q.nonce.toString()} · {queueStatus(q.createdAt, cardDelay.cooldown, cardDelay.expiration, snapshot?.timestamp ?? 0n)}</strong>
                  <p className="mono small">{q.to}</p><details><summary>{t("Ver chamada", "View call")}</summary><code>{q.data}</code><p>{q.value.toString()} wei</p></details>
                  <button className="outline" disabled={busy || q.nonce !== cardDelay.head} onClick={() => run(async () => openReview(await dispatchCard(requireClient(), cardDelay, q, chainId)))}>{t("Executar na carteira", "Execute in wallet")}</button>
                </div>)}</>}
              </>}
            </>}
            {!(tab === "card" && activeItem.pending) && <><div className="grid two"><Field label={t("Token ERC-20 (vazio = moeda nativa)", "ERC-20 token (empty = native coin)")}><input disabled={busy} value={token} readOnly placeholder={`0x… / ${chain.nativeCurrency.symbol}`} /></Field>
              <Field label={t("Quantidade", "Amount")}><input disabled={busy} value={amount} inputMode="decimal" onChange={e => setAmount(e.target.value)} placeholder="0.00" /></Field></div>
            <p className="small muted">{t("Use uma carteira de destino diferente da carteira conectada.", "Use a destination wallet different from the connected wallet.")}</p>
            <Field label={t("Endereço de destino", "Destination address")}><input disabled={busy} value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off"
              aria-invalid={!!destination && !!transferProblem} aria-describedby={destination && transferProblem ? "transfer-destination-error" : undefined} /></Field>
            {destination && transferProblem && <DestinationMessage id="transfer-destination-error" problem={transferProblem} lang={lang} />}
            <p className="small muted">{t("O envio acontece nesta rede, sem conversão. Para começar, escolha uma pequena quantidade.", "The transfer stays on this network, with no conversion. Start with a small amount.")}</p>
            <button disabled={busy || !snapshot || (tab === "card" && !cardDelay) || !!transferProblem} onClick={() => run(() => prepareTransfer(tab === "card"))}>{tab === "card" ? t("Solicitar retirada", "Request withdrawal") : t("Transferir na carteira", "Transfer in wallet")}</button></>}
          </section>}
          {step === 3 && activeItem && tab === "invest" && <section className="panel">
            <p className="eyebrow">{t("POSIÇÕES E RESGATES", "POSITIONS & REDEMPTIONS")}</p><h2>{t("Saia pelo contrato do investimento.", "Exit through the investment contract.")}</h2>
            <p>{t("Confira esta posição. Resgates em etapas continuam aqui quando a espera terminar.", "Review this position. Multi-step redemptions can be resumed here after the waiting period.")}</p>
            <button className="outline" disabled={busy || !snapshot} onClick={() => { const result = diagnosis.results.find(r => r.chainId === chainId); if (result) openAsset(activeItem, result); }}>{t("Atualizar saldo", "Refresh balance")}</button>
            <div className="grid two"><Field label={t("Quantidade de cotas para resgatar", "Shares to redeem")}><input disabled={busy} value={amount} onChange={e => setAmount(e.target.value)} placeholder={t("Vazio = disponível", "Empty = available")} inputMode="decimal" /></Field>
              <Field label={t("Destino (vazio = esta Safe)", "Destination (empty = this Safe)")}><input disabled={busy} value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off"
                aria-invalid={!!investProblem} aria-describedby={investProblem ? "invest-destination-error" : undefined} /></Field></div>
            {investProblem && <DestinationMessage id="invest-destination-error" problem={investProblem} lang={lang} />}
            {positions.length > visiblePositions.length && <p className="small muted">{t("Posições desmarcadas em Preparar carteiras ficam ocultas.", "Positions unticked in Prepare wallets are hidden.")}</p>}
            {visiblePositions.map(p => <article className="position" key={p.product.id}>
              <div className="section-title"><h3>{p.product.name}</h3><strong>{formatUnits(p.balance, p.decimals)}</strong></div>
              <p className="mono small muted">{p.product.address}</p>
              {p.product.note && <p className="note">{p.product.note}</p>}
              {p.available !== undefined && <p>{t("Disponível para resgate agora", "Redeemable now")}: {formatUnits(p.available, p.decimals)}</p>}
              {p.pending !== undefined && <p>{t("Cotas aguardando", "Pending shares")}: {formatUnits(p.pending, p.decimals)} · {t("Disponíveis para claim", "Claimable")}: {formatUnits(p.claimable ?? 0n, p.decimals)}</p>}
              <div className="row"><button className="outline" disabled={busy || p.balance === 0n || !!investProblem} onClick={() => run(async () => {
                const safe = requireSnapshot();
                if (destination) assertSeparateRecipient(destination, walletAddress, guardians);
                await openReview(await redeemPosition(requireClient(), safe, p.product, amount ? parseAmount(amount, p.decimals) : p.available !== undefined && p.available < p.balance ? p.available : p.balance, destination || safe.address));
              })}>{p.product.kind === "receipt" ? t("Transferir posição", "Transfer position") : t("Resgatar na carteira", "Redeem in wallet")}</button>
                {!["staking", "receipt"].includes(p.product.kind) && <button className="text-button" disabled={busy || !destination || !p.balance || !!investProblem} onClick={() => run(async () => {
                  const safe = requireSnapshot(), recipient = address(destination);
                  if (same(recipient, safe.address)) throw new Error("Choose an external destination for the position transfer");
                  const units = amount ? parseAmount(amount, p.decimals) : p.balance;
                  await openReview({ ...safeAction(safe, transferCall(p.product.address, recipient, units), t("Transferir posição sem resgatar", "Transfer position without redemption")), receive: { token: p.product.address, recipient, minimum: units } });
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
                <button className="outline" disabled={busy} onClick={() => run(async () => openReview(await claimStader(requireClient(), requireSnapshot(), p.product, i)))}>{t("Receber na carteira", "Claim in wallet")}</button>
              </div>)}
            </article>)}
            {!excluded(activeItem.id) && mamoPositions.filter(p => !activeItem.strategy || same(p.address, activeItem.strategy.address)).map(p => <article className="position" key={p.address}>
              <h3>MAMO strategy · {formatUnits(p.balance, p.decimals)}</h3><p className="mono small">{p.address}</p>
              <div className="row"><button disabled={busy || !p.balance} onClick={() => run(async () => openReview(await withdrawMamo(requireClient(), requireSnapshot(), p.address)))}>{t("Retirar MAMO", "Withdraw MAMO")}</button>
                <button className="outline" disabled={busy} onClick={() => run(async () => openReview(await withdrawMamo(requireClient(), requireSnapshot(), p.address, true)))}>{t("Receber recompensas", "Claim rewards")}</button></div>
            </article>)}
            {positionFailures.length > 0 && <details className="message warning"><summary>{t("Consulta parcial — posições não verificadas", "Partial scan — unverified positions")} ({positionFailures.length})</summary>{positionFailures.map(f => <p key={f} className="small">{f}</p>)}</details>}
          </section>}
          {step === 3 && activeItem && tab === "legacy" && excluded(activeItem.id) && <section className="panel compact"><p className="note">{t("As cestas antigas desta rede não estão selecionadas. Selecione-as em Preparar carteiras para movê-las.", "Legacy baskets on this network are not selected. Select them in Prepare wallets to move them.")}</p></section>}
          {step === 3 && activeItem && tab === "legacy" && !excluded(activeItem.id) && <LegacyPanel contents={activeItem.basketId !== undefined ? <BasketContentsView contents={baskets.contents[String(activeItem.basketId)]} lang={lang} retry={() => baskets.retry([activeItem.basketId!])} /> : undefined} initialNft={activeItem.basketId} key={`${activeItem.id}:${snapshot?.address ?? ""}:${rpc}`} client={client} snapshot={snapshot} busy={busy} lang={lang} run={run} review={openReview} invalidate={() => setReview(undefined)} />}
          {review && <section className="panel review" aria-label={t("Revisão da transação", "Transaction review")}>
            <p className="eyebrow">{t("TRANSAÇÃO", "TRANSACTION")}</p><h2>{review.label}</h2>
            <dl><dt>{t("Rede", "Network")}</dt><dd>{chain.name} ({review.chainId})</dd><dt>{t("Conta", "Account")}</dt><dd className="mono">{review.account}</dd>
              <dt>{t("Contrato chamado", "Called contract")}</dt><dd className="mono">{review.call.to}</dd><dt>{t("Valor nativo", "Native value")}</dt><dd>{formatUnits(review.call.value, 18)} {chain.nativeCurrency.symbol}</dd>
              {review.expectedOwner && <><dt>{t("Novo owner", "New owner")}</dt><dd className="mono">{review.expectedOwner}</dd></>}
              {review.receive && <><dt>{t("Recebimento esperado", "Expected receipt")}</dt><dd className="mono">{review.receive.recipient}<br />Token: {review.receive.token ?? chain.nativeCurrency.symbol}<br />{t("Mínimo (unidades brutas)", "Minimum (raw units)")}: {review.receive.minimum.toString()}</dd></>}
            </dl>
            {review.details?.map(detail => <p className="mono small" key={detail}>{detail}</p>)}
            {!review.approval && <CallDetails call={review.call} />}
            <details><summary>{t("Dados da chamada", "Call data")}</summary><code>{review.approval ? t("A assinatura EIP-712 será vinculada à rede, módulo, Safe, novo owner e nonce.", "The EIP-712 signature is bound to chain, module, Safe, new owner and nonce.") : review.call.data}</code></details>
            <p className="small">{t("A operação será simulada antes do envio. Sua carteira mostrará o gas, pago por você.", "The operation is simulated before sending. Your wallet will show the gas you pay.")}</p>
            <div className="row"><button disabled={busy || uncertain} onClick={() => run(() => execute())}>{busy ? t("Aguardando…", "Waiting…") : t("Tentar novamente na carteira", "Try again in wallet")}</button>
              {review.kind === "safe" && snapshot && snapshot.threshold > 1n && <button className="outline" disabled={busy || uncertain} onClick={() => run(() => execute(true))}>{t("Registrar minha aprovação", "Register my approval")}</button>}
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
