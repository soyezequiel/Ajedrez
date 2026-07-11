import type { MatchResult, MatchSnapshot, MovePayload } from "./types.js";
import type { RoomPhase, RoomPlayer } from "./rooms.js";

/** Identidad del jugador (login local por nombre). */
export interface SessionIdentity {
  npub: string;
  displayName: string;
}

/** Vista de sala que se manda al cliente (sin estado interno del motor). */
export interface RoomView {
  id: string;
  code: string;
  hostNpub: string;
  phase: RoomPhase;
  players: RoomPlayer[];
}

/** Mensajes cliente → servidor. */
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

/** Mensajes servidor → cliente. */
export type ServerMessage =
  | { t: "authed"; identity: SessionIdentity }
  | { t: "error"; code: string; message: string }
  | { t: "room"; room: RoomView }
  | { t: "match"; snapshot: MatchSnapshot }
  | { t: "draw_offer"; byNpub: string }
  | { t: "ended"; result: MatchResult; winnerNpubs: string[] }
  /** Un jugador se desconectó (online=false, con gracia para volver) o volvió. */
  | { t: "presence"; npub: string; online: boolean; graceMs?: number };
