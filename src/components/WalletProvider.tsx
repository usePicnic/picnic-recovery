import { useState, type ReactNode } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectKitButton } from "connectkit";
import { chains, defaultReadRpcs } from "../catalog/chains";
import type { Chain } from "viem";

// Browser-wallet discovery works without a WalletConnect project or relay.
// Transaction reads continue to use the RPC explicitly chosen in the app.
const config = createConfig({
  chains: chains as readonly [Chain, ...Chain[]],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  storage: null,
  transports: Object.fromEntries(chains.map(chain => [chain.id, http(defaultReadRpcs(chain)[0])])),
});
export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return <WagmiProvider config={config} reconnectOnMount={false}>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </WagmiProvider>;
}
// Rendered only in step 0; later steps link back there to change the connection.
export function WalletButton({ busy, lang, primary }: { busy: boolean; lang: "pt" | "en"; primary?: boolean }) {
  return <ConnectKitButton.Custom>{({ isConnected, show }) =>
    <button className={primary ? "connect-button" : "outline"} disabled={busy} onClick={show}>
      {isConnected ? lang === "pt" ? "Trocar ou desconectar" : "Switch or disconnect" : lang === "pt" ? "Conectar carteira" : "Connect wallet"}
    </button>
  }</ConnectKitButton.Custom>;
}
