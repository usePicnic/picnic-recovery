import type { EIP1193Provider } from "viem";
// Development-only fixture, reachable only with Vite dev + ?demo=1 on loopback.
// The production build removes the guarded dynamic import in App.tsx.
export const demoProvider: EIP1193Provider = {
  request: async ({ method, params }: { method: string; params?: unknown }) => {
    const request = async (method: string, params: unknown = []) => {
      const response = await fetch("http://127.0.0.1:18547", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    };
    if (!String(await request("web3_clientVersion")).toLowerCase().includes("anvil")) throw new Error("Demo requires local Anvil");
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [(await request("eth_accounts"))[0]];
    return request(method, params);
  }, on: () => {}, removeListener: () => {},
} as EIP1193Provider;
