import { RELAYS } from "../config.js";
import { getPool } from "./relays.js";

/** Lista NIP-02 (kind:3) más reciente del usuario. */
export async function fetchContacts(pubkey: string): Promise<string[]> {
  const author = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(author)) return [];
  try {
    const events = await getPool().querySync(
      [...RELAYS.profile],
      { kinds: [3], authors: [author] },
      { maxWait: 3500 },
    );
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
