import { chains } from "../catalog/chains";
import { ChainLogo } from "./ChainLogo";

export function RecoveryLanding({ lang, start }: { lang: "pt" | "en"; start: () => void }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  return <>
    <main className="recovery-landing">
      <p className="landing-kicker">{t("Picnic Recovery · acesso independente", "Picnic Recovery · independent access")}</p>
      <h1>{[t("Encontre.", "Find."), t("Prepare.", "Prepare."), t("Retire.", "Withdraw.")].map((word, i) => <span key={i} className={i === 2 ? "lime" : ""}><sup aria-hidden="true">{i}</sup>{word}</span>)}</h1>
      <ol className="landing-journey">{[t("Diagnóstico", "Diagnosis"), t("Preparar carteiras", "Prepare wallets"), t("Mover o dinheiro", "Move funds")].map((label, i) => <li key={i}><b>{i}</b>{label}</li>)}</ol>
      <p className="landing-description">{t("Recupere seus ativos da Picnic direto na blockchain, com a sua própria carteira. Sem login e sem depender dos servidores da Picnic.", "Recover your Picnic assets directly on-chain, using your own wallet. No login and no dependency on Picnic's servers.")}</p>
      <button type="button" className="landing-start" onClick={start}>{t("Começar", "Get started")}</button>
      <p className="landing-hint">{t(`Conecte sua carteira para um diagnóstico automático das ${chains.length} redes. Nenhuma assinatura é pedida nessa consulta.`, `Connect your wallet for an automatic scan of all ${chains.length} networks. No signature is requested for the scan.`)}</p>
    </main>
    <footer className="landing-footer">
      <ul aria-label={t("Redes consultadas", "Supported networks")}>{chains.map(chain => <li key={chain.id}><ChainLogo id={chain.id} size={16} />{chain.name}</li>)}</ul>
      <div className="landing-facts"><a href="https://github.com/usePicnic/picnic-recovery" target="_blank" rel="noreferrer">{t("Código aberto", "Open source")}</a><span>{t("Executável localmente", "Runs locally")}</span><span>{t("Sem custódia de chaves", "No key custody")}</span></div>
    </footer>
  </>;
}
