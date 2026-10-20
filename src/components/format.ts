import { formatUnits } from "viem";

// Grouped whole part, at most six fraction digits; the exact value stays in the title.
export function formatAmount(value: bigint, decimals: number | undefined, lang: "pt" | "en") {
  if (decimals === undefined) return `${value.toString()} ${lang === "pt" ? "unidades brutas" : "raw units"}`;
  const [whole, fraction = ""] = formatUnits(value, decimals).split(".");
  const shown = fraction.slice(0, 6).replace(/0+$/, "");
  if (value > 0n && whole === "0" && !shown) return lang === "pt" ? "< 0,000001" : "< 0.000001";
  const grouped = BigInt(whole).toLocaleString(lang === "pt" ? "pt-BR" : "en-US");
  return shown ? `${grouped}${lang === "pt" ? "," : "."}${shown}` : grouped;
}
export const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
