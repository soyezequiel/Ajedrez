import type { Event } from "nostr-tools";
import { RELAYS } from "../config.js";
import { getPool } from "./relays.js";

const MAX_OUTBOX_RELAYS = 6;

async function queryContacts(relays: string[], author: string, maxWait: number): Promise<Event[]> {
  try { return await getPool().querySync(relays, { kinds: [3], authors: [author] }, { maxWait }); }
  catch { return []; }
}

async function fetchOutboxRelays(author: string): Promise<string[]> {
  try {
    const events = await getPool().querySync([...RELAYS.profile], { kinds: [10002], authors: [author] }, { maxWait: 2000 });
    if (!events.length) return [];
    const newest = events.reduce((a, b) => b.created_at > a.created_at ? b : a);
    return newest.tags
      .filter((tag) => tag[0] === "r" && tag[2] !== "read" && /^wss?:\/\//.test(tag[1] ?? ""))
      .map((tag) => tag[1]!)
      .slice(0, MAX_OUTBOX_RELAYS);
  } catch { return []; }
}

function normalizeRelay(url: string): string { return url.trim().toLowerCase().replace(/\/+$/, ""); }

/** Lista NIP-02 más reciente, buscando en relays conocidos y outbox en paralelo. */
export async function fetchContacts(pubkey: string): Promise<string[]> {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return [];
  try {
    const knownRelays = new Set(RELAYS.profile.map(normalizeRelay));
    const [direct, outbox] = await Promise.all([
      queryContacts([...RELAYS.profile], author, 3000),
      fetchOutboxRelays(author).then((relays) => {
        const extra = relays.filter((relay) => !knownRelays.has(normalizeRelay(relay)));
        return extra.length ? queryContacts(extra, author, 2000) : [];
      }),
    ]);
    const events = [...direct, ...outbox];
    if (!events.length) return [];
    const newest = events.reduce((a, b) => b.created_at > a.created_at ? b : a);
    return [...new Set(newest.tags
      .filter((tag) => tag[0] === "p" && /^[0-9a-f]{64}$/.test(tag[1] ?? ""))
      .map((tag) => tag[1]!.toLowerCase()))]
      .filter((contact) => contact !== author);
  } catch {
    return [];
  }
}
