import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { ChessMatch } from "./chessMatch.js";
import type { BetInfo } from "./lunaNegra.js";
import type { Npub } from "./types.js";

export type RoomPhase = "lobby" | "awaiting_deposit" | "playing" | "finished";

export interface RoomPlayer {
  npub: Npub;
  displayName: string;
  color: "w" | "b" | null;
}

/** Una sala = un emparejamiento 1v1 con (opcional) apuesta en sats. */
export class Room {
  readonly id: string;
  readonly code: string;
  readonly hostNpub: Npub;
  readonly createdAt = Date.now();

  phase: RoomPhase = "lobby";
  stakeSats = 0;
  bet: BetInfo | null = null;
  match: ChessMatch | null = null;

  /** Asiento por color. Host = blancas por defecto. */
  private readonly players = new Map<Npub, RoomPlayer>();
  /** Oferta de tablas pendiente del npub que la ofreció. */
  drawOfferBy: Npub | null = null;

  constructor(host: { npub: Npub; displayName: string }) {
    this.id = `room_${randomBytes(6).toString("hex")}`;
    this.code = makeCode();
    this.hostNpub = host.npub;
    this.players.set(host.npub, {
      npub: host.npub,
      displayName: host.displayName,
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
  join(player: { npub: Npub; displayName: string }): RoomPlayer {
    const existing = this.players.get(player.npub);
    if (existing) return existing;
    if (this.isFull) throw new RoomError("ROOM_FULL", "La sala está completa");
    const seat: RoomPlayer = {
      npub: player.npub,
      displayName: player.displayName,
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

  inviteUrl(publicWebUrl: string): string {
    return `${publicWebUrl.replace(/\/$/, "")}/?join=${encodeURIComponent(this.id)}`;
  }
}

export class RoomManager {
  private readonly byId = new Map<string, Room>();
  private readonly byCode = new Map<string, string>(); // code -> roomId

  create(host: { npub: Npub; displayName: string }): Room {
    const room = new Room(host);
    this.byId.set(room.id, room);
    this.byCode.set(room.code, room.id);
    return room;
  }

  get(roomId: string): Room | undefined {
    return this.byId.get(roomId);
  }

  getByCode(code: string): Room | undefined {
    const id = this.byCode.get(code.toUpperCase());
    return id ? this.byId.get(id) : undefined;
  }

  remove(roomId: string): void {
    const room = this.byId.get(roomId);
    if (!room) return;
    this.byCode.delete(room.code);
    this.byId.delete(roomId);
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
