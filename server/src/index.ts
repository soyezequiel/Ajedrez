import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { luna, type SessionIdentity } from "./lunaNegra.js";
import { MatchError } from "./chessMatch.js";
import { Room, RoomError, RoomManager } from "./rooms.js";
import type { ClientMessage, RoomView, ServerMessage } from "./protocol.js";
import type { MovePayload, Npub } from "./types.js";

const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL ?? "http://localhost:5173";

const rooms = new RoomManager();

interface ConnState {
  identity?: SessionIdentity;
  roomId?: string;
}
const conns = new Map<WebSocket, ConnState>();
const roomSockets = new Map<string, Set<WebSocket>>();
/** Jugadores que confirmaron "listo" por sala. */
const readyByRoom = new Map<string, Set<Npub>>();
/** Heartbeats de presencia por sala (para limpiar al terminar). */
const presenceTimers = new Map<string, NodeJS.Timeout>();

// ---------------------------------------------------------------- HTTP / webhook

const app = express();
app.use(cors());

app.get("/health", (_req, res) => {
  res.json({ ok: true, lunaLive: config.lunaLive, rooms: rooms.all().length });
});

// Webhook de Luna Negra (§8): cuerpo CRUDO para verificar la firma HMAC.
app.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  (req, res) => {
    const raw = req.body.toString("utf8");
    const sig = req.header("X-LunaNegra-Signature") ?? "";
    if (!luna.verifyWebhook(raw, sig)) return res.status(401).end();
    const event = JSON.parse(raw) as { type: string; data: unknown };
    handleWebhook(event.type, event.data);
    res.json({ ok: true });
  },
);

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

  if (msg.t === "auth") return void (await handleAuth(ws, state, msg.token));
  if (!state.identity)
    return send(ws, { t: "error", code: "UNAUTHED", message: "Autenticate primero" });

  switch (msg.t) {
    case "create_room":
      return handleCreate(ws, state, msg.stakeSats ?? 0);
    case "join_room":
      return handleJoin(ws, state, msg.roomId, msg.code);
    case "set_stake":
      return handleSetStake(ws, state, msg.stakeSats);
    case "ready":
      return await handleReady(ws, state);
    case "move":
      return handleMove(ws, state, msg.move);
    case "resign":
      return await handleResign(ws, state);
    case "offer_draw":
      return handleOfferDraw(ws, state);
    case "accept_draw":
      return await handleAcceptDraw(ws, state);
    case "invite_friend":
      return await handleInvite(ws, state, msg.toNpub);
    case "leave":
      return handleDisconnect(ws);
  }
}

async function handleAuth(ws: WebSocket, state: ConnState, token: string): Promise<void> {
  const identity = await luna.verifySession(token);
  if (!identity)
    return send(ws, { t: "error", code: "INVALID_TOKEN", message: "Token inválido" });
  state.identity = identity;
  send(ws, { t: "authed", identity });
  // De paso mandamos los amigos para la barra lateral.
  const friends = await luna.getFriends(identity.npub);
  send(ws, { t: "friends", friends });
}

function handleCreate(ws: WebSocket, state: ConnState, stakeSats: number): void {
  const me = identity(state);
  const room = rooms.create({ npub: me.npub, displayName: me.displayName });
  room.stakeSats = Math.max(0, Math.floor(stakeSats));
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
}

function handleSetStake(ws: WebSocket, state: ConnState, stakeSats: number): void {
  const room = currentRoom(state);
  if (room.hostNpub !== identity(state).npub)
    return send(ws, { t: "error", code: "NOT_HOST", message: "Solo el host fija la apuesta" });
  if (room.phase !== "lobby")
    return send(ws, { t: "error", code: "BAD_PHASE", message: "La partida ya arrancó" });
  room.stakeSats = Math.max(0, Math.floor(stakeSats));
  broadcastRoom(room);
}

async function handleReady(ws: WebSocket, state: ConnState): Promise<void> {
  const room = currentRoom(state);
  const me = identity(state);
  if (!room.isFull)
    return send(ws, { t: "error", code: "NOT_FULL", message: "Falta el rival" });
  const ready = readyByRoom.get(room.id) ?? new Set<Npub>();
  ready.add(me.npub);
  readyByRoom.set(room.id, ready);
  if (room.roster.every((p) => ready.has(p.npub))) await beginMatchFlow(room);
}

/** Ambos listos: si hay apuesta, crear el pozo y esperar depósitos; si no, arrancar. */
async function beginMatchFlow(room: Room): Promise<void> {
  if (room.stakeSats > 0 && !room.bet) {
    const white = room.white!;
    const black = room.black!;
    const bet = await luna.createBet({
      participants: [white.npub, black.npub],
      stakeSats: room.stakeSats,
      roomId: room.id,
      matchId: `match_${room.id}`,
      victoryCondition: "jaque mate / abandono / tiempo",
    });
    room.bet = bet;
    room.phase = "awaiting_deposit";
    broadcastRoom(room);
    broadcast(room, { t: "bet", bet });
    if (bet?.status === "funded") return startAndBroadcast(room);
    return pollDeposits(room);
  }
  startAndBroadcast(room);
}

/** Pollea el estado del pozo hasta que esté fondeado o venza el plazo. */
function pollDeposits(room: Room): void {
  if (!room.bet) return;
  const betId = room.bet.betId;
  const timer = setInterval(async () => {
    const bet = await luna.getBet(betId);
    if (!bet) return;
    room.bet = bet;
    broadcast(room, { t: "bet", bet });
    if (bet.status === "funded") {
      clearInterval(timer);
      startAndBroadcast(room);
    } else if (["expired", "cancelled", "refunded"].includes(bet.status)) {
      clearInterval(timer);
      room.phase = "lobby";
      readyByRoom.delete(room.id);
      broadcastRoom(room);
    }
  }, 3000);
}

function startAndBroadcast(room: Room): void {
  const match = room.startMatch();
  broadcastRoom(room);
  broadcast(room, { t: "match", snapshot: match.snapshot() });
  startPresence(room);
}

function handleMove(ws: WebSocket, state: ConnState, move: MovePayload): void {
  const room = currentRoom(state);
  if (!room.match) return send(ws, { t: "error", code: "NO_MATCH", message: "No hay partida" });
  const snapshot = room.match.move(identity(state).npub, move);
  broadcast(room, { t: "match", snapshot });
  if (room.match.isOver) void finishMatch(room);
}

async function handleResign(ws: WebSocket, state: ConnState): Promise<void> {
  const room = currentRoom(state);
  if (!room.match) return;
  const snapshot = room.match.resign(identity(state).npub);
  broadcast(room, { t: "match", snapshot });
  await finishMatch(room);
}

function handleOfferDraw(ws: WebSocket, state: ConnState): void {
  const room = currentRoom(state);
  if (!room.match || room.match.isOver) return;
  room.drawOfferBy = identity(state).npub;
  broadcast(room, { t: "draw_offer", byNpub: room.drawOfferBy });
}

async function handleAcceptDraw(ws: WebSocket, state: ConnState): Promise<void> {
  const room = currentRoom(state);
  const me = identity(state).npub;
  if (!room.match || !room.drawOfferBy || room.drawOfferBy === me) return;
  const snapshot = room.match.agreeDraw();
  broadcast(room, { t: "match", snapshot });
  await finishMatch(room);
}

async function handleInvite(ws: WebSocket, state: ConnState, toNpub: Npub): Promise<void> {
  const room = currentRoom(state);
  const me = identity(state);
  const res = await luna.sendInvite({
    fromNpub: me.npub,
    toNpub,
    roomId: room.id,
    inviteUrl: room.inviteUrl(PUBLIC_WEB_URL),
  });
  if (!res.delivered)
    send(ws, { t: "error", code: "INVITE_FAILED", message: "No se pudo invitar" });
}

/** Cierre de partida: declarar ganador a Luna Negra y avisar a la sala. */
async function finishMatch(room: Room): Promise<void> {
  if (!room.match) return;
  room.phase = "finished";
  stopPresence(room);
  const winnerNpubs = room.match.winnerNpubs();
  const betId = room.bet?.betId ?? null;
  if (betId) await luna.reportWinners(betId, winnerNpubs);
  broadcast(room, {
    t: "ended",
    result: room.match.getResult(),
    winnerNpubs,
    betId,
  });
}

// ----------------------------------------------------------------- presencia (§3)

function startPresence(room: Room): void {
  const beat = () => {
    for (const p of room.roster) {
      void luna.postPresence({
        npub: p.npub,
        status: "in-game",
        roomId: room.id,
        state: { rival: room.roster.find((o) => o.npub !== p.npub)?.displayName },
      });
    }
  };
  beat();
  presenceTimers.set(room.id, setInterval(beat, 10_000));
}

function stopPresence(room: Room): void {
  const timer = presenceTimers.get(room.id);
  if (timer) clearInterval(timer);
  presenceTimers.delete(room.id);
  for (const p of room.roster) void luna.postPresence({ npub: p.npub, status: "online" });
}

// ----------------------------------------------------------------- webhooks (§8)

function handleWebhook(type: string, data: unknown): void {
  // Reflejar el evento a la sala correspondiente si aplica.
  const roomId = (data as { roomId?: string })?.roomId;
  if (roomId) {
    const room = rooms.get(roomId);
    if (room) void refreshBet(room);
  }
  console.log(`[webhook] ${type}`);
}

async function refreshBet(room: Room): Promise<void> {
  if (!room.bet) return;
  const bet = await luna.getBet(room.bet.betId);
  if (bet) {
    room.bet = bet;
    broadcast(room, { t: "bet", bet });
  }
}

// ----------------------------------------------------------------- helpers

function attachToRoom(ws: WebSocket, state: ConnState, room: Room): void {
  state.roomId = room.id;
  const set = roomSockets.get(room.id) ?? new Set<WebSocket>();
  set.add(ws);
  roomSockets.set(room.id, set);
}

function handleDisconnect(ws: WebSocket): void {
  const state = conns.get(ws);
  conns.delete(ws);
  if (!state?.roomId) return;
  const set = roomSockets.get(state.roomId);
  set?.delete(ws);
  // Si una partida con apuesta queda sin un jugador conectado, no resolvemos
  // automáticamente acá (un abandono lo maneja un timeout futuro / reconexión).
}

function roomView(room: Room): RoomView {
  return {
    id: room.id,
    code: room.code,
    hostNpub: room.hostNpub,
    phase: room.phase,
    stakeSats: room.stakeSats,
    players: room.roster,
    inviteUrl: room.inviteUrl(PUBLIC_WEB_URL),
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
  console.log(
    `[ajedrez] server en :${config.port} · Luna Negra ${config.lunaLive ? "LIVE" : "MOCK"}`,
  );
});
