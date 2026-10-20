import type { Address } from "viem";
import { same } from "../core/client";
import type { NetworkDiagnosis } from "../core/diagnosis";
import { WalletButton } from "./WalletProvider";
import { ChainLogo } from "./ChainLogo";

type Props = {
  account: string; wallet?: Address; picnicAccount?: Address; identifying?: boolean;
  results: NetworkDiagnosis[]; busy: boolean; lang: "pt" | "en";
};
function AccountIcon({ kind }: { kind: "wallet" | "safe" | "card" }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    {kind === "wallet" ? <><path d="M4 6V5a2 2 0 0 1 2-2h12v4M4 7h16v14H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" /><path d="M20 12h-6v5h6M16 14.5h1" /></>
      : kind === "safe" ? <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="12" cy="12" r="4" /><path d="M12 6v3m0 6v3m-6-6h3m6 0h3" /></>
      : <><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M2 10h20M6 15h4" /></>}
  </svg>;
}
export function LinkedAccounts({ account, wallet, picnicAccount, identifying, results, busy, lang }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const cards = [...new Map(results.flatMap(result => (result.linkedCards ?? []).filter(card => card.cards.some(delay =>
    delay.delayVersion === "v5" && delay.controllers.some(controller => same(controller, result.account))))
    .map(card => [card.account.toLowerCase(), card] as const))).values()];
  const separate = account && (!wallet || !same(account, wallet));
  const isPicnic = !!picnicAccount && same(account, picnicAccount);
  const snapshot = results.find(result => same(result.account, account) && result.snapshot?.version !== "EOA" && result.snapshot)?.snapshot;
  const isCard = results.some(result => same(result.account, account) && result.cards.some(delay => delay.delayVersion === "v5"));
  return <section className="linked-accounts" aria-label={t("Contas vinculadas", "Linked accounts")}>
    <div className="linked-account signer-account">
      <span className="account-icon"><AccountIcon kind="wallet" /></span>
      <div className="linked-account-info">
        <div className="linked-account-title"><strong>{wallet ? t("Carteira que assina", "Signing wallet") : t("Conecte sua carteira", "Connect your wallet")}</strong>{wallet && <span className="account-role">Signer</span>}</div>
        {wallet && <p className="mono account-address">{wallet}</p>}
        <p className="small muted">{wallet ? t("Autoriza as operações das suas contas.", "Authorizes operations for your accounts.")
          : t("Vamos identificar suas contas e consultar todas as redes. Nenhuma assinatura é pedida nesta etapa.", "We will identify your accounts and check every network. No signature is requested at this step.")}</p>
      </div>
      <WalletButton busy={busy} lang={lang} primary={!wallet} />
    </div>
    {identifying && <div className="linked-account identifying-account" role="status"><span className="scan-spinner" aria-hidden="true" />{t("Identificando sua Picnic Safe…", "Finding your Picnic Safe…")}</div>}
    {separate && <div className="linked-account" data-account-kind={isPicnic ? "picnic-safe" : isCard ? "card-safe" : "inspected"}>
      <span className="account-icon"><AccountIcon kind={isCard ? "card" : "safe"} /></span>
      <div className="linked-account-info">
        <div className="linked-account-title"><strong>{isPicnic ? "Picnic Safe" : isCard ? t("Safe do cartão", "Card Safe") : snapshot ? t("Safe em consulta", "Safe being inspected") : t("Conta em consulta", "Account being inspected")}</strong>
          {isPicnic && <span className="account-role verified">{t("Identificada", "Identified")}</span>}</div>
        <p className="mono account-address">{account}</p>
        <p className="small muted">{isPicnic ? t("Guarda seus ativos. A carteira acima é uma proprietária verificada desta Safe.", "Holds your assets. The wallet above is a verified owner of this Safe.")
          : t("Conta selecionada para consultar os ativos e verificar o acesso.", "Selected account for asset and access checks.")}</p>
      </div>
    </div>}
    {cards.filter(card => !same(card.account, account)).map(card => <div className="linked-account" data-account-kind="card-safe" key={card.account}>
      <span className="account-icon"><AccountIcon kind="card" /></span>
      <div className="linked-account-info">
        <div className="linked-account-title"><strong>{t("Safe do cartão", "Card Safe")}</strong><span className="network-cell small"><ChainLogo id={100} size={16} />Gnosis</span></div>
        <p className="mono account-address">{card.account}</p>
        <p className="small muted">{isPicnic ? t("Guarda o saldo do cartão. Controlada pela Picnic Safe acima.", "Holds the card balance. Controlled by the Picnic Safe above.")
          : t("Guarda o saldo do cartão. Controlada pela conta em consulta.", "Holds the card balance. Controlled by the inspected account.")}</p>
      </div>
    </div>)}
  </section>;
}
