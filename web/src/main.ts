import "./styles.css";
import { WS_URL } from "./config.js";
import { Net } from "./net.js";
import { createBoard, type BoardController, type BoardKind, type MoveFn } from "./board.js";
import type {
  Color,
  MatchSnapshot,
  MovePayload,
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
  ended: { winnerNpubs: string[]; text: string; sub: string } | null;
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
    if (m.room.phase === "lobby") { state.ready = false; state.history = []; }
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
  net.on("draw_offer", (m) => {
    state.drawOfferBy = m.byNpub;
    patchSidePanels();
  });
  net.on("ended", (m) => {
    state.ended = { winnerNpubs: m.winnerNpubs, ...endedText(m.winnerNpubs, m.result) };
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
  });
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

function renderLogin(): void {
  app.innerHTML = shell(`
    <p class="muted">Partidas 1v1 en tiempo real. Entrá con un nombre.</p>
    <div class="stack">
      <input id="name" placeholder="Tu nombre" />
      <button class="btn-gold" id="go">Entrar a jugar</button>
    </div>
    <p class="fine">Sin cuenta ni registro — solo tu nombre y un rival.</p>`);
  const input = document.getElementById("name") as HTMLInputElement;
  const go = () => input.value.trim() && loginWith(input.value);
  document.getElementById("go")!.addEventListener("click", go);
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  input.focus();
}

// --------------------------------------------------------------- render: topbar

function topbar(): string {
  const id = state.identity;
  return `
    <header class="topbar">
      <span class="brand"><span class="mark">♞</span>Ajedrez</span>
      <span class="spacer"></span>
      ${id ? `<span class="me"><span class="avatar">${initials(id.displayName)}</span>${id.displayName}</span>` : ""}
    </header>`;
}

// --------------------------------------------------------------- render: home

function renderHome(): void {
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
      </div>
    </main>`;

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
    <button class="btn-gold" id="ready" ${!full || state.ready ? "disabled" : ""}>
      ${state.ready ? "Esperando al rival…" : full ? "Listo" : "Falta el rival"}
    </button>`;
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
  return `<div class="card result-card ${cls}" style="position:static;padding:28px">
    <div class="crown">${crown}</div>
    <p class="result-title">${e.text}</p>
    <p class="result-sub">${e.sub}</p>
    <div class="actions" style="margin-top:22px">
      <button class="btn-gold" id="home">Volver al inicio</button>
    </div>
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
