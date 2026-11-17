import { mkdirSync } from 'node:fs'
import { readdir, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { QUEUE_IDS, type GameListEntry, type LeaderboardEntry } from '@shared/types'
import { teamBlame, type GameSummary } from '@shared/summary'
import type { EncounterStats } from '@shared/encounters'

/** The layout of version 1 (1.0 and 1.1). Later versions build on it through MIGRATIONS. */
export const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  game_id     INTEGER PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  duration    INTEGER NOT NULL,
  queue_id    INTEGER NOT NULL,
  mode        TEXT    NOT NULL,
  win         INTEGER NOT NULL,
  champion_id INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  deaths      INTEGER NOT NULL,
  assists     INTEGER NOT NULL,
  blamed      TEXT,
  cosmos      REAL,
  summary     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS games_created ON games (created_at DESC);
CREATE TABLE IF NOT EXISTS game_players (
  game_id     INTEGER NOT NULL REFERENCES games (game_id) ON DELETE CASCADE,
  puuid       TEXT    NOT NULL,
  riot_id     TEXT    NOT NULL,
  champion_id INTEGER NOT NULL,
  ally        INTEGER NOT NULL,
  me          INTEGER NOT NULL,
  premade     INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  mvp         INTEGER NOT NULL,
  troll       INTEGER NOT NULL,
  win         INTEGER NOT NULL,
  PRIMARY KEY (game_id, puuid)
);
CREATE INDEX IF NOT EXISTS game_players_puuid ON game_players (puuid);
`

/** Version of the database layout, kept in `PRAGMA user_version`. Databases from 1.0 and 1.1 are version 1 (or 0). */
export const DB_VERSION = 3

/** Columns one migration adds to an existing table (skipped when they are already there). */
type AddColumns = { table: string; columns: [name: string, definition: string][] }

/**
 * Migrations, keyed by the version they lead to. Each runs once in a transaction together with
 * raising user_version, and is written so that running it on a database that already has its
 * changes does no harm.
 */
const MIGRATIONS: Record<number, { add?: AddColumns[]; sql?: string; after?: (db: DatabaseSync) => void }> = {
  // 1.2: per-player K/D/A and multikill for the encounters on the loading screen, plus the
  // tables of the achievements and the Discord posts
  2: {
    add: [
      {
        table: 'game_players',
        columns: [
          ['kills', 'INTEGER NOT NULL DEFAULT 0'],
          ['deaths', 'INTEGER NOT NULL DEFAULT 0'],
          ['assists', 'INTEGER NOT NULL DEFAULT 0'],
          ['multikill', 'INTEGER NOT NULL DEFAULT 0']
        ]
      }
    ],
    sql: `
      CREATE TABLE IF NOT EXISTS achievements (
        id          TEXT PRIMARY KEY,
        unlocked_at INTEGER NOT NULL,
        game_id     INTEGER,
        seen        INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS discord_posts (
        game_id   INTEGER PRIMARY KEY,
        posted_at INTEGER NOT NULL
      );`,
    after: backfillPlayerStats
  },
  // 1.2: the flights you watched (cosmos achievements)
  3: {
    sql: `
      CREATE TABLE IF NOT EXISTS flights (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      INTEGER NOT NULL,
        variant TEXT    NOT NULL,
        galaxy  INTEGER NOT NULL
      );`
  }
}

/** Fills the new per-player columns from the summary JSON of every saved game. */
function backfillPlayerStats(db: DatabaseSync): void {
  const update = db.prepare('UPDATE game_players SET kills = ?, deaths = ?, assists = ?, multikill = ? WHERE game_id = ? AND puuid = ?')
  const rows = db.prepare('SELECT game_id, summary FROM games').all() as unknown as { game_id: number; summary: string }[]
  for (const row of rows) {
    let summary: GameSummary
    try {
      summary = JSON.parse(row.summary) as GameSummary
    } catch {
      continue
    }
    for (const player of summary.players ?? []) {
      update.run(player.kills ?? 0, player.deaths ?? 0, player.assists ?? 0, player.multikill ?? 0, row.game_id, player.puuid)
    }
  }
}

/** Brings a database up to DB_VERSION. Safe to call on every start. */
export function migrate(db: DatabaseSync): number {
  db.exec(BASE_SCHEMA)
  let version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  for (let next = Math.max(version, 1) + 1; next <= DB_VERSION; next++) {
    const migration = MIGRATIONS[next]
    db.exec('BEGIN')
    try {
      for (const { table, columns } of migration.add ?? []) {
        const existing = new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((column) => column.name)
        )
        for (const [name, definition] of columns) {
          if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        }
      }
      if (migration.sql) db.exec(migration.sql)
      migration.after?.(db)
      db.exec(`PRAGMA user_version = ${next}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    version = next
  }
  return version
}

interface GameRow {
  game_id: number
  created_at: number
  duration: number
  queue_id: number
  mode: string
  win: number
  champion_id: number
  kills: number
  deaths: number
  assists: number
  blamed: string | null
  cosmos: number | null
}

const LIST_COLUMNS = 'game_id, created_at, duration, queue_id, mode, win, champion_id, kills, deaths, assists, blamed, cosmos'

/**
 * Game history in a SQLite database (userData/games.db). Every finished game is kept: one row with
 * the full summary as JSON plus the columns the history list needs, and one row per player for the
 * MVP / troll leaderboard.
 */
export class GameStore {
  private readonly db: DatabaseSync
  private readonly insertGame: StatementSync
  private readonly insertPlayer: StatementSync
  private readonly deletePlayers: StatementSync

  /** `file` is the database path, or ':memory:' for tests. */
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    migrate(this.db)
    this.insertGame = this.db.prepare(
      `INSERT INTO games (${LIST_COLUMNS}, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id) DO UPDATE SET
         created_at = excluded.created_at, duration = excluded.duration, queue_id = excluded.queue_id, mode = excluded.mode,
         win = excluded.win, champion_id = excluded.champion_id, kills = excluded.kills, deaths = excluded.deaths,
         assists = excluded.assists, blamed = excluded.blamed, cosmos = COALESCE(games.cosmos, excluded.cosmos),
         summary = excluded.summary`
    )
    this.insertPlayer = this.db.prepare(
      `INSERT INTO game_players (game_id, puuid, riot_id, champion_id, ally, me, premade, score, mvp, troll, win, kills, deaths, assists, multikill)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.deletePlayers = this.db.prepare('DELETE FROM game_players WHERE game_id = ?')
  }

  /** Saves a game, replacing an earlier copy of the same game. */
  save(summary: GameSummary): void {
    this.db.exec('BEGIN')
    try {
      this.write(summary)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private write(summary: GameSummary): void {
    const me = summary.players.find((player) => player.me)
    const blamed = teamBlame(summary)
    this.insertGame.run(
      summary.gameId,
      summary.createdAt,
      Math.round(summary.duration),
      summary.queueId,
      summary.mode,
      summary.win ? 1 : 0,
      me?.championId ?? 0,
      me?.kills ?? 0,
      me?.deaths ?? 0,
      me?.assists ?? 0,
      blamed?.riotId ?? null,
      summary.cosmos ?? null,
      JSON.stringify(summary)
    )
    this.deletePlayers.run(summary.gameId)
    const allies = summary.players.filter((player) => player.ally).length
    const seen = new Set<string>()
    for (const player of summary.players) {
      if (seen.has(player.puuid)) continue
      seen.add(player.puuid)
      this.insertPlayer.run(
        summary.gameId,
        player.puuid,
        player.riotId,
        player.championId,
        player.ally ? 1 : 0,
        player.me ? 1 : 0,
        player.premade ? 1 : 0,
        Math.round(player.score),
        summary.mvp === player.puuid ? 1 : 0,
        // nobody is the troll of a team of one
        allies > 1 && blamed?.puuid === player.puuid ? 1 : 0,
        (player.ally ? summary.win : !summary.win) ? 1 : 0,
        player.kills,
        player.deaths,
        player.assists,
        player.multikill ?? 0
      )
    }
  }

  get(gameId: number): GameSummary | null {
    const row = this.db.prepare('SELECT summary FROM games WHERE game_id = ?').get(gameId) as { summary: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.summary) as GameSummary
    } catch {
      return null
    }
  }

  /** Every saved summary, newest first. */
  all(): GameSummary[] {
    const rows = this.db.prepare('SELECT summary FROM games ORDER BY created_at DESC').all() as unknown as { summary: string }[]
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(row.summary) as GameSummary]
      } catch {
        return []
      }
    })
  }

  /** The history list, newest first. */
  list(): GameListEntry[] {
    const rows = this.db.prepare(`SELECT ${LIST_COLUMNS} FROM games ORDER BY created_at DESC`).all() as unknown as GameRow[]
    return rows.map((row) => ({
      gameId: row.game_id,
      createdAt: row.created_at,
      duration: row.duration,
      queueId: row.queue_id,
      mode: row.mode,
      win: row.win === 1,
      championId: row.champion_id,
      kda: [row.kills, row.deaths, row.assists],
      blamedPremade: row.blamed,
      cosmos: row.cosmos ?? row.game_id
    }))
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number }).n
  }

  /** Removes the made-up games of the admin tool (negative ids), returns how many there were. */
  deleteTestGames(): number {
    // game_players rows go with them (ON DELETE CASCADE)
    return Number(this.db.prepare('DELETE FROM games WHERE game_id < 0').run().changes)
  }

  /**
   * Win or loss per game for the given players in ARAM or ARAM: Mayhem, as gameId → won. Same
   * result as resultsFromSummaries (records.ts) over the whole history, without parsing it.
   */
  results(puuids: string[], mode: 'mayhem' | 'aram'): Map<string, Map<number, boolean>> {
    const results = new Map<string, Map<number, boolean>>()
    if (!puuids.length) return results
    const queues = QUEUE_IDS[mode]
    const rows = this.db
      .prepare(
        `SELECT p.puuid AS puuid, p.game_id AS game_id, p.win AS win
           FROM game_players p JOIN games g ON g.game_id = p.game_id
          WHERE p.puuid IN (${puuids.map(() => '?').join(', ')})
            AND (g.mode = ? OR g.queue_id IN (${queues.map(() => '?').join(', ')}))`
      )
      .all(...puuids, mode === 'mayhem' ? 'KIWI' : 'ARAM', ...queues) as unknown as { puuid: string; game_id: number; win: number }[]
    for (const row of rows) {
      const forPlayer = results.get(row.puuid) ?? new Map<number, boolean>()
      forPlayer.set(row.game_id, row.win === 1)
      results.set(row.puuid, forPlayer)
    }
    return results
  }

  /**
   * What your saved games say about each of these players: games with and against them (from your
   * side), and the last game you shared, with their champion and K/D/A. One query, a self-join on
   * your own row of each game. `me` is your puuid (null: any account that was you), players that are
   * you are skipped, and so is `excludeGameId` (the game that is loading right now).
   */
  encounters(me: string | null, puuids: string[], excludeGameId: number | null = null): Map<string, EncounterStats> {
    const result = new Map<string, EncounterStats>()
    const others = puuids.filter((puuid) => puuid && puuid !== me)
    if (!others.length) return result
    const rows = this.db
      .prepare(
        `SELECT o.puuid AS puuid, o.riot_id AS riot_id, o.game_id AS game_id, g.created_at AS created_at,
                o.champion_id AS champion_id, o.kills AS kills, o.deaths AS deaths, o.assists AS assists,
                o.ally AS ally, m.win AS my_win
           FROM game_players o
           JOIN game_players m ON m.game_id = o.game_id AND m.me = 1 AND m.puuid <> o.puuid ${me ? 'AND m.puuid = ?' : ''}
           JOIN games g ON g.game_id = o.game_id
          WHERE o.puuid IN (${others.map(() => '?').join(', ')}) AND o.me = 0 AND o.game_id <> ?
          ORDER BY g.created_at DESC, o.game_id DESC`
      )
      .all(...(me ? [me] : []), ...others, excludeGameId ?? 0) as unknown as {
      puuid: string
      riot_id: string
      game_id: number
      created_at: number
      champion_id: number
      kills: number
      deaths: number
      assists: number
      ally: number
      my_win: number
    }[]
    for (const row of rows) {
      let stats = result.get(row.puuid)
      if (!stats) {
        // rows come newest first, so the first one is the last time you met
        stats = {
          together: { games: 0, wins: 0 },
          against: { games: 0, wins: 0 },
          riotId: row.riot_id,
          last: {
            gameId: row.game_id,
            createdAt: row.created_at,
            championId: row.champion_id,
            kda: [row.kills, row.deaths, row.assists],
            ally: row.ally === 1,
            win: row.my_win === 1
          }
        }
        result.set(row.puuid, stats)
      }
      const side = row.ally === 1 ? stats.together : stats.against
      side.games++
      side.wins += row.my_win
    }
    return result
  }

  /** The players you shared the most saved games with (not you), most first. For the admin tool. */
  mostMet(limit: number): { puuid: string; riotId: string; championId: number; together: number; against: number }[] {
    return (
      this.db
        .prepare(
          `SELECT o.puuid AS puuid, MAX(o.riot_id) AS riot_id, MAX(o.champion_id) AS champion_id,
                  SUM(o.ally) AS together, SUM(1 - o.ally) AS against
             FROM game_players o JOIN game_players m ON m.game_id = o.game_id AND m.me = 1 AND m.puuid <> o.puuid
            WHERE o.me = 0
            GROUP BY o.puuid ORDER BY COUNT(*) DESC LIMIT ?`
        )
        .all(Math.max(1, Math.round(limit))) as unknown as {
        puuid: string
        riot_id: string
        champion_id: number
        together: number
        against: number
      }[]
    ).map((row) => ({ puuid: row.puuid, riotId: row.riot_id, championId: row.champion_id, together: row.together, against: row.against }))
  }

  /** Ids of the saved games you played with or against this player, newest first. */
  gamesWith(puuid: string): number[] {
    const rows = this.db
      .prepare(
        `SELECT o.game_id AS game_id FROM game_players o
           JOIN game_players m ON m.game_id = o.game_id AND m.me = 1 AND m.puuid <> o.puuid
           JOIN games g ON g.game_id = o.game_id
          WHERE o.puuid = ? AND o.me = 0
          ORDER BY g.created_at DESC`
      )
      .all(puuid) as unknown as { game_id: number }[]
    return rows.map((row) => row.game_id)
  }

  /**
   * How often you and your premades were MVP or troll of your team. A player counts in the games
   * they played in your premade group; random teammates never show up.
   */
  leaderboard(): LeaderboardEntry[] {
    const rows = this.db
      .prepare(
        `SELECT p.puuid AS puuid,
                MAX(p.me) AS me,
                COUNT(*) AS games,
                SUM(p.win) AS wins,
                SUM(p.mvp) AS mvps,
                SUM(p.troll) AS trolls,
                AVG(p.score) AS score,
                (SELECT l.riot_id FROM game_players l JOIN games g ON g.game_id = l.game_id
                  WHERE l.puuid = p.puuid ORDER BY g.created_at DESC LIMIT 1) AS riot_id,
                (SELECT c.champion_id FROM game_players c
                  WHERE c.puuid = p.puuid AND c.ally = 1 AND (c.me = 1 OR c.premade = 1)
                  GROUP BY c.champion_id ORDER BY COUNT(*) DESC, MAX(c.game_id) DESC LIMIT 1) AS champion_id
           FROM game_players p
          WHERE p.ally = 1 AND (p.me = 1 OR p.premade = 1)
          GROUP BY p.puuid
          ORDER BY mvps DESC, games DESC`
      )
      .all() as unknown as {
      puuid: string
      me: number
      games: number
      wins: number
      mvps: number
      trolls: number
      score: number
      riot_id: string
      champion_id: number
    }[]
    return rows.map((row) => ({
      puuid: row.puuid,
      riotId: row.riot_id,
      me: row.me === 1,
      championId: row.champion_id,
      games: row.games,
      wins: row.wins,
      mvps: row.mvps,
      trolls: row.trolls,
      avgScore: Math.round(row.score)
    }))
  }

  /**
   * One-time import of the old history (one <gameId>.json per game). Imported files move to an
   * `imported` subfolder, so a second run finds nothing and nothing is ever deleted.
   */
  async importLegacy(dir: string): Promise<number> {
    const files = (await readdir(dir).catch(() => [] as string[])).filter((file) => /^\d+\.json$/.test(file))
    let imported = 0
    for (const file of files) {
      try {
        const summary = JSON.parse(await readFile(join(dir, file), 'utf8')) as GameSummary
        if (typeof summary?.gameId !== 'number' || !Array.isArray(summary.players)) continue
        if (!this.get(summary.gameId)) this.save(summary)
        mkdirSync(join(dir, 'imported'), { recursive: true })
        await rename(join(dir, file), join(dir, 'imported', file))
        imported++
      } catch {
        // unreadable file: leave it where it is
      }
    }
    return imported
  }

  /** The underlying database, for the other stores that keep their tables in games.db. */
  get database(): DatabaseSync {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}
