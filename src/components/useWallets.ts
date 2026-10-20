import { useEffect, useState } from "react";
import type { EIP1193Provider } from "viem";
export type WalletChoice = { id: string; name: string; provider: EIP1193Provider };
// EIP-6963 avoids the race between extensions replacing window.ethereum.
export function useWallets() {
  const [wallets, setWallets] = useState<WalletChoice[]>([]);
  useEffect(() => {
    const announce = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof detail?.info?.uuid !== "string" || typeof detail.info.name !== "string" || typeof detail.provider?.request !== "function") return;
      setWallets(old => old.some(w => w.id === detail.info.uuid) ? old : [...old, {
        id: detail.info.uuid.slice(0, 100), name: detail.info.name.slice(0, 80), provider: detail.provider,
      }].slice(0, 30));
    };
    window.addEventListener("eip6963:announceProvider", announce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", announce);
  }, []);
  return wallets;
}
