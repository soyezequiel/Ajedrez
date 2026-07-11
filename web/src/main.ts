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
import { startVersionGuard } from "./version.js";
import type { NgpSigner, ParsedChallenge } from "nostr-game-protocol/ngp";
import type {
  BetView,
  Color,
  MatchSnapshot,
  MovePayload,
  RatingChange,
  RoomPlayer,
  RoomView,
  SessionIdentity,
} from "./protocol.js";

const NAME_KEY = "ajedrez.name.v1";

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
  /** ¿El server tiene el escrow de apuestas activo? */
  betsEnabled: boolean;
  /** Apuesta en curso de la sala, o null. */
  bet: BetView | null;
  /** Invoice de depósito propio (para pagar con billetera). */
  myBetInvoice: { bolt11: string | null; amountSats: number; stakeSats: number } | null;
  /** Historial de jugadas de ESTA sesión (coordenadas). El servidor solo manda
   *  `lastMove`, así que lo acumulamos localmente; se reinicia al entrar a una sala. */
  history: MovePayload[];
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
  betsEnabled: false,
  bet: null,
  myBetInvoice: null,
  history: [],
};

let board: BoardController | null = null;

function boardKind(): BoardKind {
  return new URLSearchParams(location.search).get("board") === "canvas" ? "canvas" : "vexel";
}

// --------------------------------------------------------------- arranque

function storedName(): string | null {
  return sessionStorage.getItem(NAME_KEY);
}

function pendingJoin(): string | null {
  return new URLSearchParams(location.search).get("join");
}

function start(): void {
  startVersionGuard(toast); // recarga sola si el server anuncia un build nuevo
  // "Salir" (delegado: la topbar se re-renderiza en cada pantalla).
  document.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest?.("[data-action=logout]")) logout();
  });
  wireNet();
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

/**
 * Autentica con un ChessSigner ya obtenido (cualquier método: nip07/nip46/local).
 * Toma el nombre del perfil best-effort y arranca el handshake de challenge.
 */
async function beginNostr(signer: ChessSigner): Promise<void> {
  renderConnecting();
  let displayName = "";
  try {
    const pubkey = await signer.getPublicKey();
    displayName = (await fetchProfile(pubkey)).name ?? "";
  } catch {
    clearActiveSigner();
    login = null;
    toast("No se pudo obtener tu clave Nostr.");
    return renderLogin();
  }
  login = { kind: "nostr", signer: toNgpSigner(signer), displayName };
  net.connect();
  net.authChallenge();
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
    state.identity = m.identity;
    startInbox();
    const join = pendingJoin();
    cleanUrl();
    if (state.room) net.joinRoom({ roomId: state.room.id }); // reconexión: volver a la sala
    else if (join) net.joinRoom({ roomId: join });
    else renderHome();
  });
  net.on("room", (m) => {
    const wasInRoom = state.room !== null;
    state.room = m.room;
    if (m.room.phase === "lobby") { state.ready = false; state.history = []; }
    maybeSendPendingChallenge(m.room);
    if (!wasInRoom) enterGame();
    else patchGame();
  });
  net.on("match", (m) => {
    recordMove(m.snapshot.lastMove);
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
    state.drawOfferBy = m.byNpub;
    patchSidePanels();
  });
  net.on("ended", (m) => {
    state.ended = { winnerNpubs: m.winnerNpubs, ...endedText(m.winnerNpubs, m.result) };
    state.myRating = m.ratings?.find((r) => r.npub === state.identity?.npub) ?? null;
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
    if (m.code === "NO_ROOM" && state.room) {
      state.room = null;
      state.match = null;
      state.ended = null;
      state.history = [];
      toast("La sala ya no existe");
      renderHome();
      return;
    }
    toast(`${m.code}: ${m.message}`);
    // Refrescar el lobby resetea botones que quedaron en estado "cargando"
    // (p. ej. "Creando…" si falló la propuesta de apuesta).
    if (state.room?.phase === "lobby") patchSidePanels();
  });
  net.on("close", () => {
    if (!state.identity || !login) return renderConnError();
    toast("Conexión perdida, reconectando…");
    const mode = login;
    setTimeout(() => {
      net.connect();
      // Invitado: re-auth por nombre (sin fricción). Nostr: re-firmar el reto.
      if (mode.kind === "guest") net.auth(mode.name);
      else net.authChallenge();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  });
}

/** Backoff de reconexión (se resetea cuando el socket vuelve a abrir). */
let reconnectDelay = 1000;

function cleanUrl(): void {
  const url = new URL(location.href);
  url.searchParams.delete("join");
  history.replaceState(null, "", url.toString());
}

/** Acumula el último movimiento si es nuevo respecto al anterior. */
function recordMove(last: MovePayload | null): void {
  if (!last) return;
  const prev = state.history[state.history.length - 1];
  if (prev && prev.from === last.from && prev.to === last.to) return;
  state.history.push(last);
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
  const jugadas = state.history.length ? ` · ${state.history.length} jugadas` : "";
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

function renderConnecting(): void {
  app.innerHTML = shell(`<p class="muted">Conectando con el servidor…</p>`);
}

function renderConnError(): void {
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
  return `
    <header class="topbar">
      <span class="brand"><span class="mark">♞</span>Ajedrez</span>
      <span class="spacer"></span>
      ${id ? `<span class="me"><span class="avatar">${initials(id.displayName)}</span>${id.displayName}</span><button class="logout" data-action="logout" title="Cerrar sesión">Salir</button>` : ""}
    </header>`;
}

// --------------------------------------------------------------- render: home

function renderHome(): void {
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
}

function phasePanelHtml(): string {
  const room = state.room!;
  if (state.ended) return endedPanel() + historyCard();
  if (room.phase === "playing") return historyCard() + playingPanel();
  return lobbyPanel();
}

function historyCard(): string {
  const rows: string[] = [];
  const last = state.history.length - 1;
  for (let i = 0; i < state.history.length; i += 2) {
    const w = state.history[i];
    const b = state.history[i + 1];
    if (!w) continue;
    const wLast = i === last ? " last" : "";
    const bLast = i + 1 === last ? " last" : "";
    rows.push(
      `<span class="num">${i / 2 + 1}.</span>` +
        `<span class="ply${wLast}">${w.from}${w.to}</span>` +
        `<span class="ply${bLast}">${b ? b.from + b.to : ""}</span>`,
    );
  }
  const body = rows.length
    ? `<div class="history-grid">${rows.join("")}</div>`
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
  const drawIncoming = state.drawOfferBy && state.drawOfferBy !== state.identity?.npub;
  const m = state.match;
  const status =
    m?.inCheck && m.result.kind === "ongoing"
      ? `<p class="status check">¡Jaque!</p>`
      : `<p class="status muted">${m?.turn === myColor() ? "Tu turno" : "Turno del rival"}</p>`;
  const drawBtn = drawIncoming
    ? `<button id="accept-draw" class="btn-gold">Aceptar tablas</button>`
    : `<button id="offer-draw">½ Ofrecer tablas</button>`;
  return `<div class="card">
    ${status}
    <div class="actions" style="margin-top:12px">
      ${drawBtn}
      <button class="danger" id="resign">Abandonar</button>
    </div>
  </div>`;
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
      <button class="btn-gold" id="home">Volver al inicio</button>
      ${login?.kind === "nostr" ? `<button id="share-achievement">Compartir logro ♟</button>` : ""}
      ${zapRivalButton()}
    </div>
  </div>`;
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
  const plies = state.history.length;
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
  on("resign", () => net.resign());
  on("offer-draw", () => { net.offerDraw(); toast("Tablas ofrecidas"); });
  on("accept-draw", () => net.acceptDraw());
  on("home", () => location.reload());
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

function toast(text: string): void {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

start();
