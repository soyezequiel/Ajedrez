import { buildScoreEvent, type NgpSigner } from "nostr-game-protocol/ngp";
import { GAME_COORD, SCORE_BOARD } from "../config.js";
import { publishToWrite } from "./relays.js";

/**
 * Firma el marcador kind:31339 del jugador (score = rating ELO) y lo publica a
 * relays. Best-effort: Luna Negra lo proyecta a su ranking y cualquier cliente
 * Nostr lo puede leer. El puntaje firmado por cliente es falsificable — sirve
 * para el ranking social, no para repartir dinero.
 */
export async function publishRating(signer: NgpSigner, rating: number): Promise<void> {
  const event = await buildScoreEvent(signer, {
    gameCoord: GAME_COORD,
    board: SCORE_BOARD,
    score: rating,
    client: "ajedrez-web",
  });
  await publishToWrite(event);
}
