import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { App } from "../src/App";

const state = vi.hoisted(() => ({ wallet: undefined as string | undefined, resolved: undefined as string | undefined, inspected: "" }));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: state.wallet }) }));
vi.mock("connectkit", () => ({ ConnectKitProvider: ({ children }: { children: unknown }) => children }));
vi.mock("../src/components/ChainLogo", () => ({ ChainLogo: () => null }));
vi.mock("../src/components/WalletProvider", () => ({ WalletButton: () => null }));
vi.mock("../src/components/useConnectedAccount", () => ({ useConnectedAccount: () => state.resolved ? { status: "ready", account: state.resolved } : { status: "loading" } }));
vi.mock("../src/components/useDiagnosis", async () => ({
  ...await vi.importActual("../src/components/useDiagnosis"),
  useDiagnosis: (account: string) => { state.inspected = account; return { account, results: [], customTokens: [] }; },
}));
vi.mock("../src/components/useBasketContents", () => ({ useBasketContents: () => ({ contents: {} }) }));
vi.mock("../src/core/progress", async () => ({ ...await vi.importActual("../src/core/progress"), readProgress: () => ({ version: 1, accounts: [{ chainId: 100, address: "0x1111111111111111111111111111111111111111" }], transactions: [] }) }));

it("only diagnoses the live signer or its discovered Safe, never a saved or disconnected account", () => {
  const render = () => renderToStaticMarkup(createElement(App));
  state.wallet = undefined; state.resolved = undefined;
  render(); expect(state.inspected).toBe("");
  state.wallet = "0x2222222222222222222222222222222222222222";
  render(); expect(state.inspected).toBe(state.wallet);
  state.resolved = "0x3333333333333333333333333333333333333333";
  render(); expect(state.inspected).toBe(state.resolved);
  state.wallet = "0x4444444444444444444444444444444444444444"; state.resolved = undefined;
  render(); expect(state.inspected).toBe(state.wallet);
  state.wallet = undefined;
  render(); expect(state.inspected).toBe("");
});
