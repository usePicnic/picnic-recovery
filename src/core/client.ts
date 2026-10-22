import { createPublicClient, http, getAddress, type Address, type Chain, type PublicClient } from "viem";

export const SENTINEL = "0x0000000000000000000000000000000000000001" as const;
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function address(value: string): Address {
  const normalized = getAddress(value.trim());
  if (/^0x0{39}[01]$/i.test(normalized)) throw new Error("Invalid wallet address");
  return normalized;
}
export function validateRpc(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    throw new Error("Use HTTPS, or HTTP for a local node");
  }
  if (parsed.username || parsed.password) throw new Error("RPC URL must not contain credentials");
  return parsed.href;
}
export function publicClient(chain: Chain, rpc: string, timeout = 20_000): PublicClient {
  return createPublicClient({ chain, transport: http(validateRpc(rpc), { retryCount: 0, timeout }) });
}
export async function assertChain(client: PublicClient, chainId: number) {
  if (await client.getChainId() !== chainId) throw new Error("RPC chain does not match selected network");
}

export function parseAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255 || !/^\d+(\.\d+)?$/.test(value)) throw new Error("Enter a positive decimal amount using a dot");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new Error(`Token supports at most ${decimals} decimal places`);
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount <= 0n || amount >= 2n ** 256n) throw new Error("Amount is outside the token range");
  return amount;
}
