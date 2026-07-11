import {
  buildPresenceClearEvent,
  buildPresenceEvent,
  type NgpSigner,
} from "nostr-game-protocol/ngp";
import { GAME_COORD, PRESENCE_MESSAGE } from "../config.js";
import { publishToWrite } from "./relays.js";

/** TTL de la presencia (segundos). Mayor que el heartbeat para evitar titileo. */
const PRESENCE_TTL_SEC = 240;
/** Cada cuánto revisamos si toca re-firmar (ms). */
const HEARTBEAT_MS = 60_000;
/** Mínimo entre firmas: no re-firmamos más seguido para no spamear al signer
 *  (importa con NIP-46, que puede pedir aprobación en cada firma). */
const MIN_RESIGN_MS = 120_000;

export interface PresenceController {
  /** Activa "Jugando Ajedrez" y mantiene el heartbeat. */
  start(): void;
  /** Limpia la presencia (desaparece ya) y corta el heartbeat. */
  stop(): Promise<void>;
}

/**
 * Presencia NIP-38 (kind:30315) anclada al juego. El propio jugador firma el
 * estado — no hace falta game server. Best-effort: nunca interrumpe el juego.
 */
export function createPresence(signer: NgpSigner): PresenceController {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSignAt = 0;

  async function beat(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - lastSignAt < MIN_RESIGN_MS) return;
    lastSignAt = now;
    try {
      const event = await buildPresenceEvent(signer, {
        gameCoord: GAME_COORD,
        message: PRESENCE_MESSAGE,
        ttlSec: PRESENCE_TTL_SEC,
      });
      await publishToWrite(event);
    } catch {
      // Best-effort: si el signer o los relays fallan, seguimos jugando.
    }
  }

  return {
    start(): void {
      void beat(true);
      timer ??= setInterval(() => void beat(), HEARTBEAT_MS);
    },
    async stop(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      lastSignAt = 0;
      try {
        await publishToWrite(await buildPresenceClearEvent(signer));
      } catch {
        // Best-effort.
      }
    },
  };
}
