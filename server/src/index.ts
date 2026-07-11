import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { MatchError } from "./chessMatch.js";
import { Room, RoomError, RoomManager } from "./rooms.js";
import {
  AuthError,
  issueSessionToken,
  makeChallenge,
  verifyNostrAuth,
  verifySessionToken,
} from "./nostrAuth.js";
import { applyResult, type RatingChange } from "./ratings.js";
import { BetError, betsEnabled, cancelBet, createBet, settleBet, watchBet } from "./bets.js";
import type { NgeBet } from "nostr-game-protocol/nge";
import type { Event } from "nostr-tools/pure";
import type { BetView, ClientMessage, RoomView, ServerMessage, SessionIdentity } from "./protocol.js";
import type { Color, MovePayload, Npub } from "./types.js";

/** Apuesta activa por sala (el escrow NGE la custodia server-side). */
interface BetRecord {
  betId: string;
  stakeSats: number;
  /** true una vez que se fondeó y arrancó la partida (evita doble arranque). */
  started: boolean;
  /** Corta el watch del escrow. */
  stop?: () => void;
}
const betsByRoom = new Map<string, BetRecord>();

const rooms = new RoomManager();

interface ConnState {
  identity?: SessionIdentity;
  roomId?: string;
  /** Reto de login Nostr emitido a esta conexión, pendiente de firma. */
  challenge?: string;
}
const conns = new Map<WebSocket, ConnState>();
const roomSockets = new Map<string, Set<WebSocket>>();
/** Jugadores que confirmaron "listo" por sala. */
const readyByRoom = new Map<string, Set<Npub>>();
/** Timer por sala que cierra la partida cuando vence el reloj del turno. */
const clockTimers = new Map<string, NodeJS.Timeout>();
/** Timers de abandono por sala: npub desconectado → pierde si no vuelve a tiempo. */
const abandonTimers = new Map<string, Map<Npub, NodeJS.Timeout>>();

// ---------------------------------------------------------------- HTTP

const app = express();
app.use(cors());

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.all().length, buildId: config.buildId });
});

// El web sondea esto y, si el buildId difiere del suyo, recarga (ver web/src/version.ts).
app.get("/version", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ buildId: config.buildId });
});

// Sirve el build del web (deploy unificado: HTTP + WS en el mismo puerto). En dev
// se corre Vite aparte (:5173) y este bloque simplemente no encuentra `web/dist`.
const webDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
if (existsSync(webDist)) {
  app.use((_req, res, next) => {
    // Cross-origin isolation: el tablero Vexel usa SharedArrayBuffer (-pthread).
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    next();
  });
  // index:false → el index NO se sirve desde acá; cae al handler de abajo, que le
  // pone no-cache (así un deploy nuevo no queda tapado por caché del borde/Cloudflare).
  // Los assets llevan hash en el nombre (Vite), así que su caché por defecto es segura.
  app.use(express.static(webDist, { index: false }));
  // Cualquier ruta no-archivo sirve el index (el shell rutea por query string).
  app.get("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.sendFile(join(webDist, "index.html"));
  });
} else {
  console.warn(
    "[ajedrez] web/dist no existe — buildeá el web ('npm --prefix web run build') " +
      "o corré Vite en dev ('npm --prefix web run dev').",
  );
}

const server = createServer(app);
const wss = new WebSocketServer({ server });

// ----------------------------------------------------------------- WS handling

wss.on("connection", (ws) => {
  conns.set(ws, {});
  ws.on("message", (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      return send(ws, { t: "error", code: "BAD_JSON", message: "JSON inválido" });
    }
    handleMessage(ws, msg).catch((err) => {
      const code =
        err instanceof MatchError ||
        err instanceof RoomError ||
        err instanceof AuthError ||
        err instanceof BetError
          ? err.code
          : "INTERNAL";
      send(ws, { t: "error", code, message: String(err.message ?? err) });
    });
  });
  ws.on("close", () => handleDisconnect(ws));
});

async function handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  const state = conns.get(ws);
  if (!state) return;

  if (msg.t === "auth") return handleAuth(ws, state, msg.token);
  if (msg.t === "auth_challenge") return handleAuthChallenge(ws, state);
  if (msg.t === "auth_nostr") return handleAuthNostr(ws, state, msg.event, msg.displayName);
  if (msg.t === "auth_token") return handleAuthToken(ws, state, msg.token);
  if (!state.identity)
    return send(ws, { t: "error", code: "UNAUTHED", message: "Autenticate primero" });

  switch (msg.t) {
    case "create_room":
      return handleCreate(ws, state);
    case "join_room":
      return handleJoin(ws, state, msg.roomId, msg.code);
    case "enter_room":
      return handleEnterRoom(ws, state, msg.roomId);
    case "ready":
      return handleReady(ws, state);
    case "move":
      return handleMove(ws, state, msg.move);
    case "resign":
      return handleResign(ws, state);
    case "offer_draw":
      return handleOfferDraw(ws, state);
    case "accept_draw":
      return handleAcceptDraw(ws, state);
    case "propose_bet":
      return handleProposeBet(ws, state, msg.stakeSats);
    case "cancel_bet":
      return handleCancelBet(ws, state);
    case "leave":
      return handleDisconnect(ws);
  }
}

/** Login invitado por nombre: derivamos un id estable del nombre elegido. */
function handleAuth(ws: WebSocket, state: ConnState, token: string): void {
  const identity = makeIdentity(token);
  if (!identity)
    return send(ws, { t: "error", code: "INVALID_TOKEN", message: "Nombre inválido" });
  state.identity = identity;
  send(ws, { t: "authed", identity });
  send(ws, { t: "caps", bets: betsEnabled() });
}

/** `token` = nombre del jugador. Id estable por nombre (para reconexión). */
function makeIdentity(token: string): SessionIdentity | null {
  const name = token.trim();
  if (!name) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "") || "anon";
  return { npub: `u_${slug}`, displayName: name, guest: true };
}

/** Login Nostr, paso 1: emite un reto para que el jugador lo firme (NIP-42). */
function handleAuthChallenge(ws: WebSocket, state: ConnState): void {
  state.challenge = makeChallenge();
  send(ws, { t: "challenge", challenge: state.challenge });
}

/** Login Nostr, paso 2: verifica la firma del reto y fija la identidad real. */
function handleAuthNostr(
  ws: WebSocket,
  state: ConnState,
  event: Event,
  displayName?: string,
): void {
  if (!state.challenge)
    return send(ws, { t: "error", code: "NO_CHALLENGE", message: "Pedí un challenge primero" });
  const { pubkey, npub } = verifyNostrAuth(event, state.challenge);
  state.challenge = undefined;
  const name = cleanDisplayName(displayName) ?? `${npub.slice(0, 12)}…`;
  state.identity = { npub, pubkey, displayName: name, guest: false };
  const token = issueSessionToken(pubkey, npub, name);
  send(ws, { t: "authed", identity: state.identity, token });
  send(ws, { t: "caps", bets: betsEnabled() });
}

/**
 * Login Nostr por token: reusa una sesión ya verificada (reload/reconexión) sin
 * volver a firmar. El token fue emitido por el server tras un login firmado, así
 * que el pubkey sigue siendo confiable. Rota el token en cada uso.
 */
function handleAuthToken(ws: WebSocket, state: ConnState, token: string): void {
  const res = verifySessionToken(token);
  if (!res)
    return send(ws, { t: "error", code: "BAD_TOKEN", message: "Sesión inválida o vencida" });
  const name = res.displayName || `${res.npub.slice(0, 12)}…`;
  state.identity = { npub: res.npub, pubkey: res.pubkey, displayName: name, guest: false };
  const fresh = issueSessionToken(res.pubkey, res.npub, name);
  send(ws, { t: "authed", identity: state.identity, token: fresh });
  send(ws, { t: "caps", bets: betsEnabled() });
}

/** Display name best-effort del perfil: no es sensible (la firma es la auth),
 *  solo lo saneamos para no romper la UI. */
function cleanDisplayName(name?: string): string | null {
  const trimmed = name?.trim().replace(/\s+/g, " ").slice(0, 40);
  return trimmed ? trimmed : null;
}

function handleCreate(ws: WebSocket, state: ConnState): void {
  const me = identity(state);
  const room = rooms.create({ npub: me.npub, displayName: me.displayName, pubkey: me.pubkey });
  attachToRoom(ws, state, room);
  broadcastRoom(room);
}

/** Room Link (Luna `?lnRoom=<id>`): entra a la sala por su id externo, creándola
 *  lazy si no existe. Público: cualquiera con el link entra (identidad ya validada
 *  por el login Nostr de este socket). */
function handleEnterRoom(ws: WebSocket, state: ConnState, roomId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId))
    return send(ws, { t: "error", code: "BAD_ROOM_ID", message: "lnRoom inválido" });
  const me = identity(state);
  const room = rooms.enterByExternalId(roomId, {
    npub: me.npub,
    displayName: me.displayName,
    pubkey: me.pubkey,
  });
  attachToRoom(ws, state, room);
  broadcastRoom(room);
  resync(ws, room);
}

function handleJoin(
  ws: WebSocket,
  state: ConnState,
  roomId?: string,
  code?: string,
): void {
  const me = identity(state);
  const room = roomId ? rooms.get(roomId) : code ? rooms.getByCode(code) : undefined;
  if (!room) return send(ws, { t: "error", code: "NO_ROOM", message: "Sala inexistente" });
  if (!room.hasPlayer(me.npub))
    room.join({ npub: me.npub, displayName: me.displayName, pubkey: me.pubkey });
  attachToRoom(ws, state, room);
  broadcastRoom(room);
  resync(ws, room);
}

/** Pone al día a un socket que (re)entra a una sala con partida en curso o terminada. */
function resync(ws: WebSocket, room: Room): void {
  const match = room.match;
  if (!match) return;
  // Cobrar el reloj primero: si venció mientras nadie miraba, cerrar acá mismo.
  const timedOut = match.checkTimeout();
  if (timedOut) {
    broadcast(room, { t: "match", snapshot: timedOut });
    finishMatch(room);
    return;
  }
  send(ws, { t: "match", snapshot: match.snapshot() });
  if (room.drawOfferBy && !match.isOver)
    send(ws, { t: "draw_offer", byNpub: room.drawOfferBy });
  if (match.isOver)
    send(ws, { t: "ended", result: match.getResult(), winnerNpubs: match.winnerNpubs() });
}

function handleReady(ws: WebSocket, state: ConnState): void {
  const room = currentRoom(state);
  const me = identity(state);
  if (!room.isFull)
    return send(ws, { t: "error", code: "NOT_FULL", message: "Falta el rival" });
  const ready = readyByRoom.get(room.id) ?? new Set<Npub>();
  ready.add(me.npub);
  readyByRoom.set(room.id, ready);
  if (room.roster.every((p) => ready.has(p.npub))) startAndBroadcast(room);
}

function startAndBroadcast(room: Room): void {
  const match = room.startMatch();
  broadcastRoom(room);
  broadcast(room, { t: "match", snapshot: match.snapshot() });
  scheduleClock(room);
}

/** Programa el cierre por timeout para cuando venza el reloj del jugador en turno. */
function scheduleClock(room: Room): void {
  clearTimeout(clockTimers.get(room.id));
  clockTimers.delete(room.id);
  const match = room.match;
  if (!match || match.isOver) return;
  const timer = setTimeout(() => {
    const snapshot = match.checkTimeout();
    if (!snapshot) return scheduleClock(room); // jitter: aún queda tiempo
    broadcast(room, { t: "match", snapshot });
    finishMatch(room);
  }, match.turnRemainingMs() + 50);
  clockTimers.set(room.id, timer);
}

function handleMove(ws: WebSocket, state: ConnState, move: MovePayload): void {
  const room = currentRoom(state);
  if (!room.match) return send(ws, { t: "error", code: "NO_MATCH", message: "No hay partida" });
  const snapshot = room.match.move(identity(state).npub, move);
  broadcast(room, { t: "match", snapshot });
  if (room.match.isOver) finishMatch(room);
  else scheduleClock(room);
}

function handleResign(ws: WebSocket, state: ConnState): void {
  const room = currentRoom(state);
  if (!room.match) return;
  const snapshot = room.match.resign(identity(state).npub);
  broadcast(room, { t: "match", snapshot });
  finishMatch(room);
}

function handleOfferDraw(ws: WebSocket, state: ConnState): void {
  const room = currentRoom(state);
  if (!room.match || room.match.isOver) return;
  room.drawOfferBy = identity(state).npub;
  broadcast(room, { t: "draw_offer", byNpub: room.drawOfferBy });
}

function handleAcceptDraw(ws: WebSocket, state: ConnState): void {
  const room = currentRoom(state);
  const me = identity(state).npub;
  if (!room.match || !room.drawOfferBy || room.drawOfferBy === me) return;
  const snapshot = room.match.agreeDraw();
  broadcast(room, { t: "match", snapshot });
  finishMatch(room);
}

// ----------------------------------------------------------------- apuestas NGE

/** El anfitrión propone una apuesta; el escrow emite un invoice por jugador. */
async function handleProposeBet(ws: WebSocket, state: ConnState, stakeSats: number): Promise<void> {
  if (!betsEnabled())
    return send(ws, { t: "error", code: "BETS_DISABLED", message: "Apuestas deshabilitadas" });
  const room = currentRoom(state);
  const me = identity(state);
  if (me.npub !== room.hostNpub)
    return send(ws, { t: "error", code: "NOT_HOST", message: "Solo el anfitrión propone la apuesta" });
  if (room.phase !== "lobby")
    return send(ws, { t: "error", code: "NOT_LOBBY", message: "La partida ya arrancó" });
  if (betsByRoom.has(room.id))
    return send(ws, { t: "error", code: "BET_EXISTS", message: "Ya hay una apuesta en curso" });
  const white = room.white;
  const black = room.black;
  if (!white || !black || !room.isFull)
    return send(ws, { t: "error", code: "NOT_FULL", message: "Falta el rival" });
  if (!white.pubkey || !black.pubkey)
    return send(ws, {
      t: "error",
      code: "GUEST_IN_ROOM",
      message: "Ambos jugadores deben entrar con Nostr para apostar",
    });
  if (!Number.isInteger(stakeSats) || stakeSats <= 0)
    return send(ws, { t: "error", code: "BAD_STAKE", message: "Monto inválido" });

  const created = await createBet({
    clientRef: `bet_${room.id}`,
    roomId: room.id,
    stakeSats,
    seats: [
      { seatId: "w", pubkey: white.pubkey },
      { seatId: "b", pubkey: black.pubkey },
    ],
    condition: "Gana la partida de ajedrez (empate → reembolso)",
  });

  betsByRoom.set(room.id, { betId: created.betId, stakeSats: created.stakeSats, started: false });

  // Invoice privado a cada jugador (su asiento por color).
  for (const dep of created.deposits) {
    const npub = dep.seatId === "w" ? white.npub : black.npub;
    for (const sock of socketsOf(room.id, npub))
      send(sock, {
        t: "bet_invoice",
        betId: created.betId,
        bolt11: dep.bolt11,
        amountSats: dep.amountSats,
        stakeSats: created.stakeSats,
      });
  }

  broadcast(room, {
    t: "bet",
    bet: {
      betId: created.betId,
      status: "pending_deposits",
      stakeSats: created.stakeSats,
      potSats: created.potSats,
      seats: [
        { color: "w", deposited: false },
        { color: "b", deposited: false },
      ],
    },
  });

  const stop = watchBet(created.betId, (bet) => onBetUpdate(room.id, bet));
  const record = betsByRoom.get(room.id);
  if (record) record.stop = stop;
  else stop(); // la sala se limpió mientras creábamos: cortar el watch
}

/** Cada transición del escrow: refleja estado, arranca al fondear, cierra al terminar. */
function onBetUpdate(roomId: string, bet: NgeBet): void {
  const room = rooms.get(roomId);
  const record = betsByRoom.get(roomId);
  if (!room || !record) return;
  broadcast(room, { t: "bet", bet: betView(bet) });

  if (bet.status === "funded" && !record.started && room.phase === "lobby") {
    record.started = true;
    startAndBroadcast(room);
    return;
  }
  if (isTerminalBet(bet.status)) {
    record.stop?.();
    betsByRoom.delete(roomId);
    broadcast(room, { t: "bet_closed", reason: bet.status });
  }
}

/** El anfitrión cancela la apuesta pre-fondeo (reembolsa lo ya pagado). */
async function handleCancelBet(ws: WebSocket, state: ConnState): Promise<void> {
  const room = currentRoom(state);
  const me = identity(state);
  const record = betsByRoom.get(room.id);
  if (!record) return;
  if (me.npub !== room.hostNpub)
    return send(ws, { t: "error", code: "NOT_HOST", message: "Solo el anfitrión cancela" });
  if (record.started)
    return send(ws, { t: "error", code: "BET_STARTED", message: "La partida ya arrancó" });
  await cancelBet(record.betId).catch((err) => console.warn("[bet] cancel falló:", err));
  clearBet(room, "cancelada");
}

/** Liquida la apuesta al terminar la partida: ganador por color, empate → reembolso. */
function settleRoomBet(room: Room, winners: Npub[]): void {
  const record = betsByRoom.get(room.id);
  if (!record) return;
  const winnerSeats: string[] = [];
  if (winners.length === 1) {
    const color = room.roster.find((p) => p.npub === winners[0])?.color;
    if (color) winnerSeats.push(color);
  }
  // [] = empate/anulación → el escrow reembolsa. El resultado lo dicta el server.
  settleBet(record.betId, winnerSeats).catch((err) => console.warn("[bet] settle falló:", err));
  // El watch emitirá 'settled' y disparará bet_closed + limpieza.
}

function betView(bet: NgeBet): BetView {
  return {
    betId: bet.betId,
    status: bet.status,
    stakeSats: bet.stakeSats,
    potSats: bet.potSats,
    seats: bet.seats.map((s) => ({ color: (s.seatId === "w" ? "w" : "b") as Color, deposited: s.deposited })),
  };
}

function isTerminalBet(status: string): boolean {
  return ["settled", "cancelled", "expired", "refunded"].includes(status);
}

/** Corta el watch, olvida la apuesta y avisa a la sala. */
function clearBet(room: Room, reason: string): void {
  const record = betsByRoom.get(room.id);
  if (!record) return;
  record.stop?.();
  betsByRoom.delete(room.id);
  broadcast(room, { t: "bet_closed", reason });
}

/** Sockets vivos de un jugador en una sala. */
function socketsOf(roomId: string, npub: Npub): WebSocket[] {
  const set = roomSockets.get(roomId);
  if (!set) return [];
  return [...set].filter((ws) => conns.get(ws)?.identity?.npub === npub);
}

/** Cierre de partida: cancelar timers, aplicar ELO y avisar el resultado. */
function finishMatch(room: Room): void {
  if (!room.match || room.settled) return;
  room.settled = true;
  room.phase = "finished";
  clearTimeout(clockTimers.get(room.id));
  clockTimers.delete(room.id);
  const timers = abandonTimers.get(room.id);
  if (timers) for (const t of timers.values()) clearTimeout(t);
  abandonTimers.delete(room.id);
  const winners = room.match.winnerNpubs();
  broadcast(room, {
    t: "ended",
    result: room.match.getResult(),
    winnerNpubs: winners,
    ratings: rateMatch(room, winners),
  });
  settleRoomBet(room, winners);
}

/** Aplica ELO a los dos jugadores de la sala (o undefined si falta alguno). */
function rateMatch(room: Room, winners: Npub[]): RatingChange[] | undefined {
  const white = room.white;
  const black = room.black;
  if (!white || !black) return undefined;
  const winner = winners.length === 1 ? winners[0]! : null;
  return applyResult(white.npub, black.npub, winner);
}

// ----------------------------------------------------------------- helpers

function attachToRoom(ws: WebSocket, state: ConnState, room: Room): void {
  state.roomId = room.id;
  const set = roomSockets.get(room.id) ?? new Set<WebSocket>();
  set.add(ws);
  roomSockets.set(room.id, set);
  // Si tenía un timer de abandono corriendo, volvió a tiempo.
  const timers = abandonTimers.get(room.id);
  const me = state.identity;
  const pending = me ? timers?.get(me.npub) : undefined;
  if (me && pending) {
    clearTimeout(pending);
    timers?.delete(me.npub);
    broadcast(room, { t: "presence", npub: me.npub, online: true });
  }
}

function handleDisconnect(ws: WebSocket): void {
  const state = conns.get(ws);
  conns.delete(ws);
  if (!state?.roomId) return;
  roomSockets.get(state.roomId)?.delete(ws);
  const room = rooms.get(state.roomId);
  const me = state.identity;
  if (!room || !me) return;
  if (isOnline(room.id, me.npub)) return; // le queda otra pestaña/socket
  // En lobby con apuesta sin fondear: cancelar (reembolsa lo ya pagado) para no
  // dejar fondos atados si un jugador se va antes de arrancar.
  const record = betsByRoom.get(room.id);
  if (room.phase === "lobby" && record && !record.started) {
    cancelBet(record.betId).catch((err) => console.warn("[bet] cancel en disconnect:", err));
    clearBet(room, "un jugador se fue");
  }
  // Con partida en curso: gracia para reconectarse; si no vuelve, pierde.
  if (room.phase === "playing" && room.match && !room.match.isOver) {
    broadcast(room, {
      t: "presence",
      npub: me.npub,
      online: false,
      graceMs: config.abandonGraceMs,
    });
    startAbandonTimer(room, me.npub);
  }
}

/** ¿Hay algún socket vivo de este jugador en la sala? */
function isOnline(roomId: string, npub: Npub): boolean {
  const set = roomSockets.get(roomId);
  if (!set) return false;
  for (const ws of set) if (conns.get(ws)?.identity?.npub === npub) return true;
  return false;
}

function startAbandonTimer(room: Room, npub: Npub): void {
  const timers = abandonTimers.get(room.id) ?? new Map<Npub, NodeJS.Timeout>();
  abandonTimers.set(room.id, timers);
  clearTimeout(timers.get(npub));
  timers.set(
    npub,
    setTimeout(() => {
      timers.delete(npub);
      if (!room.match || room.match.isOver || isOnline(room.id, npub)) return;
      const snapshot = room.match.resign(npub);
      broadcast(room, { t: "match", snapshot });
      finishMatch(room);
    }, config.abandonGraceMs),
  );
}

function roomView(room: Room): RoomView {
  return {
    id: room.id,
    code: room.code,
    hostNpub: room.hostNpub,
    phase: room.phase,
    players: room.roster,
  };
}

function broadcastRoom(room: Room): void {
  broadcast(room, { t: "room", room: roomView(room) });
}

function broadcast(room: Room, msg: ServerMessage): void {
  const set = roomSockets.get(room.id);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function identity(state: ConnState): SessionIdentity {
  if (!state.identity) throw new RoomError("UNAUTHED", "No autenticado");
  return state.identity;
}

function currentRoom(state: ConnState): Room {
  const room = state.roomId ? rooms.get(state.roomId) : undefined;
  if (!room) throw new RoomError("NO_ROOM", "No estás en una sala");
  return room;
}

server.listen(config.port, () => {
  const served = existsSync(webDist) ? " · sirviendo web/dist" : "";
  console.log(`[ajedrez] http://localhost:${config.port}${served}`);
});
