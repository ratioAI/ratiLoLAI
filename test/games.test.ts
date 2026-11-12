import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GameStore } from '../src/main/games'
import { resultsFromSummaries } from '../src/main/records'
import { leaderboardFromSummaries, podium } from '../src/shared/leaderboard'
import type { GameSummary, SummaryPlayer } from '../src/shared/summary'

const player = (puuid: string, score: number, over: Partial<SummaryPlayer> = {}): SummaryPlayer => ({
  puuid,
  riotId: `${puuid}#EUW`,
  championId: 1,
  ally: true,
  me: puuid === 'me',
  premade: false,
  kills: 1,
  deaths: 2,
  assists: 3,
  damage: 0,
  tanked: 0,
  support: 0,
  gold: 0,
  level: 18,
  items: [],
  augments: [],
  score,
  ...over
})

/** `scores` are [me, mate, random]; the best is MVP, the worst the troll. */
const game = (gameId: number, win: boolean, scores: [number, number, number], over: Partial<GameSummary> = {}): GameSummary => {
  const players = [
    player('me', scores[0], { championId: 10 }),
    player('mate', scores[1], { premade: true, championId: 20 }),
    player('random', scores[2]),
    player('enemy', 50, { ally: false })
  ]
  const allies = players.filter((p) => p.ally).sort((a, b) => b.score - a.score)
  return {
    gameId,
    createdAt: gameId * 1000,
    duration: 1200,
    queueId: 2400,
    mode: 'KIWI',
    win,
    players,
    curve: [],
    curveSource: 'none',
    kills: [],
    mvp: allies[0].puuid,
    blame: allies[allies.length - 1].puuid,
    highlights: [],
    ...over
  }
}

describe('GameStore', () => {
  it('keeps every game and lists the newest first', () => {
    const store = new GameStore(':memory:')
    for (let id = 1; id <= 150; id++) store.save(game(id, id % 2 === 0, [50, 60, 40]))
    expect(store.count()).toBe(150)
    const list = store.list()
    expect(list[0].gameId).toBe(150)
    expect(list[0]).toMatchObject({ win: true, championId: 10, kda: [1, 2, 3], blamedPremade: 'random#EUW', mode: 'KIWI' })
    expect(store.get(7)?.players).toHaveLength(4)
    expect(store.get(999)).toBeNull()
    expect(store.all()).toHaveLength(150)
  })

  it('saving a game twice replaces it and keeps the place it was played in', () => {
    const store = new GameStore(':memory:')
    store.save(game(1, false, [50, 60, 40], { cosmos: 111 }))
    store.save(game(1, true, [50, 60, 40], { cosmos: 222 }))
    expect(store.count()).toBe(1)
    expect(store.list()[0]).toMatchObject({ win: true, cosmos: 111 })
    expect(store.leaderboard().find((row) => row.me)?.games).toBe(1)
  })

  it('falls back to the game id as place for games without one', () => {
    const store = new GameStore(':memory:')
    store.save(game(42, true, [50, 60, 40]))
    expect(store.list()[0].cosmos).toBe(42)
  })

  it('counts MVP and troll games for me and my premades only', () => {
    const store = new GameStore(':memory:')
    store.save(game(1, true, [80, 60, 40])) // me MVP, random troll
    store.save(game(2, false, [30, 90, 50])) // mate MVP, me troll
    store.save(game(3, true, [55, 20, 70])) // random MVP, mate troll
    store.save(game(4, true, [45, 95, 50])) // mate MVP, me troll
    const board = store.leaderboard()
    expect(board.map((row) => row.puuid)).toEqual(['mate', 'me'])
    expect(board[0]).toMatchObject({ riotId: 'mate#EUW', me: false, championId: 20, games: 4, wins: 3, mvps: 2, trolls: 1 })
    expect(board[1]).toMatchObject({ me: true, games: 4, mvps: 1, trolls: 2, avgScore: 53 })
  })

  it('agrees with the leaderboard computed from plain summaries, and ranks the podiums', () => {
    const store = new GameStore(':memory:')
    const scores: [number, number, number][] = [
      [80, 60, 40],
      [30, 90, 50],
      [55, 20, 70],
      [45, 95, 50],
      [70, 10, 60],
      [20, 60, 90]
    ]
    scores.forEach((score, i) => store.save(game(i + 1, i % 2 === 0, score)))
    const byPuuid = (a: { puuid: string }, b: { puuid: string }) => a.puuid.localeCompare(b.puuid)
    expect([...store.leaderboard()].sort(byPuuid)).toEqual(leaderboardFromSummaries(store.all()).sort(byPuuid))
    const board = store.leaderboard()
    // me: 2 MVP, 3 troll · mate: 2 MVP, 2 troll. Equal MVP counts and rates, so there the name decides
    expect(podium(board, 'mvp').map((row) => [row.puuid, row.mvps])).toEqual([
      ['mate', 2],
      ['me', 2]
    ])
    expect(podium(board, 'troll').map((row) => row.puuid)).toEqual(['me', 'mate'])
    // players who never were one are not on the podium
    const solo = new GameStore(':memory:')
    solo.save(game(1, true, [99, 50, 40]))
    expect(podium(solo.leaderboard(), 'mvp').map((row) => row.puuid)).toEqual(['me'])
    expect(podium(solo.leaderboard(), 'troll')).toEqual([])
  })

  it('gives the same per-player results as going through every summary', () => {
    const store = new GameStore(':memory:')
    store.save(game(1, true, [50, 60, 40]))
    store.save(game(2, false, [50, 60, 40]))
    store.save(game(3, true, [50, 60, 40], { mode: 'ARAM', queueId: 450 }))
    store.save(game(4, false, [50, 60, 40], { mode: 'CLASSIC', queueId: 420 }))
    for (const mode of ['mayhem', 'aram'] as const) {
      expect(store.results(['mate', 'enemy', 'nobody'], mode)).toEqual(resultsFromSummaries(store.all(), ['mate', 'enemy', 'nobody'], mode))
    }
    expect(store.results(['enemy'], 'mayhem').get('enemy')).toEqual(
      new Map([
        [1, false],
        [2, true]
      ])
    )
    expect(store.results([], 'aram').size).toBe(0)
  })

  it('only counts a player in the games they were premade', () => {
    const store = new GameStore(':memory:')
    store.save(game(1, true, [50, 90, 40]))
    const solo = game(2, true, [50, 90, 40])
    solo.players[1].premade = false // same player, met as a random this time
    store.save(solo)
    expect(store.leaderboard().find((row) => row.puuid === 'mate')).toMatchObject({ games: 1, mvps: 1 })
  })

  it('imports the old JSON history once and keeps the files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'games-'))
    writeFileSync(join(dir, '5.json'), JSON.stringify(game(5, true, [50, 60, 40])))
    writeFileSync(join(dir, '6.json'), JSON.stringify(game(6, false, [50, 60, 40])))
    writeFileSync(join(dir, '7.json'), '{ broken')
    const store = new GameStore(join(dir, 'games.db'))
    expect(await store.importLegacy(dir)).toBe(2)
    expect(store.list().map((entry) => entry.gameId)).toEqual([6, 5])
    expect(readdirSync(join(dir, 'imported')).sort()).toEqual(['5.json', '6.json'])
    expect(await store.importLegacy(dir)).toBe(0)
    store.close()
    // the data survives a restart
    const reopened = new GameStore(join(dir, 'games.db'))
    expect(reopened.count()).toBe(2)
    reopened.close()
  })
})
