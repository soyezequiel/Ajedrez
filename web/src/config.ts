// URL del WebSocket del servidor de ajedrez.
//   - Deploy unificado (el server sirve este web): se deriva del origen actual,
//     así funciona en localhost y en LAN (con la IP del host) sin reconfigurar.
//   - Dev con Vite en :5173 (server aparte en :8787): se fija con VITE_WS_URL
//     (ver web/.env.development).
function sameOriginWs(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

export const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ?? sameOriginWs();

// ------------------------------------------------------------------ Nostr / NGP

/** Coordenada del juego en la tienda de Luna Negra (kind:30023). Ancla todos los
 *  eventos NGP: marcador, presencia y retos filtran por este `a` exacto.
 *  Fuente: GET https://luna.naranja.fit/api/store/coords → coords["ajedrez"]. */
const ENV_GAME_COORD = (import.meta.env.VITE_GAME_COORD as string | undefined)?.trim();
export const GAME_COORD =
  ENV_GAME_COORD && ENV_GAME_COORD.length > 0
    ? ENV_GAME_COORD
    : "30023:7c45dcfb2e93594ce43bc2b16fd29b3c38ba0daf42ae8561fe6f0353892b7df4:ajedrez";

/** Copy visible de presencia NIP-38 ("Jugando X"). */
export const PRESENCE_MESSAGE = "Jugando Ajedrez";

/** Tabla del marcador kind:31339. Debe matchear el ranking histórico si existe. */
export const SCORE_BOARD = "clasico";

/** Relays por función. No se publica en relay.nostr.band: es solo de lectura. */
export const RELAYS = {
  profile: [
    "wss://relay.damus.io",
    "wss://relay.nostr.band",
    "wss://nos.lol",
    "wss://relay.primal.net",
  ],
  dm: [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.snort.social",
  ],
  write: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"],
} as const;
