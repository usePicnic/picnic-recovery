import { ChainIcon } from "connectkit";

// Network marks are bundled: ConnectKit ships inline SVGs for the major chains.
// It has none for HyperEVM (its ID 999 is an old Zora testnet) or Robinhood
// Chain, so those use local monograms. ConnectKit's Ethereum mark is flat white
// on charcoal and loses its facets at small sizes, so Ethereum uses the standard
// faceted diamond. No logo is fetched at runtime.
const monograms: Record<number, { label: string; background: string; color: string }> = {
  999: { label: "H", background: "#0f3933", color: "#97fce4" },
  4663: { label: "R", background: "#1e342d", color: "#ccff00" },
};
function EthereumMark({ size }: { size: number }) {
  return <svg className="chain-logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="16" fill="#627EEA" />
    <g fill="#FFFFFF">
      <path d="M16 4v8.87l7.5 3.35z" fillOpacity=".6" />
      <path d="M16 4 8.5 16.22 16 12.87z" />
      <path d="M16 21.97V28l7.5-10.38z" fillOpacity=".6" />
      <path d="M16 28v-6.03l-7.5-4.35z" />
      <path d="m16 20.57 7.5-4.35-7.5-3.35z" fillOpacity=".2" />
      <path d="m8.5 16.22 7.5 4.35v-7.7z" fillOpacity=".6" />
    </g>
  </svg>;
}
export function ChainLogo({ id, size = 22 }: { id: number; size?: number }) {
  if (id === 1) return <EthereumMark size={size} />;
  const mark = monograms[id];
  if (mark) return <svg className="chain-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill={mark.background} />
    <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="700" fontFamily="Arial, sans-serif" fill={mark.color}>{mark.label}</text>
  </svg>;
  return <span className="chain-logo" aria-hidden="true"><ChainIcon id={id} size={size} unsupported={false} /></span>;
}
