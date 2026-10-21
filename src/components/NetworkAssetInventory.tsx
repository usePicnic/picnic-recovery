import type { MigrationItem } from "./migration";
import { BasketContentsView } from "./BasketContents";
import { formatAmount } from "./format";
import "./NetworkAssetInventory.css";

type Lang = "pt" | "en";

// Uses diagnosis' existing inventory and content cache; opening a network never
// starts another scan. Retry remains an explicit action for incomplete baskets.
export function NetworkAssetInventory({ id, name, items, expanded, lang, retry }: {
  id: string; name: string; items: MigrationItem[]; expanded: boolean; lang: Lang; retry: (id: bigint) => void;
}) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const hasBaskets = items.some(item => item.basketId !== undefined);
  return <div id={id} className="network-inventory" hidden={!expanded}>
    {expanded && <table className="network-inventory-table" aria-label={t(`Ativos em ${name}`, `Assets on ${name}`)}>
      <thead><tr><th scope="col">{t("Ativo", "Asset")}</th><th scope="col" className="numeric">{t("Saldo", "Balance")}</th>
        {hasBaskets && <th scope="col">{t("Conteúdo da cesta", "Basket contents")}</th>}</tr></thead>
      <tbody>{items.map(item => <tr key={item.id}>
        <th scope="row"><span className="token-text"><strong>{item.kind === "baskets" ? item.basketId !== undefined ? `${t("Cesta", "Basket")} #${item.basketId}` : t("Cestas a identificar", "Baskets to identify") : item.symbol || item.name}</strong>
          {item.kind !== "baskets" && item.name !== item.symbol && <small>{item.name}</small>}</span></th>
        <td className="numeric">{item.amount ? formatAmount(item.amount.value, item.amount.decimals, lang) : item.count ?? (item.pending ? t("Pendente", "Pending") : "—")}</td>
        {hasBaskets && <td>{item.basketId !== undefined ? <BasketContentsView compact contents={item.contents} lang={lang} retry={() => retry(item.basketId!)} /> : "—"}</td>}
      </tr>)}</tbody>
    </table>}
  </div>;
}
