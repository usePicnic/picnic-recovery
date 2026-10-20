import { useState, type FormEvent } from "react";

export function CardAssetForm({ lang, disabled, add }: { lang: "pt" | "en"; disabled: boolean; add: (value: string) => Promise<void> }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [value, setValue] = useState(""), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try { await add(value); setValue(""); setMessage(t("Cartão verificado. Os saldos estão sendo adicionados à lista.", "Card verified. Its balances are being added to the list.")); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <details className="panel compact custom-token-editor"><summary>{t("Não encontrou o saldo do cartão?", "Missing your card balance?")}</summary>
    <p className="small muted">{t("Informe a Safe do cartão na Gnosis. O vínculo com a conta consultada será verificado, e cada saldo aparecerá na lista de ativos.", "Enter the card Safe on Gnosis. Its link to the inspected account will be verified, and each balance will appear in the asset list.")}</p>
    <form onSubmit={submit}><label className="field"><span>{t("Endereço da Safe do cartão", "Card Safe address")}</span><input disabled={disabled || busy} value={value} onChange={e => setValue(e.target.value)} placeholder="0x…" /></label>
      <button type="submit" disabled={disabled || busy || !value.trim()}>{busy ? t("Verificando cartão…", "Checking card…") : t("Adicionar saldos à lista", "Add balances to the list")}</button>
      {message && <p className="small" role="status">{message}</p>}
    </form>
  </details>;
}
