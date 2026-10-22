// Keep wallet/RPC diagnostics readable; viem's full message can include pages
// of transaction calldata. Rejection is an ordinary user action, not a failure.
export function displayError(error: unknown, lang: "pt" | "en") {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: number; name?: string; cause?: unknown; message?: string; shortMessage?: string };
    if (value.code === 4001 || value.name === "UserRejectedRequestError") return lang === "pt"
      ? "Você recusou a solicitação na carteira. Pode tentar novamente quando quiser."
      : "You declined the wallet request. You can try again when ready.";
    if (value.code === -32002) return lang === "pt"
      ? "Já existe uma solicitação pendente na carteira. Abra a extensão para concluir ou cancelar."
      : "A request is already pending in your wallet. Open the extension to complete or cancel it.";
    if (/\bGS013\b/.test(`${value.shortMessage ?? ""} ${value.message ?? ""}`)) return lang === "pt"
      ? "A Safe recusou uma operação (GS013). Uma transferência pode estar bloqueada. Confira os ativos pendentes nesta rede."
      : "The Safe rejected an operation (GS013). A transfer may be blocked. Check the pending assets on this network.";
    current = value.cause;
  }
  if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
