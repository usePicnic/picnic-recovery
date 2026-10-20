import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { legacyCatalogue, legacyExitCall } from "../src/core/legacy-routes";

describe("Historical catalogue exits", () => {
  it("retains every historical item, including inactive protocols", async () => {
    const c = await legacyCatalogue();
    expect(c.assets).toHaveLength(2246);
    expect(new Set(c.assets.map(a => a.type)).size).toBe(21);
  });
  it("encodes only known exit methods and requires nonzero LP output protection", async () => {
    const c = await legacyCatalogue();
    const excluded = new Set(["token", "networkToken", "ITetuDeposit", "IJarvisRewards", "IJarvisV6Mint", "IBalancerBatchSwap", "IlliquidStable"]);
    for (const asset of c.assets.filter(a => !excluded.has(a.type))) {
      const count = asset.type === "IGammaDeposit" ? 4 : (asset.linkedAssets?.length ?? 1);
      const minima = Array.from({ length: count }, () => 1n);
      const route = legacyExitCall(c, asset, minima);
      const call = decodeFunctionData({ abi: route.contract.abi, data: route.data });
      expect(["withdraw", "unstake", "removeLiquidity"]).toContain(call.functionName);
      expect(route.tokens.length).toBeGreaterThan(0);
      if (["IBalancerLiquidity", "IUniswapV2Liquidity", "IKyberLiquidity", "ICurveLiquidity", "IGammaDeposit"].includes(asset.type)) {
        expect(() => legacyExitCall(c, asset, [])).toThrow(/minimum/);
      }
    }
  });
});
