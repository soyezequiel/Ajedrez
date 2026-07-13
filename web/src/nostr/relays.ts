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

/**
 * Envía un evento YA FIRMADO a los relays de escritura de forma SÍNCRONA: encola
 * el `ws.send` ya mismo, sin `await`. Es para el cierre de pestaña (`pagehide`),
 * donde el navegador no espera trabajo asíncrono — firmar ahí no llega, pero un
 * send sobre un socket ya abierto suele alcanzar a salir. Best-effort total.
 */
export function publishToWriteSync(event: Event): void {
  try {
    for (const p of getPool().publish([...RELAYS.write], event)) p.catch(() => {});
  } catch {
    // Best-effort: si el pool no está listo, no rompemos el cierre.
  }
}

export interface NostrProfile {
  name: string | null;
  picture: string | null;
  /** Dirección Lightning (lud16) para zaps, si el perfil la declara. */
  lud16: string | null;
}

/** Lee el kind:0 del pubkey y devuelve nombre visible + lud16 (best-effort). */
export async function fetchProfile(pubkey: string, timeoutMs = 2500): Promise<NostrProfile> {
  const empty: NostrProfile = { name: null, picture: null, lud16: null };
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
    const picture = pickString(meta.picture) ?? pickString(meta.image) ?? null;
    return { name, picture, lud16 };
  } catch {
    return empty;
  }
}

/** Perfiles kind:0 en lote, quedándonos con el evento más reciente por autor. */
export async function fetchProfiles(pubkeys: string[], timeoutMs = 3500): Promise<Map<string, NostrProfile>> {
  const authors = [...new Set(pubkeys.map((p) => p.trim().toLowerCase()))]
    .filter((p) => /^[0-9a-f]{64}$/.test(p));
  const result = new Map<string, NostrProfile>();
  if (!authors.length) return result;
  try {
    const events = await getPool().querySync([...RELAYS.profile], { kinds: [0], authors }, { maxWait: timeoutMs });
    const newest = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      const previous = newest.get(event.pubkey);
      if (!previous || event.created_at > previous.created_at) newest.set(event.pubkey, event);
    }
    for (const [pubkey, event] of newest) {
      try {
        const meta = JSON.parse(event.content) as Record<string, unknown>;
        result.set(pubkey, {
          name: pickString(meta.display_name) ?? pickString(meta.name),
          picture: pickString(meta.picture) ?? pickString(meta.image),
          lud16: pickString(meta.lud16),
        });
      } catch { /* metadata inválida */ }
    }
  } catch { /* relays best-effort */ }
  return result;
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
