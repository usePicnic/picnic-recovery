import { useCallback, useEffect, useRef, useState } from "react";
import { type Address } from "viem";
import { chains } from "../catalog/chains";
import { address, assertChain, publicClient } from "../core/client";
import { diagnoseNetwork, emptyDiagnosis, type NetworkDiagnosis, type WalletGas } from "../core/diagnosis";
export type RpcOverrides = Record<number, string>;
export const rpcFor = (chainId: number, overrides: RpcOverrides) => overrides[chainId] ?? chains.find(c => c.id === chainId)?.rpcUrls.default.http[0] ?? "";
export function useDiagnosis(rawAccount: string, wallet: Address | undefined, overrides: RpcOverrides) {
  let account: Address | undefined;
  try { account = address(rawAccount); } catch { /* Wait for a complete valid address. */ }
  const [results, setResults] = useState<Record<number, NetworkDiagnosis>>({});
  const [gas, setGas] = useState<Record<number, WalletGas>>({});
  const [gasRevision, setGasRevision] = useState(0);
  const controllers = useRef(new Map<number, AbortController>());
  const launch = useCallback((id?: number) => {
    if (!account) return;
    for (const chain of chains.filter(c => id === undefined || c.id === id)) {
      controllers.current.get(chain.id)?.abort();
      const controller = new AbortController(); controllers.current.set(chain.id, controller);
      setResults(old => ({ ...old, [chain.id]: emptyDiagnosis(chain.id, account) }));
      void diagnoseNetwork({ chain, account, rpc: rpcFor(chain.id, overrides), signal: controller.signal,
        update: result => setResults(old => ({ ...old, [chain.id]: result })) });
    }
  }, [account, overrides]);
  useEffect(() => {
    const active = controllers.current;
    active.forEach(c => c.abort()); active.clear();
    setResults(account ? Object.fromEntries(chains.map(c => [c.id, emptyDiagnosis(c.id, account)])) : {});
    const timer = setTimeout(() => launch(), 500);
    return () => { clearTimeout(timer); active.forEach(c => c.abort()); active.clear(); };
  }, [account, launch]);
  useEffect(() => {
    let cancelled = false;
    setGas({});
    if (wallet && account) for (const chain of chains) {
      void (async () => {
        try {
          const client = publicClient(chain, rpcFor(chain.id, overrides));
          await assertChain(client, chain.id);
          const balance = await client.getBalance({ address: wallet });
          if (!cancelled) setGas(old => ({ ...old, [chain.id]: { address: wallet, balance } }));
        } catch {
          if (!cancelled) setGas(old => ({ ...old, [chain.id]: { address: wallet, error: "RPC unavailable" } }));
        }
      })();
    }
    return () => { cancelled = true; };
  }, [wallet, account, overrides, gasRevision]);
  const current = Object.values(results).filter(r => account && r.account.toLowerCase() === account.toLowerCase());
  const currentGas = Object.fromEntries(Object.entries(gas).filter(([, value]) => wallet && value.address.toLowerCase() === wallet.toLowerCase()));
  const rescan = useCallback((id?: number) => { launch(id); setGasRevision(value => value + 1); }, [launch]);
  return { account, results: current, gas: currentGas, rescan };
}
