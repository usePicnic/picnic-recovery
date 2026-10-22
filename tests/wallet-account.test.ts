import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EIP1193Provider } from "viem";
import { sendAction } from "../src/core/actions";
import type { Address, PublicClient } from "viem";
import { walletAccounts, watchWalletAccount } from "../src/core/walletAccount";
const old = "0xd80bC19C9dE96D92c9D56f3C280D235fC265eA62";
const next = "0xC1AF341E03625EeB5188da3ee8e39eC73c12cB58";
function fixture() {
 const listeners = new Map<string, Set<(data: unknown) => void>>();
 const request = vi.fn(async () => [old]);
 const provider = { request, on: (event: string, callback: (data: unknown) => void) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(callback); },
 removeListener: (event: string, callback: (data: unknown) => void) => listeners.get(event)?.delete(callback) } as unknown as EIP1193Provider;
 return { provider, request, listeners, emit: (event: string, data: unknown) => listeners.get(event)?.forEach(fn => fn(data)) };
}
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
describe("active account from the selected wallet provider", () => {
 it("reads authorized accounts without a new connection prompt and repairs missed events", async () => {
  const f = fixture(), update = vi.fn(), watcher = watchWalletAccount(f.provider, update);
  await watcher.refresh(); expect(update).toHaveBeenLastCalledWith({ status: "ready", accounts: walletAccounts([old]) });
  f.request.mockResolvedValue([next]); await watcher.refresh();
  expect(update).toHaveBeenLastCalledWith({ status: "ready", accounts: walletAccounts([next]) });
  expect(f.request).toHaveBeenCalledWith({ method: "eth_accounts" }); watcher.stop();
 });
 it("changes immediately on accountsChanged and ignores a stale pending read", async () => {
  const f = fixture(), update = vi.fn(); let resolve!: (value: string[]) => void;
  f.request.mockImplementation(() => new Promise(r => { resolve = r; }));
  const watcher = watchWalletAccount(f.provider, update), first = watcher.refresh();
  expect(watcher.refresh()).toBe(first); await Promise.resolve(); expect(f.request).toHaveBeenCalledTimes(1);
  f.emit("accountsChanged", [next]); resolve([old]); await first;
  expect(update).toHaveBeenCalledTimes(1); expect(update).toHaveBeenLastCalledWith({ status: "ready", accounts: walletAccounts([next]) }); watcher.stop();
 });
 it("invalidates signing identity on disconnect, empty accounts or failed reads", async () => {
  const f = fixture(), update = vi.fn(), watcher = watchWalletAccount(f.provider, update);
  await watcher.refresh(); f.emit("disconnect", {});
  expect(update).toHaveBeenLastCalledWith({ status: "disconnected", accounts: [] });
  f.emit("accountsChanged", []); expect(update).toHaveBeenLastCalledWith({ status: "disconnected", accounts: [] });
  f.request.mockRejectedValue(new Error("offline")); await watcher.refresh(); expect(update).toHaveBeenLastCalledWith({ status: "error", accounts: [] }); watcher.stop();
 });
 it("cleans up listeners and never applies results from an old connector", async () => {
  const f = fixture(), update = vi.fn(); let resolve!: (value: string[]) => void;
  f.request.mockImplementation(() => new Promise(r => { resolve = r; }));
  const watcher = watchWalletAccount(f.provider, update), pending = watcher.refresh(); await Promise.resolve(); watcher.stop(); resolve([old]); await pending;
  expect(update).not.toHaveBeenCalled(); expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
 });
 it("recovers after a provider throws synchronously", async () => {
  const f = fixture(), update = vi.fn(), watcher = watchWalletAccount(f.provider, update);
  f.request.mockImplementationOnce(() => { throw new Error("locked"); }); await watcher.refresh();
  expect(update).toHaveBeenLastCalledWith({ status: "error", accounts: [] });
  f.request.mockResolvedValue([next]); await watcher.refresh();
  expect(update).toHaveBeenLastCalledWith({ status: "ready", accounts: walletAccounts([next]) }); watcher.stop();
 });
 it("expires hung wallet reads and rejects malformed account events", async () => {
  const f = fixture(), update = vi.fn(); f.request.mockImplementation(() => new Promise(() => {}));
  const watcher = watchWalletAccount(f.provider, update), pending = watcher.refresh(); await vi.advanceTimersByTimeAsync(8000); await pending;
  expect(update).toHaveBeenLastCalledWith({ status: "error", accounts: [] });
  f.emit("accountsChanged", ["garbage"]); expect(update).toHaveBeenLastCalledWith({ status: "error", accounts: [] }); watcher.stop();
 });
});

it("never sends with the previous signer after the active account changes, even if still authorized", async () => {
 let accounts = [old];
 const request = vi.fn(async ({ method }: { method: string }) => {
  if (method === "eth_accounts") return accounts;
  if (method === "eth_chainId") return "0x64";
  throw new Error(`Unexpected request ${method}`);
 });
 const reader = { getChainId: async () => 100, call: async () => { accounts = [next, old]; return {}; }, estimateGas: async () => 21000n } as unknown as PublicClient;
 await expect(sendAction(reader, { request } as unknown as EIP1193Provider, { kind: "direct", chainId: 100, account: old as Address, expectedSender: old as Address,
  call: { to: next as Address, value: 0n, data: "0x" }, label: "test" }, () => {})).rejects.toThrow(/Wallet account or network changed/);
 expect(request.mock.calls.map(c => c[0].method)).not.toContain("eth_sendTransaction");
});
