import { decodeFunctionData, toFunctionSelector, type Abi } from "viem";
import { aaveAbi, delayAbi, erc20Abi, recoveryAbi, safeAbi, vaultAbi } from "../core/abi";
import { brlaAbi, coveredAbi, staderAbi, stakingAbi } from "../core/investments";
import { strategyAbi } from "../core/mamo";
import { basketAbi } from "../core/legacy";
import type { Call } from "../core/types";
const abi: Abi = [...erc20Abi, ...safeAbi, ...recoveryAbi, ...delayAbi, ...vaultAbi, ...aaveAbi, ...brlaAbi, ...coveredAbi, ...staderAbi, ...stakingAbi, ...strategyAbi, ...basketAbi];
export function CallDetails({ call }: { call: Call }) {
  if (call.data === "0x") return <p className="mono">Native transfer → {call.to} · {call.value.toString()} wei</p>;
  try {
    const decoded = decodeFunctionData({ abi, data: call.data });
    const fn = abi.find(item => item.type === "function" && toFunctionSelector(item) === call.data.slice(0, 10));
    return <div className="decoded-call"><strong>{decoded.functionName}</strong><dl>
      {(decoded.args ?? []).map((arg, i) => <div key={i}><dt>{fn?.type === "function" ? fn.inputs[i]?.name || `Argument ${i}` : `Argument ${i}`}</dt>
        <dd className="mono small">{JSON.stringify(arg, (_, v) => typeof v === "bigint" ? v.toString() : v)}</dd></div>)}
    </dl>{decoded.functionName === "execTransactionFromModule" && <CallDetails call={{ to: decoded.args![0] as Call["to"], value: decoded.args![1] as bigint, data: decoded.args![2] as Call["data"] }} />}</div>;
  } catch { return <p className="note">Unknown call. Do not sign unless you have independently decoded and verified it.</p>; }
}
