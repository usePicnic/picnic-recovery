import { useState } from "react";
import { formatUnits, type Address, type Chain, type PublicClient } from "viem";
import { assertChain, same } from "../core/client";
import type { AccountSnapshot } from "../core/types";

type Props = {
  client?: PublicClient; chain: Chain; snapshot?: AccountSnapshot; wallet?: Address;
  lang: "pt" | "en"; busy: boolean; destination: string;
  setDestination: (value: string) => void;
  run: (task: () => Promise<void>) => Promise<void>; next: () => void; connect: () => void;
};
export function PrepareWallet({ client, chain, snapshot, wallet, lang, busy, destination, setDestination, run, next, connect }: Props) {
  const t = (pt: string, en: string) => lang === "pt" ? pt : en;
  const [balance, setBalance] = useState<bigint>();
  const [checkedBlock, setCheckedBlock] = useState<bigint>();
  const isOwner = !!wallet && !!snapshot?.owners.some(owner => same(owner, wallet));
  return <section className="panel">
    <p className="eyebrow">{t("PASSO 1 / PREPARAR CARTEIRAS", "STEP 1 / PREPARE WALLETS")}</p>
    <h2>{t("Uma carteira para assinar. Saldo para as taxas.", "A wallet to sign. Funds for fees.")}</h2>
    <p>{t("A carteira que controla sua conta enviará as transações e pagará o gás nesta rede. Confira o saldo para taxas e escolha o destino dos ativos.", "The wallet controlling your account will send transactions and pay gas on this network. Check its fee balance and choose the asset destination.")}</p>
    {!wallet && <p className="note">{t("Nenhuma carteira conectada. A conexão é feita no passo 0.", "No wallet connected. Connect it in step 0.")} <button className="text-button" disabled={busy} onClick={connect}>{t("Ir para a conexão →", "Go to connection →")}</button></p>}
    {wallet && <div className="funding-card">
      <h3>{t("Abasteça este endereço", "Fund this address")}</h3>
      <p className="mono">{wallet}</p>
      <button className="text-button" disabled={busy} onClick={() => run(() => navigator.clipboard.writeText(wallet))}>{t("Copiar endereço", "Copy address")}</button>
      <p><strong>{chain.nativeCurrency.symbol}</strong> · {t("Rede", "Network")}: <strong>{chain.name}</strong></p>
      <p className="small">{t("Envie a moeda nativa nesta mesma rede. USDC, outros tokens e saldo em outra rede não pagam estas taxas. Para executar pela Safe, o gás fica na carteira conectada; não precisa abastecer a Safe ou o cartão só para pagar gás.", "Send the native coin on this same network. USDC, other tokens and balances on another network do not pay these fees. For Safe execution, gas belongs in the connected wallet; you do not need to fund the Safe or card just for gas.")}</p>
      <button className="outline" disabled={busy || !client} onClick={() => run(async () => {
        if (!client) return;
        setBalance(undefined); setCheckedBlock(undefined);
        await assertChain(client, chain.id);
        const block = await client.getBlockNumber();
        const amount = await client.getBalance({ address: wallet, blockNumber: block });
        setBalance(amount); setCheckedBlock(block);
      })}>{t("Conferir saldo para taxas", "Check fee balance")}</button>
      {balance !== undefined && <p role="status" className={balance === 0n ? "note" : "small"}>
        {t("Saldo para taxas", "Fee balance")}: <strong>{formatUnits(balance, chain.nativeCurrency.decimals)} {chain.nativeCurrency.symbol}</strong>
        {balance === 0n ? t(" — abasteça a carteira antes de enviar.", " — fund the wallet before sending.") : t(" — o custo de cada operação será conferido antes do envio. Este saldo não garante todas as retiradas.", " — each operation's cost is checked before sending. This balance does not guarantee all withdrawals.")}
        <br /><span className="muted small">{t("Consultado no bloco", "Checked at block")} {checkedBlock?.toString()}</span>
      </p>}
    </div>}
    <p className={isOwner ? "small" : "note"}>{isOwner
      ? t("Esta carteira está entre os owners da conta consultada. Se houver mais assinaturas necessárias, os outros owners também precisam aprovar.", "This wallet is an owner of the inspected account. If more signatures are required, the other owners must also approve.")
      : snapshot?.passkey === "detected"
        ? t("Conecte uma carteira owner. Se você está usando o guardian, conclua a recuperação no diagnóstico e depois conecte a nova carteira owner.", "Connect an owner wallet. If using a guardian, finish recovery in diagnosis and then connect the new owner wallet.")
        : t("A carteira conectada precisa controlar esta conta. Volte ao diagnóstico para conectar a carteira owner.", "The connected wallet must control this account. Return to diagnosis to connect the owner wallet.")}</p>
    <label className="field"><span>{t("Destino dos ativos", "Asset destination")}</span><input disabled={busy} value={destination} onChange={e => setDestination(e.target.value)} placeholder="0x…" /></label>
    {wallet && <button className="text-button" disabled={busy || same(wallet, snapshot?.address ?? "")} onClick={() => setDestination(wallet)}>{t("Usar minha carteira conectada como destino", "Use my connected wallet as destination")}</button>}
    <p className="small muted">{t("Você confere o destino em cada retirada. Em uma conta antiga sem Safe, a própria conta paga as taxas: deixe uma reserva de gás ao retirar a moeda nativa.", "Review the destination for each withdrawal. For a legacy account without a Safe, the account itself pays fees: leave a gas reserve when withdrawing native coins.")}</p>
    <button disabled={busy || !snapshot || !isOwner || balance === undefined || balance === 0n} onClick={next}>{t("Continuar para mover o dinheiro →", "Continue to move funds →")}</button>
  </section>;
}
