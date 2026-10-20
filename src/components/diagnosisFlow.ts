import type { Address } from "viem";
import { hasAssets, nextAction, type NetworkDiagnosis, type WalletGas } from "../core/diagnosis";
import type { CustomTokenState } from "./useDiagnosis";

export function withCustomHoldings(results: NetworkDiagnosis[], custom: CustomTokenState[]) {
  return results.map(result => ({
    ...result,
    tokens: [...result.tokens, ...custom.flatMap(item => item.status === "ready" && item.token && item.chainId === result.chainId
      && item.token.account.toLowerCase() === result.account.toLowerCase() && item.token.balance > 0n ? [item.token] : [])],
  }));
}

const accessActions = new Set(["waiting", "finalize", "recover", "owner-required", "connect"]);
export function diagnosisNext(results: NetworkDiagnosis[], wallet: Address | undefined, gas: Record<number, WalletGas>, custom: CustomTokenState[]) {
  if (!results.length || results.some(r => r.status === "queued" || r.status === "scanning") || custom.some(t => t.status === "loading")) return;
  const candidates = withCustomHoldings(results, custom).filter(r => r.snapshot && nextAction(r, wallet, gas[r.chainId]) !== "unsupported");
  // Access comes before moving funds; otherwise start with a network holding assets.
  const score = (r: NetworkDiagnosis) => (accessActions.has(nextAction(r, wallet, gas[r.chainId])) ? 4 : 0) + (hasAssets(r) ? 2 : 0) + (r.snapshot?.version !== "EOA" ? 1 : 0);
  const result = candidates.sort((a, b) => score(b) - score(a))[0];
  if (result) return { result, step: (accessActions.has(nextAction(result, wallet, gas[result.chainId])) ? 1 : 2) as 1 | 2 };
}

export function needsAttention(result: NetworkDiagnosis, wallet?: Address, gas?: WalletGas) {
  if (result.status === "queued" || result.status === "scanning") return false;
  if (result.status !== "complete" || result.issues.length || result.failedTokens || result.unreadableTokens.length || result.checkedTokens < result.totalTokens) return true;
  const relevant = hasAssets(result) || result.snapshot?.version !== "EOA";
  if (!relevant) return false;
  const action = nextAction(result, wallet, gas);
  return action !== "prepare" && action !== "no-findings" || !!wallet && gas?.balance === undefined;
}
