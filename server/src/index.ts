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
import type { ClientMessage, RoomView, ServerMessage, SessionIdentity } from "./protocol.js";
import type { MovePayload, Npub } from "./types.js";

const rooms = new RoomManager();

interface ConnState {
  identity?: SessionIdentity;
  roomId?: string;
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
  res.json({ ok: true, rooms: rooms.all().length });
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
  app.use(express.static(webDist));
  // Cualquier ruta no-archivo sirve el index (el shell rutea por query string).
  app.get("*", (_req, res) => res.sendFile(join(webDist, "index.html")));
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
      const code = err instanceof MatchError || err instanceof RoomError ? err.code : "INTERNAL";
      send(ws, { t: "error", code, message: String(err.message ?? err) });
    });
  });
  ws.on("close", () => handleDisconnect(ws));
});

async function handleMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
  const state = conns.get(ws);
  if (!state) return;

  if (msg.t === "auth") return handleAuth(ws, state, msg.token);
  if (!state.identity)
    return send(ws, { t: "error", code: "UNAUTHED", message: "Autenticate primero" });

  switch (msg.t) {
    case "create_room":
      return handleCreate(ws, state);
    case "join_room":
      return handleJoin(ws, state, msg.roomId, msg.code);
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
    case "leave":
      return handleDisconnect(ws);
  }
}

/** Login local por nombre: derivamos un id estable del nombre elegido. */
function handleAuth(ws: WebSocket, state: ConnState, token: string): void {
  const identity = makeIdentity(token);
  if (!identity)
    return send(ws, { t: "error", code: "INVALID_TOKEN", message: "Nombre inválido" });
  state.identity = identity;
  send(ws, { t: "authed", identity });
}

/** `token` = nombre del jugador. Id estable por nombre (para reconexión). */
function makeIdentity(token: string): SessionIdentity | null {
  const name = token.trim();
  if (!name) return null;
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "") || "anon";
  return { npub: `u_${slug}`, displayName: name };
}

function handleCreate(ws: WebSocket, state: ConnState): void {
  const me = identity(state);
  const room = rooms.create({ npub: me.npub, displayName: me.displayName });
  attachToRoom(ws, state, room);
  broadcastRoom(room);
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
    room.join({ npub: me.npub, displayName: me.displayName });
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

/** Cierre de partida: cancelar timers y avisar el resultado a la sala. */
function finishMatch(room: Room): void {
  if (!room.match) return;
  room.phase = "finished";
  clearTimeout(clockTimers.get(room.id));
  clockTimers.delete(room.id);
  const timers = abandonTimers.get(room.id);
  if (timers) for (const t of timers.values()) clearTimeout(t);
  abandonTimers.delete(room.id);
  broadcast(room, {
    t: "ended",
    result: room.match.getResult(),
    winnerNpubs: room.match.winnerNpubs(),
  });
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
