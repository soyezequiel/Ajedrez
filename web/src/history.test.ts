import { describe, expect, it } from "vitest";
import { buildHistoryPositions } from "./history.js";

describe("navegación del historial", () => {
  it("incluye la posición inicial y una posición por cada jugada", () => {
    const positions = buildHistoryPositions(["e4", "e5", "Nf3"]);
    expect(positions).toHaveLength(4);
    expect(positions[0]?.move).toBeNull();
    expect(positions[1]?.move).toMatchObject({ from: "e2", to: "e4" });
    expect(positions[3]?.move).toMatchObject({ from: "g1", to: "f3" });
  });

  it("restaura exactamente la posición de una media jugada", () => {
    const positions = buildHistoryPositions(["d4", "d5", "c4"]);
    expect(positions[2]?.fen.split(" ")[0]).toBe("rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR");
  });
});
