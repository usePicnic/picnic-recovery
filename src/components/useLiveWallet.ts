import { useEffect, useRef, useState } from "react";
import type { Connector } from "wagmi";
import type { Address, EIP1193Provider } from "viem";
import { same } from "../core/client";
import { watchWalletAccount, type WalletAccountState } from "../core/walletAccount";

export function useLiveWallet(connection: { address?: Address; connector?: Connector; isConnected: boolean; chainId?: number }) {
  const key = connection.isConnected ? connection.connector?.uid ?? "" : "";
  const current = useRef(connection); current.current = connection;
  const [state, setState] = useState<{ key: string; value: WalletAccountState }>();
  const refreshRef = useRef<() => Promise<void>>();
  useEffect(() => {
    const connector = connection.connector;
    if (!key || !connector) { setState(undefined); return; }
    let disposed = false, stop: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { void refreshRef.current?.(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    void connector.getProvider().then(raw => {
      if (disposed) return;
      const provider = raw as EIP1193Provider | undefined;
      if (!provider?.request) throw new Error("Wallet provider unavailable");
      const watcher = watchWalletAccount(provider, value => {
        if (disposed) return;
        setState({ key, value });
        // Reconcile ConnectKit/wagmi too when an extension misses its connector event.
        if (value.status === "ready" && !same(value.accounts[0], current.current.address ?? "")) connector.emitter.emit("change", { accounts: value.accounts });
        if (value.status === "disconnected") connector.emitter.emit("disconnect");
      });
      stop = watcher.stop; refreshRef.current = watcher.refresh;
      const tick = async () => { await watcher.refresh(); if (!disposed) timer = setTimeout(() => void tick(), 5000); };
      void tick();
      window.addEventListener("focus", refresh);
      document.addEventListener("visibilitychange", visible);
    }).catch(() => { if (!disposed) setState({ key, value: { status: "error", accounts: [] } }); });
    return () => {
      disposed = true; stop?.(); clearTimeout(timer); refreshRef.current = undefined;
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible);
    };
  }, [key]);
  useEffect(() => { void refreshRef.current?.(); }, [connection.address, connection.chainId]);
  const stored = key && state?.key === key ? state.value : undefined;
  const value = stored?.status === "ready" && !same(stored.accounts[0], connection.address ?? "") ? undefined : stored;
  return { address: value?.status === "ready" ? value.accounts[0] : undefined,
    status: !key ? "disconnected" : value?.status ?? "checking" };
}
