import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { aggregateWords, balanceOfData, classify, decimalsData, type ReadPool } from "./reads";
import { address, same } from "./client";
import { BASKET, basketAbi } from "./legacy";
import { AUTOFARM, type LegacyCatalogue } from "./legacy-routes";

// What a legacy basket holds, read directly from its on-chain wallet
// (walletOf(nftId)) against the bundled Polygon legacy catalogue. Only
// catalogue assets are checked: a token outside it is not detected.
//   token    plain ERC-20 → withdrawable and forwardable as-is
//   receipt  transferable ERC-20 receipt of a protocol (LP, vault, aToken…)
//            → can be withdrawn as-is; redeeming it is a separate step
//   position non-transferable stake (Autofarm, MasterChef) → needs a protocol exit
//   native   POL held by the basket wallet
export type BasketCategory = "token" | "receipt" | "position" | "native";
export type BasketRead = { key: string; target: Address; data: Hex; category: BasketCategory; token?: Address; name: string; symbol?: string; assetIds: string[]; types: string[] };
export type BasketHolding = Omit<BasketRead, "data" | "target" | "key"> & { key: string; balance: bigint; decimals?: number };
export type BasketContents = {
  nftId: bigint; owner: Address; wallet?: Address; status: "queued" | "loading" | "complete" | "partial" | "error";
  checked: number; total: number; failed: number; holdings: BasketHolding[]; block?: bigint; error?: string;
  unreadable?: number;
};
const farmAbi = parseAbi([
  "function stakedWantTokens(uint256 poolId,address user) view returns (uint256)",
  "function userInfo(uint256 poolId,address user) view returns (uint256 amount,uint256 rewardDebt)",
]);
const ethBalanceAbi = parseAbi(["function getEthBalance(address addr) view returns (uint256)"]);
const STAKES = new Set(["IAutofarmDeposit", "IMasterChefDeposit"]);
// Catalogue types whose position is not an ERC-20 at `address`, or that
// describe a route rather than a holding.
const SKIP = new Set(["networkToken", ...STAKES]);
export const BASKET_CHUNK = 400;

// Deterministic, deduplicated read list for one wallet. One balanceOf per
// distinct ERC-20 contract (several catalogue routes share receipts), one read
// per distinct stake pool, and native POL via Multicall3.getEthBalance.
export function basketReadPlan(catalogue: LegacyCatalogue, wallet: Address, multicall: Address): BasketRead[] {
  const reads = new Map<string, BasketRead>();
  const merge = (read: BasketRead) => {
    const existing = reads.get(read.key);
    if (!existing) { reads.set(read.key, read); return; }
    existing.assetIds.push(...read.assetIds);
    if (!existing.types.includes(read.types[0])) existing.types.push(read.types[0]);
    // A contract listed as a plain token anywhere is shown as a token.
    if (read.category === "token") { existing.category = "token"; existing.name = read.name; existing.symbol = read.symbol ?? existing.symbol; }
  };
  for (const asset of catalogue.assets) {
    let target: Address;
    try { target = address(asset.address); } catch { continue; }
    if (STAKES.has(asset.type)) {
      const poolId = Number(asset.callParams?.poolId);
      if (!Number.isSafeInteger(poolId) || poolId < 0) continue;
      const farm = asset.type === "IAutofarmDeposit" ? AUTOFARM : target;
      merge({ key: `stake:${farm.toLowerCase()}:${poolId}`, target: farm, category: "position", name: asset.name, symbol: asset.symbol, assetIds: [asset._id], types: [asset.type],
        data: asset.type === "IAutofarmDeposit" ? encodeFunctionData({ abi: farmAbi, functionName: "stakedWantTokens", args: [BigInt(poolId), wallet] })
          : encodeFunctionData({ abi: farmAbi, functionName: "userInfo", args: [BigInt(poolId), wallet] }) });
      continue;
    }
    if (SKIP.has(asset.type)) continue;
    merge({ key: `erc20:${target.toLowerCase()}`, target, token: target, category: asset.type === "token" ? "token" : "receipt", name: asset.name, symbol: asset.symbol,
      assetIds: [asset._id], types: [asset.type], data: balanceOfData(wallet) });
  }
  return [{ key: "native", target: multicall, category: "native", name: "POL", symbol: "POL", assetIds: [], types: ["networkToken"],
    data: encodeFunctionData({ abi: ethBalanceAbi, functionName: "getEthBalance", args: [wallet] }) }, ...reads.values()];
}

// Resolve wallet and ownership at one block, then read the plan in bounded
// aggregate3 chunks. Each successful chunk is a checkpointed pool unit, so a
// retry only re-reads failed chunks. Oversized chunks are split; failures are
// counted (status "partial"), never treated as zero balances.
export async function readBasketContents(options: {
  pool: ReadPool; nftId: bigint; owner: Address; multicall: Address; catalogue: LegacyCatalogue;
  onProgress?: (state: BasketContents) => void; chunk?: number;
}): Promise<BasketContents> {
  const { pool, nftId, owner, multicall, catalogue, onProgress } = options;
  const size = options.chunk ?? BASKET_CHUNK;
  const head = await pool.run(async client => {
    const block = await client.getBlockNumber();
    const [currentOwner, wallet] = await Promise.all([
      client.readContract({ address: BASKET, abi: basketAbi, functionName: "ownerOf", args: [nftId], blockNumber: block }),
      client.readContract({ address: BASKET, abi: basketAbi, functionName: "walletOf", args: [nftId], blockNumber: block }),
    ]);
    return { block, currentOwner, wallet };
  }, `basket-wallet:${owner.toLowerCase()}:${nftId}`);
  if (!same(head.currentOwner, owner)) throw new Error("This account no longer owns the basket NFT");
  const plan = basketReadPlan(catalogue, head.wallet, multicall);
  let state: BasketContents = { nftId, owner, wallet: head.wallet, status: "loading", checked: 0, total: plan.length, failed: 0, holdings: [], block: head.block };
  const emit = (patch: Partial<BasketContents>) => { state = { ...state, ...patch }; onProgress?.(state); };
  emit({});
  let block = head.block, repins = 0;
  // undefined: the contract answered without a balance; "rpc": unknown.
  type Value = bigint | undefined | "rpc";
  const read = async (reads: BasketRead[], key: string): Promise<Value[]> => {
    for (;;) {
      try {
        const words = await pool.run(client => aggregateWords(client, multicall, reads.map(r => ({ target: r.target, data: r.data })), block), key);
        return words.map(w => w.ok ? w.value : undefined);
      } catch (error) {
        pool.throwIfAborted();
        const kind = classify(error);
        // Short-history RPCs: re-pin to a newer block instead of failing.
        if (kind === "state" && repins++ < 3) { block = await pool.run(client => client.getBlockNumber()); continue; }
        if ((kind === "size" || kind === "revert") && reads.length > 25) {
          const half = Math.ceil(reads.length / 2);
          return [...await read(reads.slice(0, half), `${key}:a`), ...await read(reads.slice(half), `${key}:b`)];
        }
        return reads.map(() => "rpc" as const);
      }
    }
  };
  const prefix = `basket-contents:${head.wallet.toLowerCase()}`;
  for (let offset = 0; offset < plan.length; offset += size) {
    pool.throwIfAborted();
    const reads = plan.slice(offset, offset + size);
    const values = await read(reads, `${prefix}:${offset}:${reads.length}`);
    const positive = reads.flatMap((r, i) => { const v = values[i]; return typeof v === "bigint" && v > 0n ? [{ ...r, balance: v }] : []; });
    // Decimals only for found ERC-20s; unreadable precision stays raw units.
    const erc20 = positive.filter(p => p.token);
    const decimals = erc20.length ? await read(erc20.map(p => ({ ...p, data: decimalsData })), `${prefix}:decimals:${erc20.map(p => p.key).join(",")}`) : [];
    const holdings: BasketHolding[] = positive.map(p => {
      const d = p.token ? decimals[erc20.indexOf(p)] : p.category === "native" ? 18n : undefined;
      const { data: _data, target: _target, ...rest } = p;
      return { ...rest, decimals: typeof d === "bigint" && d <= 255n ? Number(d) : undefined };
    });
    emit({ checked: offset + reads.length, failed: state.failed + values.filter(v => v === "rpc").length,
      unreadable: (state.unreadable ?? 0) + values.filter(v => v === undefined).length, holdings: [...state.holdings, ...holdings] });
  }
  emit({ status: state.failed ? "partial" : "complete", block });
  return state;
}
// ERC-20 holdings that withdrawPortfolio can return as-is (token or receipt).
export const withdrawableHoldings = (contents: BasketContents) => contents.holdings.filter(h => h.token && (h.category === "token" || h.category === "receipt"));
