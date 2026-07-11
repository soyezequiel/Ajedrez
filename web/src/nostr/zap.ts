import { makeZapRequest } from "nostr-tools/nip57";
import type { NgpSigner } from "nostr-game-protocol/ngp";
import { RELAYS } from "../config.js";
import { fetchProfile } from "./relays.js";

export interface ZapInvoice {
  /** Invoice bolt11 a pagar por el que propina, con su billetera Lightning. */
  bolt11: string;
  amountSats: number;
}

interface LnurlPayParams {
  callback: string;
  minSendable?: number;
  maxSendable?: number;
  allowsNostr?: boolean;
  nostrPubkey?: string;
}

/**
 * Genera un invoice de zap NIP-57 para propinarle `amountSats` al `recipientPubkey`.
 * Resuelve su lud16 (kind:0), pide los parámetros LNURL-pay, firma el zap request
 * kind:9734 y devuelve el bolt11. El propio jugador lo paga con su billetera —
 * nosotros nunca tocamos fondos. Lanza con mensaje claro si algo falta.
 */
export async function createZapInvoice(
  signer: NgpSigner,
  recipientPubkey: string,
  amountSats: number,
  comment: string,
): Promise<ZapInvoice> {
  const { lud16 } = await fetchProfile(recipientPubkey);
  if (!lud16) throw new Error("El rival no tiene dirección Lightning en su perfil");
  const [name, domain] = lud16.split("@");
  if (!name || !domain) throw new Error("Dirección Lightning inválida");

  const params = (await (await fetch(`https://${domain}/.well-known/lnurlp/${name}`)).json()) as LnurlPayParams;
  if (!params.callback) throw new Error("El rival no tiene LNURL-pay activo");
  if (!params.allowsNostr || !params.nostrPubkey)
    throw new Error("El rival no acepta zaps Nostr");

  const amountMsat = clamp(amountSats * 1000, params.minSendable, params.maxSendable);
  const zapRequest = makeZapRequest({
    pubkey: recipientPubkey,
    amount: amountMsat,
    comment,
    relays: [...RELAYS.write],
  });
  const signed = await signer.signEvent(zapRequest);

  const sep = params.callback.includes("?") ? "&" : "?";
  const url = `${params.callback}${sep}amount=${amountMsat}&nostr=${encodeURIComponent(JSON.stringify(signed))}`;
  const res = (await (await fetch(url)).json()) as { pr?: string; reason?: string };
  if (!res.pr) throw new Error(res.reason || "No se pudo generar el invoice");
  return { bolt11: res.pr, amountSats: Math.round(amountMsat / 1000) };
}

function clamp(v: number, min?: number, max?: number): number {
  if (typeof min === "number" && v < min) return min;
  if (typeof max === "number" && v > max) return max;
  return v;
}
