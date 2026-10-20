import type { DestinationProblem } from "../core/destination";

// Inline, accessible explanation for every destination rule, shared by
// Prepare wallets, the batch review and the individual withdrawal forms.
export function DestinationMessage({ id, problem, lang }: { id: string; problem: DestinationProblem; lang: "pt" | "en" }) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const text = {
    missing: t("Informe o endereço de destino.", "Enter the destination address."),
    invalid: t("Informe um endereço válido (0x…).", "Enter a valid address (0x…)."),
    connected: t("Use outra carteira como destino. A carteira conectada é usada para assinar as operações.", "Use another wallet as the destination. The connected wallet signs the operations."),
    source: t("Este endereço é a própria conta de origem. Para migrar os ativos, informe o endereço de outra carteira.", "This address is the source account itself. To move the assets, enter another wallet's address."),
    guardian: t("Este endereço é um guardião de recuperação desta conta. Um guardião não deve receber os fundos: informe outra carteira que você controla.", "This address is a recovery guardian of this account. A guardian must not receive the funds: enter another wallet you control."),
  }[problem];
  return <p id={id} className="small table-error" role="alert">{text}</p>;
}
