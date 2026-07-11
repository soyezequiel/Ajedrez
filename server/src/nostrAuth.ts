import { randomBytes } from "node:crypto";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";

/** Kind de autenticación cliente (NIP-42). El jugador firma un reto emitido por
 *  el server para probar que controla la clave — así el `pubkey` es confiable y
 *  sirve para el payout de apuestas. */
export const AUTH_KIND = 22242;

/** Ventana de frescura de la firma de login (segundos). */
const AUTH_MAX_SKEW_SEC = 600;

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Reto aleatorio por conexión, atado a un solo login. */
export function makeChallenge(): string {
  return randomBytes(16).toString("hex");
}

export interface NostrAuthResult {
  /** Pubkey hex del jugador (para payouts NGE / delegación de oráculo). */
  pubkey: string;
  /** npub bech32, la clave de identidad que usan salas y partidas. */
  npub: string;
}

/**
 * Verifica un evento kind:22242 firmado contra el `challenge` emitido a ESTA
 * conexión. Lanza `AuthError` si el kind, el challenge, la frescura o la firma
 * no cuadran. No confía en `content` ni en el display name: solo en la firma.
 */
export function verifyNostrAuth(
  event: Event,
  expectedChallenge: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): NostrAuthResult {
  if (!event || typeof event !== "object")
    throw new AuthError("BAD_EVENT", "Evento de auth ausente");
  if (event.kind !== AUTH_KIND)
    throw new AuthError("BAD_KIND", "Kind de auth inesperado");
  const challenge = event.tags?.find((t) => t[0] === "challenge")?.[1];
  if (!challenge || challenge !== expectedChallenge)
    throw new AuthError("CHALLENGE_MISMATCH", "El challenge no coincide");
  if (!Number.isFinite(event.created_at) || Math.abs(nowSec - event.created_at) > AUTH_MAX_SKEW_SEC)
    throw new AuthError("STALE_AUTH", "Firma de login vencida");
  if (!verifyEvent(event)) throw new AuthError("BAD_SIG", "Firma inválida");
  return { pubkey: event.pubkey, npub: npubEncode(event.pubkey) };
}
