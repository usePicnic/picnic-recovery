import { concat, encodeAbiParameters, encodeFunctionData, getAddress, getCreate2Address, keccak256, pad, parseAbi, parseAbiItem, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import deployments from "../catalog/account-discovery.json";
import { same } from "./client";
import { inspectAccount, assertSupportedSafe, recoveryPeriod, SAFE_SINGLETONS } from "./inspect";
import { inspectCard } from "./card";
import { ReadPool } from "./reads";

const setupAbi = parseAbi(["function setup(address[],uint256,address,bytes,address,address,uint256,address)", "function enableModules(address[])"]);
function predict(owner: Address, card: boolean): Address {
  const deployment = card ? deployments.card : deployments.picnic;
  const initializer = encodeFunctionData({ abi: setupAbi, functionName: "setup", args: [[owner], 1n,
    card ? zeroAddress : deployments.picnic.addModulesLibAddress as Address,
    card ? "0x" : encodeFunctionData({ abi: setupAbi, functionName: "enableModules", args: [[deployments.picnic.safe4337ModuleAddress as Address]] }),
    (card ? deployments.card.fallbackHandler : deployments.picnic.safe4337ModuleAddress) as Address, zeroAddress, 0n, zeroAddress] });
  return getCreate2Address({ from: deployment.safeProxyFactoryAddress as Address,
    salt: keccak256(concat([keccak256(initializer), card ? keccak256(stringToHex("gnosispay.com")) : encodeAbiParameters([{ type: "uint256" }], [0n])])),
    bytecode: concat([deployment.proxyCreationCode as Hex, encodeAbiParameters([{ type: "address" }], [deployment.safeSingletonAddress as Address])]) });
}
// Matches Picnic's original EOA-owner Safe deployment. Prediction is only a hint;
// current singleton/runtime and ownership must be verified before selecting it.
export const predictPicnicAccount = (owner: Address) => predict(owner, false);
export const predictCardAccount = (controller: Address) => predict(controller, true);
export async function discoverPicnicAccount(pool: ReadPool, owner: Address) {
  const candidate = predictPicnicAccount(owner);
  const code = await pool.run(client => client.getCode({ address: candidate }), `code:${candidate.toLowerCase()}`);
  if (!code || code === "0x") return;
  const snapshot = await pool.run(client => inspectAccount(client, candidate, 100));
  assertSupportedSafe(snapshot);
  if (!snapshot.owners.some(address => same(address, owner))) return;
  return candidate;
}

// Events are address hints, never authority. Query indexed topics so this works
// without Picnic/Candide APIs. An indexed address[] hashes its padded elements
// without the ABI array offset or length; this flow supports one new owner.
export const guardianAddedTopic = keccak256(stringToHex("GuardianAdded(address,address)"));
export const recoveryFinalizedTopic = keccak256(stringToHex("RecoveryFinalized(address,address[],uint256,uint256)"));
export const recoveredOwnerTopic = (owner: Address) => keccak256(pad(owner, { size: 32 }));
export type RecoveryHandoff = { account: Address; chainId: number; newOwner: Address };
// A successful recovery can finish on another network before Gnosis. A hint
// retains the account identity, not its authority: prove current ownership on
// that network again, and never apply it to a different connected wallet.
export async function verifyRecoveryHandoff(pool: ReadPool, wallet: Address, handoff: RecoveryHandoff): Promise<Address | undefined> {
  if (!same(wallet, handoff.newOwner)) return;
  const snapshot = await pool.run(client => inspectAccount(client, handoff.account, handoff.chainId));
  assertSupportedSafe(snapshot);
  return snapshot.owners.some(owner => same(owner, wallet)) ? handoff.account : undefined;
}
export async function discoverRecoveryAccounts(pool: ReadPool, wallet: Address, chainId = 100): Promise<Address[]> {
  const queries = [
    { event: guardianAddedTopic, identity: pad(wallet, { size: 32 }), role: "guardian" },
    { event: recoveryFinalizedTopic, identity: recoveredOwnerTopic(wallet), role: "owner" },
  ] as const;
  const candidates = new Map<string, { account: Address; module: Address; roles: Set<string> }>();
  for (const query of queries) {
    const logs = await pool.run(client => client.request({ method: "eth_getLogs", params: [{
      fromBlock: "0x0", toBlock: "latest", topics: [query.event, null, query.identity],
    }] }));
    // Do not silently truncate a history scan or choose an arbitrary account.
    if (logs.length >= 2000) throw new Error("Recovery discovery history limit reached; accounts could not be fully verified");
    for (const log of logs) {
      if (log.removed || log.topics[0]?.toLowerCase() !== query.event.toLowerCase()
        || log.topics[2]?.toLowerCase() !== query.identity.toLowerCase() || !/^0x0{24}[a-f0-9]{40}$/i.test(log.topics[1] ?? "")) continue;
      const account = getAddress(`0x${log.topics[1]!.slice(-40)}`), module = getAddress(log.address);
      const key = `${account.toLowerCase()}:${module.toLowerCase()}`;
      const candidate = candidates.get(key) ?? { account, module, roles: new Set<string>() };
      candidate.roles.add(query.role); candidates.set(key, candidate);
      if (candidates.size > 64) throw new Error("Recovery discovery candidate limit reached; accounts could not be fully verified");
    }
  }
  const modules = new Map<string, boolean>();
  const found = new Map<string, Address>();
  for (const candidate of candidates.values()) {
    pool.throwIfAborted();
    const moduleKey = candidate.module.toLowerCase();
    if (!modules.has(moduleKey)) {
      const code = await pool.run(client => client.getCode({ address: candidate.module }));
      modules.set(moduleKey, recoveryPeriod(code) !== undefined);
    }
    if (!modules.get(moduleKey)) continue;
    const snapshot = await pool.run(client => inspectAccount(client, candidate.account, chainId));
    assertSupportedSafe(snapshot);
    // The emitting canonical module must still be enabled on this exact Safe.
    const recovery = snapshot.recoveries.find(r => r.supported && same(r.module, candidate.module));
    if (!recovery) continue;
    const owner = candidate.roles.has("owner") && snapshot.owners.some(value => same(value, wallet));
    const guardian = candidate.roles.has("guardian") && recovery.threshold > 0n && recovery.guardians.some(value => same(value, wallet));
    if (owner || guardian) found.set(candidate.account.toLowerCase(), candidate.account);
  }
  return [...found.values()];
}
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
// Address hints come from the deterministic original card and transfer history.
// Neither a transfer nor a matching address proves control. Every candidate is
// checked against the current Safe/Delay controller relationship before use.
export async function discoverCards(pool: ReadPool, controller: Address) {
  const predicted = predictCardAccount(controller);
  const candidates = new Set<Address>([predicted]);
  const issues: string[] = [];
  const notes: string[] = [];
  for (const args of [{ from: controller }, { to: controller }, { from: predicted }]) {
    try {
      const logs = await pool.run(client => client.getLogs({ event: transferEvent, args, fromBlock: 0n, toBlock: "latest", strict: true }), `history:${JSON.stringify(args)}`);
      if (logs.length > 2000) issues.push("Card discovery history was truncated; additional cards may be missing");
      for (const log of logs.slice(-2000).reverse()) {
        const candidate = args.to ? log.args.from : log.args.to;
        if (!same(candidate, controller) && !same(candidate, zeroAddress)) candidates.add(candidate);
      }
    } catch { pool.throwIfAborted(); issues.push("Card transfer history could not be verified; additional cards may be missing"); }
  }
  const addresses: Address[] = [];
  if (candidates.size > 64) issues.push("Card candidate limit reached; additional cards may be missing");
  const bounded = [...candidates].slice(0, 64);
  for (let offset = 0; offset < bounded.length; offset += 4) await Promise.all(bounded.slice(offset, offset + 4).map(async candidate => {
    try {
      const code = await pool.run(client => client.getCode({ address: candidate }), `code:${candidate.toLowerCase()}`);
      if (!code || code === "0x") return;
      // Ignore ordinary token/router contracts before the more expensive Safe inspection.
      if (code.length > 1000) return;
      const singleton = await pool.run(client => client.getStorageAt({ address: candidate, slot: "0x0" }), `singleton:${candidate.toLowerCase()}`);
      if (!singleton || !SAFE_SINGLETONS.some(address => same(address, `0x${singleton.slice(-40)}`))) {
        if (same(candidate, predicted)) notes.push(`Original card ${candidate} is outside the supported v5 discovery scope`);
        return;
      }
      const delays = await pool.run(client => inspectCard(client, candidate, 100), `card:${candidate.toLowerCase()}`);
      if (delays.filter(delay => delay.delayVersion === "v5" && delay.controllers.some(owner => same(owner, controller))).length === 1) addresses.push(candidate);
    } catch {
      pool.throwIfAborted();
      if (same(candidate, predicted)) issues.push(`Original card ${candidate} could not be verified; it may have been replaced`);
      else if (!issues.includes("Some card candidates could not be verified")) issues.push("Some card candidates could not be verified");
    }
  }));
  return { addresses, issues, notes };
}
