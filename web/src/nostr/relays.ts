import { SimplePool, type Event } from "nostr-tools";
import { dmRelaysFromInboxEvent } from "nostr-game-protocol/ngp";
import { RELAYS } from "../config.js";

/** Pool único de sockets, compartido por presencia, marcador, retos y perfiles. */
let pool: SimplePool | null = null;

export function getPool(): SimplePool {
  if (!pool) pool = new SimplePool();
  return pool;
}

/** Publica un evento firmado best-effort a un conjunto de relays. */
export async function publishTo(relays: string[], event: Event): Promise<void> {
  try {
    await Promise.any(getPool().publish(relays, event));
  } catch {
    // Best-effort: si ningún relay aceptó, no interrumpimos el juego.
  }
}

/** Publica un evento firmado best-effort a los relays de escritura pública. */
export function publishToWrite(event: Event): Promise<void> {
  return publishTo([...RELAYS.write], event);
}

export interface NostrProfile {
  name: string | null;
  /** Dirección Lightning (lud16) para zaps, si el perfil la declara. */
  lud16: string | null;
}

/** Lee el kind:0 del pubkey y devuelve nombre visible + lud16 (best-effort). */
export async function fetchProfile(pubkey: string, timeoutMs = 2500): Promise<NostrProfile> {
  const empty: NostrProfile = { name: null, lud16: null };
  try {
    const ev = await withTimeout(
      getPool().get([...RELAYS.profile], { kinds: [0], authors: [pubkey] }),
      timeoutMs,
    );
    if (!ev) return empty;
    const meta = JSON.parse(ev.content) as Record<string, unknown>;
    const name =
      pickString(meta.display_name) ?? pickString(meta.name) ?? null;
    const lud16 = pickString(meta.lud16) ?? null;
    return { name, lud16 };
  } catch {
    return empty;
  }
}

/**
 * Resuelve la bandeja de DM (NIP-17) de un pubkey desde su kind:10050, unida a
 * los DM_RELAYS por defecto. La MISMA función se usa al enviar (relays del
 * destinatario) y al escuchar (los propios), para que reto y recepción coincidan.
 */
export async function resolveDmRelays(pubkey: string, timeoutMs = 2500): Promise<string[]> {
  try {
    const ev = await withTimeout(
      getPool().get([...RELAYS.dm, ...RELAYS.profile], { kinds: [10050], authors: [pubkey] }),
      timeoutMs,
    );
    const declared = dmRelaysFromInboxEvent(ev ?? undefined);
    return unique([...declared, ...RELAYS.dm]);
  } catch {
    return [...RELAYS.dm];
  }
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

function pickString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
