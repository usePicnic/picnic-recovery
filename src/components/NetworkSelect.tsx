import { useEffect, useRef, useState } from "react";
import { chains, chainById } from "../catalog/chains";
import { ChainLogo } from "./ChainLogo";

export function NetworkSelect({ value, onChange, disabled, label, ids }: {
  value: number; onChange: (id: number) => void; disabled?: boolean; label: string; ids?: number[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const options = chains.filter(chain => !ids || ids.includes(chain.id));
  useEffect(() => {
    if (!open || disabled) return;
    root.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')?.focus();
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, disabled]);
  return <div className="network-picker" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}>
    <span className="picker-label">{label}</span>
    <button className="network-trigger" type="button" ref={trigger} disabled={disabled} aria-label={`${label}: ${chainById(value).name}`} aria-haspopup="listbox" aria-expanded={open && !disabled}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>
      <ChainLogo id={value} size={24} /><span>{chainById(value).name}</span><span className="picker-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && !disabled && <div className="network-options" role="listbox" aria-label={label}>
      {options.map((chain, index) => <button key={chain.id} type="button" role="option" aria-selected={chain.id === value} tabIndex={-1}
        onClick={() => { onChange(chain.id); setOpen(false); trigger.current?.focus(); }}
        onKeyDown={event => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
          root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
        }}><ChainLogo id={chain.id} size={22} /><span>{chain.name}</span>{chain.id === value && <span className="picker-check" aria-hidden="true">✓</span>}</button>)}
    </div>}
  </div>;
}
