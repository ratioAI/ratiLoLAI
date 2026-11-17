import { describe, expect, it } from 'vitest'
import { GameStore } from '../src/main/games'
import {
  MAX_ENCOUNTER_LINE,
  classifyEncounter,
  encounterLine,
  encounterStatsFromSummaries,
  encounterTargets,
  toEncounter,
  type Encounter,
  type EncounterKind,
  type EncounterStats
} from '../src/shared/encounters'
import type { GameSummary, SummaryPlayer } from '../src/shared/summary'

const wc = (games: number, wins: number) => ({ games, wins })

describe('classifyEncounter', () => {
  const cases: [string, [number, number], [number, number], EncounterKind | null][] = [
    ['never met', [0, 0], [0, 0], null],
    ['one game together', [1, 0], [0, 0], 'familiar'],
    ['one game against', [0, 0], [1, 1], 'familiar'],
    // nemesis: ≥ 3 against, ≤ 33 %
    ['3 against, 0 won', [0, 0], [3, 0], 'nemesis'],
    ['3 against, 1 won (33 %)', [0, 0], [3, 1], 'nemesis'],
    ['6 against, 2 won (33 %)', [0, 0], [6, 2], 'nemesis'],
    ['4 against, 2 won (50 %) → rival', [0, 0], [4, 2], 'rival'],
    ['2 against, 0 won: too few for nemesis', [0, 0], [2, 0], 'rival'],
    // victim: ≥ 3 against, ≥ 67 %
    ['3 against, 2 won (67 %)', [0, 0], [3, 2], 'victim'],
    ['3 against, 3 won', [0, 0], [3, 3], 'victim'],
    ['8 against, 5 won (62.5 %) → rival', [0, 0], [8, 5], 'rival'],
    // lucky charm: ≥ 3 together, ≥ 75 %
    ['4 together, 3 won (75 %)', [4, 3], [0, 0], 'luckyCharm'],
    ['3 together, 3 won', [3, 3], [0, 0], 'luckyCharm'],
    ['3 together, 2 won (67 %) → familiar', [3, 2], [0, 0], 'familiar'],
    ['2 together, 2 won: too few', [2, 2], [0, 0], 'familiar'],
    // jinx: ≥ 3 together, ≤ 25 %
    ['4 together, 1 won (25 %)', [4, 1], [0, 0], 'jinx'],
    ['3 together, 0 won', [3, 0], [0, 0], 'jinx'],
    ['3 together, 1 won (33 %) → familiar', [3, 1], [0, 0], 'familiar'],
    // the order: nemesis/victim before lucky charm/jinx before rival
    ['nemesis and lucky charm', [4, 4], [3, 0], 'nemesis'],
    ['lucky charm and 2 against', [4, 4], [2, 1], 'luckyCharm'],
    ['jinx and 2 against', [3, 0], [2, 2], 'jinx']
  ]
  it.each(cases)('%s', (_name, together, against, kind) => {
    expect(classifyEncounter(wc(...together), wc(...against))).toBe(kind)
  })
})

const stats = (together: [number, number], against: [number, number], riotId = 'Old#EUW'): EncounterStats => ({
  together: wc(...together),
  against: wc(...against),
  riotId,
  last: { gameId: 42, createdAt: Date.UTC(2026, 10, 1), championId: 157, kda: [2, 14, 3], ally: false, win: false }
})

describe('toEncounter', () => {
  it('notes the old Riot ID only when the name changed', () => {
    expect(toEncounter(stats([0, 0], [3, 0]), 'New#EUW')?.formerRiotId).toBe('Old#EUW')
    expect(toEncounter(stats([0, 0], [3, 0]), 'old#euw')?.formerRiotId).toBeUndefined()
    expect(toEncounter(stats([0, 0], [3, 0]), '')?.formerRiotId).toBeUndefined()
    expect(toEncounter(null)).toBeNull()
    expect(toEncounter(stats([0, 0], [0, 0]))).toBeNull()
  })
})

describe('encounterLine', () => {
  const now = Date.UTC(2026, 10, 13)
  const all: Encounter[] = [
    toEncounter(stats([0, 0], [3, 0]))!,
    toEncounter(stats([0, 0], [5, 4]))!,
    toEncounter(stats([4, 4], [0, 0]))!,
    toEncounter(stats([4, 0], [0, 0]))!,
    toEncounter(stats([0, 0], [2, 1]))!,
    toEncounter(stats([1, 0], [0, 0]), 'Someone#EUW')!
  ]
  it('covers every kind', () => {
    expect(new Set(all.map((e) => e.kind)).size).toBe(6)
  })
  it(`stays within ${MAX_ENCOUNTER_LINE} characters, even with long champion names`, () => {
    for (const e of all)
      for (const gameId of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const line = encounterLine({ ...e, last: { ...e.last, gameId, kda: [22, 19, 41] } }, { champName: () => 'Nunu & Willump', now })
        expect(line.length).toBeLessThanOrEqual(MAX_ENCOUNTER_LINE)
      }
  })
  it('is deterministic and uses the numbers', () => {
    const nemesis = all[0]
    expect(encounterLine(nemesis, { now })).toBe(encounterLine(nemesis, { now }))
    expect(encounterLine(nemesis, { now })).toMatch(/3–0/)
    const familiar = all[5]
    const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((gameId) =>
      encounterLine({ ...familiar, last: { ...familiar.last, gameId } }, { champName: () => 'Yasuo', now })
    )
    expect(lines).toContain('Last time: 2/14/3 Yasuo, 12 days ago')
  })
})

// --- the database query ------------------------------------------------------------------------

const p = (puuid: string, ally: boolean, over: Partial<SummaryPlayer> = {}): SummaryPlayer => ({
  puuid,
  riotId: `${puuid}#EUW`,
  championId: 1,
  ally,
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
  score: 50,
  ...over
})

const game = (gameId: number, win: boolean, players: SummaryPlayer[]): GameSummary => ({
  gameId,
  createdAt: gameId * 86_400_000,
  duration: 1200,
  queueId: 2400,
  mode: 'KIWI',
  win,
  players,
  curve: [],
  curveSource: 'none',
  kills: [],
  mvp: 'me',
  blame: null,
  highlights: []
})

// "bully" beat us 2 of 3 times (and again in the loading game); "buddy" won 3 of 4 with us; "mate" is a premade
const fixtures: GameSummary[] = [
  game(1, false, [p('me', true), p('mate', true, { premade: true }), p('buddy', true), p('bully', false, { championId: 7 })]),
  game(2, true, [p('me', true), p('buddy', true), p('bully', true)]),
  game(3, false, [p('me', true), p('mate', true, { premade: true }), p('bully', false, { kills: 14, deaths: 2, assists: 6 })]),
  game(4, true, [p('me', true), p('buddy', true), p('bully', false, { riotId: 'bully2#EUW' })]),
  game(5, true, [p('me', true), p('buddy', true, { championId: 99, kills: 9, deaths: 1, assists: 20 })]),
  // the game that is loading right now must not count
  game(6, false, [p('me', true), p('bully', false), p('buddy', true)])
]

describe('GameStore.encounters', () => {
  const store = new GameStore(':memory:')
  fixtures.forEach((summary) => store.save(summary))

  it('counts games with and against each player from your side, and keeps the last game', () => {
    const met = store.encounters('me', ['bully', 'buddy', 'nobody'], 6)
    expect(met.get('bully')).toEqual({
      together: { games: 1, wins: 1 },
      against: { games: 3, wins: 1 },
      riotId: 'bully2#EUW',
      last: { gameId: 4, createdAt: 4 * 86_400_000, championId: 1, kda: [1, 2, 3], ally: false, win: true }
    })
    expect(met.get('buddy')).toMatchObject({ together: { games: 4, wins: 3 }, against: { games: 0, wins: 0 } })
    expect(met.get('buddy')?.last).toMatchObject({ gameId: 5, championId: 99, kda: [9, 1, 20], ally: true, win: true })
    expect(met.has('nobody')).toBe(false)
    expect(toEncounter(met.get('buddy'))?.kind).toBe('luckyCharm')
    expect(toEncounter(met.get('bully'), 'bully#EUW')).toMatchObject({ kind: 'nemesis', formerRiotId: 'bully2#EUW' })
  })

  it('leaves out the current game, and never returns you', () => {
    expect(store.encounters('me', ['bully'], null).get('bully')?.against.games).toBe(4)
    expect(store.encounters('me', ['me', 'bully'], 6).has('me')).toBe(false)
    expect(store.encounters(null, ['me']).size).toBe(0)
  })

  it('gives the same numbers as the summaries do', () => {
    const puuids = ['bully', 'buddy', 'mate']
    for (const exclude of [null, 6, 3]) {
      const fromDb = store.encounters('me', puuids, exclude)
      const fromSummaries = encounterStatsFromSummaries(fixtures, 'me', puuids, exclude)
      expect(Object.fromEntries(fromDb)).toEqual(Object.fromEntries(fromSummaries))
    }
  })

  it('lists the shared games newest first', () => {
    expect(store.gamesWith('bully')).toEqual([6, 4, 3, 2, 1])
    expect(store.gamesWith('me')).toEqual([])
  })
})

describe('encounterTargets', () => {
  it('skips you and your premades', () => {
    expect(
      encounterTargets([
        { puuid: 'me', me: true, premade: false },
        { puuid: 'mate', me: false, premade: true },
        { puuid: 'x', me: false, premade: false },
        { puuid: '', me: false, premade: false }
      ])
    ).toEqual(['x'])
  })
})
