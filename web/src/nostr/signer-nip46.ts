/**
 * Conexión con firmantes remotos NIP-46 (Nostr Connect): Amber, Primal, nsec.app.
 * Portado de Luna Negra.
 *
 * El flujo por QR / "abrir en la app" usa `Nip46Client` (cliente propio con
 * detección NIP-44/NIP-04). El flujo `bunker://` pegado a mano usa BunkerSigner de
 * nostr-tools.
 */

import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import {
  BunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  type BunkerPointer,
} from "nostr-tools/nip46";
import { Nip46Client } from "./nip46-client.js";
import type { ChessSigner, StoredSigner } from "./signer-core.js";

// Relays donde cliente y firmante se encuentran para el handshake NIP-46.
export const NIP46_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nsec.app",
];

// El QR expira a los 5 minutos sin respuesta.
const QR_TIMEOUT_MS = 5 * 60_000;

// Kinds que el ajedrez llega a firmar: 1=reseñas/logros, 13=seal NIP-17 (retos),
// 22242=login, 30315=presencia NIP-38, 31339=marcador, 9734=zap request.
const NIP46_SIGN_KINDS = [1, 13, 22242, 30315, 31339, 9734];

// Permisos que pre-solicitamos en el URI nostrconnect:// (genérico + por kind, que
// algunos firmantes tipo Primal-medium necesitan para no trabarse en el login).
const NIP46_PERMS = [
  "get_public_key",
  "sign_event",
  ...NIP46_SIGN_KINDS.map((k) => `sign_event:${k}`),
  "nip04_encrypt",
  "nip04_decrypt",
  "nip44_encrypt",
  "nip44_decrypt",
];

// ─── Wrappers a ChessSigner ────────────────────────────────────────────────

function wrapBunker(signer: BunkerSigner): ChessSigner {
  return {
    method: "nip46",
    getPublicKey: () => signer.getPublicKey(),
    signEvent: (e) => signer.signEvent(e),
    nip04Encrypt: (peer, pt) => signer.nip04Encrypt(peer, pt),
    nip04Decrypt: (peer, ct) => signer.nip04Decrypt(peer, ct),
    nip44Encrypt: (peer, pt) => signer.nip44Encrypt(peer, pt),
    nip44Decrypt: (peer, ct) => signer.nip44Decrypt(peer, ct),
    close: () => signer.close(),
  };
}

function wrapClient(
  client: Nip46Client,
  ensureConnected: () => Promise<void> = async () => {},
): ChessSigner {
  return {
    method: "nip46",
    getPublicKey: async () => {
      await ensureConnected();
      return client.getPublicKey();
    },
    signEvent: async (e) => {
      await ensureConnected();
      return client.signEvent(e);
    },
    nip04Encrypt: async (peer, pt) => {
      await ensureConnected();
      return client.nip04Encrypt(peer, pt);
    },
    nip04Decrypt: async (peer, ct) => {
      await ensureConnected();
      return client.nip04Decrypt(peer, ct);
    },
    nip44Encrypt: async (peer, pt) => {
      await ensureConnected();
      return client.nip44Encrypt(peer, pt);
    },
    nip44Decrypt: async (peer, ct) => {
      await ensureConnected();
      return client.nip44Decrypt(peer, ct);
    },
    close: () => client.close(),
  };
}

// ─── Persistencia ─────────────────────────────────────────────────────────

function storedNip46(clientSecretKey: Uint8Array, bp: BunkerPointer): StoredSigner {
  return {
    method: "nip46",
    clientNsec: nip19.nsecEncode(clientSecretKey),
    bunker: { relays: bp.relays, pubkey: bp.pubkey, secret: bp.secret },
  };
}

function storedFromClient(clientSecret: Uint8Array, client: Nip46Client): StoredSigner {
  return {
    method: "nip46",
    clientNsec: nip19.nsecEncode(clientSecret),
    bunker: {
      relays: client.relays,
      pubkey: client.bunkerPubkey,
      secret: client.secret,
      encryption: client.encryptionVersion,
    },
  };
}

// ─── Flujos de conexión ───────────────────────────────────────────────────

/** Conecta con un `bunker://...` o un identificador NIP-05 (`usuario@dominio`). */
export async function connectBunker(
  input: string,
  onauth?: (url: string) => void,
): Promise<{ signer: ChessSigner; stored: StoredSigner }> {
  const bp = await parseBunkerInput(input.trim());
  if (!bp) throw new Error("No es un bunker:// ni un identificador NIP-05 válido");
  const clientSecretKey = generateSecretKey();
  const bunker = BunkerSigner.fromBunker(clientSecretKey, bp, { onauth });
  await bunker.connect();
  return { signer: wrapBunker(bunker), stored: storedNip46(clientSecretKey, bp) };
}

/**
 * Inicia el flujo Nostr Connect por QR / "abrir en la app": genera el URI
 * `nostrconnect://` y una promesa que resuelve cuando el firmante remoto acepta.
 */
export function startNostrConnect(opts?: {
  onauth?: (url: string) => void;
  signal?: AbortSignal;
  onDebug?: (line: string) => void;
}): {
  uri: string;
  established: Promise<{ signer: ChessSigner; stored: StoredSigner }>;
} {
  const clientSecret = generateSecretKey();
  const clientPubkey = getPublicKey(clientSecret);
  const secret = crypto.randomUUID().replace(/-/g, "");
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: NIP46_RELAYS,
    secret,
    perms: NIP46_PERMS,
    name: "Ajedrez",
    url: typeof window !== "undefined" ? window.location.origin : undefined,
  });

  const established = Nip46Client.fromURI({
    clientSecret,
    relays: NIP46_RELAYS,
    secret,
    timeoutMs: QR_TIMEOUT_MS,
    abortSignal: opts?.signal,
    onAuthUrl: opts?.onauth,
    onDiag: opts?.onDebug,
  })
    .then((client) => ({
      signer: wrapClient(client),
      stored: storedFromClient(clientSecret, client),
    }))
    .catch((e: unknown) => {
      if (e instanceof Error && e.message === "__qr_timeout__") {
        throw new Error(
          "El código expiró (5 minutos sin respuesta del firmante). Probá de nuevo.",
        );
      }
      throw e;
    });

  return { uri, established };
}

/** Reconecta una sesión NIP-46 persistida (al restaurar la app). */
export async function restoreBunkerSigner(
  clientNsec: string,
  bunker: {
    relays: string[];
    pubkey: string;
    secret: string | null;
    encryption?: "nip44" | "nip04";
  },
): Promise<ChessSigner> {
  const decoded = nip19.decode(clientNsec);
  if (decoded.type !== "nsec") throw new Error("clave de cliente inválida");

  // Sesiones del flujo QR (con cifrado detectado) → cliente propio dual.
  if (bunker.encryption) {
    const client = Nip46Client.fromStored({
      clientSecret: decoded.data,
      bunkerPubkey: bunker.pubkey,
      relays: bunker.relays,
      secret: bunker.secret,
      encryption: bunker.encryption,
    });
    let connectPromise: Promise<void> | null = null;
    const ensureConnected = () => {
      if (!connectPromise) {
        connectPromise = Promise.race([
          client.connect().catch(() => {}),
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]).then(() => {});
      }
      return connectPromise;
    };
    ensureConnected();
    return wrapClient(client, ensureConnected);
  }

  // Sesiones legacy (bunker://) → BunkerSigner.
  const signer = BunkerSigner.fromBunker(decoded.data, bunker);
  await signer.connect();
  return wrapBunker(signer);
}
