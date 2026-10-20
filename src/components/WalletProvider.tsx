import { useState, type ReactNode } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitButton } from "connectkit";
import { chains } from "../catalog/chains";
import type { Chain } from "viem";

// Browser-wallet discovery works without a WalletConnect project or relay.
// Transaction reads continue to use the RPC explicitly chosen in the app.
const config = createConfig({
  chains: chains as readonly [Chain, ...Chain[]],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  storage: null,
  transports: Object.fromEntries(chains.map(chain => [chain.id, http(chain.rpcUrls.default.http[0])])),
});
export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <WagmiProvider config={config} reconnectOnMount={false}>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </WagmiProvider>;
}
export function WalletButton({ busy, lang }: { busy: boolean; lang: "pt" | "en" }) {
  return <ConnectKitButton.Custom>{({ isConnected, truncatedAddress, show }) =>
    <button className="outline" disabled={busy} onClick={show}>
      {isConnected ? truncatedAddress : lang === "pt" ? "Conectar carteira" : "Connect wallet"}
    </button>
  }</ConnectKitButton.Custom>;
}
