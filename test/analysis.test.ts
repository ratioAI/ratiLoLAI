import { describe, expect, it } from 'vitest'
import { buildChampionView, buildTierList, parseRuneKey, smoothedWinRate, tierForPercentile, toOptions } from '../src/shared/analysis'
import { emptyPatchStats, emptyRoleStats } from '../src/main/crawler/aggregator'
import type { PatchStats, Role } from '../src/shared/types'

function statsWith(entries: [number, Role, number, number][], matches = 1000): PatchStats {
  const s = emptyPatchStats('15.19')
  s.matches = matches
  for (const [id, role, g, w] of entries) s.champions[`${id}:${role}`] = { ...emptyRoleStats(id, role), g, w }
  return s
}

describe('smoothedWinRate', () => {
  it('pulls small samples towards 50%', () => {
    expect(smoothedWinRate(3, 3)).toBeCloseTo(18 / 33)
    expect(smoothedWinRate(600, 1000)).toBeCloseTo(615 / 1030)
  })
})

describe('tierForPercentile', () => {
  it('maps percentiles to tiers', () => {
    expect(tierForPercentile(0.01)).toBe('S+')
    expect(tierForPercentile(0.1)).toBe('S')
    expect(tierForPercentile(0.3)).toBe('A')
    expect(tierForPercentile(0.5)).toBe('B')
    expect(tierForPercentile(0.8)).toBe('C')
    expect(tierForPercentile(0.99)).toBe('D')
  })
})

describe('buildTierList', () => {
  it('ranks champions per role and skips small samples', () => {
    const stats = statsWith([
      [1, 'TOP', 400, 230],
      [2, 'TOP', 400, 190],
      [3, 'TOP', 5, 5], // below minGames
      [4, 'MIDDLE', 300, 150]
    ])
    const list = buildTierList(stats, 20)
    const top = list.filter((e) => e.role === 'TOP')
    expect(top.map((e) => e.championId)).toEqual([1, 2])
    expect(top[0].rank).toBe(1)
    expect(top[0].winRate).toBeCloseTo(0.575)
    expect(list.find((e) => e.championId === 3)).toBeUndefined()
    expect(list.find((e) => e.championId === 4)?.pickRate).toBeCloseTo(0.3)
  })

  it('hides off-roles below the minimum role share', () => {
    const stats = statsWith([
      [1, 'TOP', 1000, 500],
      [1, 'MIDDLE', 50, 25]
    ])
    expect(buildTierList(stats, 20).map((e) => e.role)).toEqual(['TOP'])
  })

  it('returns nothing without matches', () => {
    expect(buildTierList(emptyPatchStats('15.19'), 1)).toEqual([])
  })
})

describe('toOptions', () => {
  it('sorts by popularity and computes rates', () => {
    const opts = toOptions({ a: { g: 10, w: 5 }, b: { g: 30, w: 20 } }, 40, (k) => k)
    expect(opts[0]).toMatchObject({ value: 'b', g: 30, pickRate: 0.75 })
    expect(opts[0].winRate).toBeCloseTo(2 / 3)
  })
})

describe('parseRuneKey', () => {
  it('parses the serialised rune page', () => {
    expect(parseRuneKey('8000|8010,9111,9104,8299|8400|8444,8242|5008,5008,5011')).toEqual({
      primaryStyle: 8000,
      subStyle: 8400,
      primary: [8010, 9111, 9104, 8299],
      secondary: [8444, 8242],
      shards: [5008, 5008, 5011]
    })
  })
})

describe('buildChampionView', () => {
  it('defaults to the most played role and exposes alternatives', () => {
    const stats = statsWith([
      [1, 'TOP', 800, 420],
      [1, 'JUNGLE', 200, 90]
    ])
    stats.champions['1:TOP'].matchups = { '7': { g: 40, w: 10 }, '8': { g: 40, w: 30 } }
    const view = buildChampionView(stats, 1, undefined, buildTierList(stats, 20))!
    expect(view.role).toBe('TOP')
    expect(view.availableRoles.map((r) => r.role)).toEqual(['TOP', 'JUNGLE'])
    expect(view.counters[0].championId).toBe(7)
    expect(view.goodAgainst[0].championId).toBe(8)
    expect(buildChampionView(stats, 1, 'JUNGLE', [])!.role).toBe('JUNGLE')
  })

  it('returns null for unknown champions', () => {
    expect(buildChampionView(statsWith([]), 99, undefined, [])).toBeNull()
  })
})

describe('ARAM tier list', () => {
  it('ranks by win rate only and uses the ARAM role', () => {
    const s = emptyPatchStats('15.19', 'aram')
    s.matches = 1000
    s.champions['1:ARAM'] = { ...emptyRoleStats(1, 'ARAM'), g: 100, w: 60 }
    s.champions['2:ARAM'] = { ...emptyRoleStats(2, 'ARAM'), g: 900, w: 459 }
    const list = buildTierList(s, 20)
    expect(list.map((e) => [e.championId, e.role])).toEqual([
      [1, 'ARAM'],
      [2, 'ARAM']
    ])
    expect(buildChampionView(s, 2, undefined, list)).toMatchObject({ role: 'ARAM', mode: 'aram' })
  })
})
