// Keep wallet/RPC diagnostics readable; viem's full message can include pages
// of transaction calldata. Rejection is an ordinary user action, not a failure.
export function displayError(error: unknown, lang: "pt" | "en") {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as { code?: number; name?: string; cause?: unknown };
    if (value.code === 4001 || value.name === "UserRejectedRequestError") return lang === "pt"
      ? "Você recusou a solicitação na carteira. Pode tentar novamente quando quiser."
      : "You declined the wallet request. You can try again when ready.";
    current = value.cause;
  }
  if (error && typeof error === "object" && "shortMessage" in error && typeof error.shortMessage === "string") return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
