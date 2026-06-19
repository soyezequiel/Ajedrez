import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import type { Npub } from "./types.js";

/**
 * Cliente server-to-server de Luna Negra (skill `integrar-luna-negra`).
 *
 * Reglas de oro respetadas acá:
 *  - La API key `ln_sk_…` SOLO se usa en este archivo (server). Nunca al cliente.
 *  - El resultado de una apuesta SIEMPRE sale del server (`reportWinners`).
 *  - Identidad = `npub` (nunca UUID local).
 *
 * Si no hay credenciales (`config.lunaLive === false`) cae en modo MOCK para
 * desarrollar sin backend. Cada respuesta lleva `source: "luna-negra" | "mock"`.
 */

export interface SessionIdentity {
  npub: Npub;
  pubkey: string;
  displayName: string;
  avatarUrl: string | null;
  gameId: string;
  source: "luna-negra" | "mock";
}

export interface Friend {
  npub: Npub;
  displayName: string;
  avatarUrl: string | null;
  presence: "in-game" | "online" | "offline";
  roomId: string | null;
  lastSeenMs: number | null;
}

export interface BetInfo {
  betId: string;
  status:
    | "pending_deposits"
    | "funded"
    | "settled"
    | "cancelled"
    | "expired"
    | "refunded";
  potTargetSats: number;
  feeSats: number;
  netPayoutSats: number;
  depositDeadline: string | null;
  participants: Array<{
    npub: Npub;
    depositStatus: "pending" | "paid";
    payoutSats: number | null;
    bolt11: string | null;
    lnurl: string | null;
    payUrl: string | null;
  }>;
}

class LunaNegraClient {
  private readonly base = config.luna.baseUrl.replace(/\/$/, "");

  // ---- Identidad (§1) ----------------------------------------------------

  /** Canjea un entitlement (`lnToken`) y devuelve la identidad del jugador. */
  async verifySession(entitlement: string): Promise<SessionIdentity | null> {
    if (!config.lunaLive) return mockIdentity(entitlement);
    const r = await this.get("/api/v1/session", { bearer: entitlement });
    if (!r.ok) return null;
    // `displayName`/`avatarUrl` pueden venir null en el contrato real.
    const j = (await r.json()) as {
      npub: Npub;
      pubkey: string;
      displayName: string | null;
      avatarUrl: string | null;
      gameId: string;
    };
    return {
      npub: j.npub,
      pubkey: j.pubkey,
      displayName: j.displayName || shortNpub(j.npub),
      avatarUrl: j.avatarUrl ?? null,
      gameId: j.gameId,
      source: "luna-negra",
    };
  }

  /** Verifica un invite token de sala (§4). */
  async verifyRoom(inviteToken: string): Promise<
    | ({ valid: true; npub: Npub; roomId: string; host: boolean } & Record<
        string,
        unknown
      >)
    | { valid: false }
  > {
    if (!config.lunaLive) {
      const id = mockIdentity(inviteToken);
      return id
        ? { valid: true, npub: id.npub, roomId: "mock-room", host: false }
        : { valid: false };
    }
    const r = await this.get("/api/v1/rooms/verify", { bearer: inviteToken });
    if (!r.ok) return { valid: false };
    return (await r.json()) as { valid: true; npub: Npub; roomId: string; host: boolean };
  }

  // ---- Presencia (§3) ----------------------------------------------------

  async postPresence(input: {
    npub: Npub;
    status: "in-game" | "online";
    roomId?: string;
    state?: Record<string, unknown>;
  }): Promise<void> {
    if (!config.lunaLive) return;
    await this.post("/api/v1/presence", input, { apiKey: true });
  }

  // ---- Amigos e invitaciones (§5) ---------------------------------------

  async getFriends(npub: Npub, q?: string): Promise<Friend[]> {
    if (!config.lunaLive) return mockFriends();
    const params = new URLSearchParams({ npub, presence: "true" });
    if (q) params.set("q", q);
    const r = await this.get(`/api/v1/friends?${params}`, { apiKey: true });
    if (!r.ok) return [];
    const j = (await r.json()) as { friends: Friend[] };
    return j.friends ?? [];
  }

  async sendInvite(input: {
    fromNpub: Npub;
    toNpub: Npub;
    roomId: string;
    inviteUrl: string;
  }): Promise<{ delivered: boolean }> {
    if (!config.lunaLive) return { delivered: true };
    const r = await this.post(
      "/api/v1/invites",
      { ...input, gameId: config.luna.gameId },
      { apiKey: true },
    );
    if (!r.ok) return { delivered: false };
    return (await r.json()) as { delivered: boolean };
  }

  // ---- Apuestas / escrow (§7) -------------------------------------------

  async createBet(input: {
    participants: Npub[];
    stakeSats: number;
    roomId: string;
    matchId: string;
    victoryCondition: string;
    idempotencyKey?: string;
  }): Promise<BetInfo | null> {
    if (!config.lunaLive) return mockBet(input);
    const r = await this.post(
      "/api/v1/bets",
      {
        gameId: config.luna.gameId,
        participants: input.participants,
        stakeSats: input.stakeSats,
        victoryCondition: input.victoryCondition,
        roomId: input.roomId,
        metadata: { matchId: input.matchId },
      },
      { apiKey: true, idempotencyKey: input.idempotencyKey ?? input.matchId },
    );
    if (!r.ok) return null;
    // El 201 (CreateBetResponse) trae economía + betId, pero NO `status` ni los
    // `participants` con handles de pago (bolt11/lnurl). Hidratamos con getBet
    // para devolver un BetInfo completo y no emitir un pozo a medias a la sala.
    const created = (await r.json()) as { betId: string };
    return (await this.getBet(created.betId)) ?? null;
  }

  async getBet(betId: string): Promise<BetInfo | null> {
    if (!config.lunaLive) return null;
    const r = await this.get(`/api/v1/bets/${betId}`, { apiKey: true });
    if (!r.ok) return null;
    return (await r.json()) as BetInfo;
  }

  /** Reporta el/los ganador(es). `[]` = empate → reembolso total. Idempotente. */
  async reportWinners(betId: string, winners: Npub[]): Promise<boolean> {
    if (!config.lunaLive) return true;
    const r = await this.post(
      `/api/v1/bets/${betId}/result`,
      { winners },
      { apiKey: true, idempotencyKey: `result:${betId}` },
    );
    return r.ok;
  }

  async cancelBet(betId: string): Promise<boolean> {
    if (!config.lunaLive) return true;
    const r = await this.post(`/api/v1/bets/${betId}/cancel`, {}, { apiKey: true });
    return r.ok;
  }

  // ---- Webhooks (§8) -----------------------------------------------------

  /** Verifica la firma HMAC-SHA256 del cuerpo CRUDO contra el webhook secret. */
  verifyWebhook(rawBody: string, signature: string): boolean {
    if (!config.luna.webhookSecret) return false;
    const expected = createHmac("sha256", config.luna.webhookSecret)
      .update(rawBody)
      .digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---- HTTP helpers ------------------------------------------------------

  private async get(
    path: string,
    auth: { bearer?: string; apiKey?: boolean },
  ): Promise<Response> {
    return fetch(this.base + path, { headers: this.headers(auth) });
  }

  private async post(
    path: string,
    body: unknown,
    auth: { bearer?: string; apiKey?: boolean; idempotencyKey?: string },
  ): Promise<Response> {
    const headers = this.headers(auth);
    headers["content-type"] = "application/json";
    if (auth.idempotencyKey) headers["Idempotency-Key"] = auth.idempotencyKey;
    return fetch(this.base + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  private headers(auth: { bearer?: string; apiKey?: boolean }): Record<string, string> {
    const h: Record<string, string> = {};
    if (auth.bearer) h.authorization = `Bearer ${auth.bearer}`;
    else if (auth.apiKey) h.authorization = `Bearer ${config.luna.apiKey}`;
    return h;
  }
}

/** Nombre de respaldo cuando el jugador no tiene displayName (ej. `npub1ab…xyz`). */
function shortNpub(npub: string): string {
  return npub.length > 12 ? `${npub.slice(0, 8)}…${npub.slice(-3)}` : npub;
}

// ---- Datos mock (modo dev sin backend) -----------------------------------

/** En dev el shell pasa tokens `lndemo:<nombre>`; derivamos un npub estable. */
export function mockIdentity(token: string): SessionIdentity | null {
  const name = token.startsWith("lndemo:") ? token.slice(7) : token || "Anon";
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "") || "anon";
  return {
    npub: `npub1mock${slug}`,
    pubkey: `mockpubkey_${slug}`,
    displayName: name,
    avatarUrl: null,
    gameId: config.luna.gameId || "game_mock",
    source: "mock",
  };
}

function mockFriends(): Friend[] {
  return [
    { npub: "npub1mockana", displayName: "Ana", avatarUrl: null, presence: "online", roomId: null, lastSeenMs: Date.now() },
    { npub: "npub1mockbeto", displayName: "Beto", avatarUrl: null, presence: "offline", roomId: null, lastSeenMs: null },
  ];
}

function mockBet(input: {
  participants: Npub[];
  stakeSats: number;
  matchId: string;
}): BetInfo {
  const pot = input.stakeSats * input.participants.length;
  const fee = Math.ceil(pot * 0.05);
  return {
    betId: `bet_mock_${input.matchId}`,
    status: "funded", // en mock asumimos depósito instantáneo
    potTargetSats: pot,
    feeSats: fee,
    netPayoutSats: pot - fee,
    depositDeadline: null,
    participants: input.participants.map((npub) => ({
      npub,
      depositStatus: "paid",
      payoutSats: null,
      bolt11: null,
      lnurl: null,
      payUrl: null,
    })),
  };
}

export const luna = new LunaNegraClient();
