import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/**
 * Registro en disco de las apuestas NGE activas. La verdad del escrow vive en el
 * proveedor; esto solo recuerda qué betIds quedaron abiertos por si el server se
 * reinicia con una apuesta viva: al arrancar se reembolsan (la partida murió con
 * el proceso) en vez de dejar fondos atascados.
 */

export interface StoredBet {
  betId: string;
  roomId: string;
  stakeSats: number;
  createdAt: number;
}

type Store = Record<string, StoredBet>; // por betId
let store: Store | null = null;

function load(): Store {
  if (store) return store;
  try {
    store = existsSync(config.betsPath)
      ? (JSON.parse(readFileSync(config.betsPath, "utf8")) as Store)
      : {};
  } catch (err) {
    console.warn("[bets] no se pudo leer el store, arranco vacío:", err);
    store = {};
  }
  return store;
}

function persist(): void {
  try {
    mkdirSync(dirname(config.betsPath), { recursive: true });
    writeFileSync(config.betsPath, JSON.stringify(store ?? {}));
  } catch (err) {
    console.warn("[bets] no se pudo persistir:", err);
  }
}

export function trackBet(bet: StoredBet): void {
  load()[bet.betId] = bet;
  persist();
}

export function untrackBet(betId: string): void {
  const s = load();
  if (!(betId in s)) return;
  delete s[betId];
  persist();
}

/** Apuestas que quedaron abiertas (típicamente de un proceso anterior). */
export function pendingBets(): StoredBet[] {
  return Object.values(load());
}
