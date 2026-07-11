import type { NgpSigner } from "nostr-game-protocol/ngp";
import { GAME_COORD } from "../config.js";
import { publishToWrite } from "./relays.js";

/**
 * Publica una nota kind:1 anclada al juego (`a`=gameCoord): reseña, comentario o
 * logro. Luna Negra la lee y la muestra en la ficha del juego. Best-effort.
 */
export async function publishNote(signer: NgpSigner, content: string): Promise<void> {
  const event = await signer.signEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["a", GAME_COORD]],
    content,
  });
  await publishToWrite(event);
}
