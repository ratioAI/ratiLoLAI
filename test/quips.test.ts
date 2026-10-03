import { describe, expect, it } from 'vitest'
import { quips } from '../src/shared/quips'
import type { GameSummary, SummaryPlayer } from '../src/shared/summary'

const pl = (id: string, ally: boolean, k: number, d: number, a: number, dmg: number, score: number): SummaryPlayer => ({
  puuid: id, riotId: `${id}#EUW`, championId: 1, ally, me: id === 'a1', premade: false, kills: k, deaths: d, assists: a,
  damage: dmg, tanked: 30000, support: 1000, gold: 0, level: 18, items: [], augments: [], score
})

const game = (win: boolean): GameSummary => ({
  gameId: 42, createdAt: 0, duration: 1800, queueId: 2400, mode: 'KIWI', win, curve: [], curveSource: 'none', kills: [], highlights: [],
  mvp: 'a5', blame: 'a3',
  players: [
    pl('a1', true, 27, 19, 48, 57000, 47), pl('a2', true, 23, 30, 45, 72000, 44), pl('a3', true, 16, 30, 47, 41000, 40),
    pl('a4', true, 21, 27, 55, 64000, 45), pl('a5', true, 48, 18, 59, 184000, 70),
    pl('e1', false, 10, 24, 42, 164000, 47), pl('e2', false, 39, 32, 32, 219000, 52), pl('e3', false, 2, 17, 35, 74000, 42),
    pl('e4', false, 41, 32, 31, 149000, 48), pl('e5', false, 32, 31, 19, 155000, 45)
  ]
})

describe('player quips', () => {
  it('gives every player a line, deterministic, MVP and troll get theirs – in wins too', () => {
    const q = quips(game(true))
    expect(Object.keys(q)).toHaveLength(10)
    expect(quips(game(true))).toEqual(q)
    expect(q.a5).not.toEqual(quips(game(false)).a5) // MVP line depends on the result
    expect(q.a3.length).toBeGreaterThan(10) // the troll of a won game is named too
    for (const line of Object.values(q)) expect(line).not.toMatch(/undefined|NaN/)
  })
})
