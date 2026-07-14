export type ClockUrgency = 0 | 1 | 2;

export function formatClockMs(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** El aviso se adapta a partidas cortas: 20% del ritmo, con tope de un minuto. */
export function lowTimeThresholdMs(initialMs: number): number {
  return Math.min(60_000, Math.max(10_000, initialMs * 0.2));
}

export function clockUrgency(remainingMs: number, initialMs: number): ClockUrgency {
  if (remainingMs <= 10_000) return 2;
  if (remainingMs <= lowTimeThresholdMs(initialMs)) return 1;
  return 0;
}

export function clockAriaLabel(remainingMs: number, urgency: ClockUrgency): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const time = `${Math.floor(seconds / 60)} minutos y ${seconds % 60} segundos`;
  return urgency === 2
    ? `Tiempo crítico: ${time}`
    : urgency === 1
      ? `Poco tiempo: ${time}`
      : `Tiempo restante: ${time}`;
}
