import type { Event } from "nostr-tools/pure";
import type { Color, MatchResult, MatchSnapshot, MovePayload } from "./types.js";
import type { RoomPhase, RoomPlayer } from "./rooms.js";
import type { RatingChange } from "./ratings.js";

/** Vista de la apuesta de una sala que se broadcastea (sin bolt11 privados). */
export interface BetView {
  betId: string;
  status: string;
  stakeSats: number;
  potSats: number;
  seats: { color: Color; deposited: boolean }[];
}

/**
 * Identidad del jugador. Dos modos:
 *   - Invitado (`guest:true`): login local por nombre, `npub`=`u_<slug>`, sin
 *     `pubkey`. No habilita features NGP (marcador, retos, zaps, apuestas).
 *   - Nostr (`guest:false`): `npub` real y `pubkey` hex verificados por firma.
 */
export interface SessionIdentity {
  npub: string;
  displayName: string;
  guest: boolean;
  /** Pubkey hex, presente solo en login Nostr. */
  pubkey?: string;
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
  /** Login Nostr: pide un reto para firmar (NIP-42). */
  | { t: "auth_challenge" }
  /** Login Nostr: evento kind:22242 firmado sobre el reto + display name best-effort. */
  | { t: "auth_nostr"; event: Event; displayName?: string }
  /** Re-login por token de sesión (evita re-firmar en cada reload/reconexión). */
  | { t: "auth_token"; token: string }
  | { t: "create_room" }
  | { t: "join_room"; roomId?: string; code?: string }
  /** Room Link: entra/crea la sala por su código externo de 4 caracteres (`?join=5XRR`). */
  | { t: "enter_room"; roomId: string }
  | { t: "ready" }
  | { t: "move"; move: MovePayload }
  | { t: "resign" }
  | { t: "offer_draw" }
  | { t: "accept_draw" }
  /** Rechaza la oferta de tablas pendiente del rival. */
  | { t: "decline_draw" }
  /** Pide revancha tras `finished`; con el pedido de ambos arranca la nueva
   *  partida (colores invertidos, sin apuesta). */
  | { t: "rematch" }
  /** El anfitrión propone una apuesta por `stakeSats` (por asiento). */
  | { t: "propose_bet"; stakeSats: number }
  /** Cancela la apuesta pre-fondeo. */
  | { t: "cancel_bet" }
  /** MODO DE PRUEBA (panel diag) — remover junto con attest.ts: pide al oráculo
   *  firmar una atestación kind:31338 del marcador verificado. */
  | { t: "test_attest"; score?: number }
  | { t: "leave" };

/** Mensajes servidor → cliente. */
export type ServerMessage =
  /** `token`: solo en login Nostr — sesión reutilizable para reconectar sin firmar. */
  | { t: "authed"; identity: SessionIdentity; token?: string }
  /** Capacidades del server (p. ej. si el escrow de apuestas está activo). */
  | { t: "caps"; bets: boolean }
  /** Reto a firmar para el login Nostr (NIP-42). */
  | { t: "challenge"; challenge: string }
  | { t: "error"; code: string; message: string }
  /** Estado de la apuesta de la sala (broadcast, sin bolt11 privados). */
  | { t: "bet"; bet: BetView }
  /** Invoice de depósito privado del asiento de ESTE socket. */
  | { t: "bet_invoice"; betId: string; bolt11: string | null; amountSats: number; stakeSats: number }
  /** La apuesta se cerró (cancelada, anulada o liquidada). */
  | { t: "bet_closed"; reason: string }
  | { t: "room"; room: RoomView }
  | { t: "left_room" }
  | { t: "room_closed"; reason: string }
  | { t: "match"; snapshot: MatchSnapshot }
  /** Oferta de tablas pendiente; `null` = fue rechazada/retirada. */
  | { t: "draw_offer"; byNpub: string | null }
  /** Un jugador pidió revancha (el otro la acepta mandando su propio `rematch`). */
  | { t: "rematch_offer"; byNpub: string }
  | { t: "ended"; result: MatchResult; winnerNpubs: string[]; ratings?: RatingChange[] }
  /** Un jugador se desconectó (online=false, con gracia para volver) o volvió. */
  | { t: "presence"; npub: string; online: boolean; graceMs?: number }
  /** MODO DE PRUEBA (panel diag) — remover junto con attest.ts: respuesta a
   *  test_attest. `event` = atestación kind:31338 firmada por el oráculo (que el
   *  cliente publica a relays), o null con `error` si no se pudo firmar. */
  | { t: "test_attestation"; event: Event | null; error?: string };
