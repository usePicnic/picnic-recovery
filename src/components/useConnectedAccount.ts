import { useEffect, useState } from "react";
import type { Address } from "viem";
import { chainById } from "../catalog/chains";
import { ReadPool } from "../core/reads";
import { discoverPicnicAccount, discoverRecoveryAccounts, verifyRecoveryHandoff, type RecoveryHandoff } from "../core/discovery";
import { same } from "../core/client";
import { readRpcs, type RpcOverrides } from "./useDiagnosis";

type Result = { key: string; status: "loading" | "ready" | "error" | "selection-required"; account?: Address; accounts: Address[]; issues: string[] };
export function useConnectedAccount(wallet: Address | undefined, enabled: boolean, overrides: RpcOverrides, handoff?: RecoveryHandoff) {
  const rpc = overrides[100] ?? "";
  const applicableHandoff = wallet && handoff && same(wallet, handoff.newOwner) ? handoff : undefined;
  const handoffKey = applicableHandoff ? `${applicableHandoff.chainId}:${applicableHandoff.account.toLowerCase()}:${overrides[applicableHandoff.chainId] ?? ""}` : "";
  const key = enabled && wallet ? `${wallet.toLowerCase()}:${rpc}:${handoffKey}` : "";
  const [result, setResult] = useState<Result>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!key || !wallet) return;
    const abort = new AbortController();
    const pool = new ReadPool(chainById(100), readRpcs(100, rpc ? { 100: rpc } : {}).map(url => ({ url })), abort.signal);
    setResult({ key, status: "loading", accounts: [], issues: [] });
    const resumed = applicableHandoff ? verifyRecoveryHandoff(new ReadPool(chainById(applicableHandoff.chainId),
      readRpcs(applicableHandoff.chainId, overrides).map(url => ({ url })), abort.signal), wallet, applicableHandoff) : Promise.resolve(undefined);
    void Promise.allSettled([discoverPicnicAccount(pool, wallet), discoverRecoveryAccounts(pool, wallet), resumed]).then(([predicted, recovered, verifiedHandoff]) => {
      if (abort.signal.aborted) return;
      const original = predicted.status === "fulfilled" ? predicted.value : undefined;
      const handoffAccount = verifiedHandoff.status === "fulfilled" ? verifiedHandoff.value : undefined;
      const accounts = [...new Map([...(original ? [original] : []), ...(recovered.status === "fulfilled" ? recovered.value : []), ...(handoffAccount ? [handoffAccount] : [])]
        .map(account => [account.toLowerCase(), account])).values()];
      const issues = [
        ...(predicted.status === "rejected" ? ["predicted-account-unverified"] : []),
        ...(recovered.status === "rejected" ? ["recovery-history-unverified"] : []),
        ...(verifiedHandoff.status === "rejected" ? ["recovery-handoff-unverified"] : []),
      ];
      const account = handoffAccount ?? original ?? (accounts.length === 1 ? accounts[0] : accounts.length === 0 ? wallet : undefined);
      setResult({ key, account, accounts: accounts.length ? accounts : issues.length ? [] : [wallet], issues,
        status: accounts.length > 1 && !original && !handoffAccount ? "selection-required" : accounts.length || !issues.length ? "ready" : "error" });
    });
    return () => abort.abort();
  }, [key, wallet, rpc, retry]);
  if (!key) return undefined;
  const current: Result = result?.key === key ? result : { key, status: "loading", accounts: [], issues: [] };
  return { ...current, retry: () => setRetry(value => value + 1), selectAccount: (account: Address) => setResult(old => old?.key === key && old.accounts.some(value => same(value, account))
    ? { ...old, account: old.accounts.find(value => same(value, account)), status: "ready" } : old) };
}
