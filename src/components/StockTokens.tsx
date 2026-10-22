import { useState } from "react";
export function StockTokens({ select, busy, lang }: { select: (token: string) => void; busy: boolean; lang: "pt" | "en" }) {
  const [tokens, setTokens] = useState<{ address: string; name: string; symbol: string }[]>([]);
  const [query, setQuery] = useState("");
  return <details><summary>{lang === "pt" ? "Ações, ETFs e portfolios tokenizados (BSC)" : "Tokenized stocks, ETFs and portfolios (BSC)"}</summary>
    <p className="small">{lang === "pt" ? "Transfira o token para outra carteira na BSC. Isso não vende as ações nem converte para dólares. Restrições do emissor continuam valendo." : "Transfer the token to another BSC wallet. This does not sell shares or convert to dollars. Issuer restrictions still apply."}</p>
    {!tokens.length && <button className="outline" disabled={busy} onClick={async () => setTokens((await import("../catalog/stocks.json")).default)}>{lang === "pt" ? "Carregar catálogo local" : "Load local catalogue"}</button>}
    {!!tokens.length && <><label className="field"><span>{lang === "pt" ? "Ticker ou nome" : "Ticker or name"}</span><input value={query} onChange={e => setQuery(e.target.value)} /></label>
      <label className="field"><span>Token</span><select value="" disabled={busy} onChange={e => select(e.target.value)}><option value="">{lang === "pt" ? "Escolha para preencher o contrato" : "Choose to fill token contract"}</option>
        {tokens.filter(p => `${p.symbol} ${p.name}`.toLowerCase().includes(query.toLowerCase())).slice(0, 100).map(p => <option key={p.address} value={p.address}>{p.symbol} · {p.name}</option>)}
      </select></label><p className="small muted">{tokens.length} {lang === "pt" ? "tokens no catálogo; refine a busca para ver outros resultados." : "catalogued tokens; refine your search for more results."}</p></>}
  </details>;
}
