import type { BetInfo, Friend, SessionIdentity } from "./lunaNegra.js";
import type { MatchResult, MatchSnapshot, MovePayload } from "./types.js";
import type { RoomPhase, RoomPlayer } from "./rooms.js";

/** Vista de sala que se manda al cliente (sin estado interno del motor). */
export interface RoomView {
  id: string;
  code: string;
  hostNpub: string;
  phase: RoomPhase;
  stakeSats: number;
  players: RoomPlayer[];
  inviteUrl: string;
}

/** Mensajes cliente → servidor. */
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

/** Mensajes servidor → cliente. */
export type ServerMessage =
  | { t: "authed"; identity: SessionIdentity }
  | { t: "error"; code: string; message: string }
  | { t: "room"; room: RoomView }
  | { t: "match"; snapshot: MatchSnapshot }
  | { t: "bet"; bet: BetInfo | null }
  | { t: "friends"; friends: Friend[] }
  | { t: "draw_offer"; byNpub: string }
  | { t: "ended"; result: MatchResult; winnerNpubs: string[]; betId: string | null };
