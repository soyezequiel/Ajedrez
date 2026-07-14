import "./styles.css";
import { WS_URL } from "./config.js";
import { Net } from "./net.js";
import { createBoard, type BoardController, type LegalTargets, type MoveFn } from "./board.js";
import { Chess, type Square } from "chess.js";
import { buildHistoryPositions, type HistoryPosition } from "./history.js";
import { clockAriaLabel, clockUrgency, formatClockMs } from "./clock.js";
import {
  clearActiveSigner,
  createNip07Signer,
  generateLocalSigner,
  hasStoredSigner,
  importNsec,
  restoreSigner,
  setActiveSigner,
  setEphemeralActiveSigner,
  signAuthChallenge,
  toNgpSigner,
  updateStoredPubkey,
  waitForNip07,
  type ChessSigner,
} from "./nostr/signer-core.js";
import { logoutBal, requestBalLauncherFocus, tryBalLogin } from "./nostr/bal-login.js";
import { connectBunker, startNostrConnect } from "./nostr/signer-nip46.js";
import QRCode from "qrcode";
import { fetchProfile, fetchProfiles, type NostrProfile } from "./nostr/relays.js";
import { fetchContacts } from "./nostr/contacts.js";
import { startRoomLinkInviteInbox, type RoomLinkInvite } from "./nostr/room-link-inbox.js";
import {
  fetchKnownChessPlayers,
  loadFriendAffinities,
  prioritizeFriends,
  rememberFriendActivity,
  type FriendAffinities,
} from "./nostr/friend-priority.js";
import { publishRating } from "./nostr/score.js";
import { createPresence, type PresenceController } from "./nostr/presence.js";
import { sendChallenge, startChallengeInbox, toPubkeyHex } from "./nostr/challenge.js";
import { publishNote } from "./nostr/social.js";
import { createZapInvoice } from "./nostr/zap.js";
// MODO DE PRUEBA (panel diag `?ngptest=1`) — remover con nostr/diag.ts.
import { isNgpTestMode, mountDiagPanel } from "./nostr/diag.js";
import { startVersionGuard } from "./version.js";
import { trackUx } from "./metrics.js";
import {
  hapticsEnabled,
  playFeedback,
  playSound,
  setHapticsEnabled,
  setSoundEnabled,
  soundEnabled,
  type SoundName,
} from "./sound.js";
import type { NgpSigner, ParsedChallenge } from "nostr-game-protocol/ngp";
import type {
  BetView,
  Color,
  MatchSnapshot,
  PlayerMastery,
  RatingChange,
  RoomPlayer,
  RoomView,
  SessionIdentity,
  AchievementId,
} from "./protocol.js";

const NAME_KEY = "ajedrez.name.v1";
const CLOCK_OPTIONS = [1, 3, 5, 10, 15, 30] as const;

function createConfiguredRoom(): void {
  net.createRoom();
}

/** Sala actual persistida por pestaña: un F5 en el lobby/partida re-une a la sala
 *  (el server re-admite por identidad estable y cancela el timer de abandono).
 *  sessionStorage a propósito: dos pestañas de prueba no se pisan entre sí. */
const ROOM_KEY = "ajedrez.room.v1";

function readSavedRoom(): string | null {
  try {
    return sessionStorage.getItem(ROOM_KEY);
  } catch {
    return null;
  }
}
function writeSavedRoom(roomId: string): void {
  try {
    sessionStorage.setItem(ROOM_KEY, roomId);
  } catch {
    /* storage bloqueado */
  }
}
function clearSavedRoom(): void {
  try {
    sessionStorage.removeItem(ROOM_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Vuelve al inicio sin recargar la pestaña. La identidad, el WebSocket y el
 * firmante BAL pertenecen a la sesión del juego, no a una sala particular.
 */
function leaveRoomLocally(reason?: string): void {
  clearSavedRoom();
  board?.destroy();
  board = null;
  state.room = null;
  state.match = null;
  state.matchReceivedAt = 0;
  state.ready = false;
  state.drawOfferBy = null;
  state.ended = null;
  state.myRating = null;
  state.rematchRequested = false;
  state.rematchOffer = null;
  state.bet = null;
  state.myBetInvoice = null;
  state.newlyEarned = [];
  pendingMove = null;
  viewedHistoryPly = null;
  clockAlertMatchId = "";
  ownClockAlertLevel = 0;
  document.body.classList.remove("celebrate-win", "celebrate-loss");
  renderHome();
  if (reason) toast(reason);
}

/** Cómo está autenticado el jugador en esta sesión (para re-auth al reconectar). */
type LoginMode =
  | { kind: "guest"; name: string }
  | { kind: "nostr"; signer: NgpSigner; rawSigner: ChessSigner; displayName: string };
let login: LoginMode | null = null;

/** Controlador de presencia NIP-38 (solo login Nostr). */
let presence: PresenceController | null = null;

/** Corta la suscripción al inbox de retos NIP-17 (solo Nostr). */
let inboxStop: (() => void) | null = null;

/** Perfiles y contactos Nostr usados por avatares e invitaciones. */
const playerProfiles = new Map<string, NostrProfile>();
type ChessFriend = { pubkey: string; name: string; picture: string | null };
const FRIENDS_CACHE_KEY = "ajedrez.challengeFriends.v1";
let friends: ChessFriend[] = [];
let friendsLoading = false;
let friendsLoadingFor: string | null = null;
let friendsLoadedFor: string | null = null;
let friendAffinitiesFor: string | null = null;
let friendAffinities: FriendAffinities = new Map();

/** Reto pendiente de enviar: se dispara cuando se crea la sala del retador. */
let pendingChallenge: { toPubkey: string } | null = null;

/** Presencia activa desde que autenticás (no desde que entrás a una partida) y
 *  mientras el juego esté ABIERTO — aunque la pestaña quede de fondo (mirar la
 *  tienda no te baja). Con extensión/bunker la primera firma puede promptar al
 *  cargar — decisión de producto. Se limpia al cerrar sesión (logout) o la
 *  pestaña (pagehide, clear pre-firmado); si el clear no sale (crash), el TTL de
 *  180s la vence solo. */
function ensurePresence(): PresenceController | null {
  if (login?.kind !== "nostr") return null;
  // La pubkey llavea el throttle persistido del manager (no heredar presencia
  // de otra cuenta); en `authed` la identidad ya está seteada.
  presence ??= createPresence(login.signer, state.identity?.pubkey);
  return presence;
}

// Al CERRAR la pestaña/ventana (o navegar afuera) con una partida abierta, limpiar
// la presencia NIP-38. Antes `stop()` solo se llamaba al volver al home o hacer
// logout, así que cerrar el juego dejaba la presencia colgada hasta que vencía su TTL
// (240s): en la tienda seguías apareciendo "Jugando Ajedrez". `pagehide` es la señal
// correcta de teardown (a diferencia de `visibilitychange`, no dispara al alt-tabear).
// Usamos `clearNow()` (SÍNCRONO, con el clear pre-firmado): firmar en el unload no
// llega con NIP-07/46, pero un `ws.send` sincrónico sobre el socket ya abierto suele
// salir. Si aun así no llega, el TTL + la reconciliación de Luna la bajan sin parpadeo.
// `event.persisted` = va al bfcache y puede restaurarse → no la limpiamos.
window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  presence?.clearNow();
  void logoutBal();
});

// OJO: acá NO hay gating por `visibilitychange` — es a propósito y ya se probó
// dos veces que ambas variantes están MAL: limpiar al ocultar te baja apenas mirás
// la tienda, y pausar el latido al ocultar te deja morir por TTL en ~1 min mientras
// mirás la tienda ("aparece un rato y se va"). "Jugando" = el juego ABIERTO: el
// heartbeat corre aunque la pestaña esté de fondo (el navegador lo estrangula a
// ~1/min; el TTL de 180s lo tolera). El cierre real limpia vía `pagehide`.

const app = document.getElementById("app")!;
const net = new Net(WS_URL);

// Si la foto remota ya no existe, quitamos el icono roto y quedan las iniciales.
document.addEventListener("error", (event) => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.matches("[data-avatar-image]")) image.remove();
}, true);

interface State {
  identity: SessionIdentity | null;
  room: RoomView | null;
  match: MatchSnapshot | null;
  matchReceivedAt: number;
  ready: boolean;
  drawOfferBy: string | null;
  ended: { winnerNpubs: string[]; text: string; sub: string } | null;
  /** Cambio de rating ELO propio de la última partida (solo login Nostr). */
  myRating: RatingChange | null;
  /** ¿Ya pedí revancha en esta pantalla de resultado? */
  rematchRequested: boolean;
  /** Npub del rival que pidió revancha (banner "aceptar"). */
  rematchOffer: string | null;
  /** ¿El server tiene el escrow de apuestas activo? */
  betsEnabled: boolean;
  /** Apuesta en curso de la sala, o null. */
  bet: BetView | null;
  /** Invoice de depósito propio (para pagar con billetera). */
  myBetInvoice: { bolt11: string | null; amountSats: number; stakeSats: number } | null;
  mastery: PlayerMastery | null;
  newlyEarned: AchievementId[];
}

const state: State = {
  identity: null,
  room: null,
  match: null,
  matchReceivedAt: 0,
  ready: false,
  drawOfferBy: null,
  ended: null,
  myRating: null,
  rematchRequested: false,
  rematchOffer: null,
  betsEnabled: false,
  bet: null,
  myBetInvoice: null,
  mastery: null,
  newlyEarned: [],
};

let board: BoardController | null = null;
let pendingMove: { requestId: string; from: string; to: string } | null = null;
/** null = posición autoritativa en vivo; número = ply histórico seleccionado. */
let viewedHistoryPly: number | null = null;
let clockAlertMatchId = "";
let ownClockAlertLevel: 0 | 1 | 2 = 0;

// --------------------------------------------------------------- arranque

function storedName(): string | null {
  return sessionStorage.getItem(NAME_KEY);
}

/** Link de entrada a sala. `?join=<id>` es el formato estándar (NGP): sirve para el
 *  invite propio Y para el Room Link de la tienda. La sala se crea lazy (unir-o-crear)
 *  al abrir el link — por eso el id puede no pre-existir. Validamos el formato. */
function pendingJoin(): string | null {
  const v = new URLSearchParams(location.search).get("join");
  return v && /^[A-Za-z0-9]{4}$/.test(v) ? v.toUpperCase() : null;
}

function start(): void {
  startVersionGuard(toast); // recarga sola si el server anuncia un build nuevo
  try {
    const flash = sessionStorage.getItem("ajedrez.flash.v1");
    if (flash) {
      sessionStorage.removeItem("ajedrez.flash.v1");
      setTimeout(() => toast(flash), 250);
    }
  } catch { /* storage bloqueado */ }
  // "Salir" (delegado: la topbar se re-renderiza en cada pantalla). En plena
  // partida pide confirmación: salir implica abandonar.
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const technologyBtn = target.closest?.("[data-action=technology]") as HTMLButtonElement | null;
    if (technologyBtn) {
      openTechnologyIntro(technologyBtn);
      return;
    }
    const soundBtn = target.closest?.("[data-action=sound]") as HTMLButtonElement | null;
    if (soundBtn) {
      setSoundEnabled(!soundEnabled());
      soundBtn.innerHTML = `${soundEnabled() ? "●" : "○"}<span>Sonido</span>`;
      soundBtn.setAttribute("aria-label", soundEnabled() ? "Sonido: silenciar" : "Sonido: activar");
      if (soundEnabled()) playSound("move"); // feedback inmediato
      return;
    }
    const hapticsBtn = target.closest?.("[data-action=haptics]") as HTMLButtonElement | null;
    if (hapticsBtn) {
      setHapticsEnabled(!hapticsEnabled());
      hapticsBtn.textContent = hapticsEnabled() ? "Háptica activa" : "Háptica apagada";
      playFeedback("ui");
      return;
    }
    const btn = target.closest?.("[data-action=logout]") as HTMLButtonElement | null;
    if (!btn) return;
    const inGame = state.room?.phase === "playing" && !state.ended;
    if (inGame) armButton(btn, "¿Salir y abandonar?", logout);
    else logout();
  });
  wireNet();
  void startLoginFlow();
}

async function startLoginFlow(): Promise<void> {
  // BAL tiene prioridad cuando Luna Negra conserva el canal opener. No usamos un
  // token viejo: get_public_key debe fijar la identidad activa elegida por Luna.
  const balSigner = await tryBalLogin(
    () => {
      clearActiveSigner();
      clearSessionToken();
      login = null;
      state.identity = null;
      renderLogin();
    },
    renderBalConsentRequired,
  );
  if (balSigner) {
    clearSessionToken();
    setEphemeralActiveSigner(balSigner);
    await beginNostr(balSigner);
    return;
  }

  // Con token: sesión inmediata sin depender del firmador (se restaura de fondo).
  const token = readSessionToken();
  if (token) return authViaToken(token);
  // Sin token pero con firmador guardado (raro): restaurar y firmar el challenge.
  if (hasStoredSigner()) return void restoreNostr();
  const name = storedName();
  if (!name) return renderLogin();
  login = { kind: "guest", name };
  renderConnecting();
  net.connect();
  net.auth(name);
}

function loginWith(name: string): void {
  const trimmed = name.trim();
  sessionStorage.setItem(NAME_KEY, trimmed);
  login = { kind: "guest", name: trimmed };
  renderConnecting();
  net.connect();
  net.auth(trimmed);
}

/** Caché del nombre de perfil por pubkey: el login no espera a los relays. Cachea
 *  también el resultado negativo (name:null = "sé que no tiene perfil") para que
 *  los logins repetidos de una clave sin kind:0 tampoco esperen. */
const PROFILE_CACHE_KEY = "ajedrez.profile.v1";

function readCachedProfile(pubkey: string): { known: boolean; name: string | null; picture: string | null } {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return { known: false, name: null, picture: null };
    const parsed = JSON.parse(raw) as { pubkey?: string; name?: string | null; picture?: string | null };
    if (parsed.pubkey?.toLowerCase() !== pubkey.toLowerCase()) return { known: false, name: null, picture: null };
    return { known: true, name: parsed.name ?? null, picture: parsed.picture ?? null };
  } catch {
    return { known: false, name: null, picture: null };
  }
}

function writeCachedProfile(pubkey: string, name: string | null, picture: string | null): void {
  try {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ pubkey: pubkey.toLowerCase(), name, picture }));
  } catch {
    /* storage bloqueado */
  }
}

/** Fetch del perfil en curso (el challenge lo espera un ratito solo si no hay caché). */
let profileFetch: Promise<unknown> | null = null;
/** ¿Ya conocemos el perfil de esta pubkey (aunque sea "no tiene")? → no esperar. */
let profileKnown = false;

/** Token de sesión Nostr (emitido por el server): reconecta sin re-firmar, como la
 *  cookie de Luna. Se guarda por 30 días y rota en cada authed. */
const SESSION_TOKEN_KEY = "ajedrez.session.v1";
function readSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}
function writeSessionToken(token: string): void {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    /* storage bloqueado */
  }
}
function clearSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    /* noop */
  }
}

/** Autentica la conexión Nostr: por token si lo hay (sin firmar), si no por challenge. */
function sendNostrAuth(): void {
  const token = readSessionToken();
  if (token) net.authToken(token);
  else net.authChallenge();
}

/**
 * Autentica con un ChessSigner ya obtenido (cualquier método: nip07/nip46/local).
 * Conecta al server DE INMEDIATO; el nombre de perfil se resuelve en paralelo
 * (caché primero, relays de fondo) para no demorar el login.
 */
async function beginNostr(signer: ChessSigner): Promise<void> {
  renderConnecting();
  const token = readSessionToken();
  if (token) {
    // Reconexión/reload: autenticamos por TOKEN sin bloquear en el firmador. La
    // extensión puede tardar o directamente colgarse en getPublicKey; la sesión no
    // debe depender de eso. No llamamos getPublicKey acá; la primera firma llega
    // con la presencia (al autenticar), que con extensión puede promptar al abrir.
    login = { kind: "nostr", signer: toNgpSigner(signer), rawSigner: signer, displayName: "" };
    net.connect();
    net.authToken(token);
    return;
  }
  // Primer login (sin token todavía): necesitamos la pubkey y firmar el challenge.
  let pubkey: string;
  try {
    pubkey = await signer.getPublicKey();
  } catch {
    clearActiveSigner();
    login = null;
    toast("No se pudo obtener tu clave Nostr.");
    return renderLogin();
  }
  updateStoredPubkey(pubkey);
  const cached = readCachedProfile(pubkey);
  profileKnown = cached.known;
  login = { kind: "nostr", signer: toNgpSigner(signer), rawSigner: signer, displayName: cached.name ?? "" };
  playerProfiles.set(pubkey, { name: cached.name, picture: cached.picture, lud16: null });
  // Perfil en paralelo: refresca la caché (positiva o negativa) y el nombre si
  // todavía no se mandó al server.
  profileFetch = fetchProfile(pubkey)
    .then((p) => {
      const profile = mergePlayerProfile(pubkey, p);
      writeCachedProfile(pubkey, profile.name, profile.picture);
      if (profile.name && login?.kind === "nostr" && !login.displayName) login.displayName = profile.name;
    })
    .catch(() => {});
  net.connect();
  net.authChallenge();
}

/**
 * Signer "perezoso": difiere a un firmador que se está restaurando en segundo plano.
 * Permite tener sesión (por token) ANTES de que el firmador esté listo; las features
 * que lo usen (marcador, retos) esperan a que resuelva. Si nunca resuelve (extensión
 * ausente), esas features fallan solas — pero la sesión/partida sigue andando.
 */
function lazySigner(p: Promise<ChessSigner | null>): ChessSigner {
  const real = async (): Promise<ChessSigner> => {
    const s = await p;
    if (!s) throw new Error("Firmador Nostr no disponible");
    return s;
  };
  return {
    method: "nip07",
    getPublicKey: async () => (await real()).getPublicKey(),
    signEvent: async (e) => (await real()).signEvent(e),
    nip44Encrypt: async (pk, pt) => {
      const s = await real();
      if (!s.nip44Encrypt) throw new Error("sin NIP-44");
      return s.nip44Encrypt(pk, pt);
    },
    nip44Decrypt: async (pk, ct) => {
      const s = await real();
      if (!s.nip44Decrypt) throw new Error("sin NIP-44");
      return s.nip44Decrypt(pk, ct);
    },
    nip04Encrypt: async (pk, pt) => {
      const s = await real();
      if (!s.nip04Encrypt) throw new Error("sin NIP-04");
      return s.nip04Encrypt(pk, pt);
    },
    nip04Decrypt: async (pk, ct) => {
      const s = await real();
      if (!s.nip04Decrypt) throw new Error("sin NIP-04");
      return s.nip04Decrypt(pk, ct);
    },
  };
}

/**
 * Reload/arranque con token: autentica por token DE INMEDIATO (sin esperar al
 * firmador), y restaura el firmador en segundo plano para las features Nostr. Así
 * la sesión no se pierde aunque la extensión tarde o se cuelgue en getPublicKey.
 */
function authViaToken(token: string): void {
  renderConnecting();
  const restorePromise = restoreSigner();
  const lazy = lazySigner(restorePromise);
  login = { kind: "nostr", signer: toNgpSigner(lazy), rawSigner: lazy, displayName: "" };
  net.connect();
  net.authToken(token);
  restorePromise
    .then((s) => {
      // Reemplazamos el firmador perezoso por el real para las features, sin llamar
      // getPublicKey/perfil acá: la sesión ya vale por token. La primera firma llega
      // con la presencia (al autenticar), que con extensión puede promptar al abrir.
      if (s && login?.kind === "nostr") {
        login.signer = toNgpSigner(s);
        login.rawSigner = s;
      }
    })
    .catch(() => {});
}

/**
 * Restaura la sesión Nostr guardada al reabrir. Si falla (p. ej. la extensión no
 * está lista todavía) NO borra la sesión: cae al login pero reintenta al recargar.
 */
async function restoreNostr(): Promise<void> {
  renderConnecting();
  const signer = await restoreSigner();
  if (!signer) return renderLogin();
  await beginNostr(signer);
}

/** Login con extensión NIP-07 (Alby/nos2x). */
async function loginNip07(): Promise<void> {
  renderConnecting();
  const provider = await waitForNip07(1500);
  if (!provider) {
    toast("No se detectó extensión Nostr. Probá Alby o nos2x.");
    return renderLogin();
  }
  const signer = createNip07Signer();
  setActiveSigner(signer, { method: "nip07" });
  await beginNostr(signer);
}

/** Login con firmante remoto por bunker:// o NIP-05 (usuario@dominio). */
async function loginBunker(input: string): Promise<void> {
  renderConnecting();
  try {
    const { signer, stored } = await connectBunker(input, () =>
      toast("El firmante pide autorización — revisá tu app de firma"),
    );
    setActiveSigner(signer, stored);
    await beginNostr(signer);
  } catch (e) {
    toast(e instanceof Error ? e.message : "No se pudo conectar al firmante");
    renderLogin();
  }
}

/** Login con clave local: nsec pegado o clave nueva generada en este navegador. */
function loginLocal(nsec?: string): void {
  let signer: ChessSigner;
  let storedNsec: string;
  try {
    if (nsec && nsec.trim()) {
      signer = importNsec(nsec);
      storedNsec = nsec.trim();
    } else {
      const gen = generateLocalSigner();
      signer = gen.signer;
      storedNsec = gen.nsec;
    }
  } catch (e) {
    return void toast(e instanceof Error ? e.message : "nsec inválido");
  }
  setActiveSigner(signer, { method: "local", nsec: storedNsec });
  void beginNostr(signer);
}

/** Cierra la sesión (Nostr o invitado) y vuelve al login. */
function logout(): void {
  // El logout explícito sí olvida el launcher. Los teardown transitorios usan
  // logoutBal() sin esta opción para poder renegociar BAL si la página se recarga.
  void logoutBal({ forgetLauncher: true });
  clearActiveSigner();
  clearSessionToken();
  clearSavedRoom();
  sessionStorage.removeItem(NAME_KEY);
  login = null;
  state.identity = null;
  // stop() (SDK ≥0.4) despacha el clear pre-firmado SINCRÓNICAMENTE antes de
  // sus awaits, pero al clear FRESCO (que pisa seguro) le damos hasta 1.5s
  // antes de recargar — recargar sin esperar abortaba el clear en vuelo y
  // "Jugando Ajedrez" quedaba colgado hasta vencer su TTL.
  const stopping = presence?.stop() ?? Promise.resolve();
  presence = null;
  inboxStop?.();
  inboxStop = null;
  void Promise.race([
    stopping,
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]).finally(() => location.reload());
}

/** Arranca la bandeja de retos NIP-17 (una vez, solo con login Nostr). */
function startInbox(): void {
  if (inboxStop || login?.kind !== "nostr") return;
  const pubkey = state.identity?.pubkey;
  if (!pubkey) return;
  const stopChallenge = startChallengeInbox(login.signer, pubkey, showIncomingChallenge);
  const stopRoomLinks = startRoomLinkInviteInbox(login.rawSigner, pubkey, showIncomingRoomLink);
  inboxStop = () => { stopChallenge(); stopRoomLinks(); };
}

function loadCachedFriends(pubkey: string): ChessFriend[] {
  try {
    const cached = JSON.parse(localStorage.getItem(FRIENDS_CACHE_KEY) ?? "null") as {
      pubkey?: string; friends?: ChessFriend[];
    } | null;
    if (cached?.pubkey !== pubkey || !Array.isArray(cached.friends)) return [];
    return cached.friends.filter((friend) => /^[0-9a-f]{64}$/.test(friend.pubkey));
  } catch { return []; }
}

function saveCachedFriends(pubkey: string): void {
  if (!friends.length) return;
  try { localStorage.setItem(FRIENDS_CACHE_KEY, JSON.stringify({ pubkey, friends })); }
  catch { /* caché best-effort */ }
}

function affinitiesFor(pubkey: string): FriendAffinities {
  if (friendAffinitiesFor !== pubkey) {
    friendAffinitiesFor = pubkey;
    friendAffinities = loadFriendAffinities(pubkey);
  }
  return friendAffinities;
}

function sortFriends(pubkey: string): void {
  friends = prioritizeFriends(friends, affinitiesFor(pubkey));
}

function refreshFriendUi(): void {
  if (!state.identity) return;
  if (!state.room) renderHome();
  else if (state.room.phase === "lobby") patchSidePanels();
}

/** Caché instantánea → contactos → perfiles/actividad en paralelo, igual que Tetris. */
async function loadSocialData(pubkey: string): Promise<void> {
  if (friendsLoadedFor === pubkey || friendsLoadingFor === pubkey) return;
  friendsLoadingFor = pubkey;
  const cached = loadCachedFriends(pubkey);
  if (cached.length) {
    friends = cached;
    sortFriends(pubkey);
    refreshFriendUi();
  } else if (friendsLoadedFor && friendsLoadedFor !== pubkey) {
    friends = [];
  }
  friendsLoading = friends.length === 0;

  // La consulta por lote espera a todos los relays y elige el kind:0 más nuevo;
  // es más robusta que `get()` para la identidad visible del usuario actual.
  const normalizedPubkey = pubkey.toLowerCase();
  const ownProfileTask = fetchProfiles([normalizedPubkey], undefined, 5000).then((profiles) => {
    const fetched = profiles.get(normalizedPubkey);
    if (!fetched) return;
    const own = mergePlayerProfile(normalizedPubkey, fetched);
    writeCachedProfile(pubkey, own.name, own.picture);
    if (own.name && state.identity?.pubkey?.toLowerCase() === normalizedPubkey) state.identity.displayName = own.name;
    refreshTopbarIdentity();
    if (state.room) renderPlayers();
  }).catch(() => {});
  try {
    const contacts = (await fetchContacts(pubkey)).slice(0, 1000);
    if (friendsLoadingFor !== pubkey) return;
    const previous = new Map(friends.map((friend) => [friend.pubkey, friend]));
    friends = contacts.map((contact) => {
      return previous.get(contact) ?? { pubkey: contact, name: `npub…${contact.slice(-8)}`, picture: null };
    });
    sortFriends(pubkey);
    friendsLoading = false;
    refreshFriendUi();

    const profilesTask = fetchProfiles(contacts, (profiles) => {
      if (friendsLoadingFor !== pubkey) return;
      friends = friends.map((friend) => {
        const profile = profiles.get(friend.pubkey);
        if (!profile) return friend;
        playerProfiles.set(friend.pubkey, profile);
        return { ...friend, name: profile.name ?? friend.name, picture: profile.picture ?? friend.picture };
      });
      sortFriends(pubkey);
      refreshFriendUi();
    });
    const activityTask = fetchKnownChessPlayers(contacts).then((known) => {
      if (friendsLoadingFor !== pubkey || !known.size) return;
      friendAffinities = rememberFriendActivity(pubkey, known);
      friendAffinitiesFor = pubkey;
      sortFriends(pubkey);
      refreshFriendUi();
    });
    await Promise.all([ownProfileTask, profilesTask, activityTask]);
    saveCachedFriends(pubkey);
    friendsLoadedFor = pubkey;
  } finally {
    friendsLoading = false;
    if (friendsLoadingFor === pubkey) friendsLoadingFor = null;
  }
}

function rememberChessFriends(friendPubkeys: Iterable<string>, matchId?: string | null): void {
  const owner = state.identity?.pubkey?.toLowerCase();
  if (!owner || !/^[0-9a-f]{64}$/.test(owner)) return;
  friendAffinities = rememberFriendActivity(owner, friendPubkeys, { matchId });
  friendAffinitiesFor = owner;
  sortFriends(owner);
  saveCachedFriends(owner);
}

function rememberRoomFriends(room: RoomView, matchId?: string | null): void {
  const owner = state.identity?.pubkey?.toLowerCase();
  if (!owner) return;
  rememberChessFriends(room.players.flatMap((player) => player.pubkey && player.pubkey !== owner ? [player.pubkey] : []), matchId);
}

async function hydrateRoomProfiles(room: RoomView): Promise<void> {
  const pubkeys = room.players.flatMap((player) => player.pubkey ? [player.pubkey] : []);
  const missing = pubkeys.filter((pubkey) => !playerProfiles.has(pubkey));
  if (!missing.length) return;
  const profiles = await fetchProfiles(missing);
  for (const [pubkey, profile] of profiles) {
    const merged = mergePlayerProfile(pubkey, profile);
    if (state.identity?.pubkey?.toLowerCase() === pubkey.toLowerCase()) {
      writeCachedProfile(pubkey, merged.name, merged.picture);
      if (merged.name) state.identity.displayName = merged.name;
    }
  }
  if (state.room?.id === room.id) patchGame();
  refreshTopbarIdentity();
}

/** Si hay un reto pendiente y esta es la sala que creé, lo envío al rival. */
function maybeSendPendingChallenge(room: RoomView): void {
  if (!pendingChallenge || login?.kind !== "nostr") return;
  if (room.hostNpub !== state.identity?.npub) return;
  const { toPubkey } = pendingChallenge;
  pendingChallenge = null;
  const joinUrl = `${location.origin}/?join=${encodeURIComponent(room.id)}`;
  sendChallenge(login.signer, {
    toPubkey,
    roomId: room.id,
    joinUrl,
    message: `${state.identity?.displayName ?? "Alguien"} te reta a una partida de ajedrez`,
  })
    .then(() => {
      trackUx("challenge_sent");
      showInviteButtonResult(toPubkey, "sent");
      playFeedback("invite");
      toast("Reto enviado ♟");
    })
    .catch(() => {
      showInviteButtonResult(toPubkey, "error");
      playFeedback("invalid");
      toast("No se pudo enviar el reto");
    });
}

/** Banner de reto entrante con acción de aceptar. */
function showIncomingChallenge(c: ParsedChallenge): void {
  if (!c.roomId) return;
  rememberChessFriends([c.fromPubkey]);
  const known = friends.find((friend) => friend.pubkey === c.fromPubkey);
  showInvitePopup({
    roomId: c.roomId,
    name: known?.name ?? `${c.fromNpub.slice(0, 12)}…`,
    picture: known?.picture ?? null,
  });
  void enrichInvitePopup(c.roomId, c.fromPubkey);
}

function showIncomingRoomLink(invite: RoomLinkInvite): void {
  rememberChessFriends([invite.fromPubkey]);
  const known = friends.find((friend) => friend.pubkey === invite.fromPubkey);
  showInvitePopup({
    roomId: invite.roomId,
    name: known?.name ?? `npub…${invite.fromPubkey.slice(-8)}`,
    picture: known?.picture ?? null,
  });
  void enrichInvitePopup(invite.roomId, invite.fromPubkey);
}

async function enrichInvitePopup(roomId: string, pubkey: string): Promise<void> {
  const profile = (await fetchProfiles([pubkey])).get(pubkey);
  const current = document.getElementById("challenge-banner");
  if (!profile || current?.dataset.roomId !== roomId) return;
  if (current.classList.contains("is-joining")) return;
  showInvitePopup({ roomId, name: profile.name ?? `npub…${pubkey.slice(-8)}`, picture: profile.picture });
}

/** Popup no bloqueante abajo a la derecha para DMs Nostr y retos NIP-17. */
function showInvitePopup(invite: { roomId: string; name: string; picture: string | null }): void {
  document.getElementById("challenge-banner")?.remove();
  const el = document.createElement("div");
  el.id = "challenge-banner";
  el.className = "challenge-banner";
  el.dataset.roomId = invite.roomId;
  el.innerHTML = `
    ${avatarHtml(invite.name, invite.picture, "invite-avatar")}
    <span class="challenge-text"><b>${escapeHtml(invite.name)}</b><span class="challenge-message">te invitó a jugar ajedrez</span></span>
    <span class="challenge-actions">
      <button class="btn-gold challenge-accept" id="challenge-accept" aria-live="polite">Unirme</button>
      <button id="challenge-dismiss">Ignorar</button>
    </span>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector("#challenge-dismiss")!.addEventListener("click", close);
  el.querySelector("#challenge-accept")!.addEventListener("click", () => {
    if (el.classList.contains("is-joining")) return;
    const accept = el.querySelector<HTMLButtonElement>("#challenge-accept")!;
    const dismiss = el.querySelector<HTMLButtonElement>("#challenge-dismiss")!;
    el.classList.remove("join-error");
    el.classList.add("is-joining");
    accept.disabled = true;
    dismiss.disabled = true;
    accept.setAttribute("aria-label", "Entrando a la partida");
    accept.innerHTML = '<span class="invite-button-spinner" aria-hidden="true"></span><span>Entrando…</span>';
    el.querySelector<HTMLElement>(".challenge-message")!.textContent = "te está guardando un lugar en la mesa";
    playFeedback("ui");
    announce(`Entrando a la partida de ${invite.name}`);
    trackUx("challenge_accepted");
    if (invite.roomId) net.enterRoom(invite.roomId);
  });
}

function completeInviteJoin(roomId: string): void {
  const el = document.getElementById("challenge-banner");
  if (el?.dataset.roomId !== roomId || !el.classList.contains("is-joining")) return;
  const accept = el.querySelector<HTMLButtonElement>("#challenge-accept");
  el.classList.remove("is-joining");
  el.classList.add("is-joined");
  if (accept) {
    accept.setAttribute("aria-label", "Ingresaste a la partida");
    accept.innerHTML = '<span class="challenge-join-check" aria-hidden="true">✓</span><span>¡Adentro!</span>';
  }
  const message = el.querySelector<HTMLElement>(".challenge-message");
  if (message) message.textContent = "la partida ya te está esperando";
  playFeedback("start");
  announce("Ingresaste a la partida");
  window.setTimeout(() => el.classList.add("is-leaving"), 420);
  window.setTimeout(() => el.remove(), 700);
}

function failInviteJoin(): void {
  const el = document.getElementById("challenge-banner");
  if (!el?.classList.contains("is-joining")) return;
  const accept = el.querySelector<HTMLButtonElement>("#challenge-accept");
  const dismiss = el.querySelector<HTMLButtonElement>("#challenge-dismiss");
  el.classList.remove("is-joining");
  el.classList.add("join-error");
  if (accept) {
    accept.disabled = false;
    accept.setAttribute("aria-label", "Reintentar entrar a la partida");
    accept.textContent = "Reintentar";
  }
  if (dismiss) dismiss.disabled = false;
  const message = el.querySelector<HTMLElement>(".challenge-message");
  if (message) message.textContent = "no pudimos entrar; probá de nuevo";
  playFeedback("invalid");
  announce("No pudimos entrar a la partida. Podés reintentar.");
  window.setTimeout(() => el.classList.remove("join-error"), 420);
}

/** Firma y publica el marcador (rating ELO) tras una partida, si hay login Nostr. */
function publishMyRating(): void {
  const change = state.myRating;
  if (!change || login?.kind !== "nostr") return;
  publishRating(login.signer, change.rating)
    .then(() => toast(`Marcador publicado · rating ${change.rating}`))
    .catch(() => {});
}

// --------------------------------------------------------------- net

function wireNet(): void {
  net.on("open", () => {
    reconnectDelay = 1000;
  });
  net.on("challenge", async (m) => {
    if (login?.kind !== "nostr") return;
    // Perfil desconocido (primer login de esta clave acá): le damos ≤1,2s al fetch
    // que viene corriendo en paralelo. Con caché (aún negativa) no se espera nada.
    if (!login.displayName && !profileKnown && profileFetch) {
      await Promise.race([profileFetch, new Promise((r) => setTimeout(r, 1200))]);
    }
    try {
      const event = await signAuthChallenge(login.signer, m.challenge);
      net.authNostr(event, login.displayName || undefined);
    } catch {
      clearActiveSigner();
      login = null;
      state.identity = null;
      toast("No se pudo firmar el login Nostr.");
      renderLogin();
    }
  });
  net.on("authed", (m) => {
    clearConnectWatchdog();
    hideReconnectBanner(); // la sesión volvió; room/match re-habilitan el tablero
    if (m.token) writeSessionToken(m.token); // guarda/rota el token de sesión
    state.identity = m.identity;
    startInbox();
    if (m.identity.pubkey) {
      // En el reingreso por token el server puede devolver la npub como nombre.
      // Aplicar la caché antes del primer render evita mostrarla mientras llegan
      // los relays; la consulta de fondo refresca luego nombre y avatar.
      const cachedProfile = readCachedProfile(m.identity.pubkey);
      if (cachedProfile.known) {
        playerProfiles.set(m.identity.pubkey, {
          name: cachedProfile.name,
          picture: cachedProfile.picture,
          lud16: null,
        });
        if (cachedProfile.name?.trim()) state.identity.displayName = cachedProfile.name.trim();
      }
      void loadSocialData(m.identity.pubkey);
    }
    // Presencia NIP-38 desde el arranque de la sesión (no desde la partida): el
    // jugador aparece presente apenas abre el juego. Idempotente en reconexiones.
    ensurePresence()?.start();
    const join = pendingJoin();
    const saved = readSavedRoom();
    cleanUrl();
    if (state.room) net.joinRoom({ roomId: state.room.id }); // reconexión: volver a la sala
    else if (join) net.enterRoom(join); // ?join: unir-o-crear (invite propio o Room Link)
    // F5 / bfcache: re-unirse a la sala guardada. joinRoom (no enterRoom): si la
    // sala murió queremos NO_ROOM → home, no re-crearla lazy como fantasma.
    else if (saved) net.joinRoom({ roomId: saved });
    else renderHome();
  });
  net.on("room", (m) => {
    completeInviteJoin(m.room.id);
    const previousRoomId = state.room?.id ?? null;
    const wasInRoom = state.room !== null;
    const switchedRoom = previousRoomId !== null && previousRoomId !== m.room.id;
    let isRematch = false;
    if (switchedRoom) {
      // Una mesa nueva no puede heredar el resultado, posición ni acciones de
      // la anterior. Sin esto la UI solo se corregía después de un F5.
      state.match = null;
      state.matchReceivedAt = 0;
      state.ended = null;
      state.myRating = null;
      state.drawOfferBy = null;
      state.rematchRequested = false;
      state.rematchOffer = null;
      state.bet = null;
      state.myBetInvoice = null;
      pendingMove = null;
      viewedHistoryPly = null;
    }
    state.room = m.room;
    writeSavedRoom(m.room.id);
    if (m.room.phase === "lobby") state.ready = false;
    // Revancha concedida: la sala vuelve a "playing" con el resultado viejo en
    // pantalla — limpiar el estado de la partida anterior.
    if (m.room.phase === "playing" && state.ended) {
      isRematch = true;
      state.ended = null;
      state.myRating = null;
      state.drawOfferBy = null;
      state.rematchRequested = false;
      state.rematchOffer = null;
      toast("¡Revancha! Colores invertidos");
    }
    maybeSendPendingChallenge(m.room);
    rememberRoomFriends(m.room);
    void hydrateRoomProfiles(m.room);
    if (!wasInRoom) enterGame();
    else patchGame();
    if (isRematch) showCountdown();
    if (isRematch) trackUx("rematch_started");
  });
  net.on("match", (m) => {
    const isNewMatch = state.match?.matchId !== m.snapshot.matchId && m.snapshot.sanHistory.length === 0;
    if (clockAlertMatchId !== m.snapshot.matchId) {
      clockAlertMatchId = m.snapshot.matchId;
      ownClockAlertLevel = 0;
    }
    const sound = soundForSnapshot(state.match, m.snapshot);
    if (sound) playSound(sound);
    if (pendingMove) {
      pendingMove = null;
    }
    state.match = m.snapshot;
    if (isNewMatch) viewedHistoryPly = null;
    if (isNewMatch) trackUx("game_started");
    state.matchReceivedAt = Date.now();
    if (state.room) rememberRoomFriends(state.room, m.snapshot.matchId);
    state.drawOfferBy = null;
    renderBoardFromMatch();
    patchGame();
    updateClockDisplays();
  });
  net.on("move_ack", (m) => {
    if (pendingMove?.requestId !== m.requestId) return;
    // El snapshot autoritativo llega inmediatamente después. Conservamos la pieza
    // optimista en destino hasta entonces para no producir un flash en Vexel.
  });
  net.on("move_rejected", (m) => {
    if (pendingMove?.requestId !== m.requestId) return;
    pendingMove = null;
    board?.rejectMove();
    renderBoardFromMatch();
    toast(errorText(m.code, m.message), "error");
    announce(errorText(m.code, m.message));
  });
  net.on("mastery", (m) => {
    state.mastery = m.stats;
    state.newlyEarned = m.newlyEarned;
    if (!state.room) renderHome();
    else patchSidePanels();
  });
  net.on("caps", (m) => {
    state.betsEnabled = m.bets;
  });
  net.on("bet", (m) => {
    state.bet = m.bet;
    patchSidePanels();
  });
  net.on("bet_invoice", (m) => {
    state.myBetInvoice = { bolt11: m.bolt11, amountSats: m.amountSats, stakeSats: m.stakeSats };
    patchSidePanels();
  });
  net.on("bet_closed", (m) => {
    state.bet = null;
    state.myBetInvoice = null;
    toast(`Apuesta cerrada: ${m.reason}`);
    patchSidePanels();
  });
  net.on("draw_offer", (m) => {
    // null = rechazada/retirada; avisar solo al que la había ofrecido.
    if (m.byNpub === null && state.drawOfferBy === state.identity?.npub)
      toast("El rival rechazó las tablas");
    state.drawOfferBy = m.byNpub;
    patchSidePanels();
  });
  net.on("rematch_offer", (m) => {
    if (m.byNpub === state.identity?.npub) {
      state.rematchRequested = true; // eco propio (p. ej. resync tras F5)
    } else {
      state.rematchOffer = m.byNpub;
      toast(`${nameOf(m.byNpub)} quiere revancha`);
    }
    patchSidePanels();
  });
  net.on("ended", (m) => {
    state.ended = { winnerNpubs: m.winnerNpubs, ...endedText(m.winnerNpubs, m.result) };
    // `ended` es la fuente inmediata de verdad para el cliente. Marcar también
    // la sala evita que "Retar a otro" reutilice una mesa ya finalizada aunque
    // el mensaje `room` con phase=finished llegue después o venga de un server viejo.
    if (state.room) state.room = { ...state.room, phase: "finished" };
    state.myRating = m.ratings?.find((r) => r.npub === state.identity?.npub) ?? null;
    state.rematchRequested = false;
    state.rematchOffer = null;
    trackUx("game_ended", { result: m.result.kind });
    if (board) board.setInteractive(false);
    const won = m.winnerNpubs.includes(state.identity?.npub ?? "");
    playFeedback(m.winnerNpubs.length === 0 ? "end" : won ? "win" : "lose");
    document.body.classList.remove("celebrate-win", "celebrate-loss");
    document.body.classList.add(won ? "celebrate-win" : "celebrate-loss");
    setTimeout(() => document.body.classList.remove("celebrate-win", "celebrate-loss"), 1500);
    announce(state.ended.text);
    publishMyRating();
    patchGame();
  });
  net.on("presence", (m) => {
    if (m.npub === state.identity?.npub) return;
    if (m.online) toast(`${nameOf(m.npub)} volvió a la partida`);
    else {
      const secs = Math.round((m.graceMs ?? 0) / 1000);
      toast(`${nameOf(m.npub)} se desconectó — tiene ${secs}s para volver`);
    }
  });
  net.on("error", (m) => {
    // Token de sesión vencido/inválido: lo descartamos y re-autenticamos firmando.
    if (m.code === "BAD_TOKEN") {
      clearSessionToken();
      if (login?.kind === "nostr") net.authChallenge();
      return;
    }
    // Sala inexistente: por reconexión, por F5 con sala guardada muerta, o por
    // código equivocado. En todos los casos: olvidarla y volver al inicio.
    if (m.code === "NO_ROOM") {
      failInviteJoin();
      clearSavedRoom();
      state.room = null;
      state.match = null;
      state.ended = null;
      toast("La sala ya no existe");
      renderHome();
      return;
    }
    failInviteJoin();
    toast(errorText(m.code, m.message));
    // Refrescar el lobby resetea botones que quedaron en estado "cargando"
    // (p. ej. "Creando…" si falló la propuesta de apuesta).
    if (state.room?.phase === "lobby") patchSidePanels();
  });
  net.on("dropped", () => {
    toast("Se descartó una acción por la desconexión — repetila al reconectar");
  });
  net.on("close", () => {
    if (!state.identity || !login) return renderConnError();
    // Banner persistente (no toast: la reconexión puede tardar) y tablero bloqueado
    // para no aceptar jugadas que se perderían mientras no hay socket.
    showReconnectBanner();
    board?.setInteractive(false);
    const mode = login;
    setTimeout(() => {
      net.connect();
      // Invitado: re-auth por nombre. Nostr: por token si lo hay (sin re-firmar).
      if (mode.kind === "guest") net.auth(mode.name);
      else sendNostrAuth();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  });
}

/** Backoff de reconexión (se resetea cuando el socket vuelve a abrir). */
let reconnectDelay = 1000;

function cleanUrl(): void {
  const url = new URL(location.href);
  url.searchParams.delete("join");
  url.searchParams.delete("lnOrigin"); // param informativo de la tienda (Room Link)
  history.replaceState(null, "", url.toString());
}

/**
 * Qué sonido corresponde a un snapshot nuevo. Silencio en los resyncs (F5 /
 * reconexión a mitad de partida): solo suena lo que acaba de pasar de verdad.
 */
function soundForSnapshot(prev: MatchSnapshot | null, next: MatchSnapshot): SoundName | null {
  if (next.result.kind !== "ongoing") return null;
  if (!prev || prev.matchId !== next.matchId)
    return next.sanHistory.length === 0 ? "start" : null; // partida nueva vs resync
  if (next.sanHistory.length === prev.sanHistory.length) return null; // sin jugada nueva
  if (next.inCheck) return "check";
  if (countPieces(next.fen) < countPieces(prev.fen)) return "capture";
  return "move";
}

/** Cantidad de piezas en el FEN (para detectar capturas sin datos extra). */
function countPieces(fen: string): number {
  const placement = fen.split(" ")[0] ?? "";
  let n = 0;
  for (const ch of placement) if (/[a-z]/i.test(ch)) n++;
  return n;
}

// --------------------------------------------------------------- helpers de identidad

function myColor(): Color | null {
  const me = state.identity?.npub;
  if (!me || !state.room) return null;
  const seat = state.room.players.find((p) => p.npub === me);
  return seat?.color ?? null;
}

function nameOf(npub: string): string {
  const p = state.room?.players.find((x) => x.npub === npub);
  return p ? visibleName(p) : npub.slice(0, 10);
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function profileFor(pubkey?: string): NostrProfile | null {
  return pubkey ? playerProfiles.get(pubkey) ?? playerProfiles.get(pubkey.toLowerCase()) ?? null : null;
}

/** Conserva datos válidos: un relay lento o vacío nunca borra nombre/foto ya resueltos. */
function mergePlayerProfile(pubkey: string, incoming: NostrProfile): NostrProfile {
  const current = profileFor(pubkey);
  const merged: NostrProfile = {
    name: incoming.name?.trim() || current?.name?.trim() || null,
    picture: incoming.picture?.trim() || current?.picture?.trim() || null,
    lud16: incoming.lud16?.trim() || current?.lud16?.trim() || null,
  };
  playerProfiles.set(pubkey.toLowerCase(), merged);
  return merged;
}

function visibleName(player: { displayName: string; pubkey?: string }): string {
  return profileFor(player.pubkey)?.name?.trim() || player.displayName;
}

function avatarHtml(name: string, picture: string | null, extraClass = ""): string {
  const safePicture = picture && /^https?:\/\//i.test(picture)
    ? `/api/profile-image?url=${encodeURIComponent(picture)}`
    : null;
  const classes = `avatar${extraClass ? ` ${extraClass}` : ""}`;
  return safePicture
    ? `<span class="${classes}"><span class="avatar-fallback">${escapeHtml(initials(name))}</span><img data-avatar-image src="${escapeHtml(safePicture)}" alt="" /></span>`
    : `<span class="${classes}">${escapeHtml(initials(name))}</span>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[char]!);
}

function endedText(winners: string[], result?: MatchSnapshot["result"]): { text: string; sub: string } {
  const by = result && "by" in result ? result.by : undefined;
  const reason: Record<string, string> = {
    checkmate: "por jaque mate",
    resign: "por abandono",
    timeout: "por tiempo",
    stalemate: "por ahogado",
    insufficient: "por material insuficiente",
    threefold: "por triple repetición",
    fifty: "por regla de 50 movimientos",
    agreement: "por acuerdo",
  };
  const plies = state.match?.sanHistory.length ?? 0;
  const jugadas = plies ? ` · ${plies} jugadas` : "";
  if (winners.length === 0) return { text: "Tablas", sub: (by ? reason[by] : "acordadas") + jugadas };
  const me = state.identity?.npub;
  const won = me && winners.includes(me);
  return {
    text: won ? "¡Ganaste!" : `Ganó ${nameOf(winners[0]!)}`,
    sub: (by ? reason[by] : "") + jugadas,
  };
}

// --------------------------------------------------------------- material capturado (desde FEN)

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const FULL: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/** Piezas capturadas + ventaja material, derivadas del FEN (autoritativo). */
function material(): { wCaptured: string[]; bCaptured: string[]; adv: number } {
  const fen = state.match?.fen;
  if (!fen) return { wCaptured: [], bCaptured: [], adv: 0 };
  const placement = fen.split(" ")[0] ?? "";
  const present = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of placement) {
    const lower = ch.toLowerCase();
    if (lower in FULL) {
      const side = ch === ch.toUpperCase() ? "w" : "b";
      const rec = present[side] as Record<string, number>;
      rec[lower] = (rec[lower] ?? 0) + 1;
    }
  }
  // Piezas negras que faltan → las capturó el blanco, y viceversa.
  const wCaptured: string[] = []; // negras comidas por el blanco
  const bCaptured: string[] = []; // blancas comidas por el negro
  let wMat = 0, bMat = 0;
  for (const t of ["q", "r", "b", "n", "p"]) {
    const missB = (FULL[t] ?? 0) - ((present.b as Record<string, number>)[t] ?? 0);
    const missW = (FULL[t] ?? 0) - ((present.w as Record<string, number>)[t] ?? 0);
    for (let i = 0; i < missB; i++) wCaptured.push("b" + t.toUpperCase());
    for (let i = 0; i < missW; i++) bCaptured.push("w" + t.toUpperCase());
    wMat += ((present.w as Record<string, number>)[t] ?? 0) * (PIECE_VALUE[t] ?? 0);
    bMat += ((present.b as Record<string, number>)[t] ?? 0) * (PIECE_VALUE[t] ?? 0);
  }
  return { wCaptured, bCaptured, adv: wMat - bMat };
}

function capturedHtml(color: Color): string {
  const m = material();
  const pieces = color === "w" ? m.wCaptured : m.bCaptured;
  const advForColor = color === "w" ? m.adv : -m.adv;
  const imgs = pieces
    .map((code) => `<img src="/textures/pieces/${code}.png" alt="" />`)
    .join("");
  const adv = advForColor > 0 ? `<span class="adv">+${advForColor}</span>` : "";
  return imgs + adv;
}

// --------------------------------------------------------------- render: conexión

function shell(inner: string): string {
  return `<div class="center-screen"><div class="login">
    <div class="login-mark">♞</div>
    <h1 class="display">Ajedrez</h1>
    ${inner}
  </div></div>`;
}

/** Watchdog: si autenticar no completa a tiempo, evita quedar colgado en "Conectando…". */
let connectWatchdog: ReturnType<typeof setTimeout> | null = null;
function clearConnectWatchdog(): void {
  if (connectWatchdog) {
    clearTimeout(connectWatchdog);
    connectWatchdog = null;
  }
}

function renderConnecting(): void {
  app.innerHTML = shell(`
    <p class="muted">Conectando con el servidor…</p>
    <div class="stack" style="margin-top:22px">
      <button class="btn-ghost" id="conn-cancel">Elegir otro método de login</button>
    </div>`);
  document.getElementById("conn-cancel")!.addEventListener("click", () => renderLogin());
  // Si el firmador no responde (extensión bloqueada, celu offline, relay lento), no
  // dejamos al usuario atrapado: a los 12s caemos al login para que elija otra vía.
  clearConnectWatchdog();
  connectWatchdog = setTimeout(() => {
    if (!state.identity) {
      toast("No se pudo autenticar (¿el firmador no respondió?). Probá otro método.");
      renderLogin();
    }
  }, 12_000);
}

function renderBalConsentRequired(): void {
  clearConnectWatchdog();
  app.innerHTML = shell(`
    <div class="bal-consent" role="status" aria-live="polite">
      <div class="bal-consent-icon" aria-hidden="true">✒</div>
      <p class="bal-consent-kicker">IDENTIDAD NOSTR</p>
      <h2>Autorizá la firma en Luna Negra</h2>
      <p class="muted">
        Luna Negra necesita tu permiso para que Ajedrez use tu identidad.
        Tu clave privada nunca se comparte con el juego.
      </p>
      <div class="bal-consent-step">
        <span aria-hidden="true">1</span>
        <p>Volvé a Luna Negra y elegí <b>Permitir esta vez</b> o <b>Permitir y recordar</b>.</p>
      </div>
      <button class="btn-gold bal-consent-action" id="bal-consent-focus">
        Ir a Luna Negra para autorizar
      </button>
      <p class="bal-focus-help" id="bal-focus-help" hidden>
        Si seguís viendo Ajedrez, el navegador bloqueó el cambio automático.
        Abrí el selector de pestañas y tocá <b>⚠ Luna Negra</b>.
      </p>
      <p class="fine">Cuando lo apruebes, Ajedrez continuará automáticamente.</p>
    </div>`);
  const focusButton = document.getElementById("bal-consent-focus") as HTMLButtonElement;
  const focusHelp = document.getElementById("bal-focus-help")!;
  focusButton.addEventListener("click", () => {
    requestBalLauncherFocus();
    focusButton.textContent = "Buscá la pestaña ⚠ Luna Negra";
    focusHelp.hidden = false;
  });
}

function renderConnError(): void {
  clearConnectWatchdog();
  app.innerHTML = shell(`
    <p class="muted">No se pudo conectar con el servidor de la partida.</p>
    <div class="stack" style="margin-top:24px">
      <button class="btn-gold" id="retry">Reintentar</button>
    </div>`);
  document.getElementById("retry")!.addEventListener("click", () => location.reload());
}

// --------------------------------------------------------------- render: login

type LoginTab = "extension" | "qr" | "bunker" | "local" | "guest";

const LOGIN_TABS: { id: LoginTab; label: string }[] = [
  { id: "extension", label: "Extensión" },
  { id: "qr", label: "QR" },
  { id: "bunker", label: "Bunker" },
  { id: "local", label: "Clave local" },
  { id: "guest", label: "Invitado" },
];

/** En celular no hay extensión: arrancamos en QR (escanear con la app de firma). */
function defaultLoginTab(): LoginTab {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "qr" : "extension";
}

/** Corta el flujo QR (Nostr Connect) en curso al cambiar de solapa o salir. */
let qrAbort: AbortController | null = null;

function renderLogin(tab?: LoginTab, expanded = false): void {
  clearConnectWatchdog();
  qrAbort?.abort();
  qrAbort = null;
  const preferred = tab ?? defaultLoginTab();
  if (!expanded && tab === undefined) {
    app.innerHTML = shell(`
      <p class="login-kicker">Club de ajedrez social</p>
      <p class="muted login-lead">Entrá, elegí un rival y sentí cada jugada.</p>
      <div class="login-primary stack">
        <button class="btn-gold btn-hero" id="login-primary">Continuar con Nostr</button>
        <button class="btn-ghost" id="login-more">Otras formas de entrar</button>
      </div>
      <div class="login-trust" aria-label="Beneficios de Nostr">
        <span>Identidad propia</span><span>Rivales recientes</span><span>ELO persistente</span>
      </div>`);
    document.getElementById("login-primary")!.addEventListener("click", () => {
      playFeedback("ui");
      trackUx("login_started");
      if (preferred === "qr") renderLogin("qr", true);
      else void loginNip07();
    });
    document.getElementById("login-more")!.addEventListener("click", () => renderLogin(preferred, true));
    return;
  }
  const bar = LOGIN_TABS.map(
    (t) => `<button class="login-tab${t.id === preferred ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`,
  ).join("");
  app.innerHTML = shell(`
    <p class="muted">Elegí cómo custodiar tu identidad.</p>
    <div class="login-tabs">${bar}</div>
    <div class="login-panel" id="login-panel"></div>
    <button class="login-back" id="login-back">← Volver</button>`);
  document.querySelectorAll<HTMLButtonElement>(".login-tab").forEach((b) =>
    b.addEventListener("click", () => renderLogin(b.dataset.tab as LoginTab, true)),
  );
  document.getElementById("login-back")!.addEventListener("click", () => renderLogin());
  renderLoginTab(preferred);
}

function renderLoginTab(tab: LoginTab): void {
  const panel = document.getElementById("login-panel")!;
  if (tab === "extension") {
    panel.innerHTML = `
      <button class="btn-gold" id="nostr">Entrar con extensión</button>
      <p class="fine">Alby o nos2x. Habilita marcador, retos, zaps y apuestas.</p>`;
    panel.querySelector("#nostr")!.addEventListener("click", () => void loginNip07());
  } else if (tab === "qr") {
    panel.innerHTML = `
      <p class="fine">Escaneá con tu app de firma (Amber, Primal, nsec.app), o abrí el enlace en el celu.</p>
      <div id="qr-box" class="qr-box">Generando código…</div>
      <a id="qr-link" class="btn-ghost" style="display:none">Abrir en la app de firma</a>`;
    startQrLogin();
  } else if (tab === "bunker") {
    panel.innerHTML = `
      <input id="bunker-input" placeholder="bunker://… o usuario@dominio" />
      <button class="btn-gold" id="bunker-go">Conectar</button>
      <p class="fine">Pegá un bunker:// de tu firmante, o un NIP-05 (usuario@dominio).</p>`;
    const inp = panel.querySelector("#bunker-input") as HTMLInputElement;
    const go = () => inp.value.trim() && void loginBunker(inp.value);
    panel.querySelector("#bunker-go")!.addEventListener("click", go);
    inp.addEventListener("keydown", (e) => e.key === "Enter" && go());
  } else if (tab === "local") {
    panel.innerHTML = `
      <input id="nsec-input" placeholder="nsec1…" />
      <button class="btn-gold" id="local-import">Entrar con mi nsec</button>
      <div class="login-or"><span>o</span></div>
      <button class="btn-ghost" id="local-new">Crear una clave nueva</button>
      <p class="fine">La clave vive solo en este navegador. Si la generás, guardala: es tu identidad.</p>`;
    const inp = panel.querySelector("#nsec-input") as HTMLInputElement;
    panel.querySelector("#local-import")!.addEventListener("click", () => inp.value.trim() && loginLocal(inp.value));
    inp.addEventListener("keydown", (e) => e.key === "Enter" && inp.value.trim() && loginLocal(inp.value));
    panel.querySelector("#local-new")!.addEventListener("click", showGeneratedKey);
  } else {
    panel.innerHTML = `
      <input id="name" placeholder="Tu nombre" />
      <button class="btn-gold" id="go">Entrar como invitado</button>
      <p class="fine">Invitado: solo jugás partidas — sin marcador ni apuestas.</p>`;
    const inp = panel.querySelector("#name") as HTMLInputElement;
    const go = () => inp.value.trim() && loginWith(inp.value);
    panel.querySelector("#go")!.addEventListener("click", go);
    inp.addEventListener("keydown", (e) => e.key === "Enter" && go());
  }
}

/** Arranca el handshake Nostr Connect y muestra el QR; resuelve al aceptar. */
function startQrLogin(): void {
  qrAbort = new AbortController();
  const box = document.getElementById("qr-box");
  const link = document.getElementById("qr-link") as HTMLAnchorElement | null;
  const { uri, established } = startNostrConnect({ signal: qrAbort.signal });
  QRCode.toDataURL(uri, { margin: 1, width: 240 })
    .then((url) => {
      if (box) box.innerHTML = `<img src="${url}" alt="QR Nostr Connect" width="240" height="240" />`;
    })
    .catch(() => {
      if (box) box.textContent = "No se pudo generar el QR.";
    });
  if (link) {
    link.href = uri;
    link.style.display = "";
  }
  established
    .then(({ signer, stored }) => {
      setActiveSigner(signer, stored);
      void beginNostr(signer);
    })
    .catch((e: unknown) => {
      // Ignoramos el abort al cambiar de solapa; el resto lo avisamos.
      if (qrAbort?.signal.aborted) return;
      toast(e instanceof Error ? e.message : "Falló la conexión con el firmante");
    });
}

/** Genera una clave nueva y la muestra para respaldo antes de entrar. */
function showGeneratedKey(): void {
  const { signer, nsec } = generateLocalSigner();
  const panel = document.getElementById("login-panel")!;
  panel.innerHTML = `
    <p class="fine">Esta es tu clave privada. <b>Guardala</b>: es tu identidad y no se puede recuperar.</p>
    <textarea id="new-nsec" class="nsec-box" readonly rows="2">${nsec}</textarea>
    <button class="btn-ghost" id="copy-nsec">Copiar</button>
    <button class="btn-gold" id="new-continue">Ya la guardé — entrar</button>`;
  panel.querySelector("#copy-nsec")!.addEventListener("click", () => {
    void navigator.clipboard?.writeText(nsec);
    toast("Clave copiada");
  });
  panel.querySelector("#new-continue")!.addEventListener("click", () => {
    setActiveSigner(signer, { method: "local", nsec });
    void beginNostr(signer);
  });
}

// --------------------------------------------------------------- render: topbar

function topbar(): string {
  const id = state.identity;
  const technologyBtn = `<button class="icon-btn technology-button" data-action="technology" aria-label="Tecnología usada: Vexel" title="Tecnología usada">
    <span class="technology-button-icon" aria-hidden="true"><i></i></span><span>Tecnología usada</span>
  </button>`;
  const soundBtn = `<button class="icon-btn" data-action="sound" aria-label="${soundEnabled() ? "Sonido: silenciar" : "Sonido: activar"}" title="Sonido">${soundEnabled() ? "●" : "○"}<span>Sonido</span></button>`;
  const hapticBtn = `<button class="icon-btn haptic-control" data-action="haptics" aria-label="Háptica: alternar respuesta" title="Háptica">${hapticsEnabled() ? "Háptica activa" : "Háptica apagada"}</button>`;
  return `
    <header class="topbar">
      <span class="brand"><span class="mark">A</span><span>Ajedrez<small>Club social</small></span></span>
      <span class="spacer"></span>
      ${technologyBtn}
      ${soundBtn}
      ${hapticBtn}
      ${id ? `<span class="me" id="current-user">${topbarIdentityHtml()}</span><button class="logout" data-action="logout" title="Cerrar sesión">Salir</button>` : ""}
    </header>`;
}

function openTechnologyIntro(trigger: HTMLButtonElement): void {
  if (document.getElementById("technology-intro")) return;

  const rect = trigger.getBoundingClientRect();
  trigger.classList.remove("is-pressed");
  void trigger.offsetWidth;
  trigger.classList.add("is-pressed");
  playFeedback("ui");

  const overlay = document.createElement("div");
  overlay.id = "technology-intro";
  overlay.className = "technology-intro";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "technology-intro-title");
  overlay.style.setProperty("--technology-origin-x", `${rect.left + rect.width / 2}px`);
  overlay.style.setProperty("--technology-origin-y", `${rect.top + rect.height / 2}px`);
  overlay.innerHTML = `
    <div class="technology-intro-glow" aria-hidden="true"></div>
    <div class="technology-intro-shell">
      <header class="technology-intro-header">
        <div class="technology-intro-heading">
          <span class="technology-engine-mark" aria-hidden="true"><i></i></span>
          <div><span>Motor de juegos</span><strong id="technology-intro-title">Vexel</strong></div>
        </div>
        <button class="technology-intro-close" type="button" aria-label="Cerrar intro de Vexel"><span aria-hidden="true">×</span></button>
      </header>
      <div class="technology-intro-stage">
        <div class="technology-intro-loading" aria-hidden="true"><i></i><span>Inicializando Vexel</span></div>
        <iframe src="/vexel-intro/vexel-web.html" title="Intro del motor gráfico Vexel" allow="autoplay" tabindex="0"></iframe>
      </div>
    </div>`;

  const closeButton = overlay.querySelector<HTMLButtonElement>(".technology-intro-close")!;
  const iframe = overlay.querySelector<HTMLIFrameElement>("iframe")!;
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    overlay.classList.add("is-closing");
    document.body.classList.remove("technology-intro-open");
    window.setTimeout(() => {
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
      trigger.classList.remove("is-pressed");
      if (trigger.isConnected) trigger.focus();
    }, 360);
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };

  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("animationend", () => trigger.classList.remove("is-pressed"), { once: true });
  iframe.addEventListener("load", () => {
    overlay.classList.add("is-ready");
    // Escape también debe cerrar cuando el foco está dentro del canvas del iframe.
    iframe.contentDocument?.addEventListener("keydown", onKeydown);
  });
  document.addEventListener("keydown", onKeydown);
  document.body.classList.add("technology-intro-open");
  document.body.appendChild(overlay);
  requestAnimationFrame(() => closeButton.focus());
}

function topbarIdentityHtml(): string {
  const id = state.identity;
  if (!id) return "";
  const profile = profileFor(id.pubkey);
  const candidate = profile?.name?.trim() || id.displayName.trim();
  const name = id.pubkey && (!candidate || /^npub1/i.test(candidate)) ? "Perfil Nostr" : candidate || "Jugador";
  return `${avatarHtml(name, profile?.picture ?? null)}<span class="me-name">${escapeHtml(name)}</span>`;
}

function refreshTopbarIdentity(): void {
  const current = document.getElementById("current-user");
  if (current) current.innerHTML = topbarIdentityHtml();
}

// --------------------------------------------------------------- render: home

function renderHome(): void {
  clearConnectWatchdog();
  document.body.classList.remove("game-active");
  app.innerHTML =
    topbar() +
    `<main class="home">
      <section class="home-hero">
        <p class="home-kicker">Tu mesa está lista</p>
        <h1 class="display home-title">Una partida más.<br><em>Un rival conocido.</em></h1>
        <p class="muted home-sub">Creá una mesa privada y empezá a jugar en segundos.</p>
        ${masteryStatsHtml()}
        <div class="hero-actions">
          <button class="btn-gold btn-hero" id="create">Crear mesa</button>
          <div class="join-inline">
            <input id="code" class="code-field" aria-label="Código de sala" placeholder="CÓDIGO" maxlength="4" />
            <button id="join">Entrar</button>
          </div>
        </div>
      </section>
      ${state.identity?.guest === false ? `<section class="social-hub">
        <div class="section-heading"><div><p class="section-label">Tu círculo</p><h2>Rivales y amigos</h2></div><span class="fine">Privado · vía Nostr</span></div>
        ${friendInviteListHtml()}
        <details class="npub-invite"><summary>Invitar con npub</summary><div class="row"><input id="challenge-npub" placeholder="npub1…" /><button id="challenge-send">Retar</button></div></details>
      </section>` : `<section class="guest-callout"><p>Estás jugando como invitado.</p><span>Con Nostr guardás ELO, rachas y rivales recientes.</span></section>`}
    </main>`;

  document.getElementById("create")!.addEventListener("click", () => { playFeedback("ui"); createConfiguredRoom(); });
  document.getElementById("join")!.addEventListener("click", () => {
    const code = (document.getElementById("code") as HTMLInputElement).value.trim().toUpperCase();
    if (code) net.joinRoom({ code });
  });
  document.getElementById("challenge-send")?.addEventListener("click", sendChallengeFromHome);
  wireFriendInviteButtons();
}

function masteryStatsHtml(): string {
  const stats = state.mastery;
  if (!stats || state.identity?.guest) return "";
  return `<div class="mastery-strip" aria-label="Tu progreso">
    <span><strong>${stats.rating}</strong><small>ELO</small></span>
    <span><strong>${stats.winStreak}</strong><small>Racha</small></span>
    <span><strong>${stats.wins}</strong><small>Victorias</small></span>
    <span><strong>${stats.games}</strong><small>Partidas</small></span>
  </div>`;
}

function friendInviteListHtml(): string {
  if (friendsLoading && !friends.length) return `<p class="fine">Cargando contactos Nostr…</p>`;
  const combined = new Map(friends.map((friend) => [friend.pubkey, friend]));
  for (const rival of state.mastery?.recentRivals ?? []) {
    if (!rival.pubkey || combined.has(rival.pubkey)) continue;
    const profile = profileFor(rival.pubkey);
    combined.set(rival.pubkey, { pubkey: rival.pubkey, name: profile?.name ?? rival.displayName, picture: profile?.picture ?? null });
  }
  const social = [...combined.values()];
  if (!social.length) return `<p class="fine empty-social">Tus contactos y rivales recientes aparecerán acá.</p>`;
  const owner = state.identity?.pubkey ?? "";
  const affinities = affinitiesFor(owner);
  return `<div class="friend-list">${social.slice(0, 12).map((friend) => {
    const affinity = affinities.get(friend.pubkey);
    const rivalry = state.mastery?.recentRivals.find((rival) => rival.pubkey === friend.pubkey);
    const label = rivalry
      ? `${rivalry.games} duelo${rivalry.games === 1 ? "" : "s"} · ${rivalry.wins}-${rivalry.losses}`
      : (affinity?.gamesTogether ?? 0) > 0 ? "Ya jugaron juntos" : affinity ? "Juega ajedrez" : "Contacto Nostr";
    const isSending = pendingChallenge?.toPubkey === friend.pubkey;
    return `
    <div class="friend-row">
      ${avatarHtml(friend.name, friend.picture)}
      <span class="friend-copy"><span class="friend-name">${escapeHtml(friend.name)}</span>${label ? `<small>${label}</small>` : ""}</span>
      <button type="button" class="invite-friend-button${isSending ? " is-sending" : ""}" data-invite-pubkey="${friend.pubkey}" data-invite-state="${isSending ? "sending" : "idle"}"${isSending ? " disabled" : ""} aria-live="polite" aria-label="${isSending ? `Enviando invitación a ${escapeHtml(friend.name)}` : `Invitar a ${escapeHtml(friend.name)} a jugar`}">
        ${isSending ? '<span class="invite-button-spinner" aria-hidden="true"></span><span>Enviando…</span>' : "<span>Jugar</span>"}
      </button>
    </div>`;
  }).join("")}</div>`;
}

function wireFriendInviteButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-invite-pubkey]").forEach((button) => {
    button.addEventListener("click", () => void inviteFriend(button.dataset.invitePubkey ?? "", button));
  });
  net.on("left_room", () => {
    leaveRoomLocally();
  });
  net.on("room_closed", (m) => {
    leaveRoomLocally(m.reason);
  });
}

async function inviteFriend(toPubkey: string, button?: HTMLButtonElement): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(toPubkey) || login?.kind !== "nostr") return;
  if (toPubkey === state.identity?.pubkey) return toast("No podés invitarte a vos mismo");
  if (!state.room || state.ended !== null || state.room.phase === "finished") {
    if (state.ended !== null || state.room?.phase === "finished") trackUx("next_rival_challenged");
    pendingChallenge = { toPubkey };
    setInviteButtonState(button, "sending");
    toast("Preparando una nueva mesa…");
    createConfiguredRoom();
    return;
  }
  setInviteButtonState(button, "sending");
  const friend = friends.find((candidate) => candidate.pubkey === toPubkey);
  try {
    await sendChallenge(login.signer, {
      toPubkey,
      roomId: state.room.id,
      joinUrl: `${location.origin}/?join=${state.room.id}`,
      message: `${state.identity?.displayName ?? "Alguien"} te invita a jugar ajedrez`,
    });
    trackUx("challenge_sent");
    setInviteButtonState(button, "sent");
    playFeedback("invite");
    toast(`Invitación enviada a ${friend?.name ?? "tu contacto"}`);
  } catch {
    setInviteButtonState(button, "error");
    playFeedback("invalid");
    toast("No se pudo enviar la invitación");
  }
}

type InviteButtonState = "idle" | "sending" | "sent" | "error";

/** Feedback compacto y accesible en el mismo control que inició la invitación. */
function setInviteButtonState(button: HTMLButtonElement | undefined, next: InviteButtonState): void {
  if (!button) return;
  const labels: Record<InviteButtonState, string> = {
    idle: "Jugar",
    sending: "Enviando…",
    sent: "¡Invitado!",
    error: "Reintentar",
  };
  button.dataset.inviteState = next;
  button.classList.toggle("is-sending", next === "sending");
  button.classList.toggle("is-sent", next === "sent");
  button.classList.toggle("is-error", next === "error");
  button.disabled = next === "sending" || next === "sent";
  button.setAttribute("aria-label", labels[next]);
  button.innerHTML = next === "sending"
    ? `<span class="invite-button-spinner" aria-hidden="true"></span><span>${labels[next]}</span>`
    : next === "sent"
      ? `<span class="invite-button-check" aria-hidden="true">✓</span><span>${labels[next]}</span>`
      : `<span>${labels[next]}</span>`;

  const row = button.closest(".friend-row");
  if (next === "sent" || next === "error") {
    row?.classList.remove("invite-sent", "invite-error");
    void row?.getBoundingClientRect();
    row?.classList.add(next === "sent" ? "invite-sent" : "invite-error");
    window.setTimeout(() => {
      if (!button.isConnected || button.dataset.inviteState !== next) return;
      row?.classList.remove("invite-sent", "invite-error");
      setInviteButtonState(button, "idle");
    }, next === "sent" ? 1600 : 1200);
  }
}

function showInviteButtonResult(toPubkey: string, result: "sent" | "error"): void {
  document.querySelectorAll<HTMLButtonElement>("[data-invite-pubkey]").forEach((button) => {
    if (button.dataset.invitePubkey === toPubkey) setInviteButtonState(button, result);
  });
}

/** Crea la sala y deja el reto pendiente; se envía al llegar el `room`. */
function sendChallengeFromHome(): void {
  const input = document.getElementById("challenge-npub") as HTMLInputElement | null;
  const raw = input?.value.trim();
  if (!raw) return;
  let toPubkey: string;
  try {
    toPubkey = toPubkeyHex(raw);
  } catch {
    return toast("npub inválido");
  }
  if (toPubkey === state.identity?.pubkey) return toast("No podés retarte a vos mismo");
  pendingChallenge = { toPubkey };
  toast("Creando sala…");
  createConfiguredRoom();
}

// --------------------------------------------------------------- render: partida

function enterGame(): void {
  board?.destroy();
  board = null;
  document.body.classList.add("game-active");
  state.ended = null;
  state.myRating = null;
  state.rematchRequested = false;
  state.rematchOffer = null;
  state.bet = null;
  state.myBetInvoice = null;
  state.newlyEarned = [];
  pendingMove = null;
  viewedHistoryPly = null;
  app.innerHTML =
    topbar() +
    `<main class="game">
      <div class="board-col">
        <div class="player-bar" id="player-top"></div>
        <div class="board-wrap" id="board-wrap"></div>
        <div class="player-bar" id="player-bottom"></div>
      </div>
      <aside class="side" id="side"></aside>
    </main>`;
  const onMove: MoveFn = (from, to, promo) => {
    // Peón coronando sin pieza elegida: abrir
    // el selector antes de mandar la jugada. El server valida igual.
    if (!promo && isPromotionMove(from, to)) {
      openPromotionDialog(myColor() ?? "w", to, (piece) => submitMove(from, to, piece), () => board?.rejectMove());
      return;
    }
    submitMove(from, to, promo === "" ? undefined : (promo as "q" | "r" | "b" | "n"));
  };
  const boardHost = document.getElementById("board-wrap")!;
  boardHost.dataset.boardKind = "vexel";
  const feedback = (event: "pickup" | "drop" | "invalid") => playFeedback(event === "drop" ? "move" : event);
  let failureHandled = false;
  const showVexelFailure = (reason: string) => {
    if (failureHandled) return;
    failureHandled = true;
    console.error(`[chess-board] Vexel no pudo iniciar: ${reason}`);
    board?.destroy();
    board = null;
    boardHost.replaceChildren();
    boardHost.dataset.boardKind = "error";
    boardHost.innerHTML = `<div class="board-error" role="alert">
      <strong>Vexel no pudo iniciar</strong>
      <span>El tablero necesita recargarse para continuar.</span>
      <button class="btn-gold" id="retry-vexel" type="button">Reintentar Vexel</button>
    </div>`;
    boardHost.querySelector<HTMLButtonElement>("#retry-vexel")?.addEventListener("click", () => location.reload());
    announce("Vexel no pudo iniciar. Recargá el tablero para continuar.");
  };
  board = createBoard(boardHost, onMove, feedback, showVexelFailure);
  renderBoardFromMatch();
  patchGame();
}

function submitMove(from: string, to: string, promotion?: "q" | "r" | "b" | "n"): void {
  if (pendingMove || state.room?.phase !== "playing" || !state.match) {
    board?.rejectMove();
    return;
  }
  const requestId = crypto.randomUUID?.() ?? `move_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  pendingMove = { requestId, from, to };
  net.move(requestId, from, to, promotion);
}

function showCountdown(): void {
  board?.setInteractive(false);
  board?.showCountdown();
  const beats = ["3", "2", "1", "Jugá"];
  beats.forEach((beat, index) => setTimeout(() => {
    announce(beat);
    playSound(index === beats.length - 1 ? "start" : "ui");
  }, index * 320));
  setTimeout(() => renderBoardFromMatch(), beats.length * 320 + 120);
}

/** ¿La jugada es un peón llegando a la última fila? (mirando el FEN actual). */
function isPromotionMove(from: string, to: string): boolean {
  const fen = state.match?.fen;
  if (!fen) return false;
  const piece = fenPieceAt(fen, from);
  return (piece === "P" && to[1] === "8") || (piece === "p" && to[1] === "1");
}

/** Pieza en una casilla según el FEN ('P' blanca, 'p' negra…), o null si vacía. */
function fenPieceAt(fen: string, square: string): string | null {
  const ranks = (fen.split(" ")[0] ?? "").split("/");
  const file = square.charCodeAt(0) - 97;
  const row = ranks[8 - Number(square[1])];
  if (!row || file < 0 || file > 7) return null;
  let col = 0;
  for (const ch of row) {
    if (ch >= "1" && ch <= "8") {
      col += Number(ch);
      if (col > file) return null; // la casilla cae en el hueco
    } else {
      if (col === file) return ch;
      col++;
    }
  }
  return null;
}

/** Modal para elegir la pieza de coronación. Cerrar sin elegir cancela la jugada. */
function openPromotionDialog(
  color: Color,
  target: string,
  choose: (p: "q" | "r" | "b" | "n") => void,
  cancel: () => void,
): void {
  document.getElementById("promo-modal")?.remove();
  const el = document.createElement("div");
  el.id = "promo-modal";
  el.className = "promotion-popover";
  el.dataset.target = target;
  const pieces: Array<["q" | "r" | "b" | "n", string]> = [["q", "Q"], ["r", "R"], ["b", "B"], ["n", "N"]];
  el.innerHTML = `
    <div class="promotion-panel" role="dialog" aria-label="Elegir pieza para coronar">
      <span class="promotion-label">Coroná tu peón</span>
      <div class="promo-choices">
        ${pieces
          .map(
            ([p, code]) =>
              `<button class="promo-btn" data-promo="${p}"><img src="/textures/pieces/${color}${code}.png" alt="${p}" /></button>`,
          )
          .join("")}
      </div>
    </div>`;
  document.body.appendChild(el);
  const boardBounds = document.getElementById("board-wrap")?.getBoundingClientRect();
  if (boardBounds) {
    const file = target.charCodeAt(0) - 97;
    const rank = 8 - Number(target[1]);
    const viewFile = color === "w" ? file : 7 - file;
    const viewRank = color === "w" ? rank : 7 - rank;
    const x = boardBounds.left + ((viewFile + .5) / 8) * boardBounds.width;
    const y = boardBounds.top + ((viewRank + .5) / 8) * boardBounds.height;
    el.style.setProperty("--promo-x", `${Math.max(178, Math.min(innerWidth - 178, x))}px`);
    el.style.setProperty("--promo-y", `${Math.max(90, Math.min(innerHeight - 90, y))}px`);
  }
  el.addEventListener("click", (e) => {
    if (e.target === el) { el.remove(); cancel(); }
  });
  el.querySelectorAll<HTMLElement>(".promo-btn").forEach((b) =>
    b.addEventListener("click", () => {
      el.remove();
      choose(b.dataset.promo as "q" | "r" | "b" | "n");
    }),
  );
}

function historyPositions(): HistoryPosition[] {
  return buildHistoryPositions(state.match?.sanHistory ?? []);
}

function activeHistoryPly(): number {
  const latest = state.match?.sanHistory.length ?? 0;
  return viewedHistoryPly === null ? latest : Math.max(0, Math.min(viewedHistoryPly, latest));
}

function historyPositionLabel(ply: number): string {
  if (ply === 0) return "Posición inicial";
  const san = state.match?.sanHistory[ply - 1] ?? "";
  const move = Math.ceil(ply / 2);
  return `${move}${ply % 2 === 0 ? "…" : "."} ${san}`;
}

function viewHistoryAt(ply: number): void {
  if (!state.match || pendingMove) return;
  const latest = state.match.sanHistory.length;
  const next = Math.max(0, Math.min(Math.round(ply), latest));
  viewedHistoryPly = next === latest ? null : next;
  renderBoardFromMatch();
  patchSidePanels();
  announce(viewedHistoryPly === null ? "Volviste a la posición en vivo" : `Revisando ${historyPositionLabel(next)}`);
}

function renderBoardFromMatch(): void {
  if (!board) return;
  const color = myColor() ?? "w";
  board.setOrientation(color);
  document.getElementById("history-review-badge")?.remove();
  if (state.match) {
    const isPlaying = state.room?.phase === "playing";
    const latestPly = state.match.sanHistory.length;
    const selectedPly = activeHistoryPly();
    if (selectedPly < latestPly) {
      const position = historyPositions()[selectedPly];
      if (position) {
        board.applyFen(position.fen);
        board.highlight(position.move ? [position.move.from, position.move.to] : []);
        board.setLegalTargets({});
        board.setInteractive(false);
        const badge = document.createElement("div");
        badge.id = "history-review-badge";
        badge.className = "history-review-badge";
        badge.textContent = historyPositionLabel(selectedPly);
        document.getElementById("board-wrap")?.appendChild(badge);
        return;
      }
    }
    viewedHistoryPly = null;
    board.applyFen(state.match.fen, state.match.lastMove);
    const last = state.match.lastMove;
    board.highlight(last ? [last.from, last.to] : []);
    board.setLegalTargets(isPlaying ? legalTargets(state.match.fen, color) : {});
    const myTurn = isPlaying && state.match.turn === color && state.match.result.kind === "ongoing";
    board.setInteractive(myTurn && !pendingMove);
  } else {
    board.applyFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1");
    board.setLegalTargets({});
    board.setInteractive(false);
  }
}

function legalTargets(fen: string, color: Color): LegalTargets {
  const chess = new Chess(fen);
  if (chess.turn() !== color) return {};
  const targets: LegalTargets = {};
  for (const file of "abcdefgh") {
    for (const rank of "12345678") {
      const from = `${file}${rank}` as Square;
      const moves = chess.moves({ square: from, verbose: true });
      if (moves.length) targets[from] = [...new Set(moves.map((move) => move.to))];
    }
  }
  return targets;
}

function patchGame(): void {
  renderBoardFromMatch();
  renderPlayers();
  patchSidePanels();
}

// -- barras de jugador (arriba = rival, abajo = yo) --

function renderPlayers(): void {
  const top = document.getElementById("player-top");
  const bottom = document.getElementById("player-bottom");
  if (!top || !bottom || !state.room) return;
  const me = myColor();
  const mine = state.room.players.find((p) => p.color === me) ?? state.room.players[0];
  const rival = state.room.players.find((p) => p.color !== me) ?? state.room.players[1];
  top.className = playerBarClass(rival);
  top.innerHTML = playerBarInner(rival, false);
  bottom.className = playerBarClass(mine);
  bottom.innerHTML = playerBarInner(mine, true);
}

function playerBarClass(p?: { color: Color | null }): string {
  const m = state.match;
  const isTurn = p && m?.turn === p.color && m?.result.kind === "ongoing";
  return "player-bar" + (isTurn ? " turn" : "");
}

function playerBarInner(p: RoomPlayer | undefined, isMe: boolean): string {
  if (!p) return `<span class="muted">Esperando rival…</span>`;
  const name = visibleName(p);
  const profile = profileFor(p.pubkey);
  const m = state.match;
  const matchClock = p.color === "w" ? m?.whiteClockMs : m?.blackClockMs;
  const ms = matchClock ?? (p.color ? state.room?.clockMs : undefined);
  const isTurn = m?.turn === p.color && m?.result.kind === "ongoing";
  const remaining = ms === undefined || !p.color ? undefined : liveClockMs(ms, p.color);
  const urgency = remaining === undefined ? 0 : clockUrgency(remaining, state.room?.clockMs || 5 * 60 * 1000);
  const warning = urgency === 2 ? "¡ÚLTIMOS 10 SEGUNDOS!" : urgency === 1 ? "POCO TIEMPO" : "Tiempo normal";
  const tag = isMe && isTurn ? `<span class="turn-tag">TU TURNO</span>` : "";
  const captured = p.color ? capturedHtml(p.color) : "";
  return `
    ${avatarHtml(name, profile?.picture ?? null, isMe ? "me-avatar" : "")}
    <div class="player-meta">
      <span class="player-name">${escapeHtml(name)}${tag}</span>
      <span class="captured">${captured}</span>
    </div>
    <span class="clock-shell">
      <span class="time-warning urgency-${urgency}"${p.color ? ` data-time-warning="${p.color}"` : ""} aria-hidden="true">${warning}</span>
      <span class="clock${isTurn ? " is-active" : ""}${urgency === 1 ? " is-low" : urgency === 2 ? " is-critical" : ""}" role="timer"${p.color ? ` data-clock="${p.color}"` : ""} aria-label="${remaining === undefined ? "Reloj sin iniciar" : clockAriaLabel(remaining, urgency)}">${remaining === undefined ? "--:--" : formatClockMs(remaining)}</span>
    </span>`;
}

// -- panel lateral por fase --

function patchSidePanels(): void {
  const side = document.getElementById("side");
  if (!side || !state.room) return;
  side.innerHTML = phasePanelHtml();
  wireSidePanels();
  // Mantener a la vista la posición seleccionada; en vivo, seguir la última.
  const grid = document.getElementById("history-grid");
  const selected = grid?.querySelector<HTMLElement>(".ply.viewing");
  if (grid && selected)
    grid.scrollTop = Math.max(0, selected.offsetTop - grid.clientHeight / 2 + selected.offsetHeight / 2);
  else if (grid) grid.scrollTop = grid.scrollHeight;
}

function phasePanelHtml(): string {
  const room = state.room!;
  if (state.ended) return endedPanel() + historyCard();
  if (room.phase === "playing") return historyCard() + playingPanel();
  return lobbyPanel();
}

function historyCard(): string {
  const sans = state.match?.sanHistory ?? [];
  const rows: string[] = [];
  const last = sans.length - 1;
  const selectedPly = activeHistoryPly();
  const reviewing = viewedHistoryPly !== null && selectedPly < sans.length;
  for (let i = 0; i < sans.length; i += 2) {
    const w = sans[i];
    const b = sans[i + 1];
    if (!w) continue;
    const wClass = `${i === last ? " last" : ""}${selectedPly === i + 1 ? " viewing" : ""}`;
    const bClass = `${i + 1 === last ? " last" : ""}${selectedPly === i + 2 ? " viewing" : ""}`;
    rows.push(
      `<span class="num">${i / 2 + 1}.</span>` +
        `<button type="button" class="ply${wClass}" data-history-ply="${i + 1}" aria-label="Ver posición después de ${escapeHtml(w)}">${escapeHtml(w)}</button>` +
        (b
          ? `<button type="button" class="ply${bClass}" data-history-ply="${i + 2}" aria-label="Ver posición después de ${escapeHtml(b)}">${escapeHtml(b)}</button>`
          : `<span class="ply empty" aria-hidden="true"></span>`),
    );
  }
  const body = rows.length
    ? `<div class="history-grid" id="history-grid">${rows.join("")}</div>`
    : `<p class="history-empty">Sin jugadas todavía.</p>`;
  return `<div class="card history">
    <div class="history-heading"><p class="section-label">Jugadas</p><span>${reviewing ? "Revisión" : "En vivo"}</span></div>
    ${body}
    <div class="history-controls" aria-label="Navegar posiciones anteriores">
      <button type="button" id="history-first" aria-label="Posición inicial" title="Posición inicial" ${selectedPly === 0 ? "disabled" : ""}>⏮</button>
      <button type="button" id="history-back" aria-label="Jugada anterior" title="Jugada anterior" ${selectedPly === 0 ? "disabled" : ""}>◀</button>
      <span class="history-position">${reviewing ? escapeHtml(historyPositionLabel(selectedPly)) : "● En vivo"}</span>
      <button type="button" id="history-forward" aria-label="Jugada siguiente" title="Jugada siguiente" ${selectedPly >= sans.length ? "disabled" : ""}>▶</button>
      <button type="button" id="history-live" class="history-live" aria-label="Volver a la posición en vivo" title="Volver en vivo" ${!reviewing ? "disabled" : ""}>En vivo</button>
    </div>
  </div>`;
}

function lobbyPanel(): string {
  const room = state.room!;
  const full = room.players.length >= 2;
  const clockMinutes = Math.round((room.clockMs || 5 * 60 * 1000) / 60_000);
  const timeControl = amHost()
    ? `<div class="card time-control-card is-editable" aria-label="Configurar ritmo de la partida">
        <div class="time-control-heading">
          <div><p class="section-label">Ritmo de la partida</p><strong>${clockMinutes}<small> min</small></strong></div>
          <span>Elegís vos<br><small>sin incremento</small></span>
        </div>
        <div class="time-options lobby-time-options">
          ${CLOCK_OPTIONS.map((minutes) => `<label>
            <input type="radio" name="lobby-clock-minutes" value="${minutes}" ${minutes === clockMinutes ? "checked" : ""} />
            <span>${minutes}<small>min</small></span>
          </label>`).join("")}
        </div>
        <p class="fine">Podés cambiarlo hasta que empiece la partida.</p>
      </div>`
    : `<div class="card time-control-card" aria-label="Ritmo de la partida: ${clockMinutes} minutos por jugador, sin incremento">
        <div><p class="section-label">Ritmo de la partida</p><strong>${clockMinutes}<small> min</small></strong></div>
        <span>por jugador<br><small>sin incremento</small></span>
      </div>`;
  const inviteUrl = `${location.origin}/?join=${encodeURIComponent(room.id)}`;
  const seats = room.players
    .map((p) => {
      const name = visibleName(p);
      const profile = profileFor(p.pubkey);
      const role = p.npub === room.hostNpub ? "anfitrión" : "invitado";
      const colorName = p.color === "w" ? "Blancas" : p.color === "b" ? "Negras" : "—";
      return `<div class="seat">
        ${avatarHtml(name, profile?.picture ?? null)}
        <div class="seat-meta">
          <span class="player-name">${escapeHtml(name)}</span>
          <span class="seat-role">${colorName} · ${role}</span>
        </div>
        <span class="seat-status"><span class="dot"></span>Conectado</span>
      </div>`;
    })
    .join("");
  const emptySeat = full
    ? ""
    : `<div class="seat empty">
        <span class="avatar empty">?</span>
        <span class="muted">Esperando rival…</span>
      </div>`;

  return `
    <div class="card invite-card">
      <p class="section-label">Código de sala</p>
      <p class="invite-code">${room.code}</p>
      <div class="row">
        <input id="invite-url" readonly value="${inviteUrl}" />
        <button id="copy">Copiar</button>
      </div>
      <p class="fine">Compartí el link o el código (tu rival tiene que usar OTRO nombre).</p>
    </div>
    ${timeControl}
    ${login?.kind === "nostr" && !full ? `<div class="card friend-invite-card"><p class="section-label">Invitar desde Nostr</p>${friendInviteListHtml()}</div>` : ""}
    <div class="card">${seats}${emptySeat}</div>
    ${betPanel()}
    <button class="btn-gold ready-button${state.ready ? " is-ready" : ""}" id="ready" ${!full || state.ready ? "disabled" : ""} aria-live="polite" aria-label="${state.ready ? "Estás listo. Esperando al rival" : full ? `Ponerme listo para jugar ${clockMinutes} minutos` : "Falta el rival para empezar"}">
      <span class="ready-button-icon" aria-hidden="true">${state.ready ? "✓" : "♟"}</span>
      <span class="ready-button-copy">
        <strong>${state.ready ? "¡Listo!" : full ? "Ponerme listo" : "Falta el rival"}</strong>
        <small>${state.ready ? "Esperando al rival…" : full ? `Partida de ${clockMinutes} min` : "Podrás empezar cuando se una"}</small>
      </span>
    </button>
    <button class="danger leave-room" id="leave-room">Salir de la sala</button>`;
}

/** ¿Ambos jugadores entraron con Nostr? (requisito para apostar). */
function bothNostr(): boolean {
  const players = state.room?.players ?? [];
  return players.length >= 2 && players.every((p) => !!p.pubkey);
}

function amHost(): boolean {
  return state.room?.hostNpub === state.identity?.npub;
}

/** Panel de apuesta custodiada (NGE) en el lobby. */
function betPanel(): string {
  if (!state.betsEnabled) return "";
  const bet = state.bet;
  if (!bet) {
    if (!bothNostr())
      return `<div class="card bet-card">
        <p class="section-label">Apuesta</p>
        <p class="fine">Ambos deben entrar con Nostr para apostar en la partida.</p>
      </div>`;
    if (!amHost())
      return `<div class="card bet-card">
        <p class="section-label">Apuesta</p>
        <p class="fine">El anfitrión puede proponer una apuesta en sats.</p>
      </div>`;
    return `<div class="card bet-card">
      <p class="section-label">Apuesta (opcional)</p>
      <p class="fine">Pozo custodiado por Lightning. Ganás la partida, ganás el pozo. Empate → reembolso.</p>
      <div class="row" style="margin-top:10px">
        <input id="bet-stake" type="number" min="1" placeholder="sats por jugador" />
        <button id="bet-propose">Proponer</button>
      </div>
    </div>`;
  }

  // Hay apuesta: estado + depósito propio.
  const mine = state.bet?.seats.find((s) => s.color === myColor());
  const iPaid = mine?.deposited === true;
  const seatsHtml = bet.seats
    .map((s) => {
      const name = state.room?.players.find((p) => p.color === s.color)?.displayName ?? (s.color === "w" ? "Blancas" : "Negras");
      return `<div class="bet-seat">
        <span>${name}</span>
        <span class="${s.deposited ? "paid" : "unpaid"}">${s.deposited ? "✓ pagó" : "pendiente"}</span>
      </div>`;
    })
    .join("");
  const inv = state.myBetInvoice;
  const invoiceHtml =
    !iPaid && inv?.bolt11
      ? `<div class="bet-invoice-box">
          <p class="zap-invoice-label">Pagá ${inv.amountSats} sats para entrar:</p>
          <textarea class="zap-invoice" readonly rows="3">${inv.bolt11}</textarea>
          <div class="row">
            <a class="btn-gold" href="lightning:${inv.bolt11}">Abrir en billetera</a>
            <button id="bet-copy">Copiar</button>
          </div>
        </div>`
      : iPaid
        ? `<p class="fine">Ya depositaste. Esperando al rival…</p>`
        : "";
  const cancelBtn = amHost()
    ? `<button class="danger" id="bet-cancel" style="margin-top:12px">Cancelar apuesta</button>`
    : "";
  // El escrow reporta potSats real (0 hasta fondear); mostramos el pozo objetivo.
  const targetPot = bet.stakeSats * bet.seats.length;
  return `<div class="card bet-card">
    <p class="section-label">Apuesta · pozo ${targetPot} sats (${bet.stakeSats} c/u)</p>
    <div class="bet-seats">${seatsHtml}</div>
    ${invoiceHtml}
    ${cancelBtn}
  </div>`;
}

function playingPanel(): string {
  const me = state.identity?.npub;
  const offer = state.drawOfferBy;
  const m = state.match;
  const status =
    viewedHistoryPly !== null
      ? `<p class="status review">Revisando ${escapeHtml(historyPositionLabel(activeHistoryPly()))}</p>`
      : m?.inCheck && m.result.kind === "ongoing"
      ? `<p class="status check">¡Jaque!</p>`
      : `<p class="status muted">${m?.turn === myColor() ? "Tu turno" : "Turno del rival"}</p>`;
  const drawBtn =
    offer && offer !== me
      ? `<button id="accept-draw" class="btn-gold">Aceptar tablas</button>
         <button id="decline-draw">Rechazar</button>`
      : offer && offer === me
        ? `<button disabled>Tablas ofrecidas — esperando respuesta…</button>`
        : `<button id="offer-draw">½ Ofrecer tablas</button>`;
  return `<div class="card game-controls">
    ${status}
    <div class="actions" style="margin-top:12px">
      ${drawBtn}
      <button class="danger" id="resign">Abandonar</button>
    </div>
  </div>`;
}

/**
 * Confirmación inline para acciones destructivas: el primer clic arma el botón
 * (cambia el texto), el segundo dentro de la ventana ejecuta. Sin modales.
 */
function armButton(btn: HTMLButtonElement, armedText: string, fn: () => void): void {
  if (btn.dataset.armed === "1") {
    btn.dataset.armed = "";
    fn();
    return;
  }
  const original = btn.textContent ?? "";
  btn.dataset.armed = "1";
  btn.textContent = armedText;
  setTimeout(() => {
    if (btn.isConnected && btn.dataset.armed === "1") {
      btn.dataset.armed = "";
      btn.textContent = original;
    }
  }, 4000);
}

function endedPanel(): string {
  const me = state.identity?.npub;
  const e = state.ended!;
  const cls = e.winnerNpubs.length === 0 ? "draw" : me && e.winnerNpubs.includes(me) ? "win" : "lose";
  const crown = cls === "win" ? "♔" : cls === "lose" ? "♚" : "½";
  const r = state.myRating;
  const ratingLine = r
    ? `<p class="result-rating">Rating ${r.rating} ` +
      `<span class="delta ${r.delta >= 0 ? "up" : "down"}">${r.delta >= 0 ? "+" : ""}${r.delta}</span></p>`
    : "";
  const mastery = state.mastery;
  const earned = state.newlyEarned.length
    ? `<div class="achievement-reveal">${state.newlyEarned.map((id) => `<span>✦ ${achievementLabel(id)}</span>`).join("")}</div>`
    : "";
  return `<div class="card result-card ${cls}" style="position:static">
    <div class="result-glow" aria-hidden="true"></div>
    <div class="crown">${crown}</div>
    <p class="result-title">${e.text}</p>
    <p class="result-sub">${e.sub}</p>
    ${ratingLine}
    ${mastery ? `<div class="result-mastery"><span><strong>${mastery.rating}</strong> ELO</span><span><strong>${mastery.winStreak}</strong> racha</span><span><strong>${mastery.games}</strong> partidas</span></div>` : ""}
    ${earned}
    <div class="actions result-primary-actions">
      ${rematchButton()}
      ${login?.kind === "nostr" ? `<details class="next-rival"><summary>Retar a otro</summary>${friendInviteListHtml()}</details>` : ""}
    </div>
    <div class="result-room-actions">
      <button class="result-leave-room" id="leave-room">Salir de la sala</button>
    </div>
    <div class="result-secondary-actions">
      ${login?.kind === "nostr" ? `<button id="share-achievement">Compartir</button>` : ""}
      ${zapRivalButton()}
    </div>
  </div>`;
}

function achievementLabel(id: AchievementId): string {
  const labels: Record<AchievementId, string> = {
    first_game: "Primera partida",
    first_win: "Primera victoria",
    checkmate_win: "Victoria por mate",
    win_streak_3: "Racha de 3",
    win_streak_5: "Racha de 5",
    rivalry_3: "Rivalidad naciente",
  };
  return labels[id];
}

/** Botón de revancha según el estado del pedido (solo con el rival presente). */
function rematchButton(): string {
  if (!state.room?.players || state.room.players.length < 2) return "";
  if (state.rematchRequested) return `<button disabled>Revancha pedida — esperando al rival…</button>`;
  if (state.rematchOffer)
    return `<button class="btn-gold" id="rematch">Aceptar revancha de ${nameOf(state.rematchOffer)}</button>`;
  return `<button class="btn-gold" id="rematch">⚔ Revancha</button>`;
}

/** El otro jugador de la sala (el rival). */
function rivalPlayer(): RoomPlayer | undefined {
  const me = state.identity?.npub;
  return state.room?.players.find((p) => p.npub !== me);
}

/** Botón de propina al rival — solo si yo entré con Nostr y el rival tiene pubkey. */
function zapRivalButton(): string {
  if (login?.kind !== "nostr") return "";
  const rival = rivalPlayer();
  if (!rival?.pubkey) return "";
  const resolvedName = visibleName(rival).trim();
  const name = !resolvedName || /^npub1/i.test(resolvedName) ? "tu rival" : resolvedName;
  const picture = profileFor(rival.pubkey)?.picture ?? null;
  return `<button class="zap-rival-button" id="zap-rival" aria-label="Enviar propina a ${escapeHtml(name)}">
    ${avatarHtml(name, picture, "zap-rival-avatar")}
    <span><span class="zap-rival-bolt" aria-hidden="true">⚡</span> Propina a <strong>${escapeHtml(name)}</strong></span>
  </button>`;
}

/** Texto del logro según el resultado, para publicar como kind:1. */
function achievementText(): string {
  const e = state.ended;
  const plies = state.match?.sanHistory.length ?? 0;
  const jugadas = plies ? ` en ${Math.ceil(plies / 2)} jugadas` : "";
  const rating = state.myRating ? ` Mi rating: ${state.myRating.rating}.` : "";
  const won = e && state.identity && e.winnerNpubs.includes(state.identity.npub);
  const head = e?.winnerNpubs.length === 0 ? `Empaté una partida de ajedrez${jugadas}` : won ? `Gané una partida de ajedrez${jugadas} ♟` : `Jugué una partida de ajedrez${jugadas}`;
  return `${head}.${rating} #ajedrez`;
}

function wireSidePanels(): void {
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener("click", fn);
  wireFriendInviteButtons();
  document.querySelectorAll<HTMLButtonElement>("[data-history-ply]").forEach((button) => {
    button.addEventListener("click", () => viewHistoryAt(Number(button.dataset.historyPly)));
  });
  on("history-first", () => viewHistoryAt(0));
  on("history-back", () => viewHistoryAt(activeHistoryPly() - 1));
  on("history-forward", () => viewHistoryAt(activeHistoryPly() + 1));
  on("history-live", () => viewHistoryAt(state.match?.sanHistory.length ?? 0));
  on("copy", () => {
    const el = document.getElementById("invite-url") as HTMLInputElement | null;
    if (el) navigator.clipboard.writeText(el.value).then(() => toast("Link copiado"));
  });
  document.querySelectorAll<HTMLInputElement>('input[name="lobby-clock-minutes"]').forEach((input) => {
    input.addEventListener("change", () => {
      const minutes = Number(input.value);
      if (!CLOCK_OPTIONS.includes(minutes as (typeof CLOCK_OPTIONS)[number])) return;
      state.ready = false;
      document.querySelectorAll<HTMLInputElement>('input[name="lobby-clock-minutes"]').forEach((option) => { option.disabled = true; });
      playFeedback("ui");
      net.setTimeControl(minutes);
    });
  });
  on("ready", () => {
    state.ready = true;
    playFeedback("ui");
    net.ready();
    patchSidePanels();
    announce("Estás listo. Esperando al rival.");
  });
  on("leave-room", () => {
    const btn = document.getElementById("leave-room") as HTMLButtonElement | null;
    if (!btn) return;
    if (state.ended) {
      btn.disabled = true;
      btn.textContent = "Saliendo…";
      net.leaveRoom();
    } else armButton(btn, "¿Confirmar salida?", () => net.leaveRoom());
  });
  on("bet-propose", () => {
    const input = document.getElementById("bet-stake") as HTMLInputElement | null;
    const stake = Number(input?.value);
    if (!Number.isInteger(stake) || stake <= 0) return toast("Ingresá un monto válido en sats");
    const btn = document.getElementById("bet-propose") as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = "Creando…"; }
    net.proposeBet(stake);
  });
  on("bet-cancel", () => net.cancelBet());
  on("bet-copy", () => {
    const inv = state.myBetInvoice?.bolt11;
    if (inv) navigator.clipboard.writeText(inv).then(() => toast("Invoice copiado"));
  });
  on("resign", () => {
    const btn = document.getElementById("resign") as HTMLButtonElement | null;
    if (btn) armButton(btn, "¿Confirmar abandono?", () => net.resign());
  });
  on("offer-draw", () => net.offerDraw()); // el broadcast actualiza el panel
  on("accept-draw", () => net.acceptDraw());
  on("decline-draw", () => net.declineDraw());
  on("rematch", () => {
    state.rematchRequested = true;
    trackUx("rematch_requested");
    net.rematch();
    patchSidePanels();
  });
  on("share-achievement", () => {
    if (login?.kind !== "nostr") return;
    const btn = document.getElementById("share-achievement") as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = "Publicando…"; }
    publishNote(login.signer, achievementText())
      .then(() => toast("Logro publicado en Nostr ♟"))
      .catch(() => toast("No se pudo publicar"))
      .finally(() => { if (btn) { btn.textContent = "Compartido ✓"; } });
  });
  on("zap-rival", () => {
    const rival = rivalPlayer();
    if (!rival?.pubkey) return;
    const resolvedName = visibleName(rival).trim();
    const name = !resolvedName || /^npub1/i.test(resolvedName) ? "tu rival" : resolvedName;
    openZapDialog(rival.pubkey, name, profileFor(rival.pubkey)?.picture ?? null);
  });
}

// --------------------------------------------------------------- zaps (propinas)

/** Modal de propina: elegís monto y se genera un invoice para pagar con billetera. */
function openZapDialog(pubkey: string, name: string, picture: string | null): void {
  if (login?.kind !== "nostr") return;
  const signer = login.signer;
  document.getElementById("zap-modal")?.remove();
  const el = document.createElement("div");
  el.id = "zap-modal";
  el.className = "modal-overlay";
  el.innerHTML = `
    <div class="modal">
      <button class="modal-close" id="zap-close">✕</button>
      <div class="zap-dialog-player">
        ${avatarHtml(name, picture, "zap-dialog-avatar")}
        <div><span>Enviar propina a</span><h3>${escapeHtml(name)}</h3></div>
      </div>
      <p class="muted">Elegí un monto. Se genera un invoice que pagás con tu billetera Lightning.</p>
      <div class="zap-amounts">
        ${[21, 100, 500, 1000].map((a) => `<button class="zap-amt" data-sats="${a}">${a} sats</button>`).join("")}
      </div>
      <div id="zap-result"></div>
    </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.addEventListener("click", (e) => { if (e.target === el) close(); });
  el.querySelector("#zap-close")!.addEventListener("click", close);
  el.querySelectorAll<HTMLElement>(".zap-amt").forEach((b) =>
    b.addEventListener("click", () => requestZap(signer, pubkey, name, Number(b.dataset.sats))),
  );
}

function requestZap(signer: NgpSigner, pubkey: string, name: string, sats: number): void {
  const box = document.getElementById("zap-result");
  if (box) box.innerHTML = `<p class="muted">Generando invoice…</p>`;
  createZapInvoice(signer, pubkey, sats, `Propina de ajedrez para ${name}`)
    .then((inv) => {
      if (!box) return;
      box.innerHTML = `
        <p class="zap-invoice-label">${inv.amountSats} sats · pagá con tu billetera</p>
        <textarea class="zap-invoice" readonly rows="3">${inv.bolt11}</textarea>
        <div class="row">
          <a class="btn-gold" href="lightning:${inv.bolt11}">Abrir en billetera</a>
          <button id="zap-copy">Copiar</button>
        </div>`;
      document.getElementById("zap-copy")?.addEventListener("click", () =>
        navigator.clipboard.writeText(inv.bolt11).then(() => toast("Invoice copiado")),
      );
    })
    .catch((err: unknown) => {
      if (box) box.innerHTML = `<p class="status check">${err instanceof Error ? err.message : "Error"}</p>`;
    });
}

// --------------------------------------------------------------- reloj + toast

/** Formatea el reloj de un color, descontando localmente si es su turno. */
function liveClockMs(baseMs: number, color: Color): number {
  const m = state.match;
  let live = baseMs;
  if (m && m.result.kind === "ongoing" && m.turn === color) {
    live = baseMs - (Date.now() - state.matchReceivedAt);
  }
  return Math.max(0, live);
}

// Tic del reloj: actualiza SOLO el texto de los relojes (nada de reconstruir las
// barras enteras cada segundo — flickeaba y reparseaba las piezas capturadas).
function updateClockDisplays(): void {
  const m = state.match;
  if (state.room?.phase !== "playing" || m?.result.kind !== "ongoing") return;
  for (const el of document.querySelectorAll<HTMLElement>("[data-clock]")) {
    const color = el.dataset.clock as Color;
    const remaining = liveClockMs(color === "w" ? m.whiteClockMs : m.blackClockMs, color);
    const urgency = clockUrgency(remaining, state.room.clockMs || 5 * 60 * 1000);
    el.textContent = formatClockMs(remaining);
    el.classList.toggle("is-low", urgency === 1);
    el.classList.toggle("is-critical", urgency === 2);
    el.setAttribute("aria-label", clockAriaLabel(remaining, urgency));
    const warning = document.querySelector<HTMLElement>(`[data-time-warning="${color}"]`);
    if (warning) {
      warning.className = `time-warning urgency-${urgency}`;
      warning.textContent = urgency === 2 ? "¡ÚLTIMOS 10 SEGUNDOS!" : urgency === 1 ? "POCO TIEMPO" : "Tiempo normal";
    }

    if (color !== myColor() || color !== m.turn || urgency <= ownClockAlertLevel) continue;
    ownClockAlertLevel = urgency;
    if (urgency === 2) {
      playFeedback("time-critical");
      announce("Atención: te quedan diez segundos");
    } else {
      playFeedback("time-low");
      announce(`Atención: te queda poco tiempo, ${formatClockMs(remaining)}`);
    }
  }
}

setInterval(updateClockDisplays, 250);

/** Errores del server traducidos para humanos (el código crudo va de fallback). */
const ERROR_TEXT: Record<string, string> = {
  UNAUTHED: "La sesión se perdió — iniciá sesión de nuevo",
  INVALID_TOKEN: "Ese nombre no es válido",
  BAD_ROOM_ID: "El link de la sala no es válido",
  ROOM_FULL:
    "La sala ya está completa. ¿Usaste el mismo nombre que otro jugador? Cada jugador necesita un nombre distinto.",
  NOT_READY: "Falta el rival para empezar",
  NOT_FULL: "Falta el rival para empezar",
  NOT_FINISHED: "La partida todavía no terminó",
  NO_MATCH: "No hay partida en curso",
  MATCH_OVER: "La partida ya terminó",
  NOT_A_PLAYER: "No estás jugando esta partida",
  NOT_YOUR_TURN: "No es tu turno",
  ILLEGAL_MOVE: "Esa jugada no es legal",
  BETS_DISABLED: "Las apuestas están deshabilitadas en este servidor",
  NOT_HOST: "Solo el anfitrión puede hacer eso",
  NOT_LOBBY: "La partida ya arrancó",
  BET_EXISTS: "Ya hay una apuesta en curso",
  BET_STARTED: "La partida ya arrancó — la apuesta no se puede cancelar",
  GUEST_IN_ROOM: "Ambos jugadores deben entrar con Nostr para apostar",
  BAD_STAKE: "Monto de apuesta inválido",
  NO_CHALLENGE: "Falló el login Nostr — probá de nuevo",
  BAD_EVENT: "Falló el login Nostr — probá de nuevo",
  BAD_KIND: "Falló el login Nostr — probá de nuevo",
  CHALLENGE_MISMATCH: "Falló el login Nostr — probá de nuevo",
  STALE_AUTH: "Falló el login Nostr — probá de nuevo",
  BAD_SIG: "La firma Nostr no es válida",
  BAD_JSON: "Algo salió mal en la conexión",
  INTERNAL: "Algo salió mal en el servidor",
  // Errores del escrow NGE (antes se veían todos como INTERNAL genérico).
  TIMEOUT: "El escrow no respondió a tiempo — probá de nuevo",
  PUBLISH_FAILED: "No se pudo contactar a los relays — revisá tu conexión",
  STAKE_OUT_OF_RANGE: "El monto está fuera del rango permitido por el escrow",
  RATE_LIMITED: "Demasiadas apuestas seguidas — esperá un momento",
  NOT_FUNDED: "La apuesta todavía no está fondeada",
};

function errorText(code: string, message?: string): string {
  const known = ERROR_TEXT[code];
  if (known) return known;
  // Código no mapeado (típicamente un error nuevo del escrow): mostrar el motivo
  // real que mandó el server en vez de un genérico opaco.
  return message?.trim() ? `Error del escrow: ${message}` : `Algo salió mal (${code})`;
}

const RECONNECT_BANNER_ID = "reconnect-banner";

function showReconnectBanner(): void {
  if (document.getElementById(RECONNECT_BANNER_ID)) return;
  const el = document.createElement("div");
  el.id = RECONNECT_BANNER_ID;
  el.className = "reconnect-banner";
  el.innerHTML = `<span class="spin">⟳</span>Conexión perdida — reconectando…`;
  document.body.appendChild(el);
}

function hideReconnectBanner(): void {
  document.getElementById(RECONNECT_BANNER_ID)?.remove();
}

function announce(text: string): void {
  let region = document.getElementById("game-announcer");
  if (!region) {
    region = document.createElement("div");
    region.id = "game-announcer";
    region.className = "sr-only";
    region.setAttribute("aria-live", "polite");
    document.body.appendChild(region);
  }
  region.textContent = "";
  requestAnimationFrame(() => { if (region) region.textContent = text; });
}

function toast(text: string, tone: "neutral" | "error" | "success" = "neutral"): void {
  const t = document.createElement("div");
  t.className = `toast ${tone}`;
  t.textContent = text;
  t.setAttribute("role", tone === "error" ? "alert" : "status");
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

start();

// MODO DE PRUEBA (panel diag `?ngptest=1`) — remover con nostr/diag.ts.
if (isNgpTestMode())
  mountDiagPanel(net, () => ({
    mode: login ? login.kind : null,
    signer: login?.kind === "nostr" ? login.signer : null,
  }));
