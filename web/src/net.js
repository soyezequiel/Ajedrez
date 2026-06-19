/** Cliente WebSocket tipado contra el servidor de ajedrez. */
export class Net {
    url;
    ws = null;
    handlers = {};
    queue = [];
    constructor(url) {
        this.url = url;
    }
    on(event, fn) {
        this.handlers[event] = fn;
    }
    connect() {
        const ws = new WebSocket(this.url);
        this.ws = ws;
        ws.addEventListener("open", () => {
            for (const m of this.queue)
                ws.send(JSON.stringify(m));
            this.queue = [];
            this.handlers.open?.();
        });
        ws.addEventListener("close", () => this.handlers.close?.());
        ws.addEventListener("message", (e) => {
            const msg = JSON.parse(e.data);
            const fn = this.handlers[msg.t];
            fn?.(msg);
        });
    }
    send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN)
            this.ws.send(JSON.stringify(msg));
        else
            this.queue.push(msg);
    }
    // Atajos
    auth(token, inviteToken) { this.send({ t: "auth", token, inviteToken }); }
    createRoom(stakeSats) { this.send({ t: "create_room", stakeSats }); }
    joinRoom(opts) { this.send({ t: "join_room", ...opts }); }
    setStake(stakeSats) { this.send({ t: "set_stake", stakeSats }); }
    ready() { this.send({ t: "ready" }); }
    move(from, to, promotion) {
        this.send({ t: "move", move: { from, to, promotion } });
    }
    resign() { this.send({ t: "resign" }); }
    offerDraw() { this.send({ t: "offer_draw" }); }
    acceptDraw() { this.send({ t: "accept_draw" }); }
    inviteFriend(toNpub) { this.send({ t: "invite_friend", toNpub }); }
}
