import { encodeFunctionData, parseAbi, type Abi, type Address, type PublicClient, zeroAddress } from "viem";
import { erc20Abi } from "./abi";
import { address, same } from "./client";
import { safeAction } from "./actions";
import { BASKET, basketAbi, inspectBasket } from "./legacy";
import type { AccountSnapshot, PreparedAction } from "./types";

export type LegacyAsset = {
  _id: string; address: string; type: string; name: string; symbol?: string; decimals?: number;
  contractName?: string; callParams?: Record<string, unknown>;
  linkedAssets?: { assetId: string; fraction: number }[]; resolvedOutputs?: string[];
};
export type LegacyContract = { name: string; address: string; interfaceName?: string; abi: Abi };
export type LegacyCatalogue = { chainId: number; assets: LegacyAsset[]; contracts: LegacyContract[] };
export async function legacyCatalogue(): Promise<LegacyCatalogue> {
  return (await import("../catalog/legacy.json")).default as unknown as LegacyCatalogue;
}
export const AUTOFARM = "0x89d065572136814230A55DdEeDDEC9DF34EB0B76" as const;
const farmAbi = parseAbi([
  "function stakedWantTokens(uint256 poolId,address user) view returns (uint256)",
  "function userInfo(uint256 poolId,address user) view returns (uint256 amount,uint256 rewardDebt)",
]);
export function underlyingAssets(catalogue: LegacyCatalogue, asset: LegacyAsset) {
  if (asset.resolvedOutputs) return asset.resolvedOutputs.map(token => catalogue.assets.find(a => same(a.address, token)) ?? { _id: token, address: token, name: token, type: "token" });
  return (asset.linkedAssets ?? []).map(link => {
    const found = catalogue.assets.find(a => a._id === link.assetId);
    if (!found) throw new Error(`Missing underlying metadata: ${link.assetId}`);
    return found;
  });
}
export async function legacyBalance(client: PublicClient, owner: Address, asset: LegacyAsset): Promise<bigint> {
  const params = asset.callParams ?? {};
  if (asset.type === "IAutofarmDeposit") return client.readContract({ address: AUTOFARM, abi: farmAbi,
    functionName: "stakedWantTokens", args: [BigInt(String(params.poolId)), owner] });
  if (asset.type === "IMasterChefDeposit") return (await client.readContract({ address: address(asset.address), abi: farmAbi,
    functionName: "userInfo", args: [BigInt(String(params.poolId)), owner] }))[0];
  if (asset.type === "networkToken") return client.getBalance({ address: owner });
  const target = address(asset.address);
  return client.readContract({ address: target, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}
// These routes only unwrap or unstake; swap routes are deliberately absent.
export function legacyExitCall(catalogue: LegacyCatalogue, asset: LegacyAsset, minimums: bigint[] = []) {
  const underlying = underlyingAssets(catalogue, asset);
  const tokens = underlying.map(a => address(a.address));
  const params = asset.callParams ?? {};
  const p = (key: string) => address(String(params[key]));
  const poolId = () => BigInt(String(params.poolId));
  const share = address(asset.address), all = 100_000n;
  let method: string, args: unknown[];
  const min = (length: number) => {
    if (minimums.length !== length || minimums.some(x => x < 0n) || !minimums.some(x => x > 0n)) throw new Error(`Enter ${length} minimum output amounts in raw units, with at least one positive minimum`);
    return minimums;
  };
  switch (asset.type) {
    case "IAaveV2Deposit": method = "withdraw"; args = [tokens[0], all]; break;
    case "IAutofarmDeposit": method = "withdraw"; args = [poolId(), all]; break;
    case "IHarvestDeposit": method = "withdraw"; args = [share, all]; break;
    case "IBeefyDeposit": case "IClearpoolDeposit": method = "withdraw"; args = [share, all]; break;
    case "IBalancerLiquidity": method = "removeLiquidity"; args = [share, all, min(tokens.length)]; break;
    case "IUniswapV2Liquidity": method = "removeLiquidity"; args = [tokens, all, min(2)]; break;
    case "IKyberLiquidity": method = "removeLiquidity"; args = [tokens, share, all, min(2)]; break;
    case "ICurveLiquidity": method = "removeLiquidity"; args = [p("poolAddress"), share, all, min(tokens.length)]; break;
    case "IGammaDeposit": method = "withdraw"; args = [share, tokens, all, min(4)]; break;
    case "IGauge": method = "withdraw"; args = [tokens[0], share, all]; break;
    case "IMasterChefDeposit": method = "unstake"; args = [share, tokens[0], all, poolId()]; break;
    case "ICompoundV3Bridge": method = "withdraw"; args = [tokens[0], all, share]; break;
    case "IStargateBridge": method = "removeLiquidity"; args = [all, share, tokens[0], poolId()]; break;
    case "IJarvisRewards": method = "claim"; args = [share, p("rewardsPool")]; break;
    case "ITetuDeposit": throw new Error("Transfer Tetu shares to the owner first; no deployed basket bridge is recorded. Then withdraw directly from the Tetu vault.");
    case "IJarvisV6Mint": case "IBalancerBatchSwap": case "IlliquidStable": throw new Error("This catalogue route converts the asset. Transfer the existing position without conversion instead.");
    default: throw new Error(`No verified basket exit adapter for ${asset.type}; transfer a transferable receipt, or inspect the public protocol source.`);
  }
  if (!tokens.length) throw new Error("No underlying tokens in catalogue");
  const candidates = catalogue.contracts.filter(c => c.name === asset.contractName);
  // The versioned catalogue keeps historical records in deployment order.
  const contract = candidates.at(-1);
  if (!contract) throw new Error("No deployed exit bridge in catalogue");
  return { bridge: address(contract.address), data: encodeFunctionData({ abi: contract.abi, functionName: method, args }),
    tokens, method, args, contract, underlying };
}
export async function exitLegacyBasket(client: PublicClient, snapshot: AccountSnapshot, nftId: bigint, asset: LegacyAsset, minimums: bigint[]) {
  const catalogue = await legacyCatalogue();
  const basket = await inspectBasket(client, nftId, snapshot.address);
  if (await legacyBalance(client, basket.wallet, asset) <= 0n) throw new Error("No position balance at this basket");
  const resolved = await resolveLegacyAsset(client, asset);
  if (JSON.stringify(resolved.resolvedOutputs) !== JSON.stringify(asset.resolvedOutputs)) throw new Error("Inspect this position first to review its current output token list");
  const route = legacyExitCall(catalogue, resolved, minimums);
  const code = await client.getCode({ address: route.bridge });
  if (!code || code === "0x") throw new Error("Exit bridge has no deployed code");
  const keepNested = route.underlying.some(a => !["token", "networkToken"].includes(a.type));
  // Retain nested receipts inside the basket so the next layer can use its bridge.
  // withdrawPortfolio forbids empty outputs; editPortfolio only executes bridge calls.
  return { ...safeAction(snapshot, { to: BASKET, value: 0n, data: encodeFunctionData({ abi: basketAbi,
    ...(keepNested ? { functionName: "editPortfolio", args: [nftId, [route.bridge], [route.data]] } : { functionName: "withdrawPortfolio", args: [nftId, { tokens: route.tokens, amounts: route.tokens.map(() => 100_000n) }, 0n, [route.bridge], [route.data]] }),
  }) }, `Exit ${asset.name}: ${route.method}; ${keepNested ? "nested receipts remain in basket — exit the next layer" : "output tokens arrive at the NFT owner"}`),
  details: [`Exit bridge: ${route.bridge}`, `${route.method}(${JSON.stringify(route.args, (_, v) => typeof v === "bigint" ? v.toString() : v)})`, `100% of position; output tokens: ${route.tokens.join(", ")}`, `Destination: ${keepNested ? basket.wallet : snapshot.address}`],
  revalidate: async () => {
    const fresh = await inspectBasket(client, nftId, snapshot.address);
    if (!same(fresh.wallet, basket.wallet) || await client.getCode({ address: route.bridge }) !== code) throw new Error("Basket or bridge changed; review again");
  } } satisfies PreparedAction;
}
export async function withdrawTetu(client: PublicClient, snapshot: AccountSnapshot, asset: LegacyAsset, amount: bigint) {
  if (snapshot.chainId !== 137 || asset.type !== "ITetuDeposit" || amount <= 0n) throw new Error("Invalid Tetu withdrawal");
  const vault = address(asset.address);
  const abi = parseAbi(["function underlying() view returns (address)", "function withdraw(uint256 shares)"]);
  const underlying = await client.readContract({ address: vault, abi, functionName: "underlying" });
  const expected = underlyingAssets(await legacyCatalogue(), asset)[0];
  if (!expected || !same(underlying, expected.address)) throw new Error("Tetu underlying does not match catalogue");
  return { ...safeAction(snapshot, { to: vault, value: 0n, data: encodeFunctionData({ abi, functionName: "withdraw", args: [amount] }) }, "Withdraw Tetu shares held by this Safe"),
    receive: { token: underlying, recipient: snapshot.address, minimum: 1n } } satisfies PreparedAction;
}

export async function resolveLegacyAsset(client: PublicClient, asset: LegacyAsset): Promise<LegacyAsset> {
  const abi = parseAbi([
    "function getPoolId() view returns(bytes32)", "function getPoolTokens(bytes32 poolId) view returns(address[] tokens,uint256[] balances,uint256 lastChangeBlock)",
    "function coins(uint256 index) view returns(address)", "function lpToken() view returns(address)", "function underlying() view returns(address)",
    "function tokensHeldLength() view returns(uint256)", "function tokensHeld(uint256 index) view returns(address)",
  ]);
  let outputs: readonly Address[] | undefined;
  if (asset.type === "IBalancerLiquidity") {
    const poolId = await client.readContract({ address: address(asset.address), abi, functionName: "getPoolId" });
    outputs = (await client.readContract({ address: address(String(asset.callParams?.vaultAddress)), abi, functionName: "getPoolTokens", args: [poolId] }))[0];
  } else if (asset.type === "IHarvestDeposit") {
    let vault = address(asset.address);
    try { vault = await client.readContract({ address: vault, abi, functionName: "lpToken" }); } catch { /* The bridge also supports direct vault shares. */ }
    outputs = [await client.readContract({ address: vault, abi, functionName: "underlying" })];
  } else if (asset.type === "IJarvisRewards") {
    const pool = address(String(asset.callParams?.rewardsPool));
    const count = await client.readContract({ address: pool, abi, functionName: "tokensHeldLength" });
    if (count > 100n) throw new Error("Reward token list exceeds review limit");
    outputs = await Promise.all(Array.from({ length: Number(count) }, (_, i) => client.readContract({ address: pool, abi, functionName: "tokensHeld", args: [BigInt(i)] })));
  }
  if (outputs?.some(a => same(a, zeroAddress))) throw new Error("Contract reports an invalid output token; transfer the receipt instead");
  return outputs ? { ...asset, resolvedOutputs: [...outputs] } : asset;
}
