import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatUnits, type Address, type EIP1193Provider, type Hex } from "viem";
import { chains, chainById } from "./catalog/chains";
import { products } from "./catalog/products";
import { address, parseAmount, publicClient, same } from "./core/client";
import { inspectAccount } from "./core/inspect";
import { connectedWallet, recoveryAction, safeAction, sendAction, transferCall, approveSafeProposal, safeReceiptSucceeded } from "./core/actions";
import { verifyTokenReceipt, type ReceiptExpectation } from "./core/receipts";
import { erc20Abi } from "./core/abi";
import { inspectCard, enqueueCard, readQueue, dispatchCard, skipExpiredCard, queueStatus, type CardDelay, type QueuedCall } from "./core/card";
import { inspectPosition, redeemPosition, claimCovered, settleCovered, claimStader, claimStakingRewards, recoverCoveredDeposit, findCoveredRequests, type Position } from "./core/investments";
import { useWallets } from "./components/useWallets";
import { StockTokens } from "./components/StockTokens";
import { LegacyPanel } from "./components/LegacyPanel";
import { CallDetails } from "./components/CallDetails";
import { discoverMamo, withdrawMamo, type MamoPosition } from "./core/mamo";
import { readProgress, saveProgress, downloadProgress, parseProgress } from "./core/progress";
import type { AccountSnapshot, PreparedAction } from "./core/types";

declare global { interface Window { ethereum?: EIP1193Provider } }
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
  const [rpc, setRpc] = useState(chain.rpcUrls.default.http[0] ?? "");
  const [account, setAccount] = useState("");
  const [snapshot, setSnapshot] = useState<AccountSnapshot>();
  const [progress, setProgress] = useState(readProgress);
  const wallets = useWallets();
  const [walletId, setWalletId] = useState("");
  const [walletAddress, setWalletAddress] = useState<Address>();
  const [tab, setTab] = useState("account");
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
  const [demo, setDemo] = useState<EIP1193Provider>();
  useEffect(() => {
    if (import.meta.env.DEV && ["127.0.0.1", "localhost"].includes(location.hostname) && new URLSearchParams(location.search).get("demo") === "1") {
      void import("./devProvider").then(m => setDemo(m.demoProvider));
    }
  }, []);
  function provider() {
    if (demo) return demo;
    const chosen = wallets.find(w => w.id === walletId) ?? (wallets.length === 1 ? wallets[0] : undefined);
    if (chosen) return chosen.provider;
    if (wallets.length > 1) throw new Error(t("Escolha sua carteira no seletor.", "Choose your wallet in the selector."));
    if (!window.ethereum) throw new Error(t("Abra em um navegador com carteira instalada. Nunca cole sua chave aqui.", "Open in a browser with a wallet installed. Never paste a key here."));
    return window.ethereum;
  }
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
  function chooseChain(id: number) {
    setChainId(id); setRpc(chainById(id).rpcUrls.default.http[0] ?? "");
    resetInspection();
  }
  function resetInspection() {
    setSnapshot(undefined); setReview(undefined); setPositions([]); setCoveredRequests([]); setScanProgress(""); setMamoPositions([]); setPositionFailures([]);
    setCardDelay(undefined); setQueue([]); setReviewed(false);
  }
  function openReview(action: PreparedAction) {
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
    const receipt = approveOnly ? await approveSafeProposal(requireClient(), provider(), review, submitted)
      : await sendAction(requireClient(), provider(), review, submitted);
    setProgress(old => ({ ...old, transactions: old.transactions.map(tx => tx.hash === receipt.transactionHash ? { ...tx, status: "confirmed" } : tx) }));
    setUncertain(false); setReview(undefined); setReviewed(false);
    setNotice(t("Execução confirmada. Atualize as posições para conferir as próximas etapas.", "Execution confirmed. Refresh positions to check the next steps."));
    await refresh();
  }
  async function prepareTransfer(card = false) {
    const safe = requireSnapshot();
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
    ["account", t("Conta", "Account")], ["recover", t("Recuperar acesso", "Recover access")],
    ["transfer", t("Retirar ativos", "Withdraw assets")], ["card", t("Cartão", "Card")],
    ["invest", t("Investimentos", "Investments")], ["legacy", t("Cestas antigas", "Legacy baskets")],
  ];
  const explorer = chain.blockExplorers?.default.url;
  return <div className="shell">
    <header>
      <a className="brand" href="./"><span className="brand-mark">p.</span><span>picnic<span className="brand-sub">recovery</span></span></a>
      <div className="header-actions"><Chip>{t("Direto na blockchain", "Directly on-chain")}</Chip>
        <button className="quiet" onClick={() => setLang(lang === "pt" ? "en" : "pt")} aria-label="Change language">{lang === "pt" ? "EN" : "PT"}</button>
        {!demo && wallets.length > 1 && <select className="wallet-select" aria-label={t("Carteira para assinar", "Signing wallet")} disabled={busy} value={walletId} onChange={e => { setWalletId(e.target.value); setWalletAddress(undefined); setReview(undefined); }}>
          <option value="">{t("Escolha a carteira", "Choose wallet")}</option>{wallets.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>}
        <button className="outline" disabled={busy} onClick={() => run(async () => {
          const { sender } = await connectedWallet(provider(), chainId); setWalletAddress(sender);
        })}>{walletAddress ? short(walletAddress) : t("Conectar carteira", "Connect wallet")}</button>
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
          <p className="eyebrow">{t("SUA CARTEIRA", "YOUR WALLET")}</p>
          <nav aria-label={t("Etapas", "Steps")}>{nav.map(([id, label], i) =>
            <button key={id} disabled={busy} className={tab === id ? "nav-active" : ""} onClick={() => { setTab(id); setReview(undefined); }}><span className="nav-index">0{i + 1}</span>{label}<span className="nav-arrow">↗</span></button>)}</nav>
          <div className="saved"><p className="eyebrow">{t("CONTAS SALVAS", "SAVED ACCOUNTS")}</p>
            {progress.accounts.length === 0 && <p className="muted small">{t("As contas consultadas ficam salvas neste navegador.", "Inspected accounts are saved in this browser.")}</p>}
            {progress.accounts.map(a => <button key={`${a.chainId}:${a.address}`} className="saved-account" disabled={busy} onClick={() => { chooseChain(a.chainId); setAccount(a.address); }}>{short(a.address)}<small>{chainById(a.chainId).name}</small></button>)}
            <div className="row"><button className="text-button" onClick={() => downloadProgress(progress)}>{t("Exportar progresso", "Export progress")}</button>
              <button className="text-button" disabled={busy} onClick={() => importRef.current?.click()}>{t("Importar", "Import")}</button></div>
            <input ref={importRef} hidden type="file" accept=".json,application/json" onChange={e => {
              const file = e.target.files?.[0]; if (file) void run(async () => { const imported = parseProgress(await file.text()); setProgress(imported); const pending = imported.transactions.find(tx => tx.status === "pending"); setLastHash(pending?.hash); setUncertain(Boolean(pending)); resetInspection(); });
            }} />
          </div>
          <a className="source-link" href="https://github.com/usePicnic/picnic-recovery" target="_blank" rel="noreferrer">GitHub ↗</a>
        </aside>
        <div className="content">
          <section className="panel connection">
            <div className="section-title"><span className="dot" /><h2>{t("Conexão independente", "Independent connection")}</h2></div>
            <div className="grid two">
              <Field label={t("Rede", "Network")}><select value={chainId} disabled={busy} onChange={e => chooseChain(Number(e.target.value))}>{chains.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></Field>
              <Field label={t("Safe ou carteira antiga", "Safe or legacy wallet")}><input placeholder="0x…" value={account} disabled={busy} spellCheck={false} onChange={e => { setAccount(e.target.value); resetInspection(); }} /></Field>
            </div>
            <details><summary>{t("Configurar RPC", "Configure RPC")}</summary><Field label="RPC URL"><input disabled={busy} value={rpc} type="url" onChange={e => { setRpc(e.target.value); resetInspection(); }} /></Field>
              <p className="muted small">{t("O RPC recebe consultas públicas. Você pode usar seu próprio nó. O endereço não é salvo nem exportado.", "The RPC receives public queries. You can use your own node. Its URL is not saved or exported.")}</p></details>
            <button disabled={busy || !account || !client} onClick={() => run(refresh)}>{busy ? t("Consultando…", "Working…") : t("Consultar conta →", "Inspect account →")}</button>
          </section>
          {error && <div className="message error" role="alert">{error}</div>}
          {notice && <div className="message success" role="status">{notice}</div>}
          {uncertain && <div className="message warning" role="alert">
            <strong>{t("Uma transação foi enviada. Confira o resultado antes de repetir.", "A transaction was submitted. Check its result before repeating.")}</strong>
            {lastHash && <><p className="mono">{lastHash}</p><button className="outline" disabled={busy} onClick={() => run(async () => {
              const record = progress.transactions.find(tx => tx.hash === lastHash);
              if (!record || record.chainId !== chainId) throw new Error(t("Selecione a rede da transação pendente.", "Select the pending transaction's network."));
              const receipt = await requireClient().getTransactionReceipt({ hash: lastHash });
              if (receipt.status === "success") {
                if (record.expectation?.safe) safeReceiptSucceeded(receipt.logs, record.expectation.safe, record.expectation.safeHash);
                if (record.expectation?.receive) verifyTokenReceipt(receipt, record.expectation.receive);
              }
              setNotice(`${t("Recibo", "Receipt")}: ${receipt.status}. ${t("Atualize a conta e confira o resultado da operação.", "Refresh the account and verify the operation result.")}`);
              setProgress(old => ({ ...old, transactions: old.transactions.map(tx => tx.hash === lastHash ? { ...tx, status: receipt.status === "success" ? "confirmed" : "reverted" } : tx) }));
              const other = progress.transactions.find(tx => tx.hash !== lastHash && tx.status === "pending");
              setUncertain(Boolean(other)); setLastHash(other?.hash); setReview(undefined); await refresh();
            })}>{t("Conferir recibo", "Check receipt")}</button></>}
          </div>}
          {tab === "account" && <section className="panel">
            <p className="eyebrow">{t("01 / COMECE AQUI", "01 / START HERE")}</p><h2>{t("Encontre o caminho da sua conta.", "Find your account's path.")}</h2>
            <p>{t("Informe o endereço da conta e a rede. Vamos consultar quem pode movimentar os ativos e qual recuperação está configurada.", "Enter the account address and network. We'll inspect who can move assets and which recovery is configured.")}</p>
            <div className="explainer"><span className="big-number">01</span><div><h3>{t("Já tem uma carteira que é owner?", "Already have an owner wallet?")}</h3><p>{t("Conecte-a e vá para Retirar ativos. Ver o saldo não significa ter permissão para movimentá-lo.", "Connect it and open Withdraw assets. Seeing a balance doesn't mean you can move it.")}</p></div></div>
            <div className="explainer"><span className="big-number">02</span><div><h3>{t("Tem uma chave de recuperação?", "Have a recovery key?")}</h3><p>{t("Importe-a de forma privada na sua carteira. Se ela for guardian, recupere o acesso antes de retirar.", "Import it privately in your wallet. If it's a guardian, recover access before withdrawing.")}</p></div></div>
            <p className="note">{t("Não cole chave privada, seed ou código de acesso nesta ferramenta.", "Never paste a private key, seed phrase or login code in this tool.")}</p>
          </section>}
          {snapshot && <section className="panel compact">
            <div className="section-title"><h2>{t("Estado verificado", "Inspected state")}</h2><Chip>{snapshot.version === "EOA" ? "EOA" : `Safe ${snapshot.version}`}</Chip></div>
            <div className="stats"><div><small>{t("Saldo nativo", "Native balance")}</small><strong>{formatUnits(snapshot.nativeBalance, 18)} {chain.nativeCurrency.symbol}</strong></div><div><small>{t("Assinaturas necessárias", "Required signatures")}</small><strong>{snapshot.threshold.toString()} / {snapshot.owners.length}</strong></div><div><small>{t("Bloco", "Block")}</small><strong>{snapshot.block.toString()}</strong></div></div>
            <p className="small muted">Owners</p>{snapshot.owners.map(a => <p className="mono small" key={a}>{a}</p>)}
            {snapshot.warnings.map(w => <p className="note" key={w}>{w}</p>)}
          </section>}
          {tab === "recover" && <section className="panel">
            <p className="eyebrow">{t("02 / RECUPERAR CONTROLE", "02 / RECOVER CONTROL")}</p><h2>{t("Uma nova chave para a mesma conta.", "A new key for the same account.")}</h2>
            {!snapshot && <p>{t("Consulte a conta para começar.", "Inspect the account to begin.")}</p>}
            {snapshot && snapshot.recoveries.length === 0 && <p className="note">{t("Nenhum módulo de recuperação compatível foi identificado. Isso não significa que não existam outras rotas.", "No compatible recovery module was identified. Other routes may still exist.")}</p>}
            {snapshot?.recoveries.map(r => <div key={r.module} className="recovery-box">
              <p className="mono small">{r.module}</p><p>{t("Aprovações de guardiões", "Guardian approvals")}: {r.threshold.toString()} · {t("Espera do contrato", "Contract waiting period")}: {Number(r.period ?? 0n) / 86400} {t("dias", "days")}</p>
              {r.guardians.map(g => <p className="mono small muted" key={g}>{g}</p>)}
              {r.pending.executeAfter > 0n ? <>
                <p><strong>{t("Recuperação pendente", "Recovery pending")}</strong></p>
                <p>{t("Novo owner", "New owner")}: <span className="mono">{r.pending.newOwners.join(", ")}</span></p>
                <p>{t("Finalização a partir de", "Earliest finalization")}: {new Date(Number(r.pending.executeAfter) * 1000).toLocaleString(lang)}</p>
                <div className="row"><button disabled={busy || snapshot.timestamp < r.pending.executeAfter} onClick={() => run(async () => openReview(recoveryAction(requireSnapshot(), r.module, "finalize")))}>{t("Revisar finalização", "Review finalization")}</button>
                  <button className="outline" disabled={busy} onClick={() => run(async () => openReview(recoveryAction(requireSnapshot(), r.module, "cancel")))}>{t("Cancelar com owner atual", "Cancel with current owner")}</button></div>
              </> : <><Field label={t("Nova carteira que você controla", "New wallet you control")}><input disabled={busy} value={owner} onChange={e => setOwner(e.target.value)} placeholder="0x…" /></Field>
                <p className="small muted">{t("A nova carteira deve ser diferente dos guardiões. A assinatura autoriza a troca de controle da Safe.", "The new wallet must differ from the guardians. Signing authorizes a change of Safe control.")}</p>
                <div className="row"><button disabled={busy} onClick={() => run(async () => openReview(recoveryAction(requireSnapshot(), r.module, "approve", owner)))}>{t("Revisar aprovação", "Review approval")}</button>
                  <button className="outline" disabled={busy} onClick={() => run(async () => openReview(recoveryAction(requireSnapshot(), r.module, "start", owner)))}>{t("Iniciar após aprovações", "Start after approvals")}</button></div>
              </>}
            </div>)}
          </section>}
          {(tab === "transfer" || tab === "card") && <section className="panel">
            <p className="eyebrow">{tab === "card" ? "04 / CARD" : "03 / TRANSFER"}</p><h2>{tab === "card" ? t("Retire o saldo do cartão.", "Withdraw card funds.") : t("Escolha o destino dos seus ativos.", "Choose where your assets go.")}</h2>
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
            <Field label={t("Endereço de destino", "Destination address")}><input disabled={busy} value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" /></Field>
            <p className="small muted">{t("O envio acontece nesta rede, sem conversão. Para começar, escolha uma pequena quantidade.", "The transfer stays on this network, with no conversion. Start with a small amount.")}</p>
            <button disabled={busy || !snapshot || (tab === "card" && !cardDelay)} onClick={() => run(() => prepareTransfer(tab === "card"))}>{tab === "card" ? t("Revisar retirada com espera", "Review delayed withdrawal") : t("Revisar transferência", "Review transfer")}</button>
          </section>}
          {tab === "invest" && <section className="panel">
            <p className="eyebrow">{t("05 / POSIÇÕES E RESGATES", "05 / POSITIONS & REDEMPTIONS")}</p><h2>{t("Saia pelo contrato do investimento.", "Exit through the investment contract.")}</h2>
            <p>{t("Consulte as posições desta Safe. Resgates em etapas continuam aqui quando a espera terminar.", "Inspect this Safe's positions. Multi-step redemptions can be resumed here after the waiting period.")}</p>
            <button className="outline" disabled={busy || !snapshot} onClick={() => run(scanPositions)}>{t("Consultar posições", "Inspect positions")}</button>
            <div className="grid two"><Field label={t("Quantidade de cotas para resgatar", "Shares to redeem")}><input disabled={busy} value={amount} onChange={e => setAmount(e.target.value)} placeholder={t("Vazio = disponível", "Empty = available")} inputMode="decimal" /></Field>
              <Field label={t("Destino (vazio = esta Safe)", "Destination (empty = this Safe)")}><input disabled={busy} value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" /></Field></div>
            {positions.map(p => <article className="position" key={p.product.id}>
              <div className="section-title"><h3>{p.product.name}</h3><strong>{formatUnits(p.balance, p.decimals)}</strong></div>
              <p className="mono small muted">{p.product.address}</p>
              {p.product.note && <p className="note">{p.product.note}</p>}
              {p.available !== undefined && <p>{t("Disponível para resgate agora", "Redeemable now")}: {formatUnits(p.available, p.decimals)}</p>}
              {p.pending !== undefined && <p>{t("Cotas aguardando", "Pending shares")}: {formatUnits(p.pending, p.decimals)} · {t("Disponíveis para claim", "Claimable")}: {formatUnits(p.claimable ?? 0n, p.decimals)}</p>}
              <div className="row"><button className="outline" disabled={busy || p.balance === 0n} onClick={() => run(async () => {
                const safe = requireSnapshot();
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
            {mamoPositions.map(p => <article className="position" key={p.address}>
              <h3>MAMO strategy · {formatUnits(p.balance, p.decimals)}</h3><p className="mono small">{p.address}</p>
              <div className="row"><button disabled={busy || !p.balance} onClick={() => run(async () => openReview(await withdrawMamo(requireClient(), requireSnapshot(), p.address)))}>{t("Retirar MAMO", "Withdraw MAMO")}</button>
                <button className="outline" disabled={busy} onClick={() => run(async () => openReview(await withdrawMamo(requireClient(), requireSnapshot(), p.address, true)))}>{t("Receber recompensas", "Claim rewards")}</button></div>
            </article>)}
            {positionFailures.length > 0 && <details className="message warning"><summary>{t("Consulta parcial — posições não verificadas", "Partial scan — unverified positions")} ({positionFailures.length})</summary>{positionFailures.map(f => <p key={f} className="small">{f}</p>)}</details>}
          </section>}
          {tab === "legacy" && <LegacyPanel key={`${chainId}:${snapshot?.address ?? ""}:${rpc}`} client={client} snapshot={snapshot} busy={busy} lang={lang} run={run} review={openReview} invalidate={() => setReview(undefined)} />}
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
  </div>;
}
