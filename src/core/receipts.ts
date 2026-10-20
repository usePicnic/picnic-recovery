import { decodeEventLog, type Address, type Hex, type TransactionReceipt } from "viem";
import { erc20Abi } from "./abi";
import { same } from "./client";
export type ReceiptExpectation = { safe?: Address; safeHash?: Hex; receive?: { token: Address; recipient: Address; minimum: string } };
export function verifyTokenReceipt(receipt: TransactionReceipt, effect: NonNullable<ReceiptExpectation["receive"]>) {
  let received = 0n;
  for (const log of receipt.logs) {
    if (!same(log.address, effect.token)) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics: log.topics });
      if (same(event.args.to, effect.recipient)) received += event.args.value;
      if (same(event.args.from, effect.recipient)) received -= event.args.value;
    } catch { /* unrelated event */ }
  }
  if (received < BigInt(effect.minimum)) throw new Error("Receipt does not prove the expected token receipt; inspect before retrying");
}
