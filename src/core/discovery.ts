import { concat, encodeAbiParameters, encodeFunctionData, getCreate2Address, keccak256, parseAbi, parseAbiItem, stringToHex, zeroAddress, type Address, type Hex } from "viem";
import deployments from "../catalog/account-discovery.json";
import { same } from "./client";
import { inspectAccount, assertSupportedSafe, SAFE_SINGLETONS } from "./inspect";
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
  const code = await pool.run(client => client.getCode({ address: candidate }));
  if (!code || code === "0x") return;
  const snapshot = await pool.run(client => inspectAccount(client, candidate, 100));
  assertSupportedSafe(snapshot);
  if (!snapshot.owners.some(address => same(address, owner))) return;
  return candidate;
}
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
// Address hints come from the deterministic original card and transfer history.
// Neither a transfer nor a matching address proves control. Every candidate is
// checked against the current Safe/Delay controller relationship before use.
export async function discoverCards(pool: ReadPool, controller: Address) {
  const predicted = predictCardAccount(controller);
  const candidates = new Set<Address>([predicted]);
  const issues: string[] = [];
  for (const args of [{ from: controller }, { to: controller }, { from: predicted }]) {
    try {
      const logs = await pool.run(client => client.getLogs({ event: transferEvent, args, fromBlock: 0n, toBlock: "latest", strict: true }));
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
      const code = await pool.run(client => client.getCode({ address: candidate }));
      if (!code || code === "0x") return;
      // Ignore ordinary token/router contracts before the more expensive Safe inspection.
      if (code.length > 1000) return;
      const singleton = await pool.run(client => client.getStorageAt({ address: candidate, slot: "0x0" }));
      if (!singleton || !SAFE_SINGLETONS.some(address => same(address, `0x${singleton.slice(-40)}`))) {
        if (same(candidate, predicted)) issues.push(`Original card ${candidate} uses an unrecognized singleton; inspect its replacement instead`);
        return;
      }
      const delays = await pool.run(client => inspectCard(client, candidate, 100));
      if (delays.filter(delay => delay.controllers.some(owner => same(owner, controller))).length === 1) addresses.push(candidate);
    } catch {
      pool.throwIfAborted();
      if (same(candidate, predicted)) issues.push(`Original card ${candidate} could not be verified; it may have been replaced`);
      else if (!issues.includes("Some card candidates could not be verified")) issues.push("Some card candidates could not be verified");
    }
  }));
  return { addresses, issues };
}
