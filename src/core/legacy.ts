import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { erc20Abi } from "./abi";
import { aggregateWords, classify, ReadPool } from "./reads";
import { address, same } from "./client";
import { safeAction } from "./actions";
import type { AccountSnapshot } from "./types";

export const BASKET = "0xee13C86EE4eb1EC3a05E2cc3AB70576F31666b3b" as const;
export const basketAbi = parseAbi([
  "function editPortfolio(uint256 nftId,address[] bridgeAddresses,bytes[] bridgeEncodedCalls)",
  "function tokenCounter() view returns (uint256)",
  "function ownerOf(uint256 nftId) view returns (address)",
  "function walletOf(uint256 nftId) view returns (address)",
  "function withdrawPortfolio(uint256 nftId,(address[] tokens,uint256[] amounts) outputs,uint256 outputEthPercentage,address[] bridgeAddresses,bytes[] bridgeEncodedCalls)",
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);
export async function inspectBasket(client: PublicClient, nftId: bigint, owner: Address) {
  if (await client.getChainId() !== 137) throw new Error("Legacy baskets are on Polygon");
  const [currentOwner, wallet] = await Promise.all([
    client.readContract({ address: BASKET, abi: basketAbi, functionName: "ownerOf", args: [nftId] }),
    client.readContract({ address: BASKET, abi: basketAbi, functionName: "walletOf", args: [nftId] }),
  ]);
  if (!same(currentOwner, owner)) throw new Error("This account does not own the basket NFT");
  return { nftId, owner: currentOwner, wallet };
}
export async function withdrawBasketToken(client: PublicClient, snapshot: AccountSnapshot, nftId: bigint, rawToken: string) {
  const basket = await inspectBasket(client, nftId, snapshot.address);
  const token = address(rawToken);
  const balance = await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [basket.wallet] });
  if (!balance) throw new Error("No token balance in this basket wallet");
  return { ...safeAction(snapshot, { to: BASKET, value: 0n, data: encodeFunctionData({
    abi: basketAbi, functionName: "withdrawPortfolio",
    args: [nftId, { tokens: [token], amounts: [100000n] }, 0n, [], []],
  }) }, "Withdraw basket token/receipt to NFT owner Safe; redeem receipts separately"),
  receive: { token, recipient: snapshot.address, minimum: balance } };
}

export async function discoverBaskets(client: PublicClient, owner: Address, start: bigint, count = 200) {
  if (await client.getChainId() !== 137 || start < 0n || count < 1 || count > 1000) throw new Error("Invalid basket discovery range");
  const total = await client.readContract({ address: BASKET, abi: basketAbi, functionName: "tokenCounter" });
  const end = start + BigInt(count) < total ? start + BigInt(count) : total;
  const owned: bigint[] = [], failed: bigint[] = [];
  for (let from = start; from < end; from += 10n) {
    const ids = Array.from({ length: Number(end - from < 10n ? end - from : 10n) }, (_, i) => from + BigInt(i));
    const results = await Promise.allSettled(ids.map(id => client.readContract({ address: BASKET, abi: basketAbi, functionName: "ownerOf", args: [id] })));
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && same(r.value, owner)) owned.push(ids[i]);
      else if (r.status === "rejected") failed.push(ids[i]);
    });
  }
  return { owned, failed, next: end, total };
}

export async function withdrawBasketNative(client: PublicClient, snapshot: AccountSnapshot, nftId: bigint) {
  const { wallet } = await inspectBasket(client, nftId, snapshot.address);
  const balance = await client.getBalance({ address: wallet });
  if (!balance) throw new Error("No native balance in basket");
  return { ...safeAction(snapshot, { to: BASKET, value: 0n, data: encodeFunctionData({ abi: basketAbi, functionName: "withdrawPortfolio",
    args: [nftId, { tokens: [], amounts: [] }, 100_000n, [], []] }) }, "Withdraw native POL from basket to its owner"),
    receive: { token: null, recipient: snapshot.address, minimum: balance } };
}

// Enumerate ownership at one block, not an arbitrary first 200 NFT IDs. Burned
// IDs may revert. Completeness is proven by matching balanceOf at that block.
// Each successful chunk is checkpointed; retry only requests missing chunks.
export async function discoverOwnedBaskets(pool: ReadPool, owner: Address, expected: bigint, blockNumber: bigint, multicall: Address) {
  const total = await pool.run(client => client.readContract({ address: BASKET, abi: basketAbi, functionName: "tokenCounter", blockNumber }), `basket-total:${blockNumber}`);
  const owned: bigint[] = [];
  let failed = 0;
  const limit = total < 100_000n ? total : 100_000n;
  const read = async (start: bigint, end: bigint): Promise<void> => {
    const ids = Array.from({ length: Number(end - start) }, (_, i) => start + BigInt(i));
    try {
      const values = await pool.run(client => aggregateWords(client, multicall, ids.map(id => ({ target: BASKET,
        data: encodeFunctionData({ abi: basketAbi, functionName: "ownerOf", args: [id] }) })), blockNumber), `basket-owners:${blockNumber}:${start}:${end}`);
      values.forEach((value, i) => { if (value.ok && value.value === BigInt(owner)) owned.push(ids[i]); });
    } catch (error) {
      pool.throwIfAborted();
      if (classify(error) === "size" && ids.length > 1) {
        const middle = start + BigInt(Math.ceil(ids.length / 2));
        await read(start, middle); await read(middle, end);
      } else { failed += ids.length; }
    }
  };
  for (let start = 0n; start < limit && BigInt(owned.length) < expected; start += 200n) {
    pool.throwIfAborted();
    await read(start, start + 200n < limit ? start + 200n : limit);
    // A down RPC should not produce hundreds of exhausted retry batches.
    if (failed >= 200) break;
  }
  return { owned, complete: BigInt(owned.length) === expected, failed, limited: limit < total };
}
