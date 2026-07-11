import {
  buildChallengeGiftWrap,
  parseChallengeGiftWrap,
  type NgpSigner,
  type ParsedChallenge,
} from "nostr-game-protocol/ngp";
import { decode } from "nostr-tools/nip19";
import type { Event } from "nostr-tools";
import { GAME_COORD } from "../config.js";
import { getPool, publishTo, resolveDmRelays } from "./relays.js";

const SEEN_KEY = "ajedrez.challenge.seen.v1";
/** Lookback del inbox: los gift-wrap NIP-59 llevan timestamp aleatorizado hasta
 *  2 días atrás, así que escuchamos ~3 días para no perdernos ninguno. */
const INBOX_LOOKBACK_SEC = 3 * 24 * 60 * 60;

/** npub o hex → pubkey hex. Lanza si no es una clave pública válida. */
export function toPubkeyHex(input: string): string {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  const { type, data } = decode(trimmed);
  if (type !== "npub" || typeof data !== "string")
    throw new Error("Ingresá un npub válido");
  return data;
}

/**
 * Envía un reto 1v1 NIP-17 al pubkey destino. Usa el gift-wrap de mínima
 * fricción (una sola firma) y lo publica a la bandeja del destinatario (su
 * kind:10050 + DM_RELAYS). Best-effort en la publicación; lanza si el signer no
 * soporta NIP-44 (necesario para cifrar el reto).
 */
export async function sendChallenge(
  signer: NgpSigner,
  input: { toPubkey: string; roomId: string; joinUrl: string; message: string },
): Promise<void> {
  const giftWrap = await buildChallengeGiftWrap(signer, GAME_COORD, {
    toPubkey: input.toPubkey,
    roomId: input.roomId,
    joinUrl: input.joinUrl,
    message: input.message,
  });
  const relays = await resolveDmRelays(input.toPubkey);
  await publishTo(relays, giftWrap);
}

/**
 * Suscribe la bandeja NIP-17 del jugador y entrega los retos entrantes válidos,
 * deduplicados. Devuelve una función para cortar la suscripción.
 */
export function startChallengeInbox(
  signer: NgpSigner,
  myPubkey: string,
  onChallenge: (challenge: ParsedChallenge) => void,
): () => void {
  const seen = loadSeen();
  let stopped = false;

  void resolveDmRelays(myPubkey).then((relays) => {
    if (stopped) return;
    const sub = getPool().subscribeMany(
      relays,
      { kinds: [1059], "#p": [myPubkey], since: nowSec() - INBOX_LOOKBACK_SEC },
      {
        onevent: (giftWrap: Event) => {
          if (seen.has(giftWrap.id)) return;
          markSeen(seen, giftWrap.id);
          void parseChallengeGiftWrap(signer, GAME_COORD, giftWrap, {
            origin: location.origin,
          }).then((parsed) => {
            if (!parsed) return;
            if (parsed.rumorId && seen.has(parsed.rumorId)) return;
            if (parsed.rumorId) markSeen(seen, parsed.rumorId);
            onChallenge(parsed);
          });
        },
      },
    );
    stop = () => sub.close();
    if (stopped) sub.close();
  });

  let stop = () => {};
  return () => {
    stopped = true;
    stop();
  };
}

// ------------------------------------------------------------- dedupe persistente

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function loadSeen(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[];
    return new Set(arr.slice(-200));
  } catch {
    return new Set();
  }
}

function markSeen(seen: Set<string>, id: string): void {
  seen.add(id);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200)));
  } catch {
    // Sin storage: la dedupe vive solo en memoria esta sesión.
  }
}
