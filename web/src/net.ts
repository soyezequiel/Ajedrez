import type { ClientMessage, ServerMessage } from "./protocol.js";

type Handlers = {
  [M in ServerMessage as M["t"]]?: (msg: M) => void;
} & { open?: () => void; close?: () => void };

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
    ws.addEventListener("close", () => this.handlers.close?.());
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
  auth(token: string, inviteToken?: string) { this.send({ t: "auth", token, inviteToken }); }
  createRoom(stakeSats: number) { this.send({ t: "create_room", stakeSats }); }
  joinRoom(opts: { roomId?: string; code?: string }) { this.send({ t: "join_room", ...opts }); }
  setStake(stakeSats: number) { this.send({ t: "set_stake", stakeSats }); }
  ready() { this.send({ t: "ready" }); }
  move(from: string, to: string, promotion?: "q" | "r" | "b" | "n") {
    this.send({ t: "move", move: { from, to, promotion } });
  }
  resign() { this.send({ t: "resign" }); }
  offerDraw() { this.send({ t: "offer_draw" }); }
  acceptDraw() { this.send({ t: "accept_draw" }); }
  inviteFriend(toNpub: string) { this.send({ t: "invite_friend", toNpub }); }
}
