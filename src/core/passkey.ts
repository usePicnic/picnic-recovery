import type { Hex, PublicClient, Address } from "viem";
import signers from "../catalog/passkey-signers.json";

// Picnic's Safe WebAuthn v0.2.0/v0.2.1 owner proxies. Compare the full runtime
// after masking the four constructor immutables, and require its canonical
// singleton. This classifies the UI only; it never authorizes a transaction.
// Source: Picnic framework-common/src/constants/passkey.ts, WEBAUTHN_OVERRIDES.
export function isPasskeySigner(code?: Hex): boolean {
  if (!code || code === "0x") return false;
  for (const signer of signers) {
    if (code.length !== signer.runtime.length) continue;
    const start = 2 + signer.singletonSlot * 2;
    if (code.slice(start, start + 64).toLowerCase() !== signer.singleton.slice(2).toLowerCase().padStart(64, "0")) continue;
    let normalized = code.toLowerCase();
    for (const offset of signer.immutableSlots) {
      const at = 2 + offset * 2;
      normalized = normalized.slice(0, at) + "0".repeat(64) + normalized.slice(at + 64);
    }
    if (normalized === signer.runtime.toLowerCase()) return true;
  }
  return false;
}

export async function inspectPasskey(client: PublicClient, owners: readonly Address[], blockNumber: bigint) {
  const codes = await Promise.allSettled(owners.map(owner => client.getCode({ address: owner, blockNumber })));
  if (codes.some(result => result.status === "fulfilled" && isPasskeySigner(result.value))) return "detected" as const;
  // Unrecognized contract signers and failed reads are not evidence of an EOA.
  if (codes.some(result => result.status === "rejected" || result.value && result.value !== "0x")) return "unknown" as const;
  return "not-detected" as const;
}
