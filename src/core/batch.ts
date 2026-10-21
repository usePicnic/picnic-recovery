import { BaseError, encodeFunctionData, getAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import type { Product } from "../catalog/products";
import { delayAbi, erc20Abi, safeAbi } from "./abi";
import { address, same } from "./client";
import { prevalidatedSignature, safeBatchAction } from "./actions";
import { aggregateWords, balanceOfData } from "./reads";
import { BASKET, basketAbi } from "./legacy";
import { inspectCard, queueHash, type CardDelay } from "./card";
import { inspectPosition, stakingAbi, type Position } from "./investments";
import { inspectMamo, strategyAbi, type MamoPosition } from "./mamo";
import { withdrawableHoldings, type BasketContents, type BasketHolding } from "./basket-contents";
import { MAX_BATCH_CALLS } from "./multisend";
import type { AccountSnapshot, Call, PreparedAction, Receive } from "./types";

// Selected assets of one network, as chosen in Prepare wallets. The planner
// never adds anything that is not in this list.
export type BatchSource =
  | { id: string; kind: "native"; label: string }
  | { id: string; kind: "token"; label: string; token: Address }
  | { id: string; kind: "position"; label: string; product: Product }
  | { id: string; kind: "mamo"; label: string; strategy: Address }
  | { id: string; kind: "basket"; label: string; nftId: bigint; contents?: BasketContents }
  | { id: string; kind: "card"; label: string; delay: CardDelay; asset: Address | "native" }
  | { id: string; kind: "card-queue"; label: string; delay: CardDelay }
  | { id: string; kind: "unidentified"; label: string };

// Fresh on-chain state for each source, read at one block immediately
// before review. `amounts` are what the planned calls rely on; revalidation
// requires each to be unchanged or larger before sending.
export type BatchFact =
  | { id: string; kind: "native"; label: string; balance: bigint }
  | { id: string; kind: "token"; label: string; token: Address; balance: bigint; decimals?: number; symbol?: string; transferBlocked?: boolean }
  | { id: string; kind: "position"; label: string; position: Position }
  | { id: string; kind: "mamo"; label: string; mamo: MamoPosition }
  | { id: string; kind: "basket"; label: string; nftId: bigint; owned: boolean; wallet?: Address; tokens: (BasketHolding & { fresh: bigint })[]; native: bigint;
      stakes: BasketHolding[]; contents?: BasketContents["status"]; unread?: number; readFailed?: boolean }
  | { id: string; kind: "card"; label: string; delay?: CardDelay; asset: Address | "native"; balance: bigint; card: Address }
  | { id: string; kind: "card-queue"; label: string; delay: CardDelay }
  | { id: string; kind: "unidentified"; label: string };

export type EntryStatus = "included" | "individual" | "later" | "empty";
// What happens to one selected asset in this batch, stated plainly.
//   received: funds arrive at the destination in this transaction
//   shares:   the investment's transferable shares arrive (not redeemed)
//   queued:   a card withdrawal request is created; funds arrive only after
//             the contract waiting period and a later execution step
export type Outcome = "received" | "shares" | "queued";
export type BatchEntry = {
  id: string; label: string; status: EntryStatus; outcome?: Outcome;
  calls: Call[]; callLabels: string[]; receives: Receive[]; queued: { module: Address; txHash: Hex }[];
  transferBlocked?: boolean; notes: string[]; later: string[]; gas: bigint; amounts: Record<string, bigint>;
};
export type BatchPlan = {
  chainId: number; account: Address; destination: Address; block: bigint; multisend?: Address;
  unavailable?: "eoa" | "multisend" | "unsupported"; entries: BatchEntry[]; parts: string[][];
};

// Conservative per-call gas heuristics used only to split very large batches
// into visible parts. Each part is still simulated and estimated before sending.
const GAS = { transfer: 70_000n, share: 90_000n, staking: 160_000n, mamo: 260_000n, basket: 220_000n, basketToken: 90_000n, enqueue: 130_000n, base: 60_000n };
export const PART_GAS_BUDGET = 8_000_000n;
const ALL = 100_000n; // withdrawPortfolio share scale: 100000 = 100%

const ethBalanceAbi = [{ type: "function", name: "getEthBalance", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const word = (value: bigint) => getAddress(`0x${value.toString(16).padStart(40, "0").slice(-40)}`);

export async function readBatchFacts(client: PublicClient, snapshot: AccountSnapshot, sources: readonly BatchSource[], multicall3?: Address): Promise<BatchFact[]> {
  const safe = snapshot.address, blockNumber = snapshot.block;
  const balance = (token: Address, owner: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber });
  const baskets = sources.filter((s): s is Extract<BatchSource, { kind: "basket" }> => s.kind === "basket");
  const basketFacts = await readBasketFacts(client, safe, baskets, blockNumber, multicall3);
  const facts: BatchFact[] = [];
  for (const source of sources) {
    switch (source.kind) {
      case "native": facts.push({ ...source, balance: await client.getBalance({ address: safe, blockNumber }) }); break;
      case "token": {
        const [value, decimals] = await Promise.all([balance(source.token, safe),
          client.readContract({ address: source.token, abi: erc20Abi, functionName: "decimals", blockNumber }).catch(() => undefined)]);
        facts.push({ ...source, balance: value, decimals });
        break;
      }
      case "position": facts.push({ ...source, position: await inspectPosition(client, safe, source.product) }); break;
      case "mamo": facts.push({ ...source, mamo: await inspectMamo(client, safe, source.strategy) }); break;
      case "basket": facts.push(basketFacts.get(source.id)!); break;
      case "card": {
        const delay = (await inspectCard(client, source.delay.card, snapshot.chainId))
          .find(d => d.delayVersion === "v5" && same(d.address, source.delay.address) && d.controllers.some(c => same(c, safe)));
        const value = source.asset === "native" ? await client.getBalance({ address: source.delay.card, blockNumber }) : await balance(source.asset, source.delay.card);
        facts.push({ ...source, delay, balance: value, card: source.delay.card });
        break;
      }
      default: facts.push(source);
    }
  }
  return facts;
}
// Probe ordinary token transfers through the actual Safe, with the same sender
// and block as the plan. A valid balance does not imply transferability (e.g.
// locked airdrops). Only GS013 proves an inner-call failure: RPC errors and Safe
// authorization errors abort preparation, never turn into excluded assets.
// Multisig proposals retain the existing full-transaction approval/simulation path.
export async function screenTokenTransfers(client: PublicClient, snapshot: AccountSnapshot, facts: readonly BatchFact[], destination: Address, sender?: Address): Promise<BatchFact[]> {
  if (snapshot.version === "EOA" || snapshot.threshold !== 1n || !sender || !snapshot.owners.some(owner => same(owner, sender))) return [...facts];
  const checked: BatchFact[] = [];
  for (const fact of facts) {
    if (fact.kind !== "token" || fact.balance <= 0n) { checked.push(fact); continue; }
    const data = encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [fact.token, 0n,
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [destination, fact.balance] }),
      0, 0n, 0n, 0n, zeroAddress, zeroAddress, prevalidatedSignature(sender)] });
    try {
      await client.call({ account: sender, to: snapshot.address, data, blockNumber: snapshot.block });
      checked.push({ ...fact, transferBlocked: false });
    } catch (error) {
      const failures: unknown[] = [];
      if (error instanceof BaseError) error.walk(cause => { failures.push(cause); return false; });
      else failures.push(error);
      const reverted = failures.some(cause => /\bGS013\b/.test(cause instanceof Error ? cause.message : String(cause)));
      if (!reverted) throw error;
      checked.push({ ...fact, transferBlocked: true });
    }
  }
  return checked;
}

// Ownership, wallet and known content balances of many baskets in bounded
// aggregate3 chunks at the review block (149 baskets ≈ a few requests).
async function readBasketFacts(client: PublicClient, owner: Address, baskets: Extract<BatchSource, { kind: "basket" }>[], blockNumber: bigint, multicall3?: Address) {
  const out = new Map<string, Extract<BatchFact, { kind: "basket" }>>();
  if (!baskets.length) return out;
  if (!multicall3) throw new Error("Multicall3 is required to read basket contents");
  const words = async (calls: { target: Address; data: Hex }[]) => {
    const values: (bigint | undefined)[] = [];
    for (let i = 0; i < calls.length; i += 300) {
      const chunk = await aggregateWords(client, multicall3, calls.slice(i, i + 300), blockNumber);
      values.push(...chunk.map(w => w.ok ? w.value : undefined));
    }
    return values;
  };
  const heads = await words(baskets.flatMap(b => [
    { target: BASKET, data: encodeFunctionData({ abi: basketAbi, functionName: "ownerOf", args: [b.nftId] }) },
    { target: BASKET, data: encodeFunctionData({ abi: basketAbi, functionName: "walletOf", args: [b.nftId] }) },
  ]));
  const wallets = baskets.map((b, i) => {
    const [ownerWord, walletWord] = [heads[i * 2], heads[i * 2 + 1]];
    return { basket: b, owned: ownerWord !== undefined && same(word(ownerWord), owner), wallet: walletWord !== undefined && walletWord !== 0n ? word(walletWord) : undefined };
  });
  // Only contents previously identified for this exact wallet are re-read.
  const reads = wallets.flatMap(w => !w.owned || !w.wallet ? [] : [
    { basket: w.basket.id, key: "native", call: { target: multicall3, data: encodeFunctionData({ abi: ethBalanceAbi, functionName: "getEthBalance", args: [w.wallet] }) } },
    ...(w.basket.contents && same(w.basket.contents.wallet ?? "", w.wallet) ? withdrawableHoldings(w.basket.contents) : [])
      .map(h => ({ basket: w.basket.id, key: h.key, call: { target: h.token!, data: balanceOfData(w.wallet!) } })),
  ]);
  const values = await words(reads.map(r => r.call));
  for (const { basket, owned, wallet } of wallets) {
    const fresh = (key: string) => { const i = reads.findIndex(r => r.basket === basket.id && r.key === key); return i < 0 ? undefined : values[i]; };
    const contents = basket.contents && wallet && same(basket.contents.wallet ?? "", wallet) ? basket.contents : undefined;
    out.set(basket.id, { id: basket.id, kind: "basket", label: basket.label, nftId: basket.nftId, owned, wallet, native: fresh("native") ?? 0n,
      readFailed: !!owned && !!wallet && (fresh("native") === undefined || !!contents && withdrawableHoldings(contents).some(h => fresh(h.key) === undefined)),
      tokens: (contents ? withdrawableHoldings(contents) : []).map(h => ({ ...h, fresh: fresh(h.key) ?? 0n })),
      stakes: contents?.holdings.filter(h => h.category === "position") ?? [], contents: contents?.status, unread: contents ? contents.failed + (contents.total - contents.checked) + (contents.unreadable ?? 0) : undefined });
  }
  return out;
}

function entry(fact: BatchFact, patch: Partial<BatchEntry>): BatchEntry {
  return { id: fact.id, label: fact.label, status: "included", calls: [], callLabels: [], receives: [], queued: [], notes: [], later: [], gas: 0n, amounts: {}, ...patch };
}
const transfer = (token: Address | null, to: Address, amount: bigint): Call => token
  ? { to: token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) }
  : { to, value: amount, data: "0x" };

// Pure: turns fresh facts into explicit per-asset entries and gas-bounded
// parts. Nothing selected is dropped silently: each fact yields exactly one
// entry stating whether it is in the batch, needs an individual step, or has
// nothing to move now.
export function planBatch(options: { snapshot: AccountSnapshot; destination: string; facts: readonly BatchFact[]; multisend?: Address; guardians?: readonly string[]; budget?: bigint }): BatchPlan {
  const { snapshot, facts } = options;
  const destination = address(options.destination);
  if (same(destination, snapshot.address)) throw new Error("Destination must differ from the source account");
  if ([...options.guardians ?? [], ...snapshot.recoveries.flatMap(r => r.guardians)].some(g => same(g, destination))) throw new Error("The destination is a recovery guardian of this account. Choose a wallet that is not a guardian");
  const unavailable = snapshot.version === "EOA" ? "eoa" as const : snapshot.warnings.some(w => w.includes("transactions disabled")) ? "unsupported" as const : !options.multisend ? "multisend" as const : undefined;
  const entries = facts.map(fact => planFact(fact, snapshot, destination));
  if (unavailable) for (const e of entries) if (e.status === "included") Object.assign(e, { status: "individual", calls: [], callLabels: [], receives: [], queued: [], gas: 0n });
  const parts: string[][] = [];
  let current: string[] = [], gas = 0n, calls = 0;
  const budget = options.budget ?? PART_GAS_BUDGET;
  for (const e of entries.filter(e => e.status === "included")) {
    if (current.length && (gas + e.gas > budget || calls + e.calls.length > MAX_BATCH_CALLS)) { parts.push(current); current = []; gas = 0n; calls = 0; }
    current.push(e.id); gas += e.gas; calls += e.calls.length;
  }
  if (current.length) parts.push(current);
  return { chainId: snapshot.chainId, account: snapshot.address, destination, block: snapshot.block, multisend: options.multisend, unavailable, entries, parts };
}

function planFact(fact: BatchFact, snapshot: AccountSnapshot, destination: Address): BatchEntry {
  const safe = snapshot.address;
  switch (fact.kind) {
    case "native": {
      if (fact.balance <= 0n) return entry(fact, { status: "empty" });
      return entry(fact, { outcome: "received", calls: [transfer(null, destination, fact.balance)], callLabels: [`Send ${fact.label}`],
        receives: [{ token: null, recipient: destination, minimum: fact.balance }], gas: GAS.transfer, amounts: { "safe:native": fact.balance },
        notes: ["The connected wallet pays the network fee; the Safe's own coin balance is not needed for later steps of this tool."] });
    }
    case "token": {
      if (fact.balance <= 0n) return entry(fact, { status: "empty" });
      if (fact.transferBlocked) return entry(fact, { status: "individual", transferBlocked: true,
        notes: ["This token transfer reverted when simulated through this Safe with the selected destination. It is excluded from this batch, not recorded as migrated. Its balance remains in the source account."] });
      return entry(fact, { outcome: "received", calls: [transfer(fact.token, destination, fact.balance)], callLabels: [`Transfer ${fact.label}`],
        receives: [{ token: fact.token, recipient: destination, minimum: fact.balance }], gas: GAS.transfer, amounts: { [`safe:${fact.token.toLowerCase()}`]: fact.balance } });
    }
    case "position": {
      const { position } = fact, product = position.product;
      const later = [
        ...(position.pending ?? 0n) > 0n || (position.pendingDeposit ?? 0n) > 0n ? ["A redemption or deposit request is pending: settle or claim it individually when the contract allows it."] : [],
        ...(position.claimable ?? 0n) > 0n || (position.claimableDeposit ?? 0n) > 0n ? ["Claimable shares exist: claim them individually; they arrive at this Safe."] : [],
        ...position.requests?.length ? ["Stader withdrawal requests exist: claim each one individually after its unlock time (native POL arrives at this Safe)."] : [],
      ];
      if (position.balance <= 0n) return entry(fact, { status: later.length ? "later" : "empty", later });
      if (product.kind === "staking") {
        const token = position.asset!;
        return entry(fact, { outcome: "received", later: [...later, "Unclaimed staking rewards are not claimed by this batch."],
          calls: [{ to: product.address, value: 0n, data: encodeFunctionData({ abi: stakingAbi, functionName: "withdraw", args: [position.balance] }) }, transfer(token, destination, position.balance)],
          callLabels: [`Unstake ${fact.label} to the Safe`, `Forward ${fact.label} stake token`],
          receives: [{ token, recipient: destination, minimum: position.balance }], gas: GAS.staking + GAS.transfer, amounts: { [`stake:${product.address.toLowerCase()}`]: position.balance } });
      }
      // Transferable shares move intact: no redemption, no swap, no liquidity dependency.
      return entry(fact, { outcome: "shares", later, calls: [transfer(product.address, destination, position.balance)], callLabels: [`Transfer ${fact.label} shares (not redeemed)`],
        receives: [{ token: product.address, recipient: destination, minimum: position.balance }], gas: GAS.share, amounts: { [`safe:${product.address.toLowerCase()}`]: position.balance },
        notes: ["The destination receives the investment shares themselves. Redeeming them is a separate, optional step from that wallet."] });
    }
    case "mamo": {
      const { mamo } = fact;
      if (mamo.balance <= 0n) return entry(fact, { status: "empty" });
      return entry(fact, { outcome: "received", later: ["Strategy rewards are not claimed by this batch."],
        calls: [{ to: mamo.address, value: 0n, data: encodeFunctionData({ abi: strategyAbi, functionName: "withdraw", args: [mamo.balance] }) }, transfer(mamo.token, destination, mamo.balance)],
        callLabels: ["Withdraw MAMO strategy principal to the Safe", "Forward MAMO to the destination"],
        receives: [{ token: mamo.token, recipient: destination, minimum: mamo.balance }], gas: GAS.mamo + GAS.transfer, amounts: { [`mamo:${mamo.address.toLowerCase()}`]: mamo.balance } });
    }
    case "basket": {
      if (!fact.owned || !fact.wallet) return entry(fact, { status: "individual", notes: ["Basket ownership or wallet could not be verified at the review block."] });
      if (fact.readFailed) return entry(fact, { status: "individual", notes: ["The current balance of a basket asset could not be verified. It is unknown, not zero. Retry this network before migrating the basket."] });
      const notes: string[] = [], later: string[] = [];
      if (fact.contents !== "complete" || (fact.unread ?? 0) > 0) notes.push(fact.contents ? `Some balances could not be verified (${fact.unread ?? 0} catalogue checks): unread tokens stay in the basket.` : "Basket contents have not been read yet: only native POL can be included.");
      notes.push("Only tokens in the bundled legacy catalogue are detected; others stay in the basket.");
      if (fact.stakes.length) later.push(`${fact.stakes.length} protocol position(s) need an individual exit first: ${fact.stakes.map(s => s.symbol ?? s.name).join(", ")}.`);
      const tokens = fact.tokens.filter(t => t.fresh > 0n);
      if (!tokens.length && fact.native <= 0n) return entry(fact, { status: later.length ? "later" : "empty", notes, later });
      // withdrawPortfolio pays the NFT owner (this Safe); the same Safe
      // transaction then forwards exactly the basket amounts to the destination.
      const withdraw: Call = { to: BASKET, value: 0n, data: encodeFunctionData({ abi: basketAbi, functionName: "withdrawPortfolio",
        args: [fact.nftId, { tokens: tokens.map(t => t.token!), amounts: tokens.map(() => ALL) }, fact.native > 0n ? ALL : 0n, [], []] }) };
      const forwards = tokens.map(t => transfer(t.token!, destination, t.fresh));
      if (tokens.some(t => t.category === "receipt")) notes.push("Protocol receipt tokens are moved as-is; redeeming them is a separate step.");
      return entry(fact, { outcome: "received", notes, later,
        calls: [withdraw, ...forwards, ...fact.native > 0n ? [transfer(null, destination, fact.native)] : []],
        callLabels: [`Withdraw basket #${fact.nftId} to the Safe`, ...tokens.map(t => `Forward ${t.symbol ?? t.name}`), ...fact.native > 0n ? ["Forward POL"] : []],
        receives: [...tokens.map(t => ({ token: t.token!, recipient: destination, minimum: t.fresh })), ...fact.native > 0n ? [{ token: null, recipient: destination, minimum: fact.native }] : []],
        gas: GAS.basket + BigInt(tokens.length) * (GAS.basketToken + GAS.transfer) + (fact.native > 0n ? GAS.transfer : 0n),
        amounts: Object.fromEntries([...tokens.map(t => [`basket:${fact.nftId}:${t.token!.toLowerCase()}`, t.fresh]), ["basket:" + fact.nftId + ":native", fact.native]]) });
    }
    case "card": {
      if (!fact.delay) return entry(fact, { status: "individual", notes: ["The card's v5 Delay controller link could not be verified at the review block."] });
      if (fact.delay.tail > fact.delay.head) return entry(fact, { status: "later", later: ["This card already has queued withdrawal requests. Complete or discard them before queuing another withdrawal, so the same balance is not requested twice."] });
      if (fact.balance <= 0n) return entry(fact, { status: "empty" });
      const inner = transfer(fact.asset === "native" ? null : fact.asset, destination, fact.balance);
      const minutes = Number(fact.delay.cooldown) / 60;
      return entry(fact, { outcome: "queued",
        calls: [{ to: fact.delay.address, value: 0n, data: encodeFunctionData({ abi: delayAbi, functionName: "execTransactionFromModule", args: [inner.to, inner.value, inner.data, 0] }) }],
        callLabels: [`Queue card withdrawal of ${fact.label}`], queued: [{ module: fact.delay.address, txHash: queueHash(inner) }], gas: GAS.enqueue,
        amounts: { [`card:${fact.card.toLowerCase()}:${fact.asset === "native" ? "native" : fact.asset.toLowerCase()}`]: fact.balance },
        later: [`Card funds are NOT received by this batch. After the card waiting period (${minutes >= 1 ? `${Math.round(minutes)} min` : `${fact.delay.cooldown}s`}), execute each queued request in order from the card row.`,
          ...fact.delay.expiration > 0n ? [`Queued requests expire ${fact.delay.expiration}s after they become executable.`] : [],
          "If the card balance drops before execution (for example, a card payment), that request fails and must be queued again."] });
    }
    case "card-queue": return entry(fact, { status: "later", later: ["Existing card requests: execute them individually once their waiting period ends."] });
    case "unidentified": return entry(fact, { status: "individual", notes: ["Some owned baskets are not identified yet; retry the Polygon scan in diagnosis."] });
  }
}

// One reviewed Safe transaction for one part. Revalidation re-reads every
// source fact at a new block and requires each amount the calls rely on to be
// unchanged or larger, plus unchanged basket/card identity.
export function batchPartAction(options: {
  snapshot: AccountSnapshot; plan: BatchPlan; part: number; forbiddenRecipients?: Address[];
  reread?: () => Promise<BatchFact[]>; label: string;
}): PreparedAction {
  const { snapshot, plan, part } = options;
  if (plan.unavailable || !plan.multisend) throw new Error("A Safe batch is not available for this account on this network");
  const ids = plan.parts[part];
  if (!ids?.length) throw new Error("Nothing to include in this part");
  const entries = ids.map(id => plan.entries.find(e => e.id === id)!);
  const calls = entries.flatMap(e => e.calls), labels = entries.flatMap(e => e.callLabels);
  const action = safeBatchAction(snapshot, plan.multisend, calls, labels, options.label);
  return { ...action, receives: entries.flatMap(e => e.receives), queued: entries.flatMap(e => e.queued),
    forbiddenRecipients: options.forbiddenRecipients,
    destinations: [plan.destination],
    details: entries.map(e => `${e.label}: ${e.outcome}`),
    revalidate: options.reread && (async () => {
      const fresh = await options.reread!();
      const amounts = Object.assign({}, ...fresh.map(f => planFact(f, snapshot, plan.destination).amounts)) as Record<string, bigint>;
      for (const e of entries) for (const [key, value] of Object.entries(e.amounts)) {
        if ((amounts[key] ?? 0n) < value) throw new Error("A balance changed since review. Review this network again");
      }
      for (const f of fresh) {
        if (f.kind === "basket" && ids.includes(f.id)) {
          const old = plan.entries.find(e => e.id === f.id);
          if (!f.owned || (old?.calls.length && !f.wallet)) throw new Error("Basket ownership changed; review again");
        }
        if (f.kind === "card" && ids.includes(f.id) && !f.delay) throw new Error("Card controller changed; review again");
      }
    }),
  };
}
export const includedEntries = (plan: BatchPlan, part?: number) => plan.entries.filter(e => e.status === "included" && (part === undefined || plan.parts[part]?.includes(e.id)));
