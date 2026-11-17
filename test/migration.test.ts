import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { BASE_SCHEMA, DB_VERSION, GameStore, migrate } from '../src/main/games'
import { buildSummary, type GameSummary, type RawGame } from '../src/shared/summary'

/** A game as 1.1 saved it: no multikill or pentas in the summary. */
function oldSummary(gameId: number, kills: number[]): GameSummary {
  return {
    gameId,
    createdAt: gameId * 1000,
    duration: 1200,
    queueId: 2400,
    mode: 'KIWI',
    win: true,
    players: kills.map((killCount, i) => ({
      puuid: i === 0 ? 'me' : `p${i}`,
      riotId: `${i === 0 ? 'me' : `p${i}`}#EUW`,
      championId: 10 + i,
      ally: i < 2,
      me: i === 0,
      premade: i === 1,
      kills: killCount,
      deaths: i + 1,
      assists: 2 * i,
      damage: 1000,
      tanked: 1000,
      support: 0,
      gold: 0,
      level: 18,
      items: [],
      augments: [],
      score: 50
    })),
    curve: [],
    curveSource: 'none',
    kills: [],
    mvp: 'me',
    blame: 'p1',
    highlights: []
  }
}

/** Writes games the way 1.1 did (layout version 1, no per-player K/D/A columns). */
function legacyDb(games: GameSummary[], db = new DatabaseSync(':memory:')): DatabaseSync {
  db.exec(BASE_SCHEMA)
  const insertGame = db.prepare(
    `INSERT INTO games (game_id, created_at, duration, queue_id, mode, win, champion_id, kills, deaths, assists, blamed, cosmos, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertPlayer = db.prepare(
    `INSERT INTO game_players (game_id, puuid, riot_id, champion_id, ally, me, premade, score, mvp, troll, win)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const game of games) {
    insertGame.run(game.gameId, game.createdAt, game.duration, game.queueId, game.mode, 1, 10, 0, 0, 0, null, null, JSON.stringify(game))
    for (const p of game.players)
      insertPlayer.run(game.gameId, p.puuid, p.riotId, p.championId, p.ally ? 1 : 0, p.me ? 1 : 0, p.premade ? 1 : 0, 50, 0, 0, 1)
  }
  return db
}

const version = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
const tables = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as { name: string }[]).map(
    (row) => row.name
  )
const playerRows = (db: DatabaseSync) =>
  db.prepare('SELECT game_id, puuid, kills, deaths, assists, multikill FROM game_players ORDER BY game_id, puuid').all()

describe('database migration', () => {
  const games = [oldSummary(1, [5, 2, 7]), oldSummary(2, [11, 0, 3]), { ...oldSummary(3, [1, 1, 1]), players: [] }]

  it('takes a 1.1 database to the current version and fills the new columns from the summaries', () => {
    const db = legacyDb(games)
    expect(version(db)).toBe(0)
    expect(migrate(db)).toBe(DB_VERSION)
    expect(version(db)).toBe(DB_VERSION)
    expect(tables(db)).toEqual(expect.arrayContaining(['achievements', 'discord_posts', 'games', 'game_players']))
    const rows = playerRows(db) as unknown as { game_id: number; puuid: string; kills: number; deaths: number; assists: number }[]
    expect(rows.find((row) => row.game_id === 1 && row.puuid === 'p2')).toMatchObject({ kills: 7, deaths: 3, assists: 4, multikill: 0 })
    expect(rows.find((row) => row.game_id === 2 && row.puuid === 'me')).toMatchObject({ kills: 11, deaths: 1, assists: 0 })
    expect(rows).toHaveLength(6)
  })

  it('is idempotent: running it again, or again after the version was lost, changes nothing', () => {
    const db = legacyDb(games)
    migrate(db)
    const before = JSON.stringify(playerRows(db))
    expect(migrate(db)).toBe(DB_VERSION)
    db.exec('PRAGMA user_version = 1')
    expect(migrate(db)).toBe(DB_VERSION)
    expect(JSON.stringify(playerRows(db))).toBe(before)
  })

  it('migrates a 1.1 database file when the store opens it, and keeps working afterwards', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rc-migrate-')), 'games.db')
    legacyDb(games, new DatabaseSync(file)).close()
    const store = new GameStore(file)
    expect(store.count()).toBe(3)
    expect(store.get(2)?.players[0].kills).toBe(11)
    store.close()
    // second start: nothing to migrate
    const again = new GameStore(file)
    expect(again.list()).toHaveLength(3)
    expect(version(again.database)).toBe(DB_VERSION)
    again.close()
  })

  it('a new database starts at the current version, and saving fills K/D/A and multikill', () => {
    const store = new GameStore(':memory:')
    expect(version(store.database)).toBe(DB_VERSION)
    const game = oldSummary(9, [4, 2, 6])
    game.players[0].multikill = 5
    game.players[0].pentas = 1
    store.save(game)
    expect(playerRows(store.database)).toContainEqual({ game_id: 9, puuid: 'me', kills: 4, deaths: 1, assists: 0, multikill: 5 })
  })
})

describe('summary multikills', () => {
  it('reads largestMultiKill and pentaKills from the client stats', () => {
    const game: RawGame = {
      gameId: 1,
      gameCreation: 0,
      gameDuration: 900,
      queueId: 2400,
      gameMode: 'KIWI',
      participants: [
        { participantId: 1, championId: 1, teamId: 100, stats: { win: true, kills: 9, largestMultiKill: 5, pentaKills: 1 } },
        { participantId: 2, championId: 2, teamId: 200, stats: { win: false, kills: 1 } }
      ],
      participantIdentities: [
        { participantId: 1, player: { puuid: 'me', gameName: 'me', tagLine: 'EUW' } },
        { participantId: 2, player: { puuid: 'x', gameName: 'x', tagLine: 'EUW' } }
      ]
    }
    const summary = buildSummary(game, null, 'me', new Set())
    expect(summary.players[0]).toMatchObject({ multikill: 5, pentas: 1 })
    expect(summary.players[1]).toMatchObject({ multikill: 0, pentas: 0 })
  })
})

describe('migration v4 (clips)', () => {
  const tables = (db: DatabaseSync): string[] =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as { name: string }[]).map((row) => row.name)

  /** A database as 1.2 left it: layout version 3. */
  function v3Db(): DatabaseSync {
    const db = legacyDb([oldSummary(1, [3, 1, 0])])
    db.exec('ALTER TABLE game_players ADD COLUMN kills INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE game_players ADD COLUMN deaths INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE game_players ADD COLUMN assists INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE game_players ADD COLUMN multikill INTEGER NOT NULL DEFAULT 0')
    db.exec('CREATE TABLE achievements (id TEXT PRIMARY KEY, unlocked_at INTEGER NOT NULL, game_id INTEGER, seen INTEGER NOT NULL DEFAULT 0)')
    db.exec('CREATE TABLE discord_posts (game_id INTEGER PRIMARY KEY, posted_at INTEGER NOT NULL)')
    db.exec('CREATE TABLE flights (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, variant TEXT NOT NULL, galaxy INTEGER NOT NULL)')
    db.exec("INSERT INTO achievements (id, unlocked_at, game_id, seen) VALUES ('first', 5, 1, 1)")
    db.exec('PRAGMA user_version = 3')
    return db
  }

  it('adds recordings, clips and edits to a v3 database and keeps what is there', () => {
    const db = v3Db()
    expect(migrate(db)).toBe(4)
    expect(DB_VERSION).toBe(4)
    expect(tables(db)).toEqual(expect.arrayContaining(['recordings', 'clips', 'edits', 'games', 'achievements', 'flights']))
    expect((db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT seen FROM achievements').get() as { seen: number }).seen).toBe(1)
    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map((column) => column.name)
    expect(columns('recordings')).toEqual(['id', 'game_id', 'started_at', 'ended_at', 'dir', 'bytes', 'kept'])
    expect(columns('clips')).toEqual([
      'id',
      'game_id',
      'recording_id',
      'created_at',
      'start_ms',
      'end_ms',
      'file',
      'thumb',
      'kind',
      'title',
      'favorite',
      'bytes'
    ])
    expect(columns('edits')).toEqual(['clip_id', 'project_json', 'updated_at'])
  })

  it('is idempotent: a second run changes nothing and keeps the clips', () => {
    const db = v3Db()
    migrate(db)
    db.exec("INSERT INTO clips (game_id, created_at, start_ms, end_ms, file, kind) VALUES (1, 10, 0, 30000, 'a.mp4', 'manual')")
    expect(migrate(db)).toBe(4)
    // even when the version was reset, the tables are created with IF NOT EXISTS
    db.exec('PRAGMA user_version = 3')
    expect(migrate(db)).toBe(4)
    expect((db.prepare('SELECT COUNT(*) AS n FROM clips').get() as { n: number }).n).toBe(1)
    expect((db.prepare('SELECT title, favorite, bytes FROM clips').get() as Record<string, unknown>)).toEqual({ title: '', favorite: 0, bytes: 0 })
  })
})
