import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, HttpRequestError, type Address, type PublicClient } from "viem";
import { polygon } from "viem/chains";
import { basketAbi, discoverOwnedBaskets } from "../src/core/legacy";
import { ReadPool, type ReadCheckpoint } from "../src/core/reads";

const owner = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const multicall = polygon.contracts.multicall3.address;
function fixture(owned: bigint[]) {
  let failing = false;
  const reads: bigint[][] = [];
  const client = { getChainId: vi.fn(async () => 137), readContract: vi.fn(async ({functionName, args, blockNumber}: {functionName:string;args?: unknown[];blockNumber?:bigint}) => {
    expect(blockNumber).toBe(10n);
    if(functionName === "tokenCounter") return 601n;
    const calls = args![0] as {callData:`0x${string}`}[];
    const ids = calls.map(call => decodeFunctionData({abi:basketAbi,data:call.callData}).args[0] as bigint);
    reads.push(ids);
    if(failing && ids[0] === 200n) throw new HttpRequestError({url:"x",status:503});
    return ids.map(id => id === 10n ? {success:false,returnData:"0x"} : {success:true,returnData:encodeAbiParameters([{type:"address"}],[owned.includes(id)?owner:other])});
  }) };
  const checkpoint: ReadCheckpoint = new Map();
  const pool = () => new ReadPool(polygon, [{url:"http://localhost:8545",client:client as unknown as PublicClient}],new AbortController().signal,0,undefined,checkpoint);
  return {client,reads,pool,fail:(value:boolean)=>{failing=value;}};
}
describe("complete basket ownership discovery", () => {
  it("finds owned IDs beyond 200 and checks all reads at the count's block",async()=>{
    const f=fixture([5n,250n,600n]);
    const found=await discoverOwnedBaskets(f.pool(),owner,3n,10n,multicall);
    expect(found.complete).toBe(true); expect(found.owned).toEqual([5n,250n,600n]);
    expect(f.reads.map(ids=>ids[0])).toEqual([0n,200n,400n,600n]);
  });
  it("retains partial ownership and resumes only missing chunks",async()=>{
    const f=fixture([5n,250n,600n]); f.fail(true);
    const partial=await discoverOwnedBaskets(f.pool(),owner,3n,10n,multicall);
    expect(partial.complete).toBe(false); expect(partial.owned).toEqual([5n]);
    const before=f.reads.length; f.fail(false);
    const complete=await discoverOwnedBaskets(f.pool(),owner,3n,10n,multicall);
    expect(complete.complete).toBe(true); expect(complete.owned).toEqual([5n,250n,600n]);
    expect(f.reads.slice(before).map(ids=>ids[0])).toEqual([200n,400n,600n]);
    expect(f.client.readContract.mock.calls.filter(([args])=>args.functionName==='tokenCounter')).toHaveLength(1);
  });
  it("does not label a count mismatch complete or treat missing IDs as zero",async()=>{
    const f=fixture([5n]);
    expect((await discoverOwnedBaskets(f.pool(),owner,2n,10n,multicall)).complete).toBe(false);
  });
});
