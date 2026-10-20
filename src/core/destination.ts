import type { Address } from "viem";
import { address, same } from "./client";

// Migration UI policy: keep the connected signing wallet separate from the
// receiving wallet. This is distinct from Candide's guardian/new-owner rule.
export function destinationError(destination: string, source: string, wallet?: Address) {
  if (!destination.trim()) return "missing" as const;
  try {
    const recipient = address(destination);
    if (wallet && same(recipient, wallet)) return "connected" as const;
    if (same(recipient, source)) return "source" as const;
  } catch { return "invalid" as const; }
}

export function assertSeparateRecipient(recipient: string, wallet?: Address) {
  if (wallet && same(address(recipient), wallet)) throw new Error("Use a destination wallet different from the connected signing wallet");
}
