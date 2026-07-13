import type { Event } from "nostr-tools";
import type { ChessSigner } from "./signer-core.js";
import { RELAYS } from "../config.js";
import { getPool } from "./relays.js";

export interface RoomLinkInvite {
  eventId: string;
  fromPubkey: string;
  roomId: string;
  url: string;
}

const SEEN_KEY = "ajedrez.roomlink.seen.v1";
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const ROOM_RE = /^[A-Za-z0-9]{4}$/;

export function parseOwnRoomLink(text: string, origin: string): { url: string; roomId: string } | null {
  for (const raw of text.match(URL_RE) ?? []) {
    try {
      const url = new URL(raw);
      const roomId = url.searchParams.get("join");
      if (url.origin === origin && roomId && ROOM_RE.test(roomId)) return { url: raw, roomId };
    } catch { /* seguir */ }
  }
  return null;
}

export function startRoomLinkInviteInbox(
  signer: ChessSigner,
  myPubkey: string,
  onInvite: (invite: RoomLinkInvite) => void,
): () => void {
  const seen = readSeen();
  const me = myPubkey.toLowerCase();
  let closed = false;
  const sub = getPool().subscribeMany(
    [...RELAYS.dm],
    { kinds: [4], "#p": [me], since: Math.floor(Date.now() / 1000) - 10 * 60 },
    { onevent: (event: Event) => {
      if (closed || seen.has(event.id) || event.pubkey === me || !signer.nip04Decrypt) return;
      void signer.nip04Decrypt(event.pubkey, event.content).then((plain) => {
        const link = parseOwnRoomLink(plain, location.origin);
        if (closed || seen.has(event.id) || !link) return;
        seen.add(event.id);
        persistSeen(seen);
        onInvite({ eventId: event.id, fromPubkey: event.pubkey, ...link });
      }).catch(() => {});
    } },
  );
  return () => { closed = true; sub.close(); };
}

function readSeen(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]); }
  catch { return new Set(); }
}

function persistSeen(seen: Set<string>): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-200))); }
  catch { /* sin storage */ }
}
