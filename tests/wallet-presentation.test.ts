import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { adaptConnectKitPresentation } from "../tooling/connectkitPresentation";

const source = readFileSync(new URL("../node_modules/connectkit/build/index.es.js", import.meta.url), "utf8");
// Exercise the installed library's actual wallet-list function after adaptation,
// including its overrides/deduplication, without requesting a real wallet.
function wallets(language: string) {
  const adapted = adaptConnectKitPresentation(source);
  const body = adapted.slice(adapted.indexOf("const useWallets = () => {"), adapted.indexOf("\nconst ProfileIcon"));
  const connectors = [
    { id: "injected", name: "Injected", type: "injected", getProvider: () => "fallback" },
    { id: "walletConnect", name: "WalletConnect", type: "walletConnect" },
    { id: "io.metamask", name: "MetaMask", type: "injected", getProvider: () => "metamask" },
    { id: "io.rabby", name: "Rabby", type: "injected" },
  ];
  const run = new Function("useConnectors", "useContext", "walletConfigs", "jsx", "isCoinbaseWalletConnector", "isInjectedConnector", `${body};return useWallets();`);
  return { connectors, list: run(() => connectors, () => ({ options: { language } }), { injected: { name: "Browser Wallet", shortName: "Browser" } }, () => null, () => false, (type: string) => type === "injected") as Array<{ id: string; name: string; shortName?: string; connector: typeof connectors[number] }> };
}
describe("wallet selector presentation", () => {
  it("keeps named wallets first, QR connection next, and the Portuguese fallback last", () => {
    const { list, connectors } = wallets("pt-BR");
    expect(list.map(wallet => wallet.id)).toEqual(["io.metamask", "io.rabby", "walletConnect", "injected"]);
    expect(list.at(-1)).toMatchObject({ name: "Outra carteira", shortName: "Outra carteira", connector: connectors[0] });
    expect(list[0]).toMatchObject({ name: "MetaMask", connector: connectors[2] });
  });
  it("uses Other wallet for both desktop and mobile in English", () => {
    expect(wallets("en-US").list.at(-1)).toMatchObject({ name: "Other wallet", shortName: "Other wallet" });
  });
  it("fails visibly if a dependency update removes the expected presentation code", () => {
    expect(() => adaptConnectKitPresentation("changed upstream code")).toThrow("review the label/order adaptation");
  });
});
