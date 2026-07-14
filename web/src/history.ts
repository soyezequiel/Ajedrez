import { Chess } from "chess.js";
import type { MovePayload } from "./protocol.js";

export interface HistoryPosition {
  /** Cantidad de medias jugadas aplicadas; 0 representa la posición inicial. */
  ply: number;
  fen: string;
  san: string | null;
  move: MovePayload | null;
}

/** Reconstruye posiciones navegables desde el historial SAN autoritativo. */
export function buildHistoryPositions(sanHistory: readonly string[]): HistoryPosition[] {
  const chess = new Chess();
  const positions: HistoryPosition[] = [{ ply: 0, fen: chess.fen(), san: null, move: null }];
  sanHistory.forEach((san, index) => {
    const applied = chess.move(san);
    positions.push({
      ply: index + 1,
      fen: chess.fen(),
      san,
      move: {
        from: applied.from,
        to: applied.to,
        promotion: applied.promotion as MovePayload["promotion"],
      },
    });
  });
  return positions;
}
