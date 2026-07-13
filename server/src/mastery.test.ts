import { describe, expect, it } from "vitest";
import { MasteryStore } from "./mastery.js";
import type { RoomPlayer } from "./rooms.js";

const WHITE: RoomPlayer = { npub: "npub_white", pubkey: "a".repeat(64), displayName: "Ada", color: "w" };
const BLACK: RoomPlayer = { npub: "npub_black", pubkey: "b".repeat(64), displayName: "Beto", color: "b" };

describe("MasteryStore", () => {
  it("registra resultado, rival y logros iniciales", () => {
    const store = new MasteryStore();
    const updates = store.recordMatch({
      matchId: "m1",
      players: [WHITE, BLACK],
      result: { kind: "white_win", by: "checkmate" },
      winners: [WHITE.npub],
      ratings: [
        { npub: WHITE.npub, rating: 1216, delta: 16 },
        { npub: BLACK.npub, rating: 1184, delta: -16 },
      ],
      endedAt: 100,
    });

    expect(updates.get(WHITE.npub)?.stats).toMatchObject({ rating: 1216, games: 1, wins: 1, winStreak: 1 });
    expect(updates.get(WHITE.npub)?.newlyEarned).toEqual(["first_game", "first_win", "checkmate_win"]);
    expect(updates.get(BLACK.npub)?.stats).toMatchObject({ games: 1, losses: 1, winStreak: 0 });
    expect(updates.get(WHITE.npub)?.stats.recentRivals[0]).toMatchObject({ npub: BLACK.npub, games: 1, wins: 1 });
  });

  it("es idempotente por matchId", () => {
    const store = new MasteryStore();
    const match = {
      matchId: "same",
      players: [WHITE, BLACK],
      result: { kind: "white_win" as const, by: "checkmate" as const },
      winners: [WHITE.npub],
    };
    store.recordMatch(match);
    const repeated = store.recordMatch(match);
    expect(repeated.get(WHITE.npub)?.stats.games).toBe(1);
    expect(repeated.get(WHITE.npub)?.newlyEarned).toEqual([]);
  });

  it("desbloquea racha y rivalidad al tercer duelo", () => {
    const store = new MasteryStore();
    for (let index = 1; index <= 3; index++) {
      store.recordMatch({
        matchId: `m${index}`,
        players: [WHITE, BLACK],
        result: { kind: "white_win", by: "resign" },
        winners: [WHITE.npub],
        endedAt: index,
      });
    }
    const stats = store.get(WHITE.npub);
    expect(stats.winStreak).toBe(3);
    expect(stats.achievements).toContain("win_streak_3");
    expect(stats.achievements).toContain("rivalry_3");
    expect(stats.recentRivals[0]?.games).toBe(3);
  });
});
