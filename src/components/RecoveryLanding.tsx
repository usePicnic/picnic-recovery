import { chains } from "../catalog/chains";
import { ChainLogo } from "./ChainLogo";

export function RecoveryLanding({ lang, start }: { lang: "pt" | "en"; start: () => void }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  return <>
    <main className="recovery-landing">
      <h1 className="recovery-promise">{[t("Mesmo sem a Picnic,", "Even without Picnic,"), t("seu acesso continua.", "your access continues.")].map(word => <span key={word}>{word}</span>)}</h1>
      <p className="landing-description">{t("Recupere o acesso às suas contas e retire seus ativos direto na blockchain, com sua carteira ou guardian configurado.", "Recover access to your accounts and withdraw your assets directly on-chain, using your wallet or configured guardian.")}</p>
      <button type="button" className="landing-start" onClick={start}>{t("Começar", "Get started")}</button>
      <p className="landing-hint">{t("O diagnóstico não pede assinatura nem movimenta seus ativos.", "The scan requires no signature and does not move your assets.")}</p>
    </main>
    <footer className="landing-footer">
      <div className="landing-facts"><a href="https://github.com/usePicnic/picnic-recovery" target="_blank" rel="noreferrer">{t("Código aberto", "Open source")}</a><span>{t("Suas chaves ficam com você", "Your keys stay with you")}</span></div>
      <details className="landing-networks"><summary>{t(`${chains.length} redes compatíveis`, `${chains.length} supported networks`)}</summary>
        <ul>{chains.map(chain => <li key={chain.id}><ChainLogo id={chain.id} size={16} />{chain.name}</li>)}</ul>
      </details>
    </footer>
  </>;
}
