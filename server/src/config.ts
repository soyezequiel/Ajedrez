/**
 * Configuración por entorno. Nada de secretos hardcodeados.
 */

// Carga server/.env si existe (Node ≥20.12, zero-dep). Las variables ya
// presentes en el entorno tienen prioridad y no se pisan.
try {
  process.loadEnvFile();
} catch {
  // Sin .env: seguimos con process.env tal cual.
}

export const config = {
  port: Number(process.env.PORT ?? 8787),

  /** Reloj por defecto de una partida (ms por jugador). 5 min + sin incremento. */
  defaultClockMs: Number(process.env.DEFAULT_CLOCK_MS ?? 5 * 60 * 1000),

  /** Gracia para reconectarse tras una desconexión antes de perder por abandono. */
  abandonGraceMs: Number(process.env.ABANDON_GRACE_MS ?? 60 * 1000),
} as const;
