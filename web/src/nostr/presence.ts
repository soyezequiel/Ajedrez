// Presencia NIP-38 (kind:30315) anclada al juego. El propio jugador firma el
// estado — no hace falta game server. Best-effort: nunca interrumpe el juego.
//
// PUERTO fino sobre el `createPresenceManager` del SDK (`nostr-game-protocol/ngp`),
// que trae el ciclo de vida completo que antes vivía acá: heartbeat sin gate de
// visibilidad ("jugando" = juego ABIERTO; TTL 180s tolera el estrangulado de
// timers de fondo), throttle de firma con cooldown (no spamear prompts del
// firmante), throttle PERSISTIDO entre recargas (sin él, cada reload re-firmaba
// → prompt de la extensión en cada apertura) y clear pre-firmado para `pagehide`
// (firmar en el unload no llega). Acá quedan solo las decisiones del juego:
// copy, coordenada, relays y clave de storage.
import {
  createPresenceManager,
  type NgpSigner,
} from "nostr-game-protocol/ngp";
import type { Event } from "nostr-tools";
import { GAME_COORD, PRESENCE_MESSAGE, RELAYS } from "../config.js";
import { getPool, publishToWriteSync } from "./relays.js";

export interface PresenceController {
  /** Activa "Jugando Ajedrez" y mantiene el heartbeat. Idempotente; la primera
   *  firma puede saltearse si el evento de la sesión anterior sigue fresco
   *  (throttle persistido — es lo que evita el prompt en cada reload). */
  start(): void;
  /** Limpia la presencia (desaparece ya) y corta el heartbeat (logout). */
  stop(): Promise<void>;
  /** Limpieza SÍNCRONA para `pagehide`: manda el clear pre-firmado sin `await`. */
  clearNow(): void;
}

/**
 * Presencia del jugador autenticado. `pubkey` (si se conoce) llavea el throttle
 * persistido para no heredar el estado de OTRA cuenta en el mismo navegador.
 */
export function createPresence(signer: NgpSigner, pubkey?: string): PresenceController {
  const manager = createPresenceManager({
    signer,
    gameCoord: GAME_COORD,
    pubkey,
    // Publicación ESTRICTA (rechaza si ningún relay aceptó), no la publishToWrite
    // que traga errores: el manager solo cuenta como "publicado" (throttle, estado
    // persistido) lo que de verdad salió.
    publish: (event: Event) => Promise.any(getPool().publish([...RELAYS.write], event)),
    publishSync: publishToWriteSync,
    storage: typeof localStorage === "undefined" ? null : localStorage,
    storageKey: "ajedrez.nostrPresence.v1",
    // Sin esto los fallos best-effort (firmante NIP-46 muerto, timeout de
    // publish) eran mudos y la presencia se dejaba de renovar en silencio.
    onError: (stage, err) => console.warn("[presence]", stage, err),
  });
  return {
    start: () => manager.start(PRESENCE_MESSAGE),
    stop: () => manager.stop(),
    clearNow: () => manager.clearNow(),
  };
}
