import type { ClientMessage, NostrEvent, ServerMessage } from "./protocol.js";

type Handlers = {
  [M in ServerMessage as M["t"]]?: (msg: M) => void;
} & { open?: () => void; close?: () => void; dropped?: (count: number) => void };

/** Cliente WebSocket tipado contra el servidor de ajedrez. */
export class Net {
  private ws: WebSocket | null = null;
  private readonly handlers: Handlers = {};
  private queue: ClientMessage[] = [];

  constructor(private readonly url: string) {}

  on<T extends keyof Handlers>(event: T, fn: Handlers[T]): void {
    this.handlers[event] = fn;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      for (const m of this.queue) ws.send(JSON.stringify(m));
      this.queue = [];
      this.handlers.open?.();
    });
    ws.addEventListener("close", () => {
      // Descartar intents encolados: tras reconectar hay que re-autenticar primero.
      // Los auth_* se encolan por diseño (se mandan antes del open) — no cuentan.
      const dropped = this.queue.filter((m) => !m.t.startsWith("auth")).length;
      this.queue = [];
      if (dropped > 0) this.handlers.dropped?.(dropped);
      this.handlers.close?.();
    });
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      const fn = this.handlers[msg.t] as ((m: ServerMessage) => void) | undefined;
      fn?.(msg);
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.queue.push(msg);
  }

  // Atajos
  auth(token: string) { this.send({ t: "auth", token }); }
  authChallenge() { this.send({ t: "auth_challenge" }); }
  authNostr(event: NostrEvent, displayName?: string) {
    this.send({ t: "auth_nostr", event, displayName });
  }
  authToken(token: string) { this.send({ t: "auth_token", token }); }
  createRoom() { this.send({ t: "create_room" }); }
  joinRoom(opts: { roomId?: string; code?: string }) { this.send({ t: "join_room", ...opts }); }
  enterRoom(roomId: string) { this.send({ t: "enter_room", roomId }); }
  ready() { this.send({ t: "ready" }); }
  move(from: string, to: string, promotion?: "q" | "r" | "b" | "n") {
    this.send({ t: "move", move: { from, to, promotion } });
  }
  resign() { this.send({ t: "resign" }); }
  rematch() { this.send({ t: "rematch" }); }
  offerDraw() { this.send({ t: "offer_draw" }); }
  acceptDraw() { this.send({ t: "accept_draw" }); }
  proposeBet(stakeSats: number) { this.send({ t: "propose_bet", stakeSats }); }
  cancelBet() { this.send({ t: "cancel_bet" }); }
}
