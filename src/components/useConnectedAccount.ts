import { useEffect, useState } from "react";
import type { Address } from "viem";
import { chainById } from "../catalog/chains";
import { ReadPool } from "../core/reads";
import { discoverPicnicAccount } from "../core/discovery";
import { readRpcs, type RpcOverrides } from "./useDiagnosis";

type Result = { key: string; status: "loading" | "ready" | "error"; account?: Address };
export function useConnectedAccount(wallet: Address | undefined, enabled: boolean, overrides: RpcOverrides) {
  const rpc = overrides[100] ?? "";
  const key = enabled && wallet ? `${wallet.toLowerCase()}:${rpc}` : "";
  const [result, setResult] = useState<Result>();
  useEffect(() => {
    if (!key || !wallet) return;
    const abort = new AbortController();
    const pool = new ReadPool(chainById(100), readRpcs(100, rpc ? { 100: rpc } : {}).map(url => ({ url })), abort.signal);
    setResult({ key, status: "loading" });
    void discoverPicnicAccount(pool, wallet).then(account => {
      if (!abort.signal.aborted) setResult({ key, status: "ready", account: account ?? wallet });
    }).catch(() => { if (!abort.signal.aborted) setResult({ key, status: "error", account: wallet }); });
    return () => abort.abort();
  }, [key, wallet, rpc]);
  return !key ? undefined : result?.key === key ? result : { key, status: "loading" as const };
}
