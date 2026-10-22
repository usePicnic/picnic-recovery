import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { erc20Abi } from "./abi";
import { same } from "./client";
import { safeAction } from "./actions";
import { stakingAbi } from "./investments";
import type { AccountSnapshot, PreparedAction } from "./types";

export const MAMO_REGISTRY = "0x46a5624C2ba92c08aBA4B206297052EDf14baa92" as const;
export const strategyAbi = parseAbi([
  "function getUserStrategies(address user) view returns (address[])",
  "function owner() view returns (address)",
  "function mamoToken() view returns (address)",
  "function multiRewards() view returns (address)",
  "function withdraw(uint256 amount)",
  "function withdrawRewards()",
]);
export type MamoPosition = { address: Address; owner: Address; token: Address; staking: Address; balance: bigint; decimals: number };
export async function inspectMamo(client: PublicClient, owner: Address, strategy: Address): Promise<MamoPosition> {
  if (await client.getChainId() !== 8453) throw new Error("MAMO strategies are on Base");
  const [actualOwner, token, staking] = await Promise.all([
    client.readContract({ address: strategy, abi: strategyAbi, functionName: "owner" }),
    client.readContract({ address: strategy, abi: strategyAbi, functionName: "mamoToken" }),
    client.readContract({ address: strategy, abi: strategyAbi, functionName: "multiRewards" }),
  ]);
  if (!same(actualOwner, owner)) throw new Error("Selected Safe does not own this MAMO strategy");
  const underlying = await client.readContract({ address: staking, abi: stakingAbi, functionName: "stakingToken" });
  if (!same(underlying, token)) throw new Error("Strategy and staking token disagree");
  const [balance, decimals] = await Promise.all([
    client.readContract({ address: staking, abi: erc20Abi, functionName: "balanceOf", args: [strategy] }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address: strategy, owner, token, staking, balance, decimals };
}
export async function discoverMamo(client: PublicClient, owner: Address, inspect = (strategy: Address) => inspectMamo(client, owner, strategy)) {
  const strategies = await client.readContract({ address: MAMO_REGISTRY, abi: strategyAbi, functionName: "getUserStrategies", args: [owner] });
  // Keep failures visible: a registry can also contain a different strategy type.
  return Promise.allSettled(strategies.map(inspect));
}
export async function withdrawMamo(client: PublicClient, snapshot: AccountSnapshot, strategy: Address, rewards = false): Promise<PreparedAction> {
  const position = await inspectMamo(client, snapshot.address, strategy);
  if (!rewards && !position.balance) throw new Error("No MAMO stake to withdraw");
  return { ...safeAction(snapshot, { to: strategy, value: 0n, data: rewards
    ? encodeFunctionData({ abi: strategyAbi, functionName: "withdrawRewards" })
    : encodeFunctionData({ abi: strategyAbi, functionName: "withdraw", args: [position.balance] }),
  }, rewards ? "Claim MAMO strategy rewards to this Safe" : "Withdraw MAMO strategy principal to this Safe"),
  ...(!rewards ? { receive: { token: position.token, recipient: snapshot.address, minimum: position.balance } } : {}),
  revalidate: async () => {
    const fresh = await inspectMamo(client, snapshot.address, strategy);
    if (!same(fresh.token, position.token) || !same(fresh.staking, position.staking)) throw new Error("MAMO strategy changed");
  } };
}
