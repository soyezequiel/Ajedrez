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
  guest: boolean;
  /** Pubkey hex, presente solo en login Nostr. */
  pubkey?: string;
}

/** Evento Nostr firmado (subset de nostr-tools; evita acoplar el tipo entero). */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface RatingChange {
  npub: string;
  rating: number;
  delta: number;
}

export interface BetView {
  betId: string;
  status: string;
  stakeSats: number;
  potSats: number;
  seats: { color: Color; deposited: boolean }[];
}

export type RoomPhase = "lobby" | "playing" | "finished";

export interface RoomPlayer {
  npub: string;
  displayName: string;
  color: Color | null;
  /** Pubkey hex, presente solo si el jugador entró con Nostr (para zaps/retos). */
  pubkey?: string;
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
  | { t: "auth_challenge" }
  | { t: "auth_nostr"; event: NostrEvent; displayName?: string }
  | { t: "auth_token"; token: string }
  | { t: "create_room" }
  | { t: "join_room"; roomId?: string; code?: string }
  | { t: "enter_room"; roomId: string }
  | { t: "ready" }
  | { t: "move"; move: MovePayload }
  | { t: "resign" }
  | { t: "offer_draw" }
  | { t: "accept_draw" }
  | { t: "propose_bet"; stakeSats: number }
  | { t: "cancel_bet" }
  // MODO DE PRUEBA (panel diag) — remover junto con nostr/diag.ts.
  | { t: "test_attest"; score?: number }
  | { t: "leave" };

export type ServerMessage =
  | { t: "authed"; identity: SessionIdentity; token?: string }
  | { t: "caps"; bets: boolean }
  | { t: "challenge"; challenge: string }
  | { t: "error"; code: string; message: string }
  | { t: "bet"; bet: BetView }
  | { t: "bet_invoice"; betId: string; bolt11: string | null; amountSats: number; stakeSats: number }
  | { t: "bet_closed"; reason: string }
  | { t: "room"; room: RoomView }
  | { t: "match"; snapshot: MatchSnapshot }
  | { t: "draw_offer"; byNpub: string }
  | { t: "ended"; result: MatchResult; winnerNpubs: string[]; ratings?: RatingChange[] }
  /** Un jugador se desconectó (online=false, con gracia para volver) o volvió. */
  | { t: "presence"; npub: string; online: boolean; graceMs?: number }
  // MODO DE PRUEBA (panel diag) — remover junto con nostr/diag.ts.
  | { t: "test_attestation"; event: NostrEvent | null; error?: string };
