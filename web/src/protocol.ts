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
  | { kind: "white_win"; by: "checkmate" | "resign" | "timeout" | "abandon" }
  | { kind: "black_win"; by: "checkmate" | "resign" | "timeout" | "abandon" }
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
  pubkey: string;
  displayName: string;
  avatarUrl: string | null;
  gameId: string;
  source: "luna-negra" | "mock";
}

export interface Friend {
  npub: string;
  displayName: string;
  avatarUrl: string | null;
  presence: "in-game" | "online" | "offline";
  roomId: string | null;
  lastSeenMs: number | null;
}

export interface BetInfo {
  betId: string;
  status: "pending_deposits" | "funded" | "settled" | "cancelled" | "expired" | "refunded";
  potTargetSats: number;
  feeSats: number;
  netPayoutSats: number;
  depositDeadline: string | null;
  participants: Array<{
    npub: string;
    depositStatus: "pending" | "paid";
    payoutSats: number | null;
    bolt11: string | null;
    lnurl: string | null;
    payUrl: string | null;
  }>;
}

export type RoomPhase = "lobby" | "awaiting_deposit" | "playing" | "finished";

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
  stakeSats: number;
  players: RoomPlayer[];
  inviteUrl: string;
}

export type ClientMessage =
  | { t: "auth"; token: string; inviteToken?: string }
  | { t: "create_room"; stakeSats?: number }
  | { t: "join_room"; roomId?: string; code?: string }
  | { t: "set_stake"; stakeSats: number }
  | { t: "ready" }
  | { t: "move"; move: MovePayload }
  | { t: "resign" }
  | { t: "offer_draw" }
  | { t: "accept_draw" }
  | { t: "invite_friend"; toNpub: string }
  | { t: "leave" };

export type ServerMessage =
  | { t: "authed"; identity: SessionIdentity }
  | { t: "error"; code: string; message: string }
  | { t: "room"; room: RoomView }
  | { t: "match"; snapshot: MatchSnapshot }
  | { t: "bet"; bet: BetInfo | null }
  | { t: "friends"; friends: Friend[] }
  | { t: "draw_offer"; byNpub: string }
  | { t: "ended"; result: MatchResult; winnerNpubs: string[]; betId: string | null };
