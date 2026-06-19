/**
 * Configuración por entorno. Nada de secretos hardcodeados.
 *
 * `LUNA_API_KEY` (ln_sk_…) JAMÁS va al cliente: vive solo acá, en el server.
 * Si no está configurada, el cliente Luna Negra cae en modo `mock` para poder
 * desarrollar sin backend (mismo patrón que el Tetris).
 */

// Carga server/.env si existe (Node ≥20.12, zero-dep). Las credenciales reales
// de Luna Negra (LUNA_API_KEY, LUNA_GAME_ID, LUNA_WEBHOOK_SECRET) viven ahí.
// Las variables ya presentes en el entorno tienen prioridad y no se pisan.
try {
  process.loadEnvFile();
} catch {
  // Sin .env: seguimos con process.env tal cual (modo mock o vars exportadas).
}

export const config = {
  port: Number(process.env.PORT ?? 8787),

  luna: {
    baseUrl: process.env.LUNA_BASE_URL ?? "https://moon21.vercel.app",
    apiKey: process.env.LUNA_API_KEY ?? "",
    gameId: process.env.LUNA_GAME_ID ?? "",
    slug: process.env.LUNA_GAME_SLUG ?? "ajedrez",
    webhookSecret: process.env.LUNA_WEBHOOK_SECRET ?? "",
    leaderboard: process.env.LUNA_LEADERBOARD ?? "ajedrez",
  },

  /** Reloj por defecto de una partida (ms por jugador). 5 min + sin incremento. */
  defaultClockMs: Number(process.env.DEFAULT_CLOCK_MS ?? 5 * 60 * 1000),

  /** true si tenemos credenciales reales de Luna Negra; si no, modo mock. */
  get lunaLive(): boolean {
    return Boolean(this.luna.apiKey && this.luna.gameId);
  },
} as const;
