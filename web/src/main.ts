import "./styles.css";
import { WS_URL } from "./config.js";
import { Net } from "./net.js";
import { createBoard, type BoardController, type BoardKind, type MoveFn } from "./board.js";
import {
  clearActiveSigner,
  createNip07Signer,
  generateLocalSigner,
  hasStoredSigner,
  importNsec,
  restoreSigner,
  setActiveSigner,
  signAuthChallenge,
  toNgpSigner,
  updateStoredPubkey,
  waitForNip07,
  type ChessSigner,
} from "./nostr/signer-core.js";
import { connectBunker, startNostrConnect } from "./nostr/signer-nip46.js";
import QRCode from "qrcode";
import { fetchProfile } from "./nostr/relays.js";
import { publishRating } from "./nostr/score.js";
import { createPresence, type PresenceController } from "./nostr/presence.js";
import { sendChallenge, startChallengeInbox, toPubkeyHex } from "./nostr/challenge.js";
import { publishNote } from "./nostr/social.js";
import { createZapInvoice } from "./nostr/zap.js";
// MODO DE PRUEBA (panel diag `?ngptest=1`) — remover con nostr/diag.ts.
import { isNgpTestMode, mountDiagPanel } from "./nostr/diag.js";
import { startVersionGuard } from "./version.js";
import { playSound, setSoundEnabled, soundEnabled, type SoundName } from "./sound.js";
import type { NgpSigner, ParsedChallenge } from "nostr-game-protocol/ngp";
import type {
  BetView,
  Color,
  MatchSnapshot,
  RatingChange,
  RoomPlayer,
  RoomView,
  SessionIdentity,
} from "./protocol.js";

const NAME_KEY = "ajedrez.name.v1";

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

/** Cómo está autenticado el jugador en esta sesión (para re-auth al reconectar). */
type LoginMode =
  | { kind: "guest"; name: string }
  | { kind: "nostr"; signer: NgpSigner; displayName: string };
let login: LoginMode | null = null;

/** Controlador de presencia NIP-38 (solo login Nostr). */
let presence: PresenceController | null = null;

/** Corta la suscripción al inbox de retos NIP-17 (solo Nostr). */
let inboxStop: (() => void) | null = null;

/** Reto pendiente de enviar: se dispara cuando se crea la sala del retador. */
let pendingChallenge: { toPubkey: string } | null = null;

/** Presencia activa mientras el jugador está en una sala (solo Nostr). */
function ensurePresence(): PresenceController | null {
  if (login?.kind !== "nostr") return null;
  presence ??= createPresence(login.signer);
  return presence;
}

const app = document.getElementById("app")!;
const net = new Net(WS_URL);

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
};

let board: BoardController | null = null;

function boardKind(): BoardKind {
  return new URLSearchParams(location.search).get("board") === "canvas" ? "canvas" : "vexel";
}

// --------------------------------------------------------------- arranque

function storedName(): string | null {
  return sessionStorage.getItem(NAME_KEY);
}

/** Link de entrada a sala. `?join=<id>` es el formato estándar (NGP): sirve para el
 *  invite propio Y para el Room Link de la tienda. La sala se crea lazy (unir-o-crear)
 *  al abrir el link — por eso el id puede no pre-existir. Validamos el formato. */
function pendingJoin(): string | null {
  const v = new URLSearchParams(location.search).get("join");
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

function start(): void {
  startVersionGuard(toast); // recarga sola si el server anuncia un build nuevo
  // "Salir" (delegado: la topbar se re-renderiza en cada pantalla). En plena
  // partida pide confirmación: salir implica abandonar.
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const soundBtn = target.closest?.("[data-action=sound]") as HTMLButtonElement | null;
    if (soundBtn) {
      setSoundEnabled(!soundEnabled());
      soundBtn.textContent = soundEnabled() ? "🔊" : "🔇";
      if (soundEnabled()) playSound("move"); // feedback inmediato
      return;
    }
    const btn = target.closest?.("[data-action=logout]") as HTMLButtonElement | null;
    if (!btn) return;
    const inGame = state.room?.phase === "playing" && !state.ended;
    if (inGame) armButton(btn, "¿Salir y abandonar?", logout);
    else logout();
  });
  wireNet();
  // Con token: sesión inmediata sin depender del firmador (se restaura de fondo).
  const token = readSessionToken();
  if (token) return void authViaToken(token);
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

function readCachedProfile(pubkey: string): { known: boolean; name: string | null } {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return { known: false, name: null };
    const parsed = JSON.parse(raw) as { pubkey?: string; name?: string | null };
    if (parsed.pubkey !== pubkey) return { known: false, name: null };
    return { known: true, name: parsed.name ?? null };
  } catch {
    return { known: false, name: null };
  }
}

function writeCachedProfile(pubkey: string, name: string | null): void {
  try {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({ pubkey, name }));
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
    // debe depender de eso. El signer queda listo para features (marcador, retos)
    // pero NO lo tocamos al cargar: llamar getPublicKey acá dispara el popup de la
    // extensión (Alby) en cada apertura. Prompta recién cuando el usuario firma algo.
    login = { kind: "nostr", signer: toNgpSigner(signer), displayName: "" };
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
  login = { kind: "nostr", signer: toNgpSigner(signer), displayName: cached.name ?? "" };
  // Perfil en paralelo: refresca la caché (positiva o negativa) y el nombre si
  // todavía no se mandó al server.
  profileFetch = fetchProfile(pubkey)
    .then((p) => {
      writeCachedProfile(pubkey, p.name);
      if (p.name && login?.kind === "nostr" && !login.displayName) login.displayName = p.name;
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
  login = { kind: "nostr", signer: toNgpSigner(lazySigner(restorePromise)), displayName: "" };
  net.connect();
  net.authToken(token);
  restorePromise
    .then((s) => {
      // Reemplazamos el firmador perezoso por el real para las features, pero NO
      // llamamos getPublicKey/perfil acá: la sesión ya vale por token y hacerlo
      // dispararía el popup de la extensión (Alby) en cada carga de la página. La
      // extensión prompta recién cuando el usuario hace algo que firma.
      if (s && login?.kind === "nostr") login.signer = toNgpSigner(s);
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
  clearActiveSigner();
  clearSessionToken();
  clearSavedRoom();
  sessionStorage.removeItem(NAME_KEY);
  login = null;
  state.identity = null;
  void presence?.stop();
  presence = null;
  inboxStop?.();
  inboxStop = null;
  location.reload();
}

/** Arranca la bandeja de retos NIP-17 (una vez, solo con login Nostr). */
function startInbox(): void {
  if (inboxStop || login?.kind !== "nostr") return;
  const pubkey = state.identity?.pubkey;
  if (!pubkey) return;
  inboxStop = startChallengeInbox(login.signer, pubkey, showIncomingChallenge);
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
    .then(() => toast("Reto enviado ♟"))
    .catch(() => toast("No se pudo enviar el reto"));
}

/** Banner de reto entrante con acción de aceptar. */
function showIncomingChallenge(c: ParsedChallenge): void {
  document.getElementById("challenge-banner")?.remove();
  const el = document.createElement("div");
  el.id = "challenge-banner";
  el.className = "challenge-banner";
  const who = `${c.fromNpub.slice(0, 12)}…`;
  el.innerHTML = `
    <span class="challenge-text">♞ <b>${who}</b> te retó a una partida</span>
    <span class="challenge-actions">
      <button class="btn-gold" id="challenge-accept">Aceptar</button>
      <button id="challenge-dismiss">Ignorar</button>
    </span>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector("#challenge-dismiss")!.addEventListener("click", close);
  el.querySelector("#challenge-accept")!.addEventListener("click", () => {
    close();
    if (c.roomId) net.joinRoom({ roomId: c.roomId });
    else toast("El reto no trae sala");
  });
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
    const wasInRoom = state.room !== null;
    state.room = m.room;
    writeSavedRoom(m.room.id);
    if (m.room.phase === "lobby") state.ready = false;
    // Revancha concedida: la sala vuelve a "playing" con el resultado viejo en
    // pantalla — limpiar el estado de la partida anterior.
    if (m.room.phase === "playing" && state.ended) {
      state.ended = null;
      state.myRating = null;
      state.drawOfferBy = null;
      state.rematchRequested = false;
      state.rematchOffer = null;
      toast("¡Revancha! Colores invertidos");
    }
    maybeSendPendingChallenge(m.room);
    if (!wasInRoom) enterGame();
    else patchGame();
  });
  net.on("match", (m) => {
    const sound = soundForSnapshot(state.match, m.snapshot);
    if (sound) playSound(sound);
    state.match = m.snapshot;
    state.matchReceivedAt = Date.now();
    state.drawOfferBy = null;
    renderBoardFromMatch();
    patchGame();
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
    state.myRating = m.ratings?.find((r) => r.npub === state.identity?.npub) ?? null;
    state.rematchRequested = false;
    state.rematchOffer = null;
    if (board) board.setInteractive(false);
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
      clearSavedRoom();
      state.room = null;
      state.match = null;
      state.ended = null;
      toast("La sala ya no existe");
      renderHome();
      return;
    }
    toast(errorText(m.code));
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
  if (next.result.kind !== "ongoing")
    return prev && prev.matchId === next.matchId && prev.result.kind === "ongoing" ? "end" : null;
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
  return p?.displayName ?? npub.slice(0, 10);
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
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

function renderLogin(tab: LoginTab = defaultLoginTab()): void {
  clearConnectWatchdog();
  qrAbort?.abort();
  qrAbort = null;
  const bar = LOGIN_TABS.map(
    (t) => `<button class="login-tab${t.id === tab ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`,
  ).join("");
  app.innerHTML = shell(`
    <p class="muted">Partidas 1v1 en tiempo real.</p>
    <div class="login-tabs">${bar}</div>
    <div class="login-panel" id="login-panel"></div>`);
  document.querySelectorAll<HTMLButtonElement>(".login-tab").forEach((b) =>
    b.addEventListener("click", () => renderLogin(b.dataset.tab as LoginTab)),
  );
  renderLoginTab(tab);
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
  const soundBtn = `<button class="logout" data-action="sound" title="Sonido">${soundEnabled() ? "🔊" : "🔇"}</button>`;
  return `
    <header class="topbar">
      <span class="brand"><span class="mark">♞</span>Ajedrez</span>
      <span class="spacer"></span>
      ${soundBtn}
      ${id ? `<span class="me"><span class="avatar">${initials(id.displayName)}</span>${id.displayName}</span><button class="logout" data-action="logout" title="Cerrar sesión">Salir</button>` : ""}
    </header>`;
}

// --------------------------------------------------------------- render: home

function renderHome(): void {
  clearConnectWatchdog();
  void presence?.stop();
  app.innerHTML =
    topbar() +
    `<main class="home">
      <h1 class="display home-title">Jugá al ajedrez</h1>
      <p class="muted home-sub">Creá una sala e invitá a tu rival, o entrá con un código.</p>
      <div class="home-cards">
        <section class="card action-card">
          <span class="glyph">♜</span>
          <h2 class="card-title">Crear sala</h2>
          <p class="muted">Recibís un link y un código para compartir con tu rival.</p>
          <button class="btn-gold" id="create">Crear sala</button>
        </section>
        <section class="card action-card">
          <span class="glyph">♟</span>
          <h2 class="card-title">Unirse por código</h2>
          <p class="muted">¿Te pasaron un código? Entrá directo a la sala.</p>
          <div class="row">
            <input id="code" class="code-field" placeholder="ABC123" maxlength="8" />
            <button id="join">Entrar</button>
          </div>
        </section>
        ${challengeCard()}
      </div>
    </main>`;

  document.getElementById("create")!.addEventListener("click", () => net.createRoom());
  document.getElementById("join")!.addEventListener("click", () => {
    const code = (document.getElementById("code") as HTMLInputElement).value.trim().toUpperCase();
    if (code) net.joinRoom({ code });
  });
  document.getElementById("challenge-send")?.addEventListener("click", sendChallengeFromHome);
}

/** Tarjeta de reto por npub — solo para login Nostr (los invitados no tienen clave). */
function challengeCard(): string {
  if (state.identity?.guest !== false) return "";
  return `
    <section class="card action-card">
      <span class="glyph">♞</span>
      <h2 class="card-title">Retar a un amigo</h2>
      <p class="muted">Pegá el npub de tu rival: le llega un reto cifrado por Nostr.</p>
      <div class="row">
        <input id="challenge-npub" placeholder="npub1…" />
        <button id="challenge-send">Retar</button>
      </div>
    </section>`;
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
  net.createRoom();
}

// --------------------------------------------------------------- render: partida

function enterGame(): void {
  state.ended = null;
  state.myRating = null;
  state.rematchRequested = false;
  state.rematchOffer = null;
  state.bet = null;
  state.myBetInvoice = null;
  ensurePresence()?.start();
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
  const onMove: MoveFn = (from, to, promo) =>
    net.move(from, to, promo === "" ? undefined : (promo as "q" | "r" | "b" | "n"));
  board = createBoard(document.getElementById("board-wrap")!, onMove, boardKind());
  renderBoardFromMatch();
  patchGame();
}

function renderBoardFromMatch(): void {
  if (!board) return;
  const color = myColor() ?? "w";
  board.setOrientation(color);
  if (state.match) {
    board.applyFen(state.match.fen);
    const last = state.match.lastMove;
    board.highlight(last ? [last.from, last.to] : []);
    const myTurn = state.match.turn === color && state.match.result.kind === "ongoing";
    board.setInteractive(myTurn);
  } else {
    board.applyFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1");
    board.setInteractive(false);
  }
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

function playerBarInner(p: { npub: string; displayName: string; color: Color | null } | undefined, isMe: boolean): string {
  if (!p) return `<span class="muted">Esperando rival…</span>`;
  const m = state.match;
  const ms = p.color === "w" ? m?.whiteClockMs : m?.blackClockMs;
  const isTurn = m?.turn === p.color && m?.result.kind === "ongoing";
  const tag = isMe && isTurn ? `<span class="turn-tag">TU TURNO</span>` : "";
  const captured = p.color ? capturedHtml(p.color) : "";
  return `
    <span class="avatar${isMe ? " me-avatar" : ""}">${initials(p.displayName)}</span>
    <div class="player-meta">
      <span class="player-name">${p.displayName}${tag}</span>
      <span class="captured">${captured}</span>
    </div>
    <span class="clock${isTurn ? " is-active" : ""}">${ms === undefined || !p.color ? "--:--" : fmtClock(ms, p.color)}</span>`;
}

// -- panel lateral por fase --

function patchSidePanels(): void {
  const side = document.getElementById("side");
  if (!side || !state.room) return;
  side.innerHTML = phasePanelHtml();
  wireSidePanels();
  // Historial: mantener la última jugada a la vista.
  const grid = document.getElementById("history-grid");
  if (grid) grid.scrollTop = grid.scrollHeight;
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
  for (let i = 0; i < sans.length; i += 2) {
    const w = sans[i];
    const b = sans[i + 1];
    if (!w) continue;
    const wLast = i === last ? " last" : "";
    const bLast = i + 1 === last ? " last" : "";
    rows.push(
      `<span class="num">${i / 2 + 1}.</span>` +
        `<span class="ply${wLast}">${w}</span>` +
        `<span class="ply${bLast}">${b ?? ""}</span>`,
    );
  }
  const body = rows.length
    ? `<div class="history-grid" id="history-grid">${rows.join("")}</div>`
    : `<p class="history-empty">Sin jugadas todavía.</p>`;
  return `<div class="card history">
    <p class="section-label">Jugadas</p>
    ${body}
  </div>`;
}

function lobbyPanel(): string {
  const room = state.room!;
  const full = room.players.length >= 2;
  const inviteUrl = `${location.origin}/?join=${encodeURIComponent(room.id)}`;
  const seats = room.players
    .map((p) => {
      const role = p.npub === room.hostNpub ? "anfitrión" : "invitado";
      const colorName = p.color === "w" ? "Blancas" : p.color === "b" ? "Negras" : "—";
      return `<div class="seat">
        <span class="avatar">${initials(p.displayName)}</span>
        <div class="seat-meta">
          <span class="player-name">${p.displayName}</span>
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
    <div class="card">${seats}${emptySeat}</div>
    ${betPanel()}
    <button class="btn-gold" id="ready" ${!full || state.ready ? "disabled" : ""}>
      ${state.ready ? "Esperando al rival…" : full ? "Listo" : "Falta el rival"}
    </button>`;
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
    m?.inCheck && m.result.kind === "ongoing"
      ? `<p class="status check">¡Jaque!</p>`
      : `<p class="status muted">${m?.turn === myColor() ? "Tu turno" : "Turno del rival"}</p>`;
  const drawBtn =
    offer && offer !== me
      ? `<button id="accept-draw" class="btn-gold">Aceptar tablas</button>
         <button id="decline-draw">Rechazar</button>`
      : offer && offer === me
        ? `<button disabled>Tablas ofrecidas — esperando respuesta…</button>`
        : `<button id="offer-draw">½ Ofrecer tablas</button>`;
  return `<div class="card">
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
  return `<div class="card result-card ${cls}" style="position:static;padding:28px">
    <div class="crown">${crown}</div>
    <p class="result-title">${e.text}</p>
    <p class="result-sub">${e.sub}</p>
    ${ratingLine}
    <div class="actions" style="margin-top:22px">
      ${rematchButton()}
      <button id="home">Volver al inicio</button>
      ${login?.kind === "nostr" ? `<button id="share-achievement">Compartir logro ♟</button>` : ""}
      ${zapRivalButton()}
    </div>
  </div>`;
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
  return `<button id="zap-rival">⚡ Propina a ${rival.displayName}</button>`;
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
  on("copy", () => {
    const el = document.getElementById("invite-url") as HTMLInputElement | null;
    if (el) navigator.clipboard.writeText(el.value).then(() => toast("Link copiado"));
  });
  on("ready", () => { state.ready = true; net.ready(); patchSidePanels(); });
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
  on("home", () => { clearSavedRoom(); location.reload(); });
  on("rematch", () => {
    state.rematchRequested = true;
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
    if (rival?.pubkey) openZapDialog(rival.pubkey, rival.displayName);
  });
}

// --------------------------------------------------------------- zaps (propinas)

/** Modal de propina: elegís monto y se genera un invoice para pagar con billetera. */
function openZapDialog(pubkey: string, name: string): void {
  if (login?.kind !== "nostr") return;
  const signer = login.signer;
  document.getElementById("zap-modal")?.remove();
  const el = document.createElement("div");
  el.id = "zap-modal";
  el.className = "modal-overlay";
  el.innerHTML = `
    <div class="modal">
      <button class="modal-close" id="zap-close">✕</button>
      <h3>⚡ Propina a ${name}</h3>
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
function fmtClock(baseMs: number, color: Color): string {
  const m = state.match;
  let live = baseMs;
  if (m && m.result.kind === "ongoing" && m.turn === color) {
    live = baseMs - (Date.now() - state.matchReceivedAt);
  }
  const s = Math.max(0, Math.ceil(live / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

setInterval(() => {
  if (state.room?.phase === "playing" && state.match?.result.kind === "ongoing") {
    renderPlayers();
  }
}, 1000);

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
};

function errorText(code: string): string {
  return ERROR_TEXT[code] ?? `Algo salió mal (${code})`;
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

function toast(text: string): void {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
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
