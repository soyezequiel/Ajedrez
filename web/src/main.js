import "./styles.css";
import { WS_URL } from "./config.js";
import { Net } from "./net.js";
import { CanvasBoard } from "./board.js";
const TOKEN_KEY = "ajedrez.token.v1";
const ID_KEY = "ajedrez.identity.v1";
const app = document.getElementById("app");
const net = new Net(WS_URL);
const state = {
    identity: null,
    friends: [],
    room: null,
    match: null,
    matchReceivedAt: 0,
    bet: null,
    ready: false,
    drawOfferBy: null,
    ended: null,
};
let board = null;
// --------------------------------------------------------------- arranque
function resolveToken() {
    const params = new URLSearchParams(location.search);
    const lnToken = params.get("lnToken");
    if (lnToken)
        return lnToken;
    const demo = params.get("lnDemo");
    if (demo)
        return "lndemo:" + demo;
    return sessionStorage.getItem(TOKEN_KEY);
}
function pendingJoin() {
    return new URLSearchParams(location.search).get("join");
}
function start() {
    wireNet();
    const token = resolveToken();
    if (!token)
        return renderLogin();
    net.connect();
    net.auth(token);
}
function loginWith(name) {
    const token = "lndemo:" + name.trim();
    sessionStorage.setItem(TOKEN_KEY, token);
    net.connect();
    net.auth(token);
}
// --------------------------------------------------------------- net
function wireNet() {
    net.on("authed", (m) => {
        state.identity = m.identity;
        sessionStorage.setItem(TOKEN_KEY, resolveToken() ?? "");
        localStorage.setItem(ID_KEY, JSON.stringify(m.identity));
        cleanUrl();
        const join = pendingJoin();
        if (join)
            net.joinRoom({ roomId: join });
        else
            renderHome();
    });
    net.on("friends", (m) => {
        state.friends = m.friends;
        if (!state.room)
            renderHome();
        else
            patchSidePanels();
    });
    net.on("room", (m) => {
        const wasInRoom = state.room !== null;
        state.room = m.room;
        if (m.room.phase === "lobby")
            state.ready = false;
        if (!wasInRoom)
            enterGame();
        else
            patchGame();
    });
    net.on("match", (m) => {
        state.match = m.snapshot;
        state.matchReceivedAt = Date.now();
        state.drawOfferBy = null;
        renderBoardFromMatch();
        patchGame();
    });
    net.on("bet", (m) => {
        state.bet = m.bet;
        patchSidePanels();
    });
    net.on("draw_offer", (m) => {
        state.drawOfferBy = m.byNpub;
        patchSidePanels();
    });
    net.on("ended", (m) => {
        state.ended = { winnerNpubs: m.winnerNpubs, betId: m.betId, text: endedText(m.winnerNpubs) };
        if (board)
            board.setInteractive(false);
        patchGame();
    });
    net.on("error", (m) => toast(`${m.code}: ${m.message}`));
}
function cleanUrl() {
    const url = new URL(location.href);
    url.searchParams.delete("lnToken");
    url.searchParams.delete("lnDemo");
    url.searchParams.delete("join");
    history.replaceState(null, "", url.toString());
}
// --------------------------------------------------------------- helpers de identidad
function myColor() {
    const me = state.identity?.npub;
    if (!me || !state.room)
        return null;
    const seat = state.room.players.find((p) => p.npub === me);
    return seat?.color ?? null;
}
function isHost() {
    return state.identity?.npub === state.room?.hostNpub;
}
function nameOf(npub) {
    const p = state.room?.players.find((x) => x.npub === npub);
    return p?.displayName ?? state.friends.find((f) => f.npub === npub)?.displayName ?? npub.slice(0, 10);
}
function endedText(winners) {
    if (winners.length === 0)
        return "Tablas — depósitos reembolsados";
    const me = state.identity?.npub;
    if (me && winners.includes(me))
        return "¡Ganaste!";
    return `Ganó ${nameOf(winners[0])}`;
}
// --------------------------------------------------------------- render: login
function renderLogin() {
    app.innerHTML = `
    <div class="center-screen"><div class="login">
      <h1>♞ <span class="accent">Ajedrez</span></h1>
      <p class="muted">Apostá sats y jugá. Entrá con un nombre (modo dev).</p>
      <div class="row" style="margin-top:18px">
        <input id="name" placeholder="Tu nombre" />
        <button class="primary" id="go">Entrar</button>
      </div>
      <p class="muted" style="margin-top:14px;font-size:12px">
        En producción Luna Negra abre el juego con tu identidad (?lnToken=).
      </p>
    </div></div>`;
    const input = document.getElementById("name");
    const go = () => input.value.trim() && loginWith(input.value);
    document.getElementById("go").addEventListener("click", go);
    input.addEventListener("keydown", (e) => e.key === "Enter" && go());
    input.focus();
}
// --------------------------------------------------------------- render: topbar
function topbar() {
    const id = state.identity;
    const initials = (id?.displayName ?? "?").slice(0, 2).toUpperCase();
    return `
    <div class="topbar">
      <span class="brand">♞ <span class="accent">Ajedrez</span></span>
      <span class="spacer"></span>
      ${id ? `<span class="me"><span class="avatar">${initials}</span>${id.displayName}
        ${id.source === "mock" ? '<span class="pill">dev</span>' : ""}</span>` : ""}
    </div>`;
}
// --------------------------------------------------------------- render: home
function renderHome() {
    app.innerHTML =
        topbar() +
            `<div class="layout">
      <div class="card">
        <h2>Jugar</h2>
        <div class="row">
          <input id="stake" type="number" min="0" step="1" value="0" />
          <span class="muted">sats de apuesta</span>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="primary" id="create">Crear sala</button>
        </div>
        <h2 style="margin-top:24px">Unirse por código</h2>
        <div class="row">
          <input id="code" placeholder="Ej: ABC123" maxlength="8" style="text-transform:uppercase" />
          <button id="join">Entrar</button>
        </div>
      </div>
      <div class="card" id="friends">${friendsHtml()}</div>
    </div>`;
    document.getElementById("create").addEventListener("click", () => {
        const stake = Number(document.getElementById("stake").value) || 0;
        net.createRoom(stake);
    });
    document.getElementById("join").addEventListener("click", () => {
        const code = document.getElementById("code").value.trim().toUpperCase();
        if (code)
            net.joinRoom({ code });
    });
}
function friendsHtml() {
    const order = { "in-game": 0, online: 1, offline: 2 };
    const sorted = [...state.friends].sort((a, b) => order[a.presence] - order[b.presence]);
    const rows = sorted
        .map((f) => `<div class="friend">
        <span class="dot ${f.presence}"></span>
        <span>${f.displayName}</span>
        <span class="spacer"></span>
        ${state.room && f.presence !== "offline" ? `<button data-invite="${f.npub}">Invitar</button>` : ""}
      </div>`)
        .join("");
    return `<h2>Amigos de Luna Negra</h2>${rows || '<p class="muted">Sin amigos conectados.</p>'}`;
}
// --------------------------------------------------------------- render: partida
function enterGame() {
    state.ended = null;
    app.innerHTML =
        topbar() +
            `<div class="game">
      <div class="board-wrap"><canvas id="board"></canvas></div>
      <div id="side"></div>
    </div>`;
    board = new CanvasBoard(document.getElementById("board"));
    window.__chess = {
        onMove: (from, to, promo) => net.move(from, to, promo === "" ? undefined : promo),
    };
    renderBoardFromMatch();
    patchGame();
}
function renderBoardFromMatch() {
    if (!board)
        return;
    const color = myColor() ?? "w";
    board.setOrientation(color);
    if (state.match) {
        board.applyFen(state.match.fen);
        const last = state.match.lastMove;
        board.highlight(last ? [last.from, last.to] : []);
        const myTurn = state.match.turn === color && state.match.result.kind === "ongoing";
        board.setInteractive(myTurn);
    }
    else {
        board.applyFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1");
        board.setInteractive(false);
    }
}
function patchGame() {
    renderBoardFromMatch();
    patchSidePanels();
}
function patchSidePanels() {
    const side = document.getElementById("side");
    if (!side || !state.room)
        return;
    side.innerHTML = playersHtml() + phasePanelHtml();
    wireSidePanels();
}
function playersHtml() {
    const room = state.room;
    const top = room.players.find((p) => p.color !== myColor()) ?? room.players[1];
    const bottom = room.players.find((p) => p.color === myColor()) ?? room.players[0];
    return `<div class="card" style="margin-bottom:16px">${playerRow(top)}${playerRow(bottom)}</div>`;
}
function playerRow(p) {
    if (!p)
        return `<div class="player muted">Esperando rival…</div>`;
    const m = state.match;
    const ms = p.color === "w" ? m?.whiteClockMs : m?.blackClockMs;
    const isTurn = m?.turn === p.color && m?.result.kind === "ongoing";
    return `<div class="player ${isTurn ? "turn" : ""}">
    <span class="avatar">${p.displayName.slice(0, 2).toUpperCase()}</span>
    <span>${p.displayName}</span>
    <span class="clock">${ms === undefined || !p.color ? "--:--" : fmtClock(ms, p.color)}</span>
  </div>`;
}
function phasePanelHtml() {
    const room = state.room;
    if (state.ended)
        return endedPanel();
    if (room.phase === "playing")
        return playingPanel();
    if (room.phase === "awaiting_deposit")
        return betPanel();
    return lobbyPanel();
}
function lobbyPanel() {
    const room = state.room;
    const full = room.players.length >= 2;
    const stakeRow = isHost()
        ? `<div class="row" style="margin-top:10px">
         <input id="stake2" type="number" min="0" value="${room.stakeSats}" />
         <button id="setstake">Apuesta</button>
       </div>`
        : `<p class="muted">Apuesta: ${room.stakeSats} sats</p>`;
    return `<div class="card">
    <h2>Sala ${room.code}</h2>
    <p class="muted">Compartí el link o el código para que entre tu rival.</p>
    <div class="row"><input id="invite-url" readonly value="${room.inviteUrl}" /><button id="copy">Copiar</button></div>
    ${stakeRow}
    <div class="row" style="margin-top:14px">
      <button class="primary" id="ready" ${!full || state.ready ? "disabled" : ""}>
        ${state.ready ? "Esperando al rival…" : full ? "Listo" : "Falta el rival"}
      </button>
    </div>
  </div>`;
}
function betPanel() {
    const bet = state.bet;
    if (!bet)
        return `<div class="card"><p class="muted">Preparando la apuesta…</p></div>`;
    const me = state.identity?.npub;
    const mine = bet.participants.find((p) => p.npub === me);
    const handles = mine && mine.depositStatus === "pending"
        ? `<p class="muted" style="margin-top:10px">Depositá ${state.room.stakeSats} sats:</p>
         ${mine.payUrl ? `<a href="${mine.payUrl}" target="_blank"><button class="primary">Pagar con wallet</button></a>` : ""}
         ${mine.bolt11 ? `<p class="deposit">${mine.bolt11}</p>` : ""}
         ${mine.lnurl ? `<p class="deposit">${mine.lnurl}</p>` : ""}`
        : `<p class="muted" style="margin-top:10px">Tu depósito está confirmado ✓</p>`;
    const rows = bet.participants
        .map((p) => `<div class="row"><span>${nameOf(p.npub)}</span><span class="spacer"></span>
      <span class="pill">${p.depositStatus === "paid" ? "pagó ✓" : "pendiente…"}</span></div>`)
        .join("");
    return `<div class="card"><div class="bet">
    <div class="pot">${bet.potTargetSats} sats</div>
    <p class="muted">Pozo · fee ${bet.feeSats} · gana ${bet.netPayoutSats}</p>
    ${rows}${handles}
  </div></div>`;
}
function playingPanel() {
    const drawIncoming = state.drawOfferBy && state.drawOfferBy !== state.identity?.npub;
    const m = state.match;
    const status = m?.inCheck && m.result.kind === "ongoing"
        ? `<p class="status check">¡Jaque!</p>`
        : `<p class="status">${m?.turn === myColor() ? "Tu turno" : "Turno del rival"}</p>`;
    return `<div class="card">
    ${state.bet ? `<div class="bet" style="margin-bottom:14px"><div class="pot">${state.bet.potTargetSats} sats</div><p class="muted">en juego</p></div>` : ""}
    ${status}
    <div class="row">
      <button class="danger" id="resign">Abandonar</button>
      ${drawIncoming ? `<button id="accept-draw" class="primary">Aceptar tablas</button>` : `<button id="offer-draw">Ofrecer tablas</button>`}
    </div>
  </div>`;
}
function endedPanel() {
    const me = state.identity?.npub;
    const e = state.ended;
    const cls = e.winnerNpubs.length === 0 ? "draw" : me && e.winnerNpubs.includes(me) ? "win" : "lose";
    return `<div class="card">
    <div class="banner ${cls}">${e.text}</div>
    <div class="row"><button class="primary" id="home">Volver al inicio</button></div>
  </div>`;
}
function wireSidePanels() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);
    document.querySelectorAll("[data-invite]").forEach((b) => b.addEventListener("click", () => net.inviteFriend(b.dataset.invite)));
    on("copy", () => {
        const el = document.getElementById("invite-url");
        if (el)
            navigator.clipboard.writeText(el.value).then(() => toast("Link copiado"));
    });
    on("setstake", () => {
        const v = Number(document.getElementById("stake2").value) || 0;
        net.setStake(v);
    });
    on("ready", () => { state.ready = true; net.ready(); patchSidePanels(); });
    on("resign", () => net.resign());
    on("offer-draw", () => { net.offerDraw(); toast("Tablas ofrecidas"); });
    on("accept-draw", () => net.acceptDraw());
    on("home", () => location.reload());
}
// --------------------------------------------------------------- reloj + toast
/** Formatea el reloj de un color, descontando localmente si es su turno. */
function fmtClock(baseMs, color) {
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
            if (cards)
                cards.outerHTML = playersHtml();
        }
    }
}, 1000);
function toast(text) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
}
start();
