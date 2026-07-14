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

export type BalSignerPhase =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "awaiting_approval"
  | "connected"
  | "signing"
  | "encrypting"
  | "decrypting"
  | "signed"
  | "disconnecting"
  | "disconnected"
  | "rejected"
  | "error";

export type BalSignerStatus = {
  phase: BalSignerPhase;
  detail: string | null;
};

const IDLE_STATUS: BalSignerStatus = { phase: "idle", detail: null };
let balStatus = IDLE_STATUS;
let hasLauncherContext = false;
let transientTimer: ReturnType<typeof setTimeout> | null = null;
const statusListeners = new Set<(status: BalSignerStatus) => void>();

function setBalStatus(phase: BalSignerPhase, detail: string | null): void {
  if (transientTimer) {
    clearTimeout(transientTimer);
    transientTimer = null;
  }
  balStatus = { phase, detail };
  for (const listener of statusListeners) listener(balStatus);
}

function stableBalStatus(): BalSignerStatus {
  if (activeClient) return { phase: "connected", detail: "Luna Negra está firmando para Ajedrez" };
  if (hasLauncherContext) return { phase: "disconnected", detail: "Sin una sesión de firma activa" };
  return IDLE_STATUS;
}

function returnToStableAfter(delayMs: number): void {
  if (transientTimer) clearTimeout(transientTimer);
  transientTimer = setTimeout(() => {
    transientTimer = null;
    const stable = stableBalStatus();
    balStatus = stable;
    for (const listener of statusListeners) listener(stable);
  }, delayMs);
}

function errorDetail(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function isRejected(error: unknown): boolean {
  return error instanceof BalError
    && (error.code === "USER_REJECTED" || error.code === "PERMISSION_DENIED");
}

export function getBalSignerStatus(): BalSignerStatus {
  return balStatus;
}

export function subscribeBalSignerStatus(
  listener: (status: BalSignerStatus) => void,
): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

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

/** Indica si esta pestaña conserva un canal autenticable hacia Luna Negra. */
export function hasBalLauncherContext(): boolean {
  const origin = launcherOrigin();
  const opener = window.opener;
  return Boolean(origin && opener && typeof opener.postMessage === "function");
}

export async function tryBalLogin(
  onLauncherLogout: () => void,
  onConsentRequired?: () => void,
): Promise<ChessSigner | null> {
  const originFromUrl = validLauncherOrigin(new URLSearchParams(location.search).get("lnOrigin"));
  const origin = launcherOrigin();
  const opener = window.opener;
  if (!origin || !opener || typeof opener.postMessage !== "function") {
    hasLauncherContext = false;
    setBalStatus("idle", null);
    return null;
  }
  hasLauncherContext = true;
  setBalStatus(
    originFromUrl ? "connecting" : "reconnecting",
    originFromUrl ? "Negociando una sesión con Luna Negra" : "Recuperando el signer de Luna Negra",
  );

  let session: BalLoginSession;
  let reconnecting: Promise<BalLoginSession> | null = null;

  const connect = async (): Promise<BalLoginSession> => {
    const handleConsentRequired = (event: MessageEvent) => {
      if (event.source !== opener || event.origin !== origin) return;
      const message = event.data as { type?: unknown; gameId?: unknown } | null;
      if (
        message?.type === CONSENT_REQUIRED_MESSAGE
        && message.gameId === GAME_ID
      ) {
        setBalStatus("awaiting_approval", "Esperando tu autorización en Luna Negra");
        onConsentRequired?.();
      }
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
        hasLauncherContext = false;
        setBalStatus("disconnected", "Luna Negra cerró la sesión de firma");
        returnToStableAfter(3500);
        onLauncherLogout();
      },
    });
    const previous = activeClient;
    activeClient = client;
    try {
      const next = await client.login();
      if (previous && previous !== client) void previous.logout("game_logout");
      setBalStatus("connected", "Luna Negra está firmando para Ajedrez");
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
          setBalStatus("reconnecting", "La sesión venció; reconectando con Luna Negra");
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
      signEvent: (event: UnsignedEvent) => trackBalOperation(
        "signing",
        `Firmando evento kind ${event.kind}`,
        () => withReconnect((signer) => signer.signEvent(event)),
      ),
      nip04Encrypt: (peer, plaintext) => trackBalOperation(
        "encrypting",
        "Cifrando mensaje NIP-04",
        () => withReconnect((signer) => signer.nip04Encrypt(peer, plaintext)),
      ),
      nip04Decrypt: (peer, ciphertext) => trackBalOperation(
        "decrypting",
        "Descifrando mensaje NIP-04",
        () => withReconnect((signer) => signer.nip04Decrypt(peer, ciphertext)),
      ),
      nip44Encrypt: (peer, plaintext) => trackBalOperation(
        "encrypting",
        "Cifrando mensaje NIP-44",
        () => withReconnect((signer) => signer.nip44Encrypt(peer, plaintext)),
      ),
      nip44Decrypt: (peer, ciphertext) => trackBalOperation(
        "decrypting",
        "Descifrando mensaje NIP-44",
        () => withReconnect((signer) => signer.nip44Decrypt(peer, ciphertext)),
      ),
      close: () => session.signer.close(),
    };
  } catch (error) {
    activeClient = null;
    setBalStatus(
      isRejected(error) ? "rejected" : "error",
      errorDetail(error, isRejected(error) ? "Rechazaste la conexión" : "No se pudo conectar el signer"),
    );
    return null;
  }
}

async function trackBalOperation<T>(
  phase: "signing" | "encrypting" | "decrypting",
  detail: string,
  operation: () => Promise<T>,
): Promise<T> {
  setBalStatus(phase, detail);
  try {
    const result = await operation();
    if (phase === "signing") {
      setBalStatus("signed", "Firma completada");
      returnToStableAfter(1400);
    } else {
      setBalStatus("connected", "Operación criptográfica completada");
      returnToStableAfter(700);
    }
    return result;
  } catch (error) {
    setBalStatus(
      isRejected(error) ? "rejected" : "error",
      errorDetail(error, isRejected(error) ? "La operación fue rechazada" : "Falló la operación del signer"),
    );
    throw error;
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
  const client = activeClient;
  if (client) setBalStatus("disconnecting", "Cerrando la sesión con Luna Negra");
  activeClient = null;
  await client?.logout("game_logout");
  if (options.forgetLauncher) {
    forgetLauncherOrigin();
    hasLauncherContext = false;
    setBalStatus("idle", null);
  } else if (hasLauncherContext) {
    setBalStatus("disconnected", "La sesión de firma se cerró");
  }
}
