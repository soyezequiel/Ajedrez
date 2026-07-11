/**
 * Configuración por entorno. Nada de secretos hardcodeados.
 */

// Carga server/.env si existe (Node ≥20.12, zero-dep). Las variables ya
// presentes en el entorno tienen prioridad y no se pisan.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile();
} catch {
  // Sin .env: seguimos con process.env tal cual.
}

const here = dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 8787),

  /** Identificador del build en curso. Lo fija el deploy (BUILD_ID = sha+timestamp)
   *  y lo reporta GET /version; el web compara contra el suyo y recarga si cambió.
   *  Vacío en dev/local → la guardia del cliente no hace nada. */
  buildId: process.env.BUILD_ID ?? "",

  /** Store de ratings ELO (JSON en disco). En Docker mapear a un volumen para
   *  que sobreviva a redeploys (ver deploy/). */
  ratingsPath: process.env.RATINGS_PATH ?? join(here, "..", "data", "ratings.json"),

  /** Reloj por defecto de una partida (ms por jugador). 5 min + sin incremento. */
  defaultClockMs: Number(process.env.DEFAULT_CLOCK_MS ?? 5 * 60 * 1000),

  /** Gracia para reconectarse tras una desconexión antes de perder por abandono. */
  abandonGraceMs: Number(process.env.ABANDON_GRACE_MS ?? 60 * 1000),

  /** MODO DE PRUEBA (panel diag): coordenada canónica del juego (kind:30023), igual
   *  que web/src/config.ts. Ancla la atestación kind:31338 del oráculo. Remover con
   *  attest.ts si se saca el modo de prueba. */
  gameCoord:
    process.env.GAME_COORD ??
    "30023:ed13c471be6bff9195a6261d8cbd6c7ab6efe79a7947b208d2b6f066b99cc4d3:ajedrez",
} as const;
