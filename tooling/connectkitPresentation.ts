import type { Plugin } from "vite";

// ConnectKit 1.9.2 hardcodes both the injected label and WalletConnect-last order,
// with no public presentation option. Keep this small, checked build adaptation
// until upstream exposes one. Connector IDs/providers and connection logic stay
// untouched; DOM order and keyboard order match on desktop and mobile.
export function adaptConnectKitPresentation(source: string): string {
  const labelAnchor = "        if (wallet.id === 'walletConnect') {";
  const oldOrder = `        // move walletConnect to the end
        .sort((a, b) => {
        if (a.id === 'walletConnect')
            return 1;
        if (b.id === 'walletConnect')
            return -1;
        return 0;
    })`;
  if (source.split(labelAnchor).length !== 2 || source.split(oldOrder).length !== 2) {
    throw new Error("ConnectKit wallet presentation changed; review the label/order adaptation before upgrading.");
  }
  return source.replace(labelAnchor, `        if (wallet.id === 'injected') {
            const name = context.options?.language === 'pt-BR' ? 'Outra carteira' : 'Other wallet';
            return { ...wallet, name, shortName: name };
        }
${labelAnchor}`).replace(oldOrder, `        // Named extensions, WalletConnect, then the generic browser fallback.
        .sort((a, b) => {
        const rank = (wallet) => wallet.id === 'injected' ? 2 : wallet.id === 'walletConnect' ? 1 : 0;
        return rank(a) - rank(b);
    })`);
}

export function connectKitPresentation(): Plugin {
  return {
    name: "picnic-connectkit-presentation",
    enforce: "pre",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/connectkit/build/index.es.js")) return;
      return { code: adaptConnectKitPresentation(source), map: null };
    },
  };
}
