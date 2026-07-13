import { GAME_COORD, RELAYS } from "../config.js";
import { getPool } from "./relays.js";

export interface FriendAffinity {
  chessSeenAtMs: number;
  lastPlayedAtMs: number | null;
  gamesTogether: number;
  matchIds: string[];
}

export type FriendAffinities = Map<string, FriendAffinity>;
export interface FriendPriorityStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

const STORAGE_PREFIX = "ajedrez.friendAffinity.v1";
const MAX_MATCH_IDS = 24;
const ACTIVITY_BATCH_SIZE = 200;
const PUBKEY_RE = /^[0-9a-f]{64}$/;

function normalizePubkey(value: string): string | null {
  const pubkey = value.trim().toLowerCase();
  return PUBKEY_RE.test(pubkey) ? pubkey : null;
}

function storageKey(owner: string): string { return `${STORAGE_PREFIX}.${owner}`; }
function browserStorage(): FriendPriorityStorage | null { return typeof localStorage === "undefined" ? null : localStorage; }

export function loadFriendAffinities(
  ownerPubkey: string,
  storage: FriendPriorityStorage | null = browserStorage(),
): FriendAffinities {
  const owner = normalizePubkey(ownerPubkey);
  if (!owner || !storage) return new Map();
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(owner)) ?? "null") as {
      version?: number; friends?: Record<string, FriendAffinity>;
    } | null;
    if (parsed?.version !== 1 || !parsed.friends) return new Map();
    const result: FriendAffinities = new Map();
    for (const [rawPubkey, value] of Object.entries(parsed.friends)) {
      const pubkey = normalizePubkey(rawPubkey);
      if (!pubkey || pubkey === owner || !value || !Number.isFinite(value.chessSeenAtMs)) continue;
      result.set(pubkey, {
        chessSeenAtMs: value.chessSeenAtMs,
        lastPlayedAtMs: value.lastPlayedAtMs && Number.isFinite(value.lastPlayedAtMs) ? value.lastPlayedAtMs : null,
        gamesTogether: Math.max(0, Math.floor(Number(value.gamesTogether) || 0)),
        matchIds: Array.isArray(value.matchIds) ? value.matchIds.filter((id) => typeof id === "string").slice(-MAX_MATCH_IDS) : [],
      });
    }
    return result;
  } catch { return new Map(); }
}

export function rememberFriendActivity(
  ownerPubkey: string,
  friendPubkeys: Iterable<string>,
  options: { matchId?: string | null; atMs?: number } = {},
  storage: FriendPriorityStorage | null = browserStorage(),
): FriendAffinities {
  const owner = normalizePubkey(ownerPubkey);
  if (!owner) return new Map();
  const affinities = loadFriendAffinities(owner, storage);
  const atMs = options.atMs && Number.isFinite(options.atMs) ? options.atMs : Date.now();
  const matchId = options.matchId?.trim() || null;
  let changed = false;
  for (const rawFriend of friendPubkeys) {
    const friend = normalizePubkey(rawFriend);
    if (!friend || friend === owner) continue;
    const previous = affinities.get(friend);
    if (!previous) {
      affinities.set(friend, {
        chessSeenAtMs: atMs,
        lastPlayedAtMs: matchId ? atMs : null,
        gamesTogether: matchId ? 1 : 0,
        matchIds: matchId ? [matchId] : [],
      });
      changed = true;
    } else if (matchId && !previous.matchIds.includes(matchId)) {
      affinities.set(friend, {
        ...previous,
        lastPlayedAtMs: Math.max(previous.lastPlayedAtMs ?? 0, atMs),
        gamesTogether: previous.gamesTogether + 1,
        matchIds: [...previous.matchIds, matchId].slice(-MAX_MATCH_IDS),
      });
      changed = true;
    }
  }
  if (changed && storage) {
    try { storage.setItem(storageKey(owner), JSON.stringify({ version: 1, friends: Object.fromEntries(affinities) })); }
    catch { /* mejora best-effort */ }
  }
  return affinities;
}

/** Primero rivales anteriores, después usuarios con actividad pública en Ajedrez. */
export function prioritizeFriends<T extends { pubkey: string; name: string }>(items: T[], affinities: FriendAffinities): T[] {
  return [...items].sort((a, b) => {
    const aa = affinities.get(a.pubkey.toLowerCase());
    const bb = affinities.get(b.pubkey.toLowerCase());
    const playedA = (aa?.gamesTogether ?? 0) > 0;
    const playedB = (bb?.gamesTogether ?? 0) > 0;
    if (playedA !== playedB) return playedA ? -1 : 1;
    if (playedA && playedB) {
      const games = (bb?.gamesTogether ?? 0) - (aa?.gamesTogether ?? 0);
      if (games) return games;
      const recent = (bb?.lastPlayedAtMs ?? 0) - (aa?.lastPlayedAtMs ?? 0);
      if (recent) return recent;
    }
    if ((aa !== undefined) !== (bb !== undefined)) return aa ? -1 : 1;
    return a.name.localeCompare(b.name, "es", { sensitivity: "base" });
  });
}

/** Evidencia pública: presencia NIP-38 o marcador persistente del ajedrez. */
export async function fetchKnownChessPlayers(pubkeys: string[]): Promise<Set<string>> {
  const unique = [...new Set(pubkeys.map(normalizePubkey).filter((value): value is string => value !== null))];
  const known = new Set<string>();
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += ACTIVITY_BATCH_SIZE) batches.push(unique.slice(i, i + ACTIVITY_BATCH_SIZE));
  await Promise.all(batches.map(async (authors) => {
    try {
      const events = await getPool().querySync([...RELAYS.profile], {
        kinds: [30315, 31339, 31337], authors, "#a": [GAME_COORD],
      }, { maxWait: 3000 });
      for (const event of events) {
        if (event.tags.some((tag) => tag[0] === "a" && tag[1] === GAME_COORD)) known.add(event.pubkey);
      }
    } catch { /* actividad pública best-effort */ }
  }));
  return known;
}
