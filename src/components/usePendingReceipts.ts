import { useCallback, useEffect, useRef, useState } from "react";
import { chainById } from "../catalog/chains";
import { publicClient } from "../core/client";
import { displayError } from "../core/errors";
import { checkSubmittedReceipt, type TransactionRecord } from "../core/pendingReceipts";
import { rpcFor, type RpcOverrides } from "./useDiagnosis";

export type ReceiptCheck = { status: "checking" | "waiting" | "error"; message?: string };
export function usePendingReceipts({ pending, enabled, busy, scope, overrides, lang, settle }: {
  pending: TransactionRecord[]; enabled: boolean; busy: boolean; scope: string; overrides: RpcOverrides; lang: "pt" | "en";
  settle: (tx: TransactionRecord, status: "confirmed" | "reverted") => void;
}) {
  const [checks, setChecks] = useState<Record<string, ReceiptCheck>>({});
  const latest = useRef({ pending, enabled, busy, scope, overrides, lang, settle });
  latest.current = { pending, enabled, busy, scope, overrides, lang, settle };
  const active = useRef(new Map<string, symbol>());
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    active.current.clear();
    setChecks({});
    return () => { generation.current++; active.current.clear(); };
  }, [scope, overrides, enabled]);
  const check = useCallback(async (hash: string) => {
    const context = latest.current, tx = context.pending.find(tx => tx.hash === hash);
    if (!tx || context.busy || !context.enabled || active.current.has(hash)) return;
    const request = Symbol(), version = generation.current;
    active.current.set(hash, request);
    const fresh = () => version === generation.current && latest.current.scope === context.scope && latest.current.pending.some(t => t.hash === hash);
    setChecks(old => ({ ...old, [hash]: { status: "checking" } }));
    try {
      const result = await checkSubmittedReceipt(publicClient(chainById(tx.chainId), rpcFor(tx.chainId, context.overrides), 12_000), tx);
      if (!fresh()) return;
      if (result === "waiting") setChecks(old => ({ ...old, [hash]: { status: "waiting" } }));
      else latest.current.settle(tx, result);
    } catch (error) {
      if (fresh()) setChecks(old => ({ ...old, [hash]: { status: "error", message: displayError(error, latest.current.lang) } }));
    } finally { if (active.current.get(hash) === request) active.current.delete(hash); }
  }, []);
  const pendingKey = pending.map(tx => `${tx.chainId}:${tx.hash}`).join("|");
  useEffect(() => {
    if (!enabled || busy || !pendingKey) return;
    // Sequential reads and one timer; never overlap checks or signing.
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      for (const tx of latest.current.pending) { if (disposed) return; await check(tx.hash); }
      if (!disposed) timer = setTimeout(() => void tick(), 15_000);
    };
    void tick();
    return () => { disposed = true; clearTimeout(timer); };
  }, [pendingKey, enabled, busy, scope, overrides, check]);
  return { checks, check };
}
