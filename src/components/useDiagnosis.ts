import { useCallback, useEffect, useRef, useState } from "react";
import { type Address } from "viem";
import { chains, chainById, defaultReadRpcs } from "../catalog/chains";
import { address, same } from "../core/client";
import { CustomTokenFailure, diagnoseNetwork, emptyDiagnosis, inspectCustomToken, type CustomToken, type CustomTokenError, type NetworkDiagnosis } from "../core/diagnosis";
import { ReadPool, type ReadCheckpoint } from "../core/reads";
import { discoverCards } from "../core/discovery";
import { inspectCard } from "../core/card";
import { products } from "../catalog/products";
export type RpcOverrides = Record<number, string>;
// The RPC used for transactions: an explicit override, otherwise the default.
export const rpcFor = (chainId: number, overrides: RpcOverrides) => overrides[chainId] ?? readRpcs(chainId, {})[0] ?? "";
// Read-only scans may fail over between public defaults. An explicit custom RPC
// is respected exactly: no silent fallback away from it.
export const readRpcs = (chainId: number, overrides: RpcOverrides): readonly string[] => {
  if (overrides[chainId]) return [overrides[chainId]];
  const chain = chains.find(c => c.id === chainId);
  return chain ? defaultReadRpcs(chain) : [];
};
const sources = (chainId: number, overrides: RpcOverrides) => readRpcs(chainId, overrides).map(url => ({ url }));
export type CustomTokenState = { chainId: number; address: Address; status: "loading" | "ready" | "error"; token?: CustomToken; error?: CustomTokenError };
// Keep confirmed holdings visible while missing units are reconstructed from
// the session checkpoint. A completed run replaces this temporary merged view.
export function retainFindings(previous: NetworkDiagnosis | undefined, next: NetworkDiagnosis): NetworkDiagnosis {
  if (!previous || !same(previous.account, next.account) || previous.chainId !== next.chainId || next.phase === "done") return next;
  const unique = <T,>(items: T[], id: (item: T) => string) => [...new Map(items.map(item => [id(item), item])).values()];
  return { ...previous, ...next, snapshot: next.snapshot ?? previous.snapshot, nativeBalance: next.nativeBalance ?? previous.nativeBalance,
    tokens: unique([...previous.tokens, ...next.tokens], token => token.address.toLowerCase()),
    positions: unique([...previous.positions, ...next.positions], position => position.product.id),
    basketCount: next.basketCount ?? previous.basketCount, basketIds: [...new Set([...previous.basketIds ?? [], ...next.basketIds ?? []])],
    strategyCount: next.strategyCount ?? previous.strategyCount, strategies: unique([...previous.strategies ?? [], ...next.strategies ?? []], strategy => strategy.address.toLowerCase()),
    cards: unique([...previous.cards, ...next.cards], card => card.address.toLowerCase()) };
}
const key = (chainId: number, token: string) => `${chainId}:${token.toLowerCase()}`;

export function useDiagnosis(rawAccount: string, overrides: RpcOverrides) {
  let account: Address | undefined;
  try { account = address(rawAccount); } catch { /* Wait for a complete valid address. */ }
  const context = useRef({ account, overrides });
  context.current = { account, overrides };
  const [results, setResults] = useState<Record<number, NetworkDiagnosis>>({});
  const resultsRef = useRef(results); resultsRef.current = results;
  const checkpoints = useRef(new Map<string, ReadCheckpoint>());
  const checkpointFor = useCallback((key: string, resume: boolean) => {
    if (!resume || !checkpoints.current.has(key)) checkpoints.current.set(key, new Map());
    return checkpoints.current.get(key)!;
  }, []);
  const controllers = useRef(new Map<number, AbortController>());
  // Session-only list of user-added tokens. Balances are always re-read for the
  // current account; pending reads for a previous account or RPC are cancelled.
  const [customList, setCustomList] = useState<{ chainId: number; address: Address }[]>([]);
  const customListRef = useRef(customList);
  customListRef.current = customList;
  const [custom, setCustom] = useState<Record<string, CustomTokenState>>({});
  const customControllers = useRef(new Map<string, AbortController>());
  const verifyCustom = useCallback((chainId: number, token: Address) => {
    const current = () => context.current.account === account && context.current.overrides === overrides;
    if (!account || !current()) return;
    const id = key(chainId, token);
    customControllers.current.get(id)?.abort();
    const controller = new AbortController(); customControllers.current.set(id, controller);
    setCustom(old => ({ ...old, [id]: { chainId, address: token, status: "loading" } }));
    void (async () => {
      try {
        const pool = new ReadPool(chainById(chainId), sources(chainId, overrides), controller.signal);
        const found = await inspectCustomToken(pool, chainId, account, token);
        if (!controller.signal.aborted && current() && same(found.account, account)) setCustom(old => ({ ...old, [id]: { chainId, address: token, status: "ready", token: found } }));
      } catch (e) {
        if (controller.signal.aborted || !current()) return;
        setCustom(old => ({ ...old, [id]: { chainId, address: token, status: "error", error: e instanceof CustomTokenFailure ? e.code : "rpc" } }));
      }
    })();
  }, [account, overrides]);
  const [cardDiscovery, setCardDiscovery] = useState<{ owner: Address; loading: boolean; issues: string[]; notes?: string[] }>();
  const discoveryRef = useRef(cardDiscovery); discoveryRef.current = cardDiscovery;
  const cardAddresses = useRef<Address[]>([]);
  const cardOwner = useRef(account);
  const cardControllers = useRef(new Map<string, AbortController>());
  const [cardResults, setCardResults] = useState<Record<string, { owner: Address; result: NetworkDiagnosis }>>({});
  const cardResultsRef = useRef(cardResults); cardResultsRef.current = cardResults;
  const launchCard = useCallback((card: Address, resume = false) => {
    if (!account) return;
    const id = card.toLowerCase();
    const previous = cardResultsRef.current[id]?.result;
    if (resume && previous?.status === "complete" && previous.cards.some(d => d.delayVersion === "v5" && d.controllers.some(c => same(c, account)))) return;
    const checkpoint = checkpointFor(`card:${id}`, resume);
    cardControllers.current.get(id)?.abort();
    const controller = new AbortController(); cardControllers.current.set(id, controller);
    if (!resume) setCardResults(old => ({ ...old, [id]: { owner: account, result: emptyDiagnosis(100, card) } }));
    void diagnoseNetwork({ chain: chainById(100), account: card, checkpoint, sources: sources(100, overrides), signal: controller.signal,
      update: result => { if (!controller.signal.aborted && context.current.account === account && context.current.overrides === overrides)
        setCardResults(old => ({ ...old, [id]: { owner: account, result: resume ? retainFindings(old[id]?.result, result) : result } })); } });
  }, [account, overrides, checkpointFor]);
  const addCard = useCallback(async (raw: string) => {
    const card = address(raw);
    if (!account) throw new Error("Inspect the controlling account first");
    if (same(card, account)) throw new Error("Enter the card Safe address, not the controlling account");
    if (cardAddresses.current.some(a => same(a, card))) throw new Error("This card is already in the list");
    const controller = new AbortController();
    const pool = new ReadPool(chainById(100), sources(100, overrides), controller.signal);
    const delays = await pool.run(client => inspectCard(client, card, 100));
    if (context.current.account !== account || context.current.overrides !== overrides) throw new Error("Account or RPC changed; try again");
    if (delays.filter(d => d.delayVersion === "v5" && d.controllers.some(c => same(c, account))).length !== 1) throw new Error("This account is not the verified controller of one v5 card Delay module");
    cardAddresses.current = [...cardAddresses.current, card];
    launchCard(card);
  }, [account, overrides, launchCard]);
  const launch = useCallback((id?: number, resume = false) => {
    if (!account) return;
    for (const chain of chains.filter(c => id === undefined || c.id === id)) {
      controllers.current.get(chain.id)?.abort();
      const controller = new AbortController(); controllers.current.set(chain.id, controller);
      const existing = resultsRef.current[chain.id];
      if (!resume || !existing || ["partial", "unavailable"].includes(existing.status)) {
        const checkpoint = checkpointFor(`network:${chain.id}`, resume);
        if (!resume) setResults(old => ({ ...old, [chain.id]: emptyDiagnosis(chain.id, account) }));
        void diagnoseNetwork({ chain, account, checkpoint, sources: sources(chain.id, overrides), signal: controller.signal,
        update: result => { if (!controller.signal.aborted && context.current.account === account && context.current.overrides === overrides)
          setResults(old => ({ ...old, [chain.id]: resume ? retainFindings(old[chain.id], result) : result })); } });
      }
      if (chain.id === 100 && (!resume || !discoveryRef.current || discoveryRef.current.issues.length > 0)) {
        setCardDiscovery({ owner: account, loading: true, issues: [] });
        const current = () => !controller.signal.aborted && context.current.account === account && context.current.overrides === overrides;
        void discoverCards(new ReadPool(chain, sources(100, overrides), controller.signal, undefined, undefined, checkpointFor("card-discovery", resume)), account).then(found => {
          if (!current()) return;
          for (const card of found.addresses) if (!cardAddresses.current.some(existing => same(existing, card))) {
            cardAddresses.current.push(card); launchCard(card);
          }
          setCardDiscovery({ owner: account, loading: false, issues: found.issues, notes: found.notes });
        }).catch(() => { if (current()) setCardDiscovery({ owner: account, loading: false, issues: ["Card discovery could not be completed; card balances remain unverified"] }); });
      }
    }
    if (id === undefined || id === 100) for (const card of cardAddresses.current) launchCard(card, resume);
    if (!resume) for (const item of customListRef.current.filter(c => id === undefined || c.chainId === id)) verifyCustom(item.chainId, item.address);
  }, [account, overrides, verifyCustom, launchCard, checkpointFor]);
  useEffect(() => {
    const active = controllers.current, customActive = customControllers.current;
    active.forEach(c => c.abort()); active.clear();
    customActive.forEach(c => c.abort()); customActive.clear();
    cardControllers.current.forEach(c => c.abort());
    if (cardOwner.current !== account) { cardAddresses.current = []; cardOwner.current = account; }
    checkpoints.current.clear();
    setCardDiscovery(undefined);
    setCardResults({});
    setCustom({});
    setResults(account ? Object.fromEntries(chains.map(c => [c.id, emptyDiagnosis(c.id, account)])) : {});
    const timer = setTimeout(() => launch(), 500);
    return () => { cardControllers.current.forEach(c => c.abort()); clearTimeout(timer); active.forEach(c => c.abort()); active.clear(); customActive.forEach(c => c.abort()); customActive.clear(); };
  }, [account, launch]);
  const current = Object.values(results).filter(r => account && r.account.toLowerCase() === account.toLowerCase()).map(result => {
    if (result.chainId !== 100) return result;
    const linkedCards = Object.values(cardResults).filter(c => same(c.owner, result.account)).map(c => c.result);
    const discovering = cardDiscovery && same(cardDiscovery.owner, result.account) ? cardDiscovery : undefined;
    const checking = discovering?.loading || linkedCards.some(c => c.status === "queued" || c.status === "scanning");
    const cardIssues = linkedCards.flatMap(c => c.status === "queued" || c.status === "scanning" ? []
      : !c.cards.some(d => d.delayVersion === "v5" && d.controllers.some(controller => same(controller, result.account))) ? [`Card ${c.account}: controller link could not be verified`]
      : c.status === "partial" || c.status === "unavailable" ? [`Card ${c.account}: balances could not be fully verified`] : []);
    return { ...result, linkedCards, status: checking ? "scanning" as const : (cardIssues.length || discovering?.issues.length) && result.status === "complete" ? "partial" as const : result.status,
      issues: [...result.issues, ...cardIssues, ...discovering?.issues ?? []], notes: [...result.notes ?? [], ...discovering?.notes ?? []] };
  });
  const retryPending = useCallback((id: number) => { launch(id, true); }, [launch]);
  const rescan = useCallback((id?: number) => { launch(id); }, [launch]);
  // "duplicate": already added; "catalogue": already checked by the automatic scan.
  const addCustomToken = useCallback(async (chainId: number, raw: string): Promise<CustomTokenError | "duplicate" | "catalogue" | "cancelled" | undefined> => {
    let token: Address;
    try { token = address(raw); } catch { return "invalid-address"; }
    if (customListRef.current.some(c => key(c.chainId, c.address) === key(chainId, token))) return "duplicate";
    const catalogue = (await import("../catalog/tokens.json")).default;
    // The catalogue may still be downloading when the wallet or RPC changes.
    // Do not start an old-context read after that context's cleanup already ran.
    if (!account || context.current.account !== account || context.current.overrides !== overrides) return "cancelled";
    if (catalogue.some(t => t.chainId === chainId && same(t.address, token)) || products.some(p => p.chainId === chainId && same(p.address, token))) return "catalogue";
    setCustomList(old => old.some(c => key(c.chainId, c.address) === key(chainId, token)) ? old : [...old, { chainId, address: token }]);
    verifyCustom(chainId, token);
  }, [account, overrides, verifyCustom]);
  const removeCustomToken = useCallback((chainId: number, token: Address) => {
    const id = key(chainId, token);
    customControllers.current.get(id)?.abort(); customControllers.current.delete(id);
    setCustomList(old => old.filter(c => key(c.chainId, c.address) !== id));
    setCustom(old => { const next = { ...old }; delete next[id]; return next; });
  }, []);
  const customTokens = customList.map(c => custom[key(c.chainId, c.address)] ?? { ...c, status: "loading" as const })
    .filter(c => !c.token || (account && same(c.token.account, account)));
  return { account, addCard, results: current, rescan, retryPending, customTokens, addCustomToken, removeCustomToken, retryCustomToken: verifyCustom };
}
