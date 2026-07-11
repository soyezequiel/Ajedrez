import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

// ─── Token de sesión (evita re-firmar en cada reload, estilo cookie de Luna) ───

/** Secreto para firmar los tokens. Estable si se setea AUTH_TOKEN_SECRET (así los
 *  tokens sobreviven a redeploys); si no, aleatorio por proceso (se invalidan al
 *  reiniciar el server → el usuario re-firma una vez). */
const TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET || randomBytes(32).toString("hex");
const TOKEN_TTL_SEC = 30 * 24 * 3600; // 30 días, como la cookie de Luna.

interface TokenPayload {
  p: string; // pubkey hex
  n: string; // npub
  d: string; // displayName
  e: number; // expiración (epoch sec)
}

function sign(body: string): string {
  return createHmac("sha256", TOKEN_SECRET).update(body).digest("base64url");
}

/** Emite un token firmado tras un login Nostr verificado. */
export function issueSessionToken(
  pubkey: string,
  npub: string,
  displayName: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  const payload: TokenPayload = { p: pubkey, n: npub, d: displayName, e: nowSec + TOKEN_TTL_SEC };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export interface SessionFromToken extends NostrAuthResult {
  displayName: string;
}

/** Verifica un token de sesión. Devuelve la identidad, o null si es inválido/vencido. */
export function verifySessionToken(
  token: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SessionFromToken | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (!payload.p || !payload.n || typeof payload.e !== "number" || payload.e < nowSec) return null;
  return { pubkey: payload.p, npub: payload.n, displayName: payload.d ?? "" };
}
