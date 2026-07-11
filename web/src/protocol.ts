// Tipos del protocolo WebSocket — COPIA del contrato del servidor
// (server/src/protocol.ts). Mantener en sync; fuente de verdad = el servidor.

export type Color = "w" | "b";

export interface MovePayload {
  from: string;
  to: string;
  promotion?: "q" | "r" | "b" | "n";
}

export type MatchResult =
  | { kind: "ongoing" }
  | { kind: "white_win"; by: "checkmate" | "resign" | "timeout" }
  | { kind: "black_win"; by: "checkmate" | "resign" | "timeout" }
  | { kind: "draw"; by: "stalemate" | "insufficient" | "threefold" | "fifty" | "agreement" };

export interface MatchSnapshot {
  matchId: string;
  fen: string;
  turn: Color;
  white: string | null;
  black: string | null;
  whiteClockMs: number;
  blackClockMs: number;
  inCheck: boolean;
  lastMove: MovePayload | null;
  result: MatchResult;
}

export interface SessionIdentity {
  npub: string;
  displayName: string;
}

export type RoomPhase = "lobby" | "playing" | "finished";

export interface RoomPlayer {
  npub: string;
  displayName: string;
  color: Color | null;
}

export interface RoomView {
  id: string;
  code: string;
  hostNpub: string;
  phase: RoomPhase;
  players: RoomPlayer[];
}

export type ClientMessage =
  | { t: "auth"; token: string }
  | { t: "create_room" }
  | { t: "join_room"; roomId?: string; code?: string }
  | { t: "ready" }
  | { t: "move"; move: MovePayload }
  | { t: "resign" }
  | { t: "offer_draw" }
  | { t: "accept_draw" }
  | { t: "leave" };

export type ServerMessage =
  | { t: "authed"; identity: SessionIdentity }
  | { t: "error"; code: string; message: string }
  | { t: "room"; room: RoomView }
  | { t: "match"; snapshot: MatchSnapshot }
  | { t: "draw_offer"; byNpub: string }
  | { t: "ended"; result: MatchResult; winnerNpubs: string[] }
  /** Un jugador se desconectó (online=false, con gracia para volver) o volvió. */
  | { t: "presence"; npub: string; online: boolean; graceMs?: number };
