// Public-RPC forks only. No production keys, accounts or transactions are used.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, type Address, type Hex, type EIP1193Provider, type Chain } from "viem";
import { gnosis, polygon, base } from "viem/chains";
import proxyArtifact from "../fixtures/SafeProxy.json";
import { erc20Abi } from "../../src/core/abi";
import { inspectAccount } from "../../src/core/inspect";
import { sendAction, safeAction } from "../../src/core/actions";
import { redeemPosition, inspectPosition, settleCovered, claimCovered, claimStader, recoverCoveredDeposit, staderAbi } from "../../src/core/investments";
import { products } from "../../src/catalog/products";

for (const [chain, rpc, port, ids] of [
  [gnosis, "https://rpc.gnosischain.com", 28545, ["sdai", "aave-eure", "covered-sdai"]],
  [polygon, "https://polygon-bor-rpc.publicnode.com", 28546, ["stbrla", "aave-usdc", "maticx"]],
  [base, "https://base-rpc.publicnode.com", 28548, ["mw-cbbtc", "mamo"]],
] as const) {
  describe(`Real ${chain.name} investment exits on an isolated fork`, () => {
    const client = createPublicClient({ chain: chain as Chain, transport: http(`http://127.0.0.1:${port}`, { timeout: 90_000 }) });
    const wallet = createWalletClient({ chain, transport: http(`http://127.0.0.1:${port}`, { timeout: 90_000 }) });
    let child: ChildProcess, accounts: Address[], safe: Address;
    const zero = "0x0000000000000000000000000000000000000000" as const;
    const raw = (method: string, params: unknown[]) => client.request({ method, params } as never);
    const provider = { request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [accounts[0]];
      return client.request({ method, params } as never);
    }, on: () => {}, removeListener: () => {} } as EIP1193Provider;
    async function exec(to: Address, data: Hex, value = 0n) {
      const s = await inspectAccount(client, safe, chain.id);
      return sendAction(client, provider, safeAction(s, { to, value, data }, "Fork setup"), () => {});
    }
    beforeAll(async () => {
      // Pin the fork's starting block in the test output for reproducibility.
      const upstream = createPublicClient({ chain: chain as Chain, transport: http(rpc, { timeout: 30_000, retryCount: 0 }) });
      const block = await upstream.getBlockNumber();
      console.info(`Fork ${chain.id} block ${block}`);
      child = spawn("anvil", ["--port", String(port), "--fork-url", rpc, "--fork-block-number", String(block), "--chain-id", String(chain.id), "--block-time", "1", "--silent"], { stdio: "pipe" });
      for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error("Fork Anvil exited");
        try { accounts = await wallet.getAddresses(); break; } catch { await new Promise(r => setTimeout(r, 250)); }
      }
      const hash = await wallet.deployContract({ account: accounts[0], abi: proxyArtifact.abi, bytecode: proxyArtifact.bytecode as Hex,
        args: ["0x41675C099F32341bf84BFc5382aF534df5C7461a"] });
      safe = (await client.waitForTransactionReceipt({ hash })).contractAddress!;
      const abi = parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]);
      await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: safe, abi, functionName: "setup", args: [[accounts[0]], 1n, zero, "0x", zero, zero, 0n, zero] }) });
      await raw("anvil_setBalance", [safe, "0x56BC75E2D63100000"]);
    });
    afterAll(() => child?.kill("SIGTERM"));
    for (const id of ids) it(`${id}: creates a nonzero position and withdraws actual underlying`, async () => {
      const product = products.find(p => p.id === id)!;
      if (id === "maticx") {
        const reserve = product.pool!;
        await raw("anvil_impersonateAccount", [reserve]); await raw("anvil_setBalance", [reserve, "0x56BC75E2D63100000"]);
        await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: reserve, address: product.address, abi: erc20Abi, functionName: "transfer", args: [safe, 10n ** 18n] }) });
        await raw("anvil_stopImpersonatingAccount", [reserve]);
        let s = await inspectAccount(client, safe, chain.id);
        const liquidity = await client.readContract({ address: reserve, abi: staderAbi, functionName: "instantPoolMatic" });
        if (liquidity < 10n ** 18n) {
          await expect(redeemPosition(client, s, product, 10n ** 18n, safe)).rejects.toThrow(/liquidity/);
          // Replenish liquidity only on the fork to test the delayed claim mechanics.
          const poolOwner = await client.readContract({ address: reserve, abi: parseAbi(["function instantPoolOwner() view returns(address)"]), functionName: "instantPoolOwner" });
          await raw("anvil_impersonateAccount", [poolOwner]); await raw("anvil_setBalance", [poolOwner, "0x56BC75E2D63100000"]);
          await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: poolOwner, address: reserve, abi: parseAbi(["function provideInstantPoolMatic() payable"]), functionName: "provideInstantPoolMatic", value: 10n ** 19n }) });
          await raw("anvil_stopImpersonatingAccount", [poolOwner]);
          console.info("Stader: live pool lacked liquidity; claim fixture replenished on local fork only");
        }
        await sendAction(client, provider, await redeemPosition(client, s, product, 10n ** 18n, safe), () => {});
        s = await inspectAccount(client, safe, chain.id);
        await sendAction(client, provider, await redeemPosition(client, s, product, 10n ** 18n, safe), () => {});
        const position = await inspectPosition(client, safe, product);
        expect(position.requests?.length).toBe(1);
        await raw("evm_setNextBlockTimestamp", [Number(position.requests![0].withdrawalTime + 1n)]); await raw("evm_mine", []);
        s = await inspectAccount(client, safe, chain.id);
        await sendAction(client, provider, await claimStader(client, s, product, 0), () => {});
        expect((await inspectPosition(client, safe, product)).requests?.length).toBe(0);
        return;
      }
      const asset = product.asset ?? await client.readContract({ address: product.address, abi: parseAbi(["function asset() view returns(address)", "function stakingToken() view returns(address)"]), functionName: product.kind === "staking" ? "stakingToken" : "asset" });
      const decimals = await client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" });
      const amount = id === "mw-cbbtc" ? 10_000n : 10n ** BigInt(decimals);
      if (id === "sdai") {
        await exec(asset, encodeFunctionData({ abi: parseAbi(["function deposit() payable"]), functionName: "deposit" }), amount);
      } else if (id === "covered-sdai") {
        const underlying = await client.readContract({ address: asset, abi: parseAbi(["function asset() view returns(address)"]), functionName: "asset" });
        await exec(underlying, encodeFunctionData({ abi: parseAbi(["function deposit() payable"]), functionName: "deposit" }), amount * 10n);
        await exec(underlying, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [asset, amount * 10n] }));
        await exec(asset, encodeFunctionData({ abi: parseAbi(["function deposit(uint256 assets,address receiver) returns(uint256)"]), functionName: "deposit", args: [amount * 10n, safe] }));
      } else {
        // Impersonation is strictly on the local fork; transfer one token from its reserve,
        // then deposit it back through the real protocol to create the fixture position.
        const reserve = id === "mw-cbbtc"
          ? await client.readContract({ address: product.address, abi: parseAbi(["function MORPHO() view returns(address)"]), functionName: "MORPHO" })
          : product.address;
        await raw("anvil_impersonateAccount", [reserve]);
        await raw("anvil_setBalance", [reserve, "0x56BC75E2D63100000"]);
        await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: reserve, address: asset, abi: erc20Abi, functionName: "transfer", args: [safe, amount] }) });
        await raw("anvil_stopImpersonatingAccount", [reserve]);
      }
      const target = product.kind === "aave" ? product.pool! : product.address;
      await exec(asset, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [target, amount] }));
      if (id === "covered-sdai") {
        // Create/cancel an actual pending deposit, without a keeper or hosted API.
        await exec(target, encodeFunctionData({ abi: parseAbi(["function requestDeposit(uint256 assets,address controller,address owner) returns(uint256)"]), functionName: "requestDeposit", args: [amount, safe, safe] }));
        await sendAction(client, provider, await recoverCoveredDeposit(client, await inspectAccount(client, safe, chain.id), product, true), () => {});
        expect((await inspectPosition(client, safe, product)).pendingDeposit).toBe(0n);
        // Fund the redemption fixture with existing transferable shares. Impersonation
        // is confined to Anvil, and does not call or alter any production account.
        const end = await client.getBlockNumber();
        const logs = await client.getContractEvents({ address: product.address, abi: erc20Abi, eventName: "Transfer", fromBlock: end - 200_000n, toBlock: end, strict: true });
        let holder: Address | undefined;
        for (const candidate of [...new Set(logs.slice().reverse().map(l => l.args.to))].slice(0, 50)) {
          if (candidate === zero || candidate.toLowerCase() === product.address.toLowerCase()) continue;
          if (await client.readContract({ address: product.address, abi: erc20Abi, functionName: "balanceOf", args: [candidate] }) >= amount) { holder = candidate; break; }
        }
        if (!holder) throw new Error("No live share holder found for the local redemption fixture");
        await raw("anvil_impersonateAccount", [holder]); await raw("anvil_setBalance", [holder, "0x56BC75E2D63100000"]);
        await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: holder, address: product.address, abi: erc20Abi, functionName: "transfer", args: [safe, amount] }) });
        await raw("anvil_stopImpersonatingAccount", [holder]);
      }
      const data = product.kind === "aave" ? encodeFunctionData({ abi: parseAbi(["function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)"]), functionName: "supply", args: [asset, amount, safe, 0] })
        : product.kind === "staking" ? encodeFunctionData({ abi: parseAbi(["function stake(uint256 amount)"]), functionName: "stake", args: [amount] })
        : product.kind === "stbrla" ? encodeFunctionData({ abi: parseAbi(["function stake(address to,uint256 amount)"]), functionName: "stake", args: [safe, amount] })
        : encodeFunctionData({ abi: parseAbi(["function deposit(uint256 assets,address receiver) returns(uint256)"]), functionName: "deposit", args: [amount, safe] });
      if (id !== "covered-sdai") await exec(target, data);
      const shares = await client.readContract({ address: product.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
      expect(shares).toBeGreaterThan(0n);
      const s = await inspectAccount(client, safe, chain.id);
      await sendAction(client, provider, await redeemPosition(client, s, product, (await inspectPosition(client, safe, product)).available ?? shares, accounts[1]), () => {});
      if (id === "covered-sdai") {
        const waiting = await inspectPosition(client, safe, product); expect(waiting.pending).toBeGreaterThan(0n);
        await raw("evm_increaseTime", [86401]); await raw("evm_mine", []);
        let fresh = await inspectAccount(client, safe, chain.id);
        await sendAction(client, provider, await settleCovered(client, fresh, product, waiting.requestId!), () => {});
        fresh = await inspectAccount(client, safe, chain.id);
        await sendAction(client, provider, await claimCovered(client, fresh, product), () => {});
        expect((await inspectPosition(client, safe, product)).claimable).toBe(0n);
      } else expect(await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [product.kind === "staking" ? safe : accounts[1]] })).toBeGreaterThan(0n);
    });
  });
}
