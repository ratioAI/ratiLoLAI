import type { DatabaseSync } from 'node:sqlite'
import type { AchievementState, Tier } from '@shared/types'
import type { GameSummary } from '@shared/summary'
import { summaryAugmentTiers, type TierLookup } from '@shared/mayhem'
import { galaxyOf } from '@shared/universe'
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_BY_ID,
  AchievementTracker,
  goalOf,
  type AchievementExtra,
  type AchievementProgress,
  type FlightCounts
} from '@shared/achievements'

interface UnlockRow {
  id: string
  unlocked_at: number
  game_id: number | null
  seen: number
}

/** The achievements and flights tables in games.db (created by the migrations in games.ts). */
export class AchievementStore {
  constructor(private readonly db: DatabaseSync) {}

  unlocked(): Map<string, { unlockedAt: number; gameId: number | null; seen: boolean }> {
    const rows = this.db.prepare('SELECT id, unlocked_at, game_id, seen FROM achievements').all() as unknown as UnlockRow[]
    return new Map(rows.map((row) => [row.id, { unlockedAt: row.unlocked_at, gameId: row.game_id, seen: row.seen === 1 }]))
  }

  /** Stores an unlock unless it is there already: the first unlocked_at stays forever. True when it is new. */
  insert(id: string, unlockedAt: number, gameId: number | null, seen: boolean): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO achievements (id, unlocked_at, game_id, seen) VALUES (?, ?, ?, ?)')
      .run(id, Math.round(unlockedAt), gameId, seen ? 1 : 0)
    return Number(result.changes) > 0
  }

  markSeen(ids: string[]): void {
    const update = this.db.prepare('UPDATE achievements SET seen = 1 WHERE id = ?')
    for (const id of ids) update.run(String(id))
  }

  /** Removes all unlocks (admin tool), or just these. */
  reset(ids?: string[]): void {
    if (!ids) this.db.exec('DELETE FROM achievements')
    else for (const id of ids) this.db.prepare('DELETE FROM achievements WHERE id = ?').run(id)
  }

  recordFlight(variant: string, galaxy: number, at = Date.now()): void {
    this.db.prepare('INSERT INTO flights (at, variant, galaxy) VALUES (?, ?, ?)').run(at, variant, galaxy)
  }

  extra(): AchievementExtra {
    const flights: FlightCounts = {}
    for (const row of this.db.prepare('SELECT variant, COUNT(*) AS n FROM flights GROUP BY variant').all() as unknown as {
      variant: string
      n: number
    }[]) {
      if (row.variant === 'wormhole' || row.variant === 'slingshot') flights[row.variant] = row.n
    }
    const galaxies = (this.db.prepare('SELECT DISTINCT galaxy FROM flights').all() as unknown as { galaxy: number }[]).map(
      (row) => row.galaxy
    )
    return { flights, galaxiesVisited: galaxies }
  }
}

export interface AchievementDeps {
  db: DatabaseSync
  /** every saved game (any order) */
  history(): GameSummary[]
  /** augment tiers, null while the augment or static data isn't there (offline) */
  tiers(): Promise<TierLookup | null>
  /** newly unlocked achievements, for the main window */
  unlocked(ids: string[]): void
  log(message: string): void
}

/**
 * Keeps the achievements up to date: worked out from the whole history once (at start, outside of
 * a game), then game by game as they are saved. Unlocks are stored with the time of the game that
 * earned them and never move or disappear, even if that game is deleted later.
 */
export class AchievementService {
  readonly store: AchievementStore
  private tracker: AchievementTracker | null = null
  /** whether the tracker was built with augment tiers (otherwise it is rebuilt once they are there) */
  private hadTiers = false
  private results: AchievementProgress[] = []
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: AchievementDeps) {
    this.store = new AchievementStore(deps.db)
  }

  /** Runs one job after the other, so a game and a flight never evaluate at the same time. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Works everything out from the whole history. The first time ever, nothing is announced. */
  rebuild(): Promise<string[]> {
    return this.serial(() => this.rebuildJob())
  }

  /** The augment tiers the tracker reads; set before every evaluation. */
  private tierOf: TierLookup | null = null
  private readonly augTiers = (summary: GameSummary): Record<string, (Tier | undefined)[]> =>
    this.tierOf ? summaryAugmentTiers(summary, this.tierOf) : {}

  private async rebuildJob(): Promise<string[]> {
    this.tierOf = await this.deps.tiers().catch(() => null)
    const started = Date.now()
    // the very first evaluation (no unlocks stored yet) only records what the history already earned
    const firstRun = !this.tracker && this.store.unlocked().size === 0
    const tracker = new AchievementTracker({ augTiers: this.augTiers })
    const history = this.deps.history().sort((a, b) => a.createdAt - b.createdAt || a.gameId - b.gameId)
    for (const summary of history) if (tracker.canAdd(summary)) tracker.add(summary)
    this.tracker = tracker
    this.hadTiers = !!this.tierOf
    const fresh = this.persist(tracker, firstRun)
    this.deps.log(
      `achievements: ${history.length} games in ${Date.now() - started} ms, ${this.results.filter((result) => result.unlocked).length} unlocked${firstRun ? ' (first run, not announced)' : ''}`
    )
    if (fresh.length && !firstRun) this.deps.unlocked(fresh)
    return fresh
  }

  /** A game was saved: adds it (or works everything out again if it doesn't fit at the end). */
  onGame(summary: GameSummary): Promise<string[]> {
    return this.serial(async () => {
      const tierOf = await this.deps.tiers().catch(() => null)
      // augment data that wasn't there before changes older games too
      if (!this.tracker || !this.tracker.canAdd(summary) || (!!tierOf && !this.hadTiers)) return this.rebuildJob()
      this.tierOf = tierOf ?? this.tierOf
      this.tracker.add(summary)
      const fresh = this.persist(this.tracker, false)
      if (fresh.length) {
        this.deps.log(`achievements unlocked by game ${summary.gameId}: ${fresh.join(', ')}`)
        this.deps.unlocked(fresh)
      }
      return fresh
    })
  }

  /** A flight was shown (cosmos achievements). */
  onFlight(variant: 'wormhole' | 'slingshot', seed: number): Promise<string[]> {
    return this.serial(async () => {
      this.store.recordFlight(variant, galaxyOf(seed).id)
      if (!this.tracker) return []
      const fresh = this.persist(this.tracker, false)
      if (fresh.length) this.deps.unlocked(fresh)
      return fresh
    })
  }

  /** Stores what is newly unlocked, returns those ids. */
  private persist(tracker: AchievementTracker, seen: boolean): string[] {
    this.results = tracker.results(this.store.extra())
    const fresh: string[] = []
    for (const result of this.results) {
      if (!result.unlocked) continue
      if (this.store.insert(result.id, result.at ?? Date.now(), result.gameId ?? null, seen)) fresh.push(result.id)
    }
    return fresh
  }

  /** Admin tool: unlock one now. */
  unlockNow(id: string, gameId: number | null): boolean {
    if (!ACHIEVEMENT_BY_ID.has(id)) throw new Error(`unknown achievement ${id}`)
    const fresh = this.store.insert(id, Date.now(), gameId, false)
    if (fresh) this.deps.unlocked([id])
    return fresh
  }

  /** Every achievement for the renderer: the stored unlocks plus the progress of the rest. */
  list(): AchievementState[] {
    const stored = this.store.unlocked()
    const progress = new Map(this.results.map((result) => [result.id, result]))
    return ACHIEVEMENTS.map((def) => {
      const unlock = stored.get(def.id)
      const goal = goalOf(def)
      const result = progress.get(def.id)
      return {
        id: def.id,
        name: def.name,
        description: def.description,
        category: def.category,
        rank: def.rank,
        secret: !!def.secret,
        unlocked: !!unlock,
        unlockedAt: unlock?.unlockedAt ?? null,
        gameId: unlock?.gameId ?? null,
        seen: unlock?.seen ?? false,
        progress: unlock ? goal : (result?.progress ?? 0),
        goal
      }
    })
  }
}
