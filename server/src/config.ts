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

  /** Store de ratings ELO (JSON en disco). En Docker mapear a un volumen para
   *  que sobreviva a redeploys (ver deploy/). */
  ratingsPath: process.env.RATINGS_PATH ?? join(here, "..", "data", "ratings.json"),

  /** Reloj por defecto de una partida (ms por jugador). 5 min + sin incremento. */
  defaultClockMs: Number(process.env.DEFAULT_CLOCK_MS ?? 5 * 60 * 1000),

  /** Gracia para reconectarse tras una desconexión antes de perder por abandono. */
  abandonGraceMs: Number(process.env.ABANDON_GRACE_MS ?? 60 * 1000),
} as const;
