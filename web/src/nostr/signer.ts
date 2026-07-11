import type { Event, EventTemplate } from "nostr-tools";
import type { NgpSigner } from "nostr-game-protocol/ngp";

/** Proveedor NIP-07 inyectado por la extensión (Alby, nos2x, …). */
interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<Event>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

const METHOD_KEY = "ajedrez.nostr.method.v1";

/** Kind de autenticación cliente (NIP-42): el jugador firma el reto del server. */
const AUTH_KIND = 22242;

/**
 * Adapta `window.nostr` a `NgpSigner`. El shape de firma coincide tal cual; el
 * nip44 de NIP-07 vive bajo `nostr.nip44.{encrypt,decrypt}`, así que lo mapeamos
 * a `nip44Encrypt/Decrypt` que espera el SDK para los retos NIP-17.
 */
export function makeSigner(nostr: Nip07Provider): NgpSigner {
  return {
    getPublicKey: () => nostr.getPublicKey(),
    signEvent: (template: EventTemplate) => nostr.signEvent(template),
    nip44Encrypt: nostr.nip44 ? (pk, pt) => nostr.nip44!.encrypt(pk, pt) : undefined,
    nip44Decrypt: nostr.nip44 ? (pk, ct) => nostr.nip44!.decrypt(pk, ct) : undefined,
  };
}

/** Algunas extensiones inyectan `window.nostr` después de cargar la página. */
export async function waitForNostr(timeoutMs = 3000): Promise<Nip07Provider | null> {
  const started = Date.now();
  while (!window.nostr && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return window.nostr ?? null;
}

/** Firma el evento kind:22242 sobre el reto del server (prueba de posesión). */
export function signAuthChallenge(signer: NgpSigner, challenge: string): Promise<Event> {
  return signer.signEvent({
    kind: AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["challenge", challenge],
      ["relay", location.origin],
    ],
    content: "ajedrez-login",
  });
}

// -- persistencia del método de login (no la clave: NIP-07 vive en la extensión) --

export function rememberNostrLogin(): void {
  localStorage.setItem(METHOD_KEY, "nip07");
}

export function forgetNostrLogin(): void {
  localStorage.removeItem(METHOD_KEY);
}

export function hasStoredNostrLogin(): boolean {
  return localStorage.getItem(METHOD_KEY) === "nip07";
}
