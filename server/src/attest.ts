// MODO DE PRUEBA (panel diag `?ngptest=1`) — remover junto con web/src/nostr/diag.ts.
//
// Firma la atestación NGP kind:31338 ("marcador verificado") con la clave de ORÁCULO
// del juego (secreto de servidor `NGP_ATTESTATION_ORACLE_NSEC`). Es lo ÚNICO que un
// jugador no puede firmar por su cuenta: certifica un resultado que el server presenció.
// El cliente publica el evento a relays (acá NO tocamos I/O de relays).
//
// ⚠️ Para que Luna Negra lo cuente como VERIFICADO, la npub de este oráculo debe estar
// declarada como `["oracle", <pubkey>]` en el listing kind:30023 de la tienda del juego
// (isAuthorizedAttestation cierra esa delegación). Sin eso, Luna ve el 31338 pero no confía.

import { buildAttestationEvent, type NgpSigner } from "nostr-game-protocol/ngp";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import { decode } from "nostr-tools/nip19";
import { config } from "./config.js";

/** ¿Hay clave de oráculo configurada? Sin ella, el marcador verificado queda apagado. */
export function oracleEnabled(): boolean {
  return Boolean(process.env.NGP_ATTESTATION_ORACLE_NSEC);
}

let cached: NgpSigner | null = null;

/** Deriva un NgpSigner (getPublicKey + signEvent) desde el nsec del oráculo. */
function oracleSigner(): NgpSigner {
  if (cached) return cached;
  const nsec = process.env.NGP_ATTESTATION_ORACLE_NSEC;
  if (!nsec) throw new Error("NGP_ATTESTATION_ORACLE_NSEC no configurada");
  const decoded = decode(nsec.trim());
  if (decoded.type !== "nsec") throw new Error("NGP_ATTESTATION_ORACLE_NSEC no es un nsec válido");
  const sk = decoded.data;
  const pubkey = getPublicKey(sk);
  cached = {
    getPublicKey: async () => pubkey,
    signEvent: async (template) => finalizeEvent(template, sk),
  };
  return cached;
}

/**
 * Firma una atestación kind:31338 que certifica el marcador `score` del jugador
 * `playerPubkey` en el juego. `ref` único por prueba → registro permanente propio.
 */
export function buildTestAttestation(playerPubkey: string, score: number): Promise<Event> {
  return buildAttestationEvent(oracleSigner(), {
    gameCoord: config.gameCoord,
    ref: `ngptest-${Date.now()}`,
    playerPubkey,
    status: "verified",
    score,
  });
}
