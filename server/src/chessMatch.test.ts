import { describe, expect, it } from "vitest";
import { ChessMatch, MatchError } from "./chessMatch.js";
import type { MovePayload, Npub } from "./types.js";

const WHITE = "npub1white";
const BLACK = "npub1black";

function newMatch(clockMs = 5 * 60 * 1000, now = Date.now()) {
  return new ChessMatch({ matchId: "m1", white: WHITE, black: BLACK, clockMs, now });
}

/** Captura el MatchError y devuelve su code (o falla si no lanzó). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof MatchError) return err.code;
    throw err;
  }
  throw new Error("se esperaba un MatchError y no se lanzó");
}

describe("ChessMatch — turnos y legalidad", () => {
  it("acepta una jugada legal de blancas y pasa el turno", () => {
    const m = newMatch();
    const snap = m.move(WHITE, { from: "e2", to: "e4" }, 1000);
    expect(snap.turn).toBe("b");
    expect(snap.lastMove).toEqual({ from: "e2", to: "e4", promotion: undefined });
  });

  it("rechaza jugar fuera de turno", () => {
    const m = newMatch();
    expect(codeOf(() => m.move(BLACK, { from: "e7", to: "e5" }))).toBe("NOT_YOUR_TURN");
  });

  it("rechaza una jugada ilegal", () => {
    const m = newMatch();
    expect(codeOf(() => m.move(WHITE, { from: "e2", to: "e5" }))).toBe("ILLEGAL_MOVE");
  });

  it("rechaza a quien no es jugador", () => {
    const m = newMatch();
    expect(codeOf(() => m.move("npub1intruso", { from: "e2", to: "e4" }))).toBe(
      "NOT_A_PLAYER",
    );
  });
});

describe("ChessMatch — finales", () => {
  it("detecta jaque mate (mate del loco) y declara ganador a negras", () => {
    const m = newMatch();
    const moves: Array<[Npub, MovePayload]> = [
      [WHITE, { from: "f2", to: "f3" }],
      [BLACK, { from: "e7", to: "e5" }],
      [WHITE, { from: "g2", to: "g4" }],
      [BLACK, { from: "d8", to: "h4" }], // Qh4# mate
    ];
    let snap = m.snapshot();
    for (const [who, mv] of moves) snap = m.move(who, mv);
    expect(snap.result).toEqual({ kind: "black_win", by: "checkmate" });
    expect(m.winnerNpubs()).toEqual([BLACK]);
    expect(m.isOver).toBe(true);
  });

  it("no permite seguir jugando una partida terminada", () => {
    const m = newMatch();
    m.resign(WHITE);
    expect(codeOf(() => m.move(BLACK, { from: "e7", to: "e5" }))).toBe("MATCH_OVER");
  });

  it("abandono: gana el rival", () => {
    const m = newMatch();
    const snap = m.resign(WHITE);
    expect(snap.result).toEqual({ kind: "black_win", by: "resign" });
    expect(m.winnerNpubs()).toEqual([BLACK]);
  });

  it("tablas por acuerdo → sin ganadores (reembolso)", () => {
    const m = newMatch();
    const snap = m.agreeDraw();
    expect(snap.result.kind).toBe("draw");
    expect(m.winnerNpubs()).toEqual([]);
  });

  it("timeout: si a blancas se le acaba el reloj, gana negras", () => {
    const m = newMatch(1000, 0); // 1s de reloj
    const snap = m.move(WHITE, { from: "e2", to: "e4" }, 2000);
    expect(snap.result).toEqual({ kind: "black_win", by: "timeout" });
    expect(m.winnerNpubs()).toEqual([BLACK]);
  });
});

describe("ChessMatch — ayudas de UI", () => {
  it("lista jugadas legales desde una casilla", () => {
    const m = newMatch();
    const moves = m.legalMovesFrom("e2");
    expect(moves).toContain("e3");
    expect(moves).toContain("e4");
  });
});
