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
export function chainById(id: number): Chain {
  const chain = chains.find(c => c.id === id);
  if (!chain) throw new Error("Unsupported chain ID");
  return chain;
}
