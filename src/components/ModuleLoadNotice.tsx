import { useEffect, useState } from "react";

export function ModuleLoadNotice({ lang, busy }: { lang: "pt" | "en"; busy: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const onFailure = () => setFailed(true);
    // Preserve the rejection so operations cannot continue with missing code.
    window.addEventListener("vite:preloadError", onFailure);
    return () => window.removeEventListener("vite:preloadError", onFailure);
  }, []);
  if (!failed) return null;
  return <div className="message error" role="alert">
    <p>{lang === "pt" ? "Não foi possível carregar uma parte do aplicativo. Verifique sua conexão e atualize a página para carregar a versão atual." : "Part of the app could not load. Check your connection and refresh the page to load the current version."}</p>
    <button className="outline" disabled={busy} onClick={() => window.location.reload()}>{lang === "pt" ? "Atualizar página" : "Refresh page"}</button>
  </div>;
}
