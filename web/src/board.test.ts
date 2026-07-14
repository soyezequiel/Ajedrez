import { describe, expect, it } from "vitest";
import { acceptsBoardInput, fenWithoutPiece, indexToSquare, parseFen, squareToIndex } from "./board.js";

describe("geometría del tablero", () => {
  it("convierte todas las casillas en ambos sentidos", () => {
    for (let index = 0; index < 64; index++) expect(squareToIndex(indexToSquare(index))).toBe(index);
  });

  it("interpreta una posición FEN sin perder piezas", () => {
    const pieces = parseFen("r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1");
    expect(pieces[squareToIndex("a8")]).toBe("bR");
    expect(pieces[squareToIndex("e8")]).toBe("bK");
    expect(pieces[squareToIndex("e5")]).toBe("wP");
    expect(pieces[squareToIndex("h1")]).toBe("wR");
  });

  it("rechaza nombres de casilla inválidos", () => {
    expect(squareToIndex("i4")).toBe(-1);
    expect(squareToIndex("a9")).toBe(-1);
    expect(squareToIndex("")).toBe(-1);
  });

  it("oculta sólo la pieza levantada y preserva el estado del FEN", () => {
    const fen = "r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 0 1";
    const lifted = fenWithoutPiece(fen, squareToIndex("e5"));
    expect(lifted).toBe("r3k2r/8/8/3p4/8/8/8/R3K2R w KQkq d6 0 1");
    expect(parseFen(lifted).filter(Boolean)).toHaveLength(parseFen(fen).filter(Boolean).length - 1);
  });

  it("bloquea el input si el tablero no está habilitado o hay una jugada pendiente", () => {
    expect(acceptsBoardInput(false, false)).toBe(false);
    expect(acceptsBoardInput(true, true)).toBe(false);
    expect(acceptsBoardInput(true, false)).toBe(true);
  });
});
