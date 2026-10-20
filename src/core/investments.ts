import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { erc20Abi, vaultAbi, aaveAbi } from "./abi";
import { address, same } from "./client";
import { safeAction, transferCall } from "./actions";
import type { AccountSnapshot, PreparedAction } from "./types";
import type { Product } from "../catalog/products";

export const brlaAbi = parseAbi([
  "function brla() view returns (address)",
  "function paused() view returns (bool)",
  "function _currentPrice() view returns (int128)",
  "function unstake(address from,address to,uint256 amount)",
]);
export const coveredAbi = parseAbi([
  "function asset() view returns (address)",
  "function pendingDepositRequest(uint256 requestId,address controller) view returns (uint256)",
  "function claimableDepositRequest(uint256 requestId,address controller) view returns (uint256)",
  "function cancelDepositRequest(uint256 requestId,address controller,address receiver) returns (uint256)",
  "function deposit(uint256 assets,address receiver,address controller) returns (uint256)",
  "function pendingRedeemShares(address controller) view returns (uint256)",
  "function claimableRedeemShares(address controller) view returns (uint256)",
  "function lastRedeemRequestId(address controller) view returns (uint256)",
  "function pendingRedeemRequest(uint256 requestId,address controller) view returns (uint256)",
  "function requestRedeem(uint256 shares,address controller,address owner) returns (uint256)",
  "function settleMaturedRedemption(uint256 requestId)",
  "function redeem(uint256 shares,address receiver,address controller) returns (uint256)",
  "event RedeemRequest(address indexed controller,address indexed owner,uint256 indexed requestId,address sender,uint256 shares)",
]);
export const staderAbi = parseAbi([
  "function getUserMaticXSwapRequests(address user) view returns ((uint256 amount,uint256 requestTime,uint256 withdrawalTime)[])",
  "function getMaticXSwapLockPeriod() view returns (uint256)",
  "function instantPoolMatic() view returns (uint256)",
  "function convertMaticXToMatic(uint256 amount) view returns (uint256,uint256,uint256)",
  "function paused() view returns (bool)",
  "function requestMaticXSwap(uint256 amount)",
  "function claimMaticXSwap(uint256 index)",
]);
export const stakingAbi = parseAbi([
  "function stakingToken() view returns (address)",
  "function balanceOf(address user) view returns (uint256)",
  "function withdraw(uint256 amount)",
  "function getReward()",
  "function exit()",
]);
export type Position = {
  product: Product; balance: bigint; decimals: number; asset?: Address;
  pending?: bigint; claimable?: bigint; requestId?: bigint; pendingDeposit?: bigint; claimableDeposit?: bigint; available?: bigint;
  requests?: readonly { amount: bigint; requestTime: bigint; withdrawalTime: bigint }[];
};
export async function inspectPosition(client: PublicClient, safe: Address, product: Product): Promise<Position> {
  if (await client.getChainId() !== product.chainId) throw new Error("Product network mismatch");
  const balance = await client.readContract({ address: product.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
  let decimals: number;
  let asset = product.asset;
  if (product.kind === "staking") {
    asset = await client.readContract({ address: product.address, abi: stakingAbi, functionName: "stakingToken" });
    decimals = await client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" });
  } else decimals = await client.readContract({ address: product.address, abi: erc20Abi, functionName: "decimals" });
  const position: Position = { product, balance, decimals, asset };
  if (product.kind === "covered") {
    const [underlying, pending, claimable, requestId, pendingDeposit, claimableDeposit] = await Promise.all([
      client.readContract({ address: product.address, abi: coveredAbi, functionName: "asset" }),
      client.readContract({ address: product.address, abi: coveredAbi, functionName: "pendingRedeemShares", args: [safe] }),
      client.readContract({ address: product.address, abi: coveredAbi, functionName: "claimableRedeemShares", args: [safe] }),
      client.readContract({ address: product.address, abi: coveredAbi, functionName: "lastRedeemRequestId", args: [safe] }),
      client.readContract({ address: product.address, abi: coveredAbi, functionName: "pendingDepositRequest", args: [0n, safe] }),
      client.readContract({ address: product.address, abi: coveredAbi, functionName: "claimableDepositRequest", args: [0n, safe] }),
    ]);
    if (!same(underlying, product.asset!)) throw new Error("Covered vault underlying changed");
    return { ...position, pending, claimable, requestId, pendingDeposit, claimableDeposit };
  }
  if (product.kind === "erc4626") position.available = await client.readContract({ address: product.address, abi: vaultAbi, functionName: "maxRedeem", args: [safe] });
  if (product.kind === "stader") {
    position.requests = await client.readContract({ address: product.pool!, abi: staderAbi, functionName: "getUserMaticXSwapRequests", args: [safe] });
  }
  return position;
}
export async function redeemPosition(
  client: PublicClient, snapshot: AccountSnapshot, product: Product, amount: bigint, rawDestination: string,
): Promise<PreparedAction> {
  if (snapshot.chainId !== product.chainId) throw new Error("Wrong investment network");
  const destination = address(rawDestination);
  const position = await inspectPosition(client, snapshot.address, product);
  if (amount <= 0n || amount > position.balance) throw new Error("Invalid position amount");
  if (product.kind === "receipt") {
    const action = safeAction(snapshot, transferCall(product.address, destination, amount), "Transfer investment position (not redeem)");
    return { ...action, receive: { token: product.address, recipient: destination, minimum: amount } };
  }
  if (product.kind === "erc4626") {
    const [asset, maximum, preview] = await Promise.all([
      client.readContract({ address: product.address, abi: vaultAbi, functionName: "asset" }),
      client.readContract({ address: product.address, abi: vaultAbi, functionName: "maxRedeem", args: [snapshot.address] }),
      client.readContract({ address: product.address, abi: vaultAbi, functionName: "previewRedeem", args: [amount] }),
    ]);
    if (product.asset && !same(asset, product.asset)) throw new Error("Vault underlying changed");
    if (amount > maximum || preview <= 0n) throw new Error("Vault liquidity or withdrawal limit prevents redemption");
    return { ...safeAction(snapshot, { to: product.address, value: 0n, data: encodeFunctionData({
      abi: vaultAbi, functionName: "redeem", args: [amount, destination, snapshot.address],
    }) }, "Redeem vault shares"), receive: { token: asset, recipient: destination, minimum: 1n } };
  }
  if (product.kind === "aave") {
    const [pool, asset] = await Promise.all([
      client.readContract({ address: product.address, abi: aaveAbi, functionName: "POOL" }),
      client.readContract({ address: product.address, abi: aaveAbi, functionName: "UNDERLYING_ASSET_ADDRESS" }),
    ]);
    if (!same(pool, product.pool!) || (product.asset && !same(asset, product.asset))) throw new Error("Aave deployment does not match catalogue");
    return { ...safeAction(snapshot, { to: pool, value: 0n, data: encodeFunctionData({
      abi: aaveAbi, functionName: "withdraw", args: [asset, amount, destination],
    }) }, "Withdraw Aave position"), receive: { token: asset, recipient: destination, minimum: amount } };
  }
  if (product.kind === "stbrla") {
    const asset = await client.readContract({ address: product.address, abi: brlaAbi, functionName: "brla" });
    if (!same(asset, product.asset!)) throw new Error("BRLA underlying changed");
    if (await client.readContract({ address: product.address, abi: brlaAbi, functionName: "paused" })) throw new Error("stBRLA withdrawals are paused on-chain");
    return { ...safeAction(snapshot, { to: product.address, value: 0n, data: encodeFunctionData({
      abi: brlaAbi, functionName: "unstake", args: [snapshot.address, destination, amount],
    }) }, "Unstake stBRLA"), receive: { token: asset, recipient: destination, minimum: 1n } };
  }
  if (product.kind === "covered") {
    return safeAction(snapshot, { to: product.address, value: 0n, data: encodeFunctionData({
      abi: coveredAbi, functionName: "requestRedeem", args: [amount, snapshot.address, snapshot.address],
    }) }, "Request covered vault redemption (funds not yet received)");
  }
  if (product.kind === "stader") {
    const [paused, liquidity, converted] = await Promise.all([
      client.readContract({ address: product.pool!, abi: staderAbi, functionName: "paused" }),
      client.readContract({ address: product.pool!, abi: staderAbi, functionName: "instantPoolMatic" }),
      client.readContract({ address: product.pool!, abi: staderAbi, functionName: "convertMaticXToMatic", args: [amount] }),
    ]);
    if (paused) throw new Error("Stader withdrawals are paused on-chain");
    if (converted[0] <= 0n || liquidity < converted[0]) throw new Error(`Stader native liquidity is insufficient (${liquidity} raw POL). Transfer MaticX as-is or try a smaller withdrawal.`);
    const allowance = await client.readContract({ address: product.address, abi: erc20Abi, functionName: "allowance", args: [snapshot.address, product.pool!] });
    if (allowance < amount) return safeAction(snapshot, { to: product.address, value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [product.pool!, amount] }) }, "Approve exact MaticX amount; request withdrawal afterward");
    return safeAction(snapshot, { to: product.pool!, value: 0n, data: encodeFunctionData({
      abi: staderAbi, functionName: "requestMaticXSwap", args: [amount],
    }) }, "Request MaticX redemption; claim after the contract waiting period");
  }
  if (product.kind === "staking") {
    return { ...safeAction(snapshot, { to: product.address, value: 0n, data: encodeFunctionData({
      abi: stakingAbi, functionName: "withdraw", args: [amount],
    }) }, "Withdraw stake to this Safe"), receive: { token: position.asset!, recipient: snapshot.address, minimum: amount } };
  }
  throw new Error("No redemption adapter for this product");
}
export async function claimCovered(client: PublicClient, snapshot: AccountSnapshot, product: Product) {
  const position = await inspectPosition(client, snapshot.address, product);
  if (product.kind !== "covered" || !position.claimable) throw new Error("No remaining claimable shares");
  return { ...safeAction(snapshot, { to: product.address, value: 0n,
    data: encodeFunctionData({ abi: coveredAbi, functionName: "redeem", args: [position.claimable, snapshot.address, snapshot.address] }),
  }, "Claim sDAI to this Safe; redeem sDAI separately"),
  receive: { token: product.asset!, recipient: snapshot.address, minimum: 1n } } satisfies PreparedAction;
}
export async function settleCovered(client: PublicClient, snapshot: AccountSnapshot, product: Product, requestId: bigint) {
  if (product.kind !== "covered") throw new Error("Wrong product");
  const pending = await client.readContract({ address: product.address, abi: coveredAbi, functionName: "pendingRedeemRequest", args: [requestId, snapshot.address] });
  if (pending <= 0n) throw new Error("No pending request with this ID for this account");
  return { kind: "direct", chainId: snapshot.chainId, account: snapshot.address, label: "Settle matured request; claim afterward",
    call: { to: product.address, value: 0n, data: encodeFunctionData({ abi: coveredAbi, functionName: "settleMaturedRedemption", args: [requestId] }) } } satisfies PreparedAction;
}
export async function claimStader(client: PublicClient, snapshot: AccountSnapshot, product: Product, index: number) {
  const position = await inspectPosition(client, snapshot.address, product);
  const request = position.requests?.[index];
  if (!request || request.withdrawalTime > (await client.getBlock()).timestamp) throw new Error("Stader request is not ready");
  return { ...safeAction(snapshot, { to: product.pool!, value: 0n, data: encodeFunctionData({
    abi: staderAbi, functionName: "claimMaticXSwap", args: [BigInt(index)],
  }) }, "Claim native POL to this Safe"), revalidate: async () => {
    const fresh = await inspectPosition(client, snapshot.address, product);
    const atIndex = fresh.requests?.[index];
    if (!atIndex || atIndex.amount !== request.amount || atIndex.requestTime !== request.requestTime || atIndex.withdrawalTime !== request.withdrawalTime) throw new Error("Withdrawal index changed; refresh requests before signing");
  }, receive: { token: null, recipient: snapshot.address, minimum: request.amount } } satisfies PreparedAction;
}

export async function findCoveredRequests(
  client: PublicClient, safe: Address, product: Product, signal?: AbortSignal,
  onProgress?: (from: bigint, to: bigint) => void,
) {
  if (product.kind !== "covered") throw new Error("Wrong product");
  const end = await client.getBlockNumber();
  const ids = new Set<bigint>();
  let from = 0n, step = end + 1n;
  while (from <= end) {
    signal?.throwIfAborted();
    const to = from + step - 1n < end ? from + step - 1n : end;
    try {
      const logs = await client.getContractEvents({ address: product.address, abi: coveredAbi, eventName: "RedeemRequest",
        args: { controller: safe }, fromBlock: from, toBlock: to, strict: true });
      if (logs.length >= 10_000) throw new Error("Log range may be truncated");
      for (const log of logs) ids.add(log.args.requestId);
      from = to + 1n; onProgress?.(from, end);
    } catch (e) {
      if (step <= 100n) throw e;
      step /= 2n;
    }
  }
  const pending: { id: bigint; shares: bigint }[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    const shares = await client.readContract({ address: product.address, abi: coveredAbi, functionName: "pendingRedeemRequest", args: [id, safe] });
    if (shares > 0n) pending.push({ id, shares });
  }
  return pending.sort((a, b) => a.id < b.id ? -1 : 1);
}

export async function recoverCoveredDeposit(client: PublicClient, snapshot: AccountSnapshot, product: Product, cancel: boolean): Promise<PreparedAction> {
  const position = await inspectPosition(client, snapshot.address, product);
  if (product.kind !== "covered") throw new Error("Wrong product");
  const amount = cancel ? position.pendingDeposit : position.claimableDeposit;
  if (!amount) throw new Error("No deposit available for this action");
  return { ...safeAction(snapshot, { to: product.address, value: 0n, data: cancel
    ? encodeFunctionData({ abi: coveredAbi, functionName: "cancelDepositRequest", args: [0n, snapshot.address, snapshot.address] })
    : encodeFunctionData({ abi: coveredAbi, functionName: "deposit", args: [amount, snapshot.address, snapshot.address] }),
  }, cancel ? "Cancel pending covered deposit and receive sDAI" : "Claim settled deposit shares; request redemption afterward"),
  receive: { token: cancel ? product.asset! : product.address, recipient: snapshot.address, minimum: cancel ? amount : 1n } };
}

export function claimStakingRewards(snapshot: AccountSnapshot, product: Product): PreparedAction {
  if (product.kind !== "staking" || snapshot.chainId !== product.chainId) throw new Error("Wrong staking product or network");
  return safeAction(snapshot, { to: product.address, value: 0n, data: encodeFunctionData({ abi: stakingAbi, functionName: "getReward" }) }, "Claim available staking rewards to this account");
}
