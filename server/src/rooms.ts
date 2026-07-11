import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { ChessMatch } from "./chessMatch.js";
import type { Npub } from "./types.js";

export type RoomPhase = "lobby" | "playing" | "finished";

export interface RoomPlayer {
  npub: Npub;
  displayName: string;
  color: "w" | "b" | null;
  /** Pubkey hex, presente solo si el jugador entró con Nostr. Habilita el
   *  payout NGE y la atestación por color. */
  pubkey?: string;
}

/** Alta de un jugador en una sala. */
export interface PlayerInit {
  npub: Npub;
  displayName: string;
  pubkey?: string;
}

/** Una sala = un emparejamiento 1v1 de ajedrez. */
export class Room {
  readonly id: string;
  readonly code: string;
  readonly hostNpub: Npub;

  phase: RoomPhase = "lobby";
  match: ChessMatch | null = null;
  /** true una vez liquidada la partida (ELO aplicado). Evita doble conteo si
   *  `finishMatch` reentra. */
  settled = false;

  /** Asiento por color. Host = blancas por defecto. */
  private readonly players = new Map<Npub, RoomPlayer>();
  /** Oferta de tablas pendiente del npub que la ofreció. */
  drawOfferBy: Npub | null = null;

  constructor(host: PlayerInit, id?: string) {
    // `id` externo = sala de un link `?join=<id>` (invite propio o Room Link de la
    // tienda), creada lazy. Sin id, generamos uno propio ("Crear sala" normal).
    this.id = id ?? `room_${randomBytes(6).toString("hex")}`;
    this.code = makeCode();
    this.hostNpub = host.npub;
    this.players.set(host.npub, {
      npub: host.npub,
      displayName: host.displayName,
      pubkey: host.pubkey,
      color: "w",
    });
  }

  get roster(): RoomPlayer[] {
    return [...this.players.values()];
  }

  get isFull(): boolean {
    return this.players.size >= 2;
  }

  hasPlayer(npub: Npub): boolean {
    return this.players.has(npub);
  }

  /** Sienta a un segundo jugador (negras). Idempotente para el mismo npub. */
  join(player: PlayerInit): RoomPlayer {
    const existing = this.players.get(player.npub);
    if (existing) return existing;
    if (this.isFull) throw new RoomError("ROOM_FULL", "La sala está completa");
    const seat: RoomPlayer = {
      npub: player.npub,
      displayName: player.displayName,
      pubkey: player.pubkey,
      color: "b",
    };
    this.players.set(player.npub, seat);
    return seat;
  }

  get white(): RoomPlayer | undefined {
    return this.roster.find((p) => p.color === "w");
  }

  get black(): RoomPlayer | undefined {
    return this.roster.find((p) => p.color === "b");
  }

  /** Crea la partida (reloj corriendo) cuando ambos jugadores están listos. */
  startMatch(now = Date.now()): ChessMatch {
    const white = this.white;
    const black = this.black;
    if (!white || !black)
      throw new RoomError("NOT_READY", "Faltan jugadores para empezar");
    this.match = new ChessMatch({
      matchId: `match_${this.id}`,
      white: white.npub,
      black: black.npub,
      clockMs: config.defaultClockMs,
      now,
    });
    this.phase = "playing";
    this.drawOfferBy = null;
    return this.match;
  }
}

export class RoomManager {
  private readonly byId = new Map<string, Room>();
  private readonly byCode = new Map<string, string>(); // code -> roomId

  create(host: PlayerInit): Room {
    const room = new Room(host);
    this.byId.set(room.id, room);
    this.byCode.set(room.code, room.id);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.byId.get(roomId);
  }

  /** `?join`: entra a la sala `roomId`; la crea lazy con ese
   *  id si no existe (el que abre primero es host/blancas). Idempotente por npub;
   *  lanza ROOM_FULL si está completa con otros dos jugadores. */
  enterByExternalId(roomId: string, player: PlayerInit): Room {
    const existing = this.byId.get(roomId);
    if (existing) {
      existing.join(player);
      return existing;
    }
    const room = new Room(player, roomId);
    this.byId.set(room.id, room);
    this.byCode.set(room.code, room.id);
    return room;
  }

  getByCode(code: string): Room | undefined {
    const id = this.byCode.get(code.toUpperCase());
    return id ? this.byId.get(id) : undefined;
  }

  all(): Room[] {
    return [...this.byId.values()];
  }
}

export class RoomError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RoomError";
  }
}

/** Código corto, legible, para compartir (sin caracteres ambiguos). */
function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (const byte of randomBytes(6)) out += alphabet[byte % alphabet.length];
  return out;
}
