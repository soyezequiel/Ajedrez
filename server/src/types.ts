/** Identidad estable del jugador = npub de Nostr (nunca un UUID local). */
export type Npub = string;

export type Color = "w" | "b";

/** Cómo terminó (o no) una partida. */
export type MatchResult =
  | { kind: "ongoing" }
  | { kind: "white_win"; by: "checkmate" | "resign" | "timeout" | "abandon" }
  | { kind: "black_win"; by: "checkmate" | "resign" | "timeout" | "abandon" }
  | {
      kind: "draw";
      by: "stalemate" | "insufficient" | "threefold" | "fifty" | "agreement";
    };

export interface MovePayload {
  from: string; // ej "e2"
  to: string; // ej "e4"
  promotion?: "q" | "r" | "b" | "n";
}

/** Estado de la partida que se envía a los clientes (sin lógica interna). */
export interface MatchSnapshot {
  matchId: string;
  fen: string;
  turn: Color;
  white: Npub | null;
  black: Npub | null;
  whiteClockMs: number;
  blackClockMs: number;
  inCheck: boolean;
  lastMove: MovePayload | null;
  result: MatchResult;
}
