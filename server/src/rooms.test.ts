import { describe, expect, it } from "vitest";
import { RoomManager } from "./rooms.js";

const HOST = { npub: "u_ana", displayName: "Ana" };
const GUEST = { npub: "u_beto", displayName: "Beto" };

const TTL = { finishedTtlMs: 10_000, emptyTtlMs: 30_000 };

describe("RoomManager — GC de salas (sweep)", () => {
  it("purga una sala terminada pasado su TTL y libera id y código", () => {
    const rooms = new RoomManager();
    const room = rooms.create(HOST);
    room.join(GUEST);
    room.startMatch(0);
    room.phase = "finished";
    room.touch(0);

    const purged = rooms.sweep({ ...TTL, now: TTL.finishedTtlMs + 1 });
    expect(purged.map((r) => r.id)).toEqual([room.id]);
    expect(rooms.get(room.id)).toBeUndefined();
    expect(rooms.getByCode(room.code)).toBeUndefined();
  });

  it("no purga salas dentro de su TTL", () => {
    const rooms = new RoomManager();
    const finished = rooms.create(HOST);
    finished.phase = "finished";
    finished.touch(0);
    const lobby = rooms.create(GUEST);
    lobby.touch(0);

    // finished: TTL corto ya vencido; lobby: TTL largo todavía vigente.
    const purged = rooms.sweep({ ...TTL, now: TTL.finishedTtlMs + 1 });
    expect(purged).toHaveLength(1);
    expect(purged[0]!.id).toBe(finished.id);
    expect(rooms.get(lobby.id)).toBe(lobby);
  });

  it("respeta el skip (sala con sockets o apuesta activa)", () => {
    const rooms = new RoomManager();
    const room = rooms.create(HOST);
    room.phase = "finished";
    room.touch(0);

    const purged = rooms.sweep({ ...TTL, now: 999_999, skip: (r) => r.id === room.id });
    expect(purged).toHaveLength(0);
    expect(rooms.get(room.id)).toBe(room);
  });

  it("touch() reinicia el reloj de inactividad", () => {
    const rooms = new RoomManager();
    const room = rooms.create(HOST);
    room.phase = "finished";
    room.touch(0);
    room.touch(TTL.finishedTtlMs); // actividad tardía

    expect(rooms.sweep({ ...TTL, now: TTL.finishedTtlMs + 1 })).toHaveLength(0);
    expect(rooms.sweep({ ...TTL, now: TTL.finishedTtlMs * 2 + 1 })).toHaveLength(1);
  });

  it("remove() es idempotente y no rompe con ids desconocidos", () => {
    const rooms = new RoomManager();
    const room = rooms.create(HOST);
    rooms.remove(room.id);
    rooms.remove(room.id);
    rooms.remove("room_inexistente");
    expect(rooms.all()).toHaveLength(0);
  });
});
