import { useState } from "react";
import { formatUnits, type PublicClient } from "viem";
import { address } from "../core/client";
import { discoverBaskets, inspectBasket, withdrawBasketNative, withdrawBasketToken } from "../core/legacy";
import { legacyCatalogue, resolveLegacyAsset, legacyBalance, exitLegacyBasket, underlyingAssets, withdrawTetu, type LegacyAsset, type LegacyCatalogue } from "../core/legacy-routes";
import type { AccountSnapshot, PreparedAction } from "../core/types";

type Props = { client?: PublicClient; snapshot?: AccountSnapshot; busy: boolean; lang: "pt" | "en";
  run: (task: () => Promise<void>) => Promise<void>; review: (action: PreparedAction) => void; invalidate: () => void };
export function LegacyPanel({ client, snapshot, busy, lang, run, review, invalidate }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [nft, setNft] = useState("");
  const [wallet, setWallet] = useState("");
  const [catalogue, setCatalogue] = useState<LegacyCatalogue>();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<LegacyAsset>();
  const [balance, setBalance] = useState<bigint>();
  const [minimums, setMinimums] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [start, setStart] = useState(0n);
  const [discovery, setDiscovery] = useState("");
  const [found, setFound] = useState<bigint[]>([]);
  function context() {
    if (!client || !snapshot || snapshot.chainId !== 137) throw new Error("Inspect the owning Safe on Polygon first");
    return { client, snapshot };
  }
  const filtered = catalogue?.assets.filter(a => `${a.name} ${a.symbol} ${a.type} ${a.address}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section className="panel" onChange={invalidate}>
    <p className="eyebrow">{t("LEGADO", "LEGACY")}</p><h2>{t("Retire de uma cesta antiga.", "Withdraw from a legacy basket.")}</h2>
    <p>{t("A Safe deve ser proprietária do NFT. Retire uma camada de investimento por vez, sem converter os ativos.", "The Safe must own the NFT. Exit one investment layer at a time without converting assets.")}</p>
    <details><summary>{t("Encontrar NFTs desta Safe", "Find this Safe's NFTs")}</summary>
      <label className="field"><span>{t("ID inicial", "Starting ID")}</span><input disabled={busy} value={start.toString()} inputMode="numeric" onChange={e => { if (/^\d*$/.test(e.target.value)) setStart(BigInt(e.target.value || "0")); }} /></label>
      <button className="outline" disabled={busy || !snapshot} onClick={() => run(async () => {
        const c = context(); const result = await discoverBaskets(c.client, c.snapshot.address, start);
        setFound(result.owned); setStart(result.next);
        setDiscovery(`${result.next} / ${result.total} · ${t("IDs sem resposta (inclui NFTs queimados)", "IDs without a response (includes burned NFTs)")}: ${result.failed.join(", ") || "0"}`);
      })}>{t("Consultar próximos 200 IDs", "Inspect next 200 IDs")}</button>
      <p className="small">{discovery}</p>{found.map(id => <button key={id.toString()} className="text-button" disabled={busy} onClick={() => { setNft(id.toString()); setWallet(""); }}>{`NFT #${id}`}</button>)}
    </details>
    <label className="field"><span>NFT ID</span><input disabled={busy} value={nft} onChange={e => { setNft(e.target.value); setWallet(""); setBalance(undefined); }} inputMode="numeric" /></label>
    <button className="outline" disabled={busy || !snapshot || !nft} onClick={() => run(async () => {
      const c = context(); const basket = await inspectBasket(c.client, BigInt(nft), c.snapshot.address);
      setWallet(basket.wallet); setCatalogue(await legacyCatalogue()); setBalance(undefined);
    })}>{t("Consultar cesta e catálogo", "Inspect basket and catalogue")}</button>
    {wallet && <><p className="mono small">{wallet}</p><p className="small">{catalogue?.assets.length} {t("itens no catálogo histórico", "historical catalogue entries")}</p>
      <label className="field"><span>{t("Buscar token, protocolo ou endereço", "Find token, protocol or address")}</span><input disabled={busy} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="field"><span>{t("Posição (primeiros 100 resultados; refine a busca)", "Position (first 100 results; refine your search)")}</span><select disabled={busy} value={selected?._id ?? ""} onChange={e => { setSelected(catalogue?.assets.find(a => a._id === e.target.value)); setBalance(undefined); setMinimums(""); }}>
        <option value="">{t("Selecione", "Select")}</option>{filtered.slice(0, 100).map(a => <option key={a._id} value={a._id}>{a.name} · {a.type} · {a.address.slice(0, 8)}</option>)}
      </select></label>
      {selected && <><p className="mono small">{selected.address}</p>
        <button className="outline" disabled={busy} onClick={() => run(async () => { const resolved = await resolveLegacyAsset(context().client, selected); setSelected(resolved); setMinimums(""); setBalance(await legacyBalance(context().client, address(wallet), resolved)); })}>{t("Consultar saldo da posição", "Inspect position balance")}</button>
        {balance !== undefined && <p>{t("Saldo (unidades brutas)", "Balance (raw units)")}: {balance.toString()}{selected.decimals !== undefined ? ` · ${formatUnits(balance, selected.decimals)}` : ""}</p>}
        <p className="small">{t("Ativos de saída", "Output assets")}: {catalogue && outputDescription(catalogue, selected)}</p>
        <label className="field"><span>{t("Mínimos de saída para pools, separados por vírgula (unidades brutas; Gamma: 4 limites)", "Pool minimum outputs, comma separated (raw units; Gamma: 4 limits)")}</span><input disabled={busy} value={minimums} onChange={e => setMinimums(e.target.value)} placeholder="1000000,1000000000000000" /></label>
        <div className="row"><button disabled={busy || balance === undefined || balance <= 0n} onClick={() => run(async () => {
          const c = context(); review(await exitLegacyBasket(c.client, c.snapshot, BigInt(nft), selected, minimums.trim() ? minimums.split(",").map(s => BigInt(s.trim())) : []));
        })}>{t("Revisar saída do protocolo", "Review protocol exit")}</button>
        <button className="outline" disabled={busy} onClick={() => run(async () => {
          const c = context(); review(selected.type === "networkToken" ? await withdrawBasketNative(c.client, c.snapshot, BigInt(nft)) : await withdrawBasketToken(c.client, c.snapshot, BigInt(nft), selected.address));
        })}>{t("Retirar apenas token/recibo", "Withdraw token/receipt only")}</button></div>
        {selected.type === "ITetuDeposit" && <button className="text-button" disabled={busy} onClick={() => run(async () => {
          const c = context(); const shares = await legacyBalance(c.client, c.snapshot.address, selected);
          review(await withdrawTetu(c.client, c.snapshot, selected, shares));
        })}>{t("Após retirar o recibo: resgatar Tetu na Safe", "After withdrawing receipt: redeem Tetu from Safe")}</button>}
      </>}
      <details><summary>{t("Retirar token por endereço", "Withdraw token by address")}</summary>
        <label className="field"><span>ERC-20</span><input disabled={busy} value={manualToken} onChange={e => setManualToken(e.target.value)} placeholder="0x…" /></label>
        <button disabled={busy || !manualToken} onClick={() => run(async () => { const c = context(); review(await withdrawBasketToken(c.client, c.snapshot, BigInt(nft), manualToken)); })}>{t("Revisar retirada", "Review withdrawal")}</button>
      </details>
    </>}
  </section>;
}

function outputDescription(catalogue: LegacyCatalogue, asset: LegacyAsset) {
  try { return underlyingAssets(catalogue, asset).map(a => `${a.symbol || a.name} (${a.address})`).join("; "); }
  catch { return "Inspect position to resolve missing historical metadata on-chain."; }
}
