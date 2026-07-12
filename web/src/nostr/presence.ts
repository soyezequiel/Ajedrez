import {
  buildPresenceClearEvent,
  buildPresenceEvent,
  type NgpSigner,
} from "nostr-game-protocol/ngp";
import { buildPresenceClearTemplate } from "nostr-game-protocol/ngp-core";
import type { Event } from "nostr-tools";
import { GAME_COORD, PRESENCE_MESSAGE } from "../config.js";
import { publishToWrite, publishToWriteSync } from "./relays.js";

/** TTL de la presencia (segundos). Corto a propósito: es el TIEMPO MÁXIMO que
 *  la tienda te sigue mostrando "Jugando Ajedrez" tras cerrar/soltar el juego si
 *  el clear no llegó a salir. Debe ser cómodamente mayor que MIN_RESIGN_MS para
 *  no titilar mientras jugás (margen para un latido perdido / clock drift). */
const PRESENCE_TTL_SEC = 60;
/** Cada cuánto revisamos si toca re-firmar (ms). Debe dividir MIN_RESIGN_MS de
 *  forma que la cadencia real de re-firma (ceil(MIN_RESIGN/HEARTBEAT)·HEARTBEAT)
 *  quede holgadamente por debajo del TTL: 20s ⇒ re-firma cada 40s, TTL 60s. */
const HEARTBEAT_MS = 20_000;
/** Mínimo entre firmas: no re-firmamos más seguido para no spamear al signer
 *  (importa con NIP-46, que puede pedir aprobación en cada firma). */
const MIN_RESIGN_MS = 40_000;

export interface PresenceController {
  /** Activa "Jugando Ajedrez" y mantiene el heartbeat (firma inmediata). */
  start(): void;
  /** Vuelve a primer plano: re-late respetando el throttle (no re-firma si la
   *  última presencia sigue fresca), sin el prompt de un `start()` forzado. */
  resume(): void;
  /** Pasa a segundo plano: deja de latir SIN limpiar (la presencia se auto-expira
   *  por TTL si no volvés) y SIN olvidar la última firma (un cambio breve de
   *  pestaña no re-firma al volver). */
  pause(): void;
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
          buildPresenceClearTemplate({ createdAt: event.created_at + 1, gameCoord: GAME_COORD }),
        );
      } catch {
        // Si falla, dejamos el clear previo (best-effort): peor caso, no pisa y la
        // presencia vence sola por TTL.
      }
    } catch {
      // Best-effort: si el signer o los relays fallan, seguimos jugando.
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function stopHeartbeat(): void {
    // Teardown REAL (logout / cierre): corta el latido y OLVIDA la última firma,
    // así una sesión nueva vuelve a anunciarse desde cero.
    clearTimer();
    lastSignAt = 0;
  }

  return {
    start(): void {
      // Idempotente: si el heartbeat ya corre, no forzamos otra firma (con NIP-46/07
      // cada firma puede ser un prompt). Se llama al autenticar y puede re-llamarse
      // en cualquier momento sin costo.
      if (timer !== null) return;
      void beat(true);
      timer = setInterval(() => void beat(), HEARTBEAT_MS);
    },
    resume(): void {
      // Volver a primer plano: re-arranca el latido pero con `beat(false)`, que
      // respeta MIN_RESIGN — si soltaste la pestaña unos segundos, no re-firma
      // (la presencia sigue viva); si estuviste afuera más que el TTL, re-anuncia.
      if (timer !== null) return;
      void beat(false);
      timer = setInterval(() => void beat(), HEARTBEAT_MS);
    },
    pause(): void {
      // Segundo plano: dejamos de latir SIN limpiar ni olvidar la firma. La
      // presencia se auto-expira por TTL si no volvés; si volvés pronto, `resume`
      // no re-firma. Así una pestaña abierta de fondo no queda "jugando" para
      // siempre, sin el costo de re-firmar en cada alt-tab.
      clearTimer();
    },
    async stop(): Promise<void> {
      stopHeartbeat();
      const clear = preparedClear;
      preparedClear = null;
      try {
        // Con tiempo (volver al home / logout) firmamos uno fresco si no había
        // pre-firmado; en el cierre de pestaña usamos `clearNow` (sincrónico).
        await publishToWrite(
          clear ?? (await buildPresenceClearEvent(signer, { gameCoord: GAME_COORD })),
        );
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
