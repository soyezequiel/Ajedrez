import { describe, expect, it } from "vitest";
import { indexToSquare, parseFen, squareToIndex } from "./board.js";

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
});
