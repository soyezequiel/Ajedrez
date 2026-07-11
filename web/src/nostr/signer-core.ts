/**
 * Abstracción de firma Nostr del ajedrez (portada de Luna Negra). La app habla con
 * un `ChessSigner` activo que puede ser:
 *  - "nip07": extensión del navegador (nos2x, Alby).
 *  - "nip46": firmante remoto Nostr Connect (Amber, Primal, nsec.app) por QR/bunker.
 *  - "local": clave en este navegador (generada o nsec importado).
 *
 * A diferencia del viejo signer.ts (solo NIP-07, sin persistencia real), acá la
 * sesión se guarda en localStorage y se restaura al reabrir, sin re-loguear.
 */

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip44,
  nip19,
  type Event,
} from "nostr-tools";
import type { NgpSigner } from "nostr-game-protocol/ngp";

export type SignerMethod = "nip07" | "nip46" | "local";

export type UnsignedEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export interface ChessSigner {
  readonly method: SignerMethod;
  getPublicKey(): Promise<string>;
  signEvent(e: UnsignedEvent): Promise<Event>;
  /** NIP-44 (lo necesita NIP-17 para los retos cifrados). */
  nip44Encrypt?(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(peerPubkey: string, ciphertext: string): Promise<string>;
  /** NIP-04 (legacy; algunos firmantes/DMs lo usan). */
  nip04Encrypt?(peerPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(peerPubkey: string, ciphertext: string): Promise<string>;
  /** Libera recursos (pool del firmante NIP-46). */
  close?(): Promise<void>;
}

/** Kind de autenticación cliente (NIP-42): el jugador firma el reto del server. */
const AUTH_KIND = 22242;

/** Firma el evento kind:22242 sobre el reto del server (prueba de posesión). */
export function signAuthChallenge(signer: NgpSigner, challenge: string): Promise<Event> {
  return signer.signEvent({
    kind: AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["challenge", challenge],
      ["relay", location.origin],
    ],
    content: "ajedrez-login",
  }) as Promise<Event>;
}

/** Adapta un ChessSigner al NgpSigner que espera el SDK (challenge, retos NIP-17). */
export function toNgpSigner(s: ChessSigner): NgpSigner {
  return {
    getPublicKey: () => s.getPublicKey(),
    signEvent: (e) => s.signEvent(e as UnsignedEvent),
    nip44Encrypt: s.nip44Encrypt ? (pk, pt) => s.nip44Encrypt!(pk, pt) : undefined,
    nip44Decrypt: s.nip44Decrypt ? (pk, ct) => s.nip44Decrypt!(pk, ct) : undefined,
  };
}

// --- Persistencia de la sesión de signer (localStorage, JSON discriminado) ---

const SIGNER_KEY = "ajedrez.signer.v1";

export type StoredSigner = {
  /** Pubkey del usuario, cacheada tras el primer login. Permite restaurar sin el
   *  RPC `get_public_key` (en NIP-46 viaja por relays: segundos de espera). */
  pubkey?: string;
} & (
  | { method: "nip07" }
  | { method: "local"; nsec: string }
  | {
      method: "nip46";
      clientNsec: string;
      bunker: {
        relays: string[];
        pubkey: string;
        secret: string | null;
        encryption?: "nip44" | "nip04";
      };
    }
);

function readStoredSigner(): StoredSigner | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(SIGNER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSigner;
  } catch {
    return null;
  }
}

function writeStoredSigner(stored: StoredSigner | null): void {
  if (typeof window === "undefined") return;
  try {
    if (stored) localStorage.setItem(SIGNER_KEY, JSON.stringify(stored));
    else localStorage.removeItem(SIGNER_KEY);
  } catch {
    /* storage bloqueado: la sesión no persiste */
  }
}

export function hasStoredSigner(): boolean {
  return readStoredSigner() !== null;
}

/** Cachea la pubkey del usuario en la sesión guardada (acelera el próximo restore). */
export function updateStoredPubkey(pubkey: string): void {
  const stored = readStoredSigner();
  if (!stored || stored.pubkey === pubkey) return;
  writeStoredSigner({ ...stored, pubkey });
}

// --- Signer activo (singleton en memoria) ---

let active: ChessSigner | null = null;

export function getActiveSigner(): ChessSigner | null {
  return active;
}

export function setActiveSigner(signer: ChessSigner, stored: StoredSigner): void {
  active = signer;
  writeStoredSigner(stored);
}

export function clearActiveSigner(): void {
  const prev = active;
  active = null;
  writeStoredSigner(null);
  void prev?.close?.();
}

/**
 * Restaura el signer guardado al arrancar la app. Para NIP-46 reconecta al
 * firmante remoto (import dinámico). Devuelve null si no había sesión o falló.
 */
export async function restoreSigner(): Promise<ChessSigner | null> {
  if (active) return active;
  const stored = readStoredSigner();
  if (!stored) return null;
  try {
    if (stored.method === "nip07") {
      // Las extensiones (Alby/nos2x) inyectan window.nostr de forma ASÍNCRONA tras
      // cargar la página. En un reload todavía no está en el primer tick: si nos
      // rindiéramos al instante, la sesión "se cerraría" en cada recarga. Esperamos.
      if (!(await waitForNip07(3000))) return null;
      active = createNip07Signer();
    } else if (stored.method === "local") {
      active = importNsec(stored.nsec);
    } else {
      const { restoreBunkerSigner } = await import("./signer-nip46.js");
      const signer = await restoreBunkerSigner(stored.clientNsec, stored.bunker);
      // Con pubkey cacheada evitamos el RPC get_public_key por relays (lento); la
      // primera firma real igual valida contra el firmante. Solo NIP-46: en NIP-07
      // el usuario puede haber cambiado de cuenta en la extensión.
      active = stored.pubkey
        ? { ...signer, getPublicKey: async () => stored.pubkey! }
        : signer;
    }
    return active;
  } catch {
    return null;
  }
}

// --- NIP-07 (extensión) ---

interface FullNip07 {
  getPublicKey(): Promise<string>;
  signEvent(e: UnsignedEvent): Promise<Event>;
  nip04?: { encrypt(pk: string, pt: string): Promise<string>; decrypt(pk: string, ct: string): Promise<string> };
  nip44?: { encrypt(pk: string, pt: string): Promise<string>; decrypt(pk: string, ct: string): Promise<string> };
}

/** Accede a window.nostr sin chocar con el tipado del viejo signer.ts. */
function win(): FullNip07 | undefined {
  return typeof window !== "undefined"
    ? ((window as unknown as { nostr?: FullNip07 }).nostr ?? undefined)
    : undefined;
}

/** Algunas extensiones inyectan window.nostr después de cargar la página. */
export async function waitForNip07(timeoutMs = 3000): Promise<FullNip07 | null> {
  const started = Date.now();
  while (!win() && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return win() ?? null;
}

export function createNip07Signer(): ChessSigner {
  const nostr = () => {
    const n = win();
    if (!n) throw new Error("Necesitás una extensión Nostr (nos2x/Alby)");
    return n;
  };
  return {
    method: "nip07",
    getPublicKey: () => nostr().getPublicKey(),
    signEvent: (e) => nostr().signEvent(e),
    nip04Encrypt: (peer, pt) => {
      const n = nostr();
      if (!n.nip04) throw new Error("Tu extensión no soporta NIP-04");
      return n.nip04.encrypt(peer, pt);
    },
    nip04Decrypt: (peer, ct) => {
      const n = nostr();
      if (!n.nip04) throw new Error("Tu extensión no soporta NIP-04");
      return n.nip04.decrypt(peer, ct);
    },
    nip44Encrypt: (peer, pt) => {
      const n = nostr();
      if (!n.nip44) throw new Error("Tu extensión no soporta NIP-44");
      return n.nip44.encrypt(peer, pt);
    },
    nip44Decrypt: (peer, ct) => {
      const n = nostr();
      if (!n.nip44) throw new Error("Tu extensión no soporta NIP-44");
      return n.nip44.decrypt(peer, ct);
    },
  };
}

// --- Clave local (generada o nsec importado; guardada plana en este navegador) ---

export function createLocalSigner(secretKey: Uint8Array): ChessSigner {
  const pubkey = getPublicKey(secretKey);
  return {
    method: "local",
    getPublicKey: async () => pubkey,
    signEvent: async (e) => finalizeEvent(e, secretKey),
    nip04Encrypt: async (peer, pt) => nip04.encrypt(secretKey, peer, pt),
    nip04Decrypt: async (peer, ct) => nip04.decrypt(secretKey, peer, ct),
    nip44Encrypt: async (peer, pt) =>
      nip44.encrypt(pt, nip44.getConversationKey(secretKey, peer)),
    nip44Decrypt: async (peer, ct) =>
      nip44.decrypt(ct, nip44.getConversationKey(secretKey, peer)),
  };
}

export function generateLocalSigner(): { signer: ChessSigner; nsec: string } {
  const sk = generateSecretKey();
  return { signer: createLocalSigner(sk), nsec: nip19.nsecEncode(sk) };
}

/** Valida y decodifica un nsec; lanza con mensaje claro si no lo es. */
export function importNsec(nsec: string): ChessSigner {
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(nsec.trim());
  } catch {
    throw new Error("Eso no parece un nsec válido");
  }
  if (decoded.type !== "nsec") throw new Error("Eso no es una clave privada (nsec)");
  return createLocalSigner(decoded.data);
}
