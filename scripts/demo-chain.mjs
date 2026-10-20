// Development-only Anvil fixture. Never connects to a public network.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, concatHex, pad, encodeFunctionData } from "viem";
import { gnosis } from "viem/chains";
import solc from "solc";
const node = spawn("anvil", ["--port", "18547", "--chain-id", "100", "--block-time", "1", "--silent"], { stdio: "ignore" });
process.on("SIGTERM", () => { node.kill("SIGTERM"); process.exit(); });
process.on("SIGINT", () => { node.kill("SIGTERM"); process.exit(); });
const rpc = "http://127.0.0.1:18547";
const client = createPublicClient({ chain: gnosis, transport: http(rpc) });
const wallet = createWalletClient({ chain: gnosis, transport: http(rpc) });
const read = name => JSON.parse(readFileSync(new URL(`../tests/fixtures/${name}.json`, import.meta.url)));
let accounts;
for (let i = 0; i < 50; i++) {
  if (node.exitCode !== null) throw new Error("Cannot start owned Anvil fixture");
  try { accounts = await wallet.getAddresses(); break; } catch { await new Promise(r => setTimeout(r, 200)); }
}
const singleton = "0x41675C099F32341bf84BFc5382aF534df5C7461a", zero = "0x0000000000000000000000000000000000000000";
await client.request({ method: "anvil_setCode", params: [singleton, read("Safe").deployedBytecode] });
const proxy = read("SafeProxy");
const safe = (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: accounts[0], abi: proxy.abi, bytecode: proxy.bytecode, args: [singleton] }) })).contractAddress;
await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: safe, abi: parseAbi(["function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)"]), functionName: "setup", args: [[accounts[0]], 1n, zero, "0x", zero, zero, 0n, zero] }) });
const compile = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "TestToken.sol": { content: readFileSync(new URL("../tests/fixtures/TestToken.sol", import.meta.url), "utf8") } }, settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } } })));
const tokenArtifact = compile.contracts["TestToken.sol"].TestToken;
const token = (await client.waitForTransactionReceipt({ hash: await wallet.deployContract({ account: accounts[0], abi: tokenArtifact.abi, bytecode: `0x${tokenArtifact.evm.bytecode.object}` }) })).contractAddress;
await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ account: accounts[0], address: token, abi: tokenArtifact.abi, functionName: "mint", args: [safe, 1_000_000_000n] }) });
console.log(JSON.stringify({ rpc, chainId: 100, safe, token, owner: accounts[0], destination: accounts[1] }, null, 2));
await new Promise(resolve => node.once("exit", resolve));
