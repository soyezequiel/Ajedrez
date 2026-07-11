import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import type { Npub } from "./types.js";

/** Rating inicial de un jugador nuevo. */
const DEFAULT_RATING = 1200;
/** Factor K del ELO (cuánto se mueve el rating por partida). */
const K = 32;

type Store = Record<Npub, number>;
let store: Store | null = null;

function load(): Store {
  if (store) return store;
  try {
    store = existsSync(config.ratingsPath)
      ? (JSON.parse(readFileSync(config.ratingsPath, "utf8")) as Store)
      : {};
  } catch (err) {
    console.warn("[ratings] no se pudo leer el store, arranco vacío:", err);
    store = {};
  }
  return store;
}

function persist(): void {
  try {
    mkdirSync(dirname(config.ratingsPath), { recursive: true });
    writeFileSync(config.ratingsPath, JSON.stringify(store ?? {}));
  } catch (err) {
    console.warn("[ratings] no se pudo persistir:", err);
  }
}

export function getRating(npub: Npub): number {
  return load()[npub] ?? DEFAULT_RATING;
}

export interface RatingChange {
  npub: Npub;
  rating: number;
  delta: number;
}

/**
 * Aplica ELO a una partida terminada y persiste. `winner` = npub ganador, o
 * `null` para tablas. Devuelve el rating nuevo y el delta de cada jugador.
 */
export function applyResult(white: Npub, black: Npub, winner: Npub | null): RatingChange[] {
  const s = load();
  const rw = s[white] ?? DEFAULT_RATING;
  const rb = s[black] ?? DEFAULT_RATING;
  const expW = 1 / (1 + 10 ** ((rb - rw) / 400));
  const expB = 1 - expW;
  const scoreW = winner === null ? 0.5 : winner === white ? 1 : 0;
  const scoreB = winner === null ? 0.5 : winner === black ? 1 : 0;
  const nw = Math.round(rw + K * (scoreW - expW));
  const nb = Math.round(rb + K * (scoreB - expB));
  s[white] = nw;
  s[black] = nb;
  persist();
  return [
    { npub: white, rating: nw, delta: nw - rw },
    { npub: black, rating: nb, delta: nb - rb },
  ];
}
