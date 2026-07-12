import {
  buildPresenceClearEvent,
  buildPresenceEvent,
  type NgpSigner,
} from "nostr-game-protocol/ngp";
import { buildPresenceClearTemplate } from "nostr-game-protocol/ngp-core";
import type { Event } from "nostr-tools";
import { GAME_COORD, PRESENCE_MESSAGE } from "../config.js";
import { publishToWrite, publishToWriteSync } from "./relays.js";

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
  /**
   * Limpieza SÍNCRONA para el cierre de pestaña (`pagehide`): manda el clear
   * pre-firmado sin `await`. No firma en el momento (no llegaría en el unload).
   */
  clearNow(): void;
}

/**
 * Presencia NIP-38 (kind:30315) anclada al juego. El propio jugador firma el
 * estado — no hace falta game server. Best-effort: nunca interrumpe el juego.
 */
export function createPresence(signer: NgpSigner): PresenceController {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSignAt = 0;
  // Clear PRE-FIRMADO de la última presencia, listo para mandar sincrónicamente al
  // cerrar la pestaña. Firmar en `pagehide` no llega con NIP-07/46 (la firma es
  // async y el navegador mata la página antes); pre-firmarlo mientras el juego está
  // vivo permite un `ws.send` sincrónico en el cierre. Su `created_at` es el de la
  // presencia + 1 para que gane la resolución del slot replaceable `d:general`.
  let preparedClear: Event | null = null;

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
      // Pre-firmamos el clear correspondiente a ESTA presencia (created_at + 1 para
      // que la pise). Se re-genera en cada beat, así siempre matchea la más nueva.
      try {
        preparedClear = await signer.signEvent(
          buildPresenceClearTemplate({ createdAt: event.created_at + 1 }),
        );
      } catch {
        // Si falla, dejamos el clear previo (best-effort): peor caso, no pisa y la
        // presencia vence sola por TTL.
      }
    } catch {
      // Best-effort: si el signer o los relays fallan, seguimos jugando.
    }
  }

  function stopHeartbeat(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    lastSignAt = 0;
  }

  return {
    start(): void {
      void beat(true);
      timer ??= setInterval(() => void beat(), HEARTBEAT_MS);
    },
    async stop(): Promise<void> {
      stopHeartbeat();
      const clear = preparedClear;
      preparedClear = null;
      try {
        // Con tiempo (volver al home / logout) firmamos uno fresco si no había
        // pre-firmado; en el cierre de pestaña usamos `clearNow` (sincrónico).
        await publishToWrite(clear ?? (await buildPresenceClearEvent(signer)));
      } catch {
        // Best-effort.
      }
    },
    clearNow(): void {
      stopHeartbeat();
      if (preparedClear) {
        publishToWriteSync(preparedClear);
        preparedClear = null;
      }
    },
  };
}
