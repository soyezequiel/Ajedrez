import { describe, expect, it } from "vitest";
import { RoomError, RoomManager, clockMsFromMinutes } from "./rooms.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOST = { npub: "u_ana", displayName: "Ana" };
const GUEST = { npub: "u_beto", displayName: "Beto" };

const TTL = { finishedTtlMs: 10_000, emptyTtlMs: 30_000 };

describe("RoomManager — GC de salas (sweep)", () => {
  it("genera ids y links de sala de 4 caracteres", () => {
    const room = new RoomManager().create(HOST);
    expect(room.id).toMatch(/^[A-Z2-9]{4}$/);
    expect(room.code).toBe(room.id);
  });

  it("guarda el tiempo elegido por el creador y lo usa en la partida", () => {
    const room = new RoomManager().create(HOST, 10 * 60 * 1000);
    room.join(GUEST);
    const match = room.startMatch(1_000).snapshot();
    expect(room.clockMs).toBe(10 * 60 * 1000);
    expect(match.whiteClockMs).toBe(10 * 60 * 1000);
    expect(match.blackClockMs).toBe(10 * 60 * 1000);
  });

  it("rechaza tiempos manipulados fuera de los ritmos ofrecidos", () => {
    expect(() => clockMsFromMinutes(0)).toThrow(RoomError);
    expect(() => clockMsFromMinutes(999)).toThrow(RoomError);
    expect(clockMsFromMinutes(3)).toBe(3 * 60 * 1000);
  });

  it("permite cambiar el tiempo en el lobby pero no durante la partida", () => {
    const room = new RoomManager().create(HOST);
    room.setClockMs(15 * 60 * 1000);
    expect(room.clockMs).toBe(15 * 60 * 1000);
    room.join(GUEST);
    room.startMatch(0);
    expect(() => room.setClockMs(3 * 60 * 1000)).toThrow(RoomError);
  });

  it("restaura sala y partida completa desde disco", () => {
    const dir = mkdtempSync(join(tmpdir(), "ajedrez-rooms-"));
    const path = join(dir, "rooms.json");
    try {
      const first = new RoomManager(path);
      const room = first.create(HOST);
      room.join(GUEST);
      room.startMatch(1_000).move(HOST.npub, { from: "e2", to: "e4" }, 2_000);
      first.persist();

      const restored = new RoomManager(path).get(room.id)!;
      expect(restored.roster).toHaveLength(2);
      expect(restored.match?.snapshot().sanHistory).toEqual(["e4"]);
      expect(restored.match?.snapshot().fen).toBe(room.match?.snapshot().fen);
      expect(restored.clockMs).toBe(room.clockMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
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

  it("rematchReset invierte colores y deja la sala lista para otra partida", () => {
    const rooms = new RoomManager();
    const room = rooms.create(HOST);
    room.join(GUEST);
    const first = room.startMatch(0);
    room.phase = "finished";
    room.settled = true;
    room.drawOfferBy = HOST.npub;
    room.rematchBy.add(HOST.npub).add(GUEST.npub);

    room.rematchReset();
    expect(room.white?.npub).toBe(GUEST.npub); // colores invertidos
    expect(room.black?.npub).toBe(HOST.npub);
    expect(room.settled).toBe(false);
    expect(room.match).toBeNull();
    expect(room.drawOfferBy).toBeNull();
    expect(room.rematchBy.size).toBe(0);

    const second = room.startMatch(0);
    expect(second).not.toBe(first);
    expect(second.matchId).not.toBe(first.matchId);
    expect(second.snapshot().white).toBe(GUEST.npub);
    expect(room.phase).toBe("playing");
  });

  it("rematchReset exige que la partida haya terminado", () => {
    const rooms = new RoomManager();
    const room = rooms.create(HOST);
    room.join(GUEST);
    room.startMatch(0); // phase = playing
    expect(() => room.rematchReset()).toThrow(RoomError);
  });

  it("remove() es idempotente y no rompe con ids desconocidos", () => {
    const rooms = new RoomManager();
    const room = rooms.create(HOST);
    rooms.remove(room.id);
    rooms.remove(room.id);
    rooms.remove("room_inexistente");
    expect(rooms.all()).toHaveLength(0);
  });

  it("libera el asiento del invitado cuando abandona el lobby", () => {
    const room = new RoomManager().create(HOST);
    room.join(GUEST);
    expect(room.leave(GUEST.npub)).toBe(true);
    expect(room.roster.map((player) => player.npub)).toEqual([HOST.npub]);
    expect(room.isFull).toBe(false);
  });

  it("no permite quitar un jugador de una partida en curso", () => {
    const room = new RoomManager().create(HOST);
    room.join(GUEST);
    room.startMatch(0);
    expect(() => room.leave(GUEST.npub)).toThrow(RoomError);
  });
});
