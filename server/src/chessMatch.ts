import { Chess } from "chess.js";
import type {
  Color,
  MatchResult,
  MatchSnapshot,
  MovePayload,
  Npub,
} from "./types.js";

/**
 * Autoridad de una partida de ajedrez. El servidor es la ÚNICA fuente de verdad:
 * valida cada jugada con chess.js, lleva el reloj y declara el ganador. Los
 * clientes solo renderizan; no pueden falsear jugadas ni el resultado.
 */
export class ChessMatch {
  readonly matchId: string;
  readonly white: Npub;
  readonly black: Npub;

  private readonly chess = new Chess();
  private result: MatchResult = { kind: "ongoing" };
  private lastMove: MovePayload | null = null;

  private whiteClockMs: number;
  private blackClockMs: number;
  /** Momento en que empezó a correr el reloj del jugador en turno. */
  private turnStartedAt: number;

  constructor(opts: {
    matchId: string;
    white: Npub;
    black: Npub;
    clockMs: number;
    now?: number;
  }) {
    this.matchId = opts.matchId;
    this.white = opts.white;
    this.black = opts.black;
    this.whiteClockMs = opts.clockMs;
    this.blackClockMs = opts.clockMs;
    this.turnStartedAt = opts.now ?? Date.now();
  }

  get isOver(): boolean {
    return this.result.kind !== "ongoing";
  }

  /** Color del jugador con ese npub, o null si no participa. */
  colorOf(npub: Npub): Color | null {
    if (npub === this.white) return "w";
    if (npub === this.black) return "b";
    return null;
  }

  /**
   * Intenta aplicar una jugada del jugador `by`. Devuelve el snapshot resultante.
   * Lanza Error con código si la jugada es ilegal o no es su turno.
   */
  move(by: Npub, payload: MovePayload, now = Date.now()): MatchSnapshot {
    if (this.isOver) throw new MatchError("MATCH_OVER", "La partida terminó");

    const color = this.colorOf(by);
    if (!color) throw new MatchError("NOT_A_PLAYER", "No sos jugador de esta partida");
    if (color !== this.chess.turn())
      throw new MatchError("NOT_YOUR_TURN", "No es tu turno");

    // Cobrar el tiempo consumido ANTES de validar; si se quedó sin reloj, pierde.
    if (this.chargeClock(now)) return this.snapshot();

    let applied;
    try {
      applied = this.chess.move({
        from: payload.from,
        to: payload.to,
        promotion: payload.promotion ?? "q",
      });
    } catch {
      throw new MatchError("ILLEGAL_MOVE", "Jugada ilegal");
    }
    if (!applied) throw new MatchError("ILLEGAL_MOVE", "Jugada ilegal");

    this.lastMove = {
      from: applied.from,
      to: applied.to,
      promotion: applied.promotion as MovePayload["promotion"],
    };
    this.turnStartedAt = now;
    this.evaluateTerminal();
    return this.snapshot();
  }

  /** Un jugador abandona. El rival gana. */
  resign(by: Npub): MatchSnapshot {
    if (this.isOver) return this.snapshot();
    const color = this.colorOf(by);
    if (!color) throw new MatchError("NOT_A_PLAYER", "No sos jugador de esta partida");
    this.result =
      color === "w"
        ? { kind: "black_win", by: "resign" }
        : { kind: "white_win", by: "resign" };
    return this.snapshot();
  }

  /** Tablas por acuerdo (ambos aceptaron; la oferta/aceptación la maneja la sala). */
  agreeDraw(): MatchSnapshot {
    if (this.isOver) return this.snapshot();
    this.result = { kind: "draw", by: "agreement" };
    return this.snapshot();
  }

  /** Un jugador abandonó la sala / se desconectó sin volver. El rival gana. */
  forfeit(by: Npub): MatchSnapshot {
    if (this.isOver) return this.snapshot();
    const color = this.colorOf(by);
    if (!color) throw new MatchError("NOT_A_PLAYER", "No sos jugador de esta partida");
    this.result =
      color === "w"
        ? { kind: "black_win", by: "abandon" }
        : { kind: "white_win", by: "abandon" };
    return this.snapshot();
  }

  /**
   * Verifica el reloj del jugador en turno sin que haya jugada (llamar en un tick).
   * Si se le acabó el tiempo, declara timeout. Devuelve el snapshot.
   */
  tickClock(now = Date.now()): MatchSnapshot {
    if (!this.isOver) this.chargeClock(now);
    return this.snapshot();
  }

  /**
   * Descuenta el tiempo transcurrido al jugador en turno. Si llega a 0, setea el
   * resultado por timeout y devuelve true.
   */
  private chargeClock(now: number): boolean {
    const elapsed = Math.max(0, now - this.turnStartedAt);
    this.turnStartedAt = now;
    if (this.chess.turn() === "w") {
      this.whiteClockMs = Math.max(0, this.whiteClockMs - elapsed);
      if (this.whiteClockMs === 0) {
        this.result = { kind: "black_win", by: "timeout" };
        return true;
      }
    } else {
      this.blackClockMs = Math.max(0, this.blackClockMs - elapsed);
      if (this.blackClockMs === 0) {
        this.result = { kind: "white_win", by: "timeout" };
        return true;
      }
    }
    return false;
  }

  private evaluateTerminal(): void {
    if (this.chess.isCheckmate()) {
      // El que acaba de mover dio mate; el del turno actual es el que perdió.
      this.result =
        this.chess.turn() === "w"
          ? { kind: "black_win", by: "checkmate" }
          : { kind: "white_win", by: "checkmate" };
      return;
    }
    if (this.chess.isStalemate()) {
      this.result = { kind: "draw", by: "stalemate" };
      return;
    }
    if (this.chess.isInsufficientMaterial()) {
      this.result = { kind: "draw", by: "insufficient" };
      return;
    }
    if (this.chess.isThreefoldRepetition()) {
      this.result = { kind: "draw", by: "threefold" };
      return;
    }
    if (this.chess.isDraw()) {
      // chess.isDraw() cubre la regla de 50 movimientos (y otras tablas).
      this.result = { kind: "draw", by: "fifty" };
    }
  }

  /** Jugadas legales desde una casilla (para resaltar en el cliente). */
  legalMovesFrom(square: string): string[] {
    return this.chess
      .moves({ square: square as never, verbose: true })
      .map((m) => (typeof m === "string" ? m : m.to));
  }

  /**
   * Ganadores en términos de npub para reportar a Luna Negra:
   * un ganador → [npub]; tablas → [] (reembolso total).
   */
  winnerNpubs(): Npub[] {
    switch (this.result.kind) {
      case "white_win":
        return [this.white];
      case "black_win":
        return [this.black];
      case "draw":
        return [];
      default:
        return [];
    }
  }

  getResult(): MatchResult {
    return this.result;
  }

  snapshot(): MatchSnapshot {
    return {
      matchId: this.matchId,
      fen: this.chess.fen(),
      turn: this.chess.turn(),
      white: this.white,
      black: this.black,
      whiteClockMs: this.whiteClockMs,
      blackClockMs: this.blackClockMs,
      inCheck: this.chess.inCheck(),
      lastMove: this.lastMove,
      result: this.result,
    };
  }
}

export class MatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MatchError";
  }
}
