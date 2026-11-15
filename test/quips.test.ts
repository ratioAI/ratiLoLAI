import { describe, expect, it } from 'vitest'
import { MAX_QUIP, quips, ratioApproved } from '../src/shared/quips'
import type { GameSummary, SummaryPlayer } from '../src/shared/summary'

const pl = (id: string, ally: boolean, k: number, d: number, a: number, dmg: number, score: number): SummaryPlayer => ({
  puuid: id,
  riotId: `${id}#EUW`,
  championId: 1,
  ally,
  me: id === 'a1',
  premade: false,
  kills: k,
  deaths: d,
  assists: a,
  damage: dmg,
  tanked: 30000,
  support: 1000,
  gold: 0,
  level: 18,
  items: [],
  augments: [],
  score
})

const game = (win: boolean): GameSummary => ({
  gameId: 42,
  createdAt: 0,
  duration: 1800,
  queueId: 2400,
  mode: 'KIWI',
  win,
  curve: [],
  curveSource: 'none',
  kills: [],
  highlights: [],
  mvp: 'a5',
  blame: 'a3',
  players: [
    pl('a1', true, 27, 19, 48, 57000, 47),
    pl('a2', true, 23, 30, 45, 72000, 44),
    pl('a3', true, 16, 30, 47, 41000, 40),
    pl('a4', true, 21, 27, 55, 64000, 45),
    pl('a5', true, 48, 18, 59, 184000, 70),
    pl('e1', false, 10, 24, 42, 164000, 47),
    pl('e2', false, 39, 32, 32, 219000, 52),
    pl('e3', false, 2, 17, 35, 74000, 42),
    pl('e4', false, 41, 32, 31, 149000, 48),
    pl('e5', false, 32, 31, 19, 155000, 45)
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

describe('player quips – traits', () => {
  // the case from a real game: lots of kills, little damage compared to the team, only S-tier augments
  const g = game(true)
  g.players[0] = pl('a1', true, 20, 16, 26, 57900, 51)
  g.players[1] = pl('a2', true, 18, 14, 40, 184000, 62)
  g.players[2] = pl('a3', true, 9, 22, 30, 120000, 38)
  g.players[3] = pl('a4', true, 6, 15, 35, 95000, 47)
  g.players[4] = pl('a5', true, 12, 13, 33, 140000, 55)
  g.mvp = 'a2'

  it('never calls a 20-kill game unremarkable and names the S-tier augments', () => {
    const q = quips(g, { a1: ['S', 'S', 'S+', 'S'] })
    expect(q.a1).not.toMatch(/Unauffällig|Statist|Durchschnitt/)
    expect(q.a1).toMatch(/20 Kills|Kills/)
    expect(q.a1).toMatch(/ratioAI/)
  })

  it('flags bad augment picks and recognises ratioAI-approved picks', () => {
    expect(ratioApproved(['S', 'S+', 'S'])).toBe(true)
    expect(ratioApproved(['S', 'A'])).toBe(false)
    expect(ratioApproved(['S'])).toBe(false)
    expect(ratioApproved(['S', undefined])).toBe(false)
    const q = quips(g, { a4: ['D', 'B', 'A'] })
    expect(q.a4).toMatch(/Augment/)
  })
})

describe('player quips – variety and length', () => {
  // a small deterministic PRNG so the random games are the same on every run
  let seed = 7
  const rnd = (max: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed % max
  }
  const tiers = ['S+', 'S', 'A', 'B', 'C', 'D'] as const
  const randomGame = (id: number): GameSummary => {
    const g = game(rnd(2) === 0)
    g.gameId = id
    g.players = g.players.map((player) => ({
      ...pl(player.puuid, player.ally, rnd(50), rnd(32), rnd(60), 5000 + rnd(220000), 20 + rnd(60)),
      puuid: `${player.puuid}-${id}`,
      tanked: rnd(150000),
      support: rnd(40000)
    }))
    return g
  }

  it('keeps every line short and never repeats a line within one game', () => {
    const seen = new Set<string>()
    for (let id = 0; id < 400; id++) {
      const g = randomGame(id)
      const augTiers = Object.fromEntries(g.players.map((player) => [player.puuid, [0, 1, 2].map(() => tiers[rnd(6)])]))
      const lines = Object.values(quips(g, augTiers))
      expect(new Set(lines).size).toBe(lines.length)
      for (const line of lines) {
        expect(line.length, line).toBeLessThanOrEqual(MAX_QUIP)
        expect(line).not.toMatch(/undefined|NaN/)
        seen.add(line)
      }
    }
    // plenty of different lines across many games
    expect(seen.size).toBeGreaterThan(150)
  })
})
