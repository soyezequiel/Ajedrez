/** Puerto de Ajedrez hacia BAL. Todo el protocolo vive en nostr-game-protocol. */
import { BalError, BalGameClient, WebPostMessageTransport } from "nostr-game-protocol/bal";
import type { ChessSigner, UnsignedEvent } from "./signer-core.js";

const GAME_ID = "ajedrez";
const LAUNCHER_ORIGIN_KEY = "ajedrez.bal.launcherOrigin.v1";
const CONSENT_REQUIRED_MESSAGE = "luna-negra:bal-consent-required";
const FOCUS_REQUEST_MESSAGE = "luna-negra:bal-focus-request";
const PERMISSIONS = [
  "get_public_key",
  "sign_event:1",
  "sign_event:13",
  "sign_event:22242",
  "sign_event:30315",
  "sign_event:31339",
  "sign_event:9734",
  "nip04_encrypt",
  "nip04_decrypt",
  "nip44_encrypt",
  "nip44_decrypt",
];

let activeClient: BalGameClient<Window> | null = null;
type BalLoginSession = Awaited<ReturnType<BalGameClient<Window>["login"]>>;

function validLauncherOrigin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.origin === raw && ["http:", "https:"].includes(parsed.protocol)
      ? parsed.origin
      : null;
  } catch { return null; }
}

/**
 * `cleanUrl()` quita `lnOrigin` después de autenticar, pero un F5 o una recarga por
 * deploy todavía necesita ese origen para volver a negociar el firmante efímero.
 * Lo conservamos por pestaña: no contiene credenciales y cada mensaje sigue
 * validando tanto `event.origin` como `event.source`.
 */
function launcherOrigin(): string | null {
  const fromUrl = validLauncherOrigin(new URLSearchParams(location.search).get("lnOrigin"));
  if (fromUrl) {
    try { sessionStorage.setItem(LAUNCHER_ORIGIN_KEY, fromUrl); }
    catch { /* storage bloqueado: BAL sigue funcionando hasta una recarga */ }
    return fromUrl;
  }
  try { return validLauncherOrigin(sessionStorage.getItem(LAUNCHER_ORIGIN_KEY)); }
  catch { return null; }
}

function forgetLauncherOrigin(): void {
  try { sessionStorage.removeItem(LAUNCHER_ORIGIN_KEY); }
  catch { /* noop */ }
}

export async function tryBalLogin(
  onLauncherLogout: () => void,
  onConsentRequired?: () => void,
): Promise<ChessSigner | null> {
  const origin = launcherOrigin();
  const opener = window.opener;
  if (!origin || !opener || typeof opener.postMessage !== "function") return null;

  let session: BalLoginSession;
  let reconnecting: Promise<BalLoginSession> | null = null;

  const connect = async (): Promise<BalLoginSession> => {
    const handleConsentRequired = (event: MessageEvent) => {
      if (event.source !== opener || event.origin !== origin) return;
      const message = event.data as { type?: unknown; gameId?: unknown } | null;
      if (
        message?.type === CONSENT_REQUIRED_MESSAGE
        && message.gameId === GAME_ID
      ) onConsentRequired?.();
    };
    window.addEventListener("message", handleConsentRequired);

    const client = new BalGameClient({
      gameId: GAME_ID,
      requestedPermissions: PERMISSIONS,
      launcherOrigin: origin,
      launcherPeer: opener,
      transport: new WebPostMessageTransport(window),
      onLauncherLogout: () => {
        // Una sesión anterior puede avisar su cierre después de que ya la
        // reemplazamos. Solo la sesión vigente puede cerrar el login del juego.
        if (activeClient !== client) return;
        activeClient = null;
        forgetLauncherOrigin();
        onLauncherLogout();
      },
    });
    const previous = activeClient;
    activeClient = client;
    try {
      const next = await client.login();
      if (previous && previous !== client) void previous.logout("game_logout");
      return next;
    } catch (error) {
      if (activeClient === client) activeClient = null;
      throw error;
    } finally {
      window.removeEventListener("message", handleConsentRequired);
    }
  };

  try {
    session = await connect();

    /**
     * El launcher conserva la identidad, pero una recarga mata el servicio
     * NIP-46 efímero. El token del game server puede mantener la UI logueada y
     * dejar al usuario sin firma para retos. Ante el primer fallo renegociamos
     * BAL y repetimos exactamente una vez la operación pendiente.
     */
    const withReconnect = async <T>(
      operation: (signer: BalLoginSession["signer"]) => Promise<T>,
    ): Promise<T> => {
      try {
        return await operation(session.signer);
      } catch (firstError) {
        try {
          reconnecting ??= connect().finally(() => { reconnecting = null; });
          session = await reconnecting;
          return await operation(session.signer);
        } catch (reconnectError) {
          console.warn("[BAL] no se pudo recuperar la sesión", {
            firstError,
            reconnectError,
          });
          throw reconnectError;
        }
      }
    };

    return {
      method: "nip46",
      getPublicKey: () => withReconnect((signer) => signer.getPublicKey()),
      signEvent: (event: UnsignedEvent) => withReconnect((signer) => signer.signEvent(event)),
      nip04Encrypt: (peer, plaintext) => withReconnect((signer) => signer.nip04Encrypt(peer, plaintext)),
      nip04Decrypt: (peer, ciphertext) => withReconnect((signer) => signer.nip04Decrypt(peer, ciphertext)),
      nip44Encrypt: (peer, plaintext) => withReconnect((signer) => signer.nip44Encrypt(peer, plaintext)),
      nip44Decrypt: (peer, ciphertext) => withReconnect((signer) => signer.nip44Decrypt(peer, ciphertext)),
      close: () => session.signer.close(),
    };
  } catch (error) {
    activeClient = null;
    if (error instanceof BalError) return null;
    return null;
  }
}

/** Pide al launcher que recupere el foco y además hace el intento directo. */
export function requestBalLauncherFocus(): void {
  const origin = launcherOrigin();
  const opener = window.opener;
  if (!origin || !opener) return;
  try {
    opener.postMessage(
      { type: FOCUS_REQUEST_MESSAGE, gameId: GAME_ID },
      origin,
    );
  } catch { /* el fallback visual explica cómo volver manualmente */ }
  try {
    opener.focus();
  } catch { /* COOP o el navegador pueden restringir focus entre pestañas */ }
}

export async function logoutBal(options: { forgetLauncher?: boolean } = {}): Promise<void> {
  if (options.forgetLauncher) forgetLauncherOrigin();
  const client = activeClient;
  activeClient = null;
  await client?.logout("game_logout");
}
