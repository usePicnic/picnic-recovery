import { defineChain, type Chain } from "viem";
import {
  mainnet, gnosis, polygon, optimism, bsc, base, arbitrum, avalanche, hyperEvm,
} from "viem/chains";

export const chains: readonly Chain[] = [
  gnosis, polygon, mainnet, base, arbitrum, optimism, bsc, avalanche, hyperEvm,
  defineChain({
    id: 4663, name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
    blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  }),
];
// Public read endpoints, first = default. thirdweb (viem's BSC default) answers
// HTTP 429 with Retry-After of minutes, so BSC starts with the endpoint listed
// in BNB Chain's JSON-RPC docs. Fallbacks are only used for reads, only when
// no custom RPC is set, and only after proving the expected chain ID.
const fallbackReads: Record<number, readonly string[]> = {
  1: ["https://ethereum-rpc.publicnode.com"],
  56: ["https://bsc-dataseed.bnbchain.org", "https://bsc-rpc.publicnode.com", "https://56.rpc.thirdweb.com"],
};
export function defaultReadRpcs(chain: Chain): readonly string[] {
  const configured = fallbackReads[chain.id] ?? [];
  return [...new Set(chain.id === 56 ? configured : [chain.rpcUrls.default.http[0], ...configured])];
}
export function chainById(id: number): Chain {
  const chain = chains.find(c => c.id === id);
  if (!chain) throw new Error("Unsupported chain ID");
  return chain;
}
