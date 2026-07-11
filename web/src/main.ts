import "./styles.css";
import { WS_URL } from "./config.js";
import { Net } from "./net.js";
import { createBoard, type BoardController, type BoardKind, type MoveFn } from "./board.js";
import type {
  Color,
  MatchSnapshot,
  RoomView,
  SessionIdentity,
} from "./protocol.js";

const NAME_KEY = "ajedrez.name.v1";

const app = document.getElementById("app")!;
const net = new Net(WS_URL);

interface State {
  identity: SessionIdentity | null;
  room: RoomView | null;
  match: MatchSnapshot | null;
  matchReceivedAt: number;
  ready: boolean;
  drawOfferBy: string | null;
  ended: { winnerNpubs: string[]; text: string } | null;
}

const state: State = {
  identity: null,
  room: null,
  match: null,
  matchReceivedAt: 0,
  ready: false,
  drawOfferBy: null,
  ended: null,
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
  wireNet();
  const name = storedName();
  if (!name) return renderLogin();
  renderConnecting();
  net.connect();
  net.auth(name);
}

function loginWith(name: string): void {
  sessionStorage.setItem(NAME_KEY, name.trim());
  net.connect();
  net.auth(name.trim());
}

// --------------------------------------------------------------- net

function wireNet(): void {
  net.on("open", () => {
    reconnectDelay = 1000;
  });
  net.on("authed", (m) => {
    state.identity = m.identity;
    const join = pendingJoin();
    cleanUrl();
    if (state.room) net.joinRoom({ roomId: state.room.id }); // reconexión: volver a la sala
    else if (join) net.joinRoom({ roomId: join });
    else renderHome();
  });
  net.on("room", (m) => {
    const wasInRoom = state.room !== null;
    state.room = m.room;
    if (m.room.phase === "lobby") state.ready = false;
    if (!wasInRoom) enterGame();
    else patchGame();
  });
  net.on("match", (m) => {
    state.match = m.snapshot;
    state.matchReceivedAt = Date.now();
    state.drawOfferBy = null;
    renderBoardFromMatch();
    patchGame();
  });
  net.on("draw_offer", (m) => {
    state.drawOfferBy = m.byNpub;
    patchSidePanels();
  });
  net.on("ended", (m) => {
    state.ended = { winnerNpubs: m.winnerNpubs, text: endedText(m.winnerNpubs) };
    if (board) board.setInteractive(false);
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
    // La sala ya no existe (p. ej. el server se reinició): volver al inicio.
    if (m.code === "NO_ROOM" && state.room) {
      state.room = null;
      state.match = null;
      state.ended = null;
      toast("La sala ya no existe");
      renderHome();
      return;
    }
    toast(`${m.code}: ${m.message}`);
  });
  // Si el socket se cae ANTES de autenticar (server caído, wss mal apuntado),
  // mostramos un estado claro. Con sesión activa, reintentamos con backoff:
  // al reconectar, `authed` nos devuelve a la sala y el server nos re-sincroniza.
  net.on("close", () => {
    const name = storedName();
    if (!state.identity || !name) return renderConnError();
    toast("Conexión perdida, reconectando…");
    setTimeout(() => {
      net.connect();
      net.auth(name);
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

function endedText(winners: string[]): string {
  if (winners.length === 0) return "Tablas";
  const me = state.identity?.npub;
  if (me && winners.includes(me)) return "¡Ganaste!";
  return `Ganó ${nameOf(winners[0]!)}`;
}

// --------------------------------------------------------------- render: conexión

function renderConnecting(): void {
  app.innerHTML = `
    <div class="center-screen"><div class="login">
      <h1>♞ <span class="accent">Ajedrez</span></h1>
      <p class="muted">Conectando con el servidor…</p>
    </div></div>`;
}

function renderConnError(): void {
  app.innerHTML = `
    <div class="center-screen"><div class="login">
      <h1>♞ <span class="accent">Ajedrez</span></h1>
      <p class="muted">No se pudo conectar con el servidor de la partida.</p>
      <div class="row" style="margin-top:18px">
        <button class="primary" id="retry">Reintentar</button>
      </div>
    </div></div>`;
  document.getElementById("retry")!.addEventListener("click", () => location.reload());
}

// --------------------------------------------------------------- render: login

function renderLogin(): void {
  app.innerHTML = `
    <div class="center-screen"><div class="login">
      <h1>♞ <span class="accent">Ajedrez</span></h1>
      <p class="muted">Entrá con un nombre y jugá una partida 1v1.</p>
      <div class="row" style="margin-top:18px">
        <input id="name" placeholder="Tu nombre" />
        <button class="primary" id="go">Entrar</button>
      </div>
    </div></div>`;
  const input = document.getElementById("name") as HTMLInputElement;
  const go = () => input.value.trim() && loginWith(input.value);
  document.getElementById("go")!.addEventListener("click", go);
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  input.focus();
}

// --------------------------------------------------------------- render: topbar

function topbar(): string {
  const id = state.identity;
  const initials = (id?.displayName ?? "?").slice(0, 2).toUpperCase();
  return `
    <div class="topbar">
      <span class="brand">♞ <span class="accent">Ajedrez</span></span>
      <span class="spacer"></span>
      ${id ? `<span class="me"><span class="avatar">${initials}</span>${id.displayName}</span>` : ""}
    </div>`;
}

// --------------------------------------------------------------- render: home

function renderHome(): void {
  app.innerHTML =
    topbar() +
    `<div class="layout">
      <div class="card">
        <h2>Jugar</h2>
        <div class="row">
          <button class="primary" id="create">Crear sala</button>
        </div>
        <h2 style="margin-top:24px">Unirse por código</h2>
        <div class="row">
          <input id="code" placeholder="Ej: ABC123" maxlength="8" style="text-transform:uppercase" />
          <button id="join">Entrar</button>
        </div>
      </div>
    </div>`;

  document.getElementById("create")!.addEventListener("click", () => net.createRoom());
  document.getElementById("join")!.addEventListener("click", () => {
    const code = (document.getElementById("code") as HTMLInputElement).value.trim().toUpperCase();
    if (code) net.joinRoom({ code });
  });
}

// --------------------------------------------------------------- render: partida

function enterGame(): void {
  state.ended = null;
  app.innerHTML =
    topbar() +
    `<div class="game">
      <div class="board-wrap" id="board-wrap"></div>
      <div id="side"></div>
    </div>`;
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
  patchSidePanels();
}

function patchSidePanels(): void {
  const side = document.getElementById("side");
  if (!side || !state.room) return;
  side.innerHTML = playersHtml() + phasePanelHtml();
  wireSidePanels();
}

function playersHtml(): string {
  const room = state.room!;
  const top = room.players.find((p) => p.color !== myColor()) ?? room.players[1];
  const bottom = room.players.find((p) => p.color === myColor()) ?? room.players[0];
  return `<div class="card" style="margin-bottom:16px">${playerRow(top)}${playerRow(bottom)}</div>`;
}

function playerRow(p?: { npub: string; displayName: string; color: Color | null }): string {
  if (!p) return `<div class="player muted">Esperando rival…</div>`;
  const m = state.match;
  const ms = p.color === "w" ? m?.whiteClockMs : m?.blackClockMs;
  const isTurn = m?.turn === p.color && m?.result.kind === "ongoing";
  return `<div class="player ${isTurn ? "turn" : ""}">
    <span class="avatar">${p.displayName.slice(0, 2).toUpperCase()}</span>
    <span>${p.displayName}</span>
    <span class="clock">${ms === undefined || !p.color ? "--:--" : fmtClock(ms, p.color)}</span>
  </div>`;
}

function phasePanelHtml(): string {
  const room = state.room!;
  if (state.ended) return endedPanel();
  if (room.phase === "playing") return playingPanel();
  return lobbyPanel();
}

function lobbyPanel(): string {
  const room = state.room!;
  const full = room.players.length >= 2;
  const inviteUrl = `${location.origin}/?join=${encodeURIComponent(room.id)}`;
  return `<div class="card">
    <h2>Sala ${room.code}</h2>
    <p class="muted">Compartí el link o el código para que entre tu rival (tiene que usar OTRO nombre).</p>
    <div class="row"><input id="invite-url" readonly value="${inviteUrl}" /><button id="copy">Copiar</button></div>
    <div class="row" style="margin-top:14px">
      <button class="primary" id="ready" ${!full || state.ready ? "disabled" : ""}>
        ${state.ready ? "Esperando al rival…" : full ? "Listo" : "Falta el rival"}
      </button>
    </div>
  </div>`;
}

function playingPanel(): string {
  const drawIncoming = state.drawOfferBy && state.drawOfferBy !== state.identity?.npub;
  const m = state.match;
  const status = m?.inCheck && m.result.kind === "ongoing"
    ? `<p class="status check">¡Jaque!</p>`
    : `<p class="status">${m?.turn === myColor() ? "Tu turno" : "Turno del rival"}</p>`;
  return `<div class="card">
    ${status}
    <div class="row">
      <button class="danger" id="resign">Abandonar</button>
      ${drawIncoming ? `<button id="accept-draw" class="primary">Aceptar tablas</button>` : `<button id="offer-draw">Ofrecer tablas</button>`}
    </div>
  </div>`;
}

function endedPanel(): string {
  const me = state.identity?.npub;
  const e = state.ended!;
  const cls = e.winnerNpubs.length === 0 ? "draw" : me && e.winnerNpubs.includes(me) ? "win" : "lose";
  return `<div class="card">
    <div class="banner ${cls}">${e.text}</div>
    <div class="row"><button class="primary" id="home">Volver al inicio</button></div>
  </div>`;
}

function wireSidePanels(): void {
  const on = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener("click", fn);
  on("copy", () => {
    const el = document.getElementById("invite-url") as HTMLInputElement | null;
    if (el) navigator.clipboard.writeText(el.value).then(() => toast("Link copiado"));
  });
  on("ready", () => { state.ready = true; net.ready(); patchSidePanels(); });
  on("resign", () => net.resign());
  on("offer-draw", () => { net.offerDraw(); toast("Tablas ofrecidas"); });
  on("accept-draw", () => net.acceptDraw());
  on("home", () => location.reload());
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
    const side = document.getElementById("side");
    if (side) {
      const cards = side.querySelector(".card");
      if (cards) cards.outerHTML = playersHtml();
    }
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
