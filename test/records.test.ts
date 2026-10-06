import { describe, expect, it } from 'vitest'
import { mergeResults, resultsFromSummaries } from '../src/main/records'
import type { GameSummary, SummaryPlayer } from '../src/shared/summary'

const player = (puuid: string, ally: boolean): SummaryPlayer => ({
  puuid,
  riotId: puuid,
  championId: 1,
  ally,
  me: puuid === 'me',
  premade: false,
  kills: 0,
  deaths: 0,
  assists: 0,
  damage: 0,
  tanked: 0,
  support: 0,
  gold: 0,
  level: 18,
  items: [],
  augments: [],
  score: 50
})
const game = (gameId: number, win: boolean, mode = 'KIWI'): GameSummary => ({
  gameId,
  createdAt: gameId,
  duration: 1200,
  queueId: mode === 'KIWI' ? 2400 : 450,
  mode,
  win,
  curve: [],
  curveSource: 'none',
  kills: [],
  highlights: [],
  mvp: null,
  blame: null,
  players: [player('me', true), player('mate', true), player('enemy', false)]
})

describe('loading-screen records', () => {
  it('counts premades from our saved games, from their side of the result', () => {
    const results = resultsFromSummaries([game(1, true), game(2, false), game(3, true), game(4, true, 'ARAM')], ['mate', 'enemy'], 'mayhem')
    expect(mergeResults(results.get('mate'))).toEqual({ games: 3, wins: 2 })
    expect(mergeResults(results.get('enemy'))).toEqual({ games: 3, wins: 1 }) // they won when we lost
  })

  it('merges sources without counting a game twice', () => {
    const saved = new Map([
      [1, true],
      [2, false]
    ])
    const client = new Map([
      [2, false],
      [3, true]
    ])
    const riot = new Map([
      [3, true],
      [4, false]
    ])
    expect(mergeResults(saved, client, riot, null)).toEqual({ games: 4, wins: 2 })
  })
})
