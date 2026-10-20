import { ChainIcon } from "connectkit";

// Network marks are bundled: ConnectKit ships inline SVGs for the major chains.
// It has none for HyperEVM (its ID 999 is an old Zora testnet) or Robinhood
// Chain, so those use local monograms. No logo is fetched at runtime.
const monograms: Record<number, { label: string; background: string; color: string }> = {
  999: { label: "H", background: "#0f3933", color: "#97fce4" },
  4663: { label: "R", background: "#1e342d", color: "#ccff00" },
};
export function ChainLogo({ id, size = 22 }: { id: number; size?: number }) {
  const mark = monograms[id];
  if (mark) return <svg className="chain-logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill={mark.background} />
    <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="700" fontFamily="Arial, sans-serif" fill={mark.color}>{mark.label}</text>
  </svg>;
  return <span className="chain-logo" aria-hidden="true"><ChainIcon id={id} size={size} unsupported={false} /></span>;
}
