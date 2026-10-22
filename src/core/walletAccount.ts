import { getAddress, isAddress, type Address, type EIP1193Provider } from "viem";

export type WalletAccountState = { status: "ready"; accounts: Address[] } | { status: "disconnected" | "error"; accounts: [] };
export function walletAccounts(value: unknown): Address[] {
  if (!Array.isArray(value) || value.some(a => typeof a !== "string" || !isAddress(a, { strict: false }))) throw new Error("Invalid wallet account response");
  return value.map(a => getAddress(a));
}
// Read the selected connector's provider, never window.ethereum or a saved signer.
// Events invalidate in-flight reads, so a late response cannot restore an old account.
export function watchWalletAccount(provider: EIP1193Provider, update: (state: WalletAccountState) => void) {
  let stopped = false, revision = 0, reading: Promise<void> | undefined;
  const publish = (accounts: Address[]) => update(accounts.length ? { status: "ready", accounts } : { status: "disconnected", accounts: [] });
  const changed = (value: unknown) => {
    revision++;
    if (stopped) return;
    try { publish(walletAccounts(value)); } catch { update({ status: "error", accounts: [] }); }
  };
  const disconnected = () => changed([]);
  provider.on?.("accountsChanged", changed);
  provider.on?.("disconnect", disconnected);
  return {
    refresh(): Promise<void> {
      if (stopped) return Promise.resolve();
      if (reading) return reading;
      const request = revision;
      reading = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const accounts = walletAccounts(await Promise.race([
            Promise.resolve().then(() => provider.request({ method: "eth_accounts" })),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Wallet account check timed out")), 8000); }),
          ]));
          if (!stopped && request === revision) publish(accounts);
        } catch { if (!stopped && request === revision) update({ status: "error", accounts: [] }); }
        finally { clearTimeout(timer); reading = undefined; }
      })();
      return reading;
    },
    stop() {
      stopped = true; revision++;
      provider.removeListener?.("accountsChanged", changed);
      provider.removeListener?.("disconnect", disconnected);
    },
  };
}
