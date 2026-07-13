export type UxEvent =
  | "login_started"
  | "challenge_sent"
  | "challenge_accepted"
  | "game_started"
  | "game_ended"
  | "rematch_requested"
  | "rematch_started"
  | "next_rival_challenged";

const sessionId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
const startedAt = performance.now();

/** Telemetría de producto sin nombres, pubkeys, salas ni movimientos. */
export function trackUx(event: UxEvent, detail: Record<string, string | number | boolean> = {}): void {
  const body = JSON.stringify({ event, sessionId, elapsedMs: Math.round(performance.now() - startedAt), detail });
  void fetch("/api/ux-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}
