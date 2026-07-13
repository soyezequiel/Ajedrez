import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AchievementId, PlayerMastery, RivalMastery } from "./protocol.js";
import type { RoomPlayer } from "./rooms.js";
import type { MatchResult, Npub } from "./types.js";
import type { RatingChange } from "./ratings.js";

interface StoredPlayer extends Omit<PlayerMastery, "recentRivals"> {
  processedMatchIds: string[];
  recentRivals: RivalMastery[];
}

type MasteryData = Record<Npub, StoredPlayer>;

export interface MasteryUpdate {
  stats: PlayerMastery;
  newlyEarned: AchievementId[];
}

const DEFAULT_RATING = 1200;
const MAX_MATCH_IDS = 200;
const MAX_RIVALS = 20;

function emptyPlayer(rating = DEFAULT_RATING): StoredPlayer {
  return {
    rating,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    winStreak: 0,
    bestWinStreak: 0,
    achievements: [],
    processedMatchIds: [],
    recentRivals: [],
  };
}

/** Estadísticas sociales durables. El matchId hace que aplicar un resultado sea idempotente. */
export class MasteryStore {
  private data: MasteryData = {};

  constructor(private readonly storagePath?: string) {
    if (!storagePath || !existsSync(storagePath)) return;
    try {
      this.data = JSON.parse(readFileSync(storagePath, "utf8")) as MasteryData;
    } catch (error) {
      console.warn("[mastery] store inválido, se inicia vacío:", error);
    }
  }

  get(npub: Npub, rating = DEFAULT_RATING): PlayerMastery {
    const current = this.data[npub] ?? emptyPlayer(rating);
    return this.publicView({ ...current, rating: current.games ? current.rating : rating });
  }

  recordMatch(opts: {
    matchId: string;
    players: RoomPlayer[];
    result: MatchResult;
    winners: Npub[];
    ratings?: RatingChange[];
    endedAt?: number;
  }): Map<Npub, MasteryUpdate> {
    const updates = new Map<Npub, MasteryUpdate>();
    if (opts.result.kind === "ongoing" || opts.players.length !== 2) return updates;
    const endedAt = opts.endedAt ?? Date.now();

    for (const player of opts.players) {
      const rival = opts.players.find((candidate) => candidate.npub !== player.npub);
      if (!rival) continue;
      const stored = this.data[player.npub] ?? emptyPlayer();
      if (stored.processedMatchIds.includes(opts.matchId)) {
        updates.set(player.npub, { stats: this.publicView(stored), newlyEarned: [] });
        continue;
      }

      const won = opts.winners.includes(player.npub);
      const drew = opts.winners.length === 0;
      stored.games += 1;
      if (won) {
        stored.wins += 1;
        stored.winStreak += 1;
        stored.bestWinStreak = Math.max(stored.bestWinStreak, stored.winStreak);
      } else if (drew) {
        stored.draws += 1;
        stored.winStreak = 0;
      } else {
        stored.losses += 1;
        stored.winStreak = 0;
      }
      stored.rating = opts.ratings?.find((rating) => rating.npub === player.npub)?.rating ?? stored.rating;
      stored.processedMatchIds = [...stored.processedMatchIds, opts.matchId].slice(-MAX_MATCH_IDS);

      const previousRival = stored.recentRivals.find((entry) => entry.npub === rival.npub);
      const rivalry: RivalMastery = {
        npub: rival.npub,
        pubkey: rival.pubkey,
        displayName: rival.displayName,
        lastPlayedAt: endedAt,
        games: (previousRival?.games ?? 0) + 1,
        wins: (previousRival?.wins ?? 0) + (won ? 1 : 0),
        draws: (previousRival?.draws ?? 0) + (drew ? 1 : 0),
        losses: (previousRival?.losses ?? 0) + (!won && !drew ? 1 : 0),
      };
      stored.recentRivals = [rivalry, ...stored.recentRivals.filter((entry) => entry.npub !== rival.npub)]
        .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
        .slice(0, MAX_RIVALS);

      const candidates: AchievementId[] = [];
      if (stored.games === 1) candidates.push("first_game");
      if (won && stored.wins === 1) candidates.push("first_win");
      if (won && opts.result.by === "checkmate") candidates.push("checkmate_win");
      if (stored.winStreak >= 3) candidates.push("win_streak_3");
      if (stored.winStreak >= 5) candidates.push("win_streak_5");
      if (rivalry.games >= 3) candidates.push("rivalry_3");
      const newlyEarned = candidates.filter((id) => !stored.achievements.includes(id));
      stored.achievements = [...stored.achievements, ...newlyEarned];
      this.data[player.npub] = stored;
      updates.set(player.npub, { stats: this.publicView(stored), newlyEarned });
    }

    this.persist();
    return updates;
  }

  private publicView(player: StoredPlayer): PlayerMastery {
    const { processedMatchIds: _processed, ...view } = player;
    return structuredClone(view);
  }

  private persist(): void {
    if (!this.storagePath) return;
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true });
      const temp = `${this.storagePath}.tmp`;
      writeFileSync(temp, JSON.stringify(this.data, null, 2));
      renameSync(temp, this.storagePath);
    } catch (error) {
      console.warn("[mastery] no se pudo persistir:", error);
    }
  }
}
