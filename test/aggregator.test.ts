import { describe, expect, it } from 'vitest'
import { aggregateMatch, emptyPatchStats, patchOf, replayParticipant, runeKey, skillMaxOrder } from '../src/main/crawler/aggregator'
import { classify, match, participant, standardTimeline } from './fixtures'

describe('patchOf', () => {
  it('reduces a game version to major.minor', () => {
    expect(patchOf('15.19.712.1234')).toBe('15.19')
  })
})

describe('skillMaxOrder', () => {
  it('orders abilities by the level at which they reach rank 5', () => {
    expect(skillMaxOrder('QWEQQRQEQERWWWW')).toBe('QWE')
    expect(skillMaxOrder('QEWQQRQEQERWEEW')).toBe('QEW')
  })
  it('returns null for very short games', () => {
    expect(skillMaxOrder('QWEQ')).toBeNull()
  })
  it('falls back to point count when nothing is maxed yet', () => {
    expect(skillMaxOrder('QWEEEQRQE')).toBe('EQW')
  })
})

describe('replayParticipant', () => {
  const r = replayParticipant(standardTimeline().info.frames[0].events, 1, classify)
  it('collects starter items without trinkets', () => {
    expect(r.starters).toEqual([1055, 2003])
  })
  it('respects ITEM_UNDO and keeps purchase order', () => {
    expect(r.completed).toEqual([6672, 3031, 6673])
  })
  it('detects the first tier-2 boots', () => {
    expect(r.boots).toBe(3006)
  })
  it('records the skill order', () => {
    expect(r.skills).toBe('QWEQQRQEQERWWWW')
  })
})

describe('runeKey', () => {
  it('serialises the full rune page', () => {
    expect(runeKey(participant(0))).toBe('8000|8010,9111,9104,8299|8400|8444,8242|5008,5008,5011')
  })
})

describe('aggregateMatch', () => {
  it('aggregates all participants of a valid match', () => {
    const stats = emptyPatchStats('15.19')
    expect(aggregateMatch(stats, match(), standardTimeline(), classify)).toBe(true)
    expect(stats.matches).toBe(1)
    expect(Object.keys(stats.champions)).toHaveLength(10)
    const top = stats.champions['100:TOP']
    expect(top).toMatchObject({ g: 1, w: 1 })
    expect(top.core['6672,3031,6673']).toEqual({ g: 1, w: 1 })
    expect(top.starters['1055,2003']).toEqual({ g: 1, w: 1 })
    expect(top.boots['3006']).toEqual({ g: 1, w: 1 })
    expect(top.skillMax['QWE']).toEqual({ g: 1, w: 1 })
    expect(top.spells['4,14']).toEqual({ g: 1, w: 1 })
    // lane opponent = enemy TOP (participant index 5 -> champion 105)
    expect(top.matchups['105']).toEqual({ g: 1, w: 1 })
    expect(stats.champions['105:TOP'].matchups['100']).toEqual({ g: 1, w: 0 })
  })

  it('counts bans and ignores empty ban slots', () => {
    const stats = emptyPatchStats('15.19')
    aggregateMatch(stats, match(), null, classify)
    expect(stats.bans).toEqual({ 1: 1, 2: 1 })
  })

  it('rejects matches from another patch', () => {
    const stats = emptyPatchStats('15.18')
    expect(aggregateMatch(stats, match(), null, classify)).toBe(false)
    expect(stats.matches).toBe(0)
  })

  it('rejects remakes', () => {
    const stats = emptyPatchStats('15.19')
    expect(aggregateMatch(stats, match({ gameDuration: 200 }), null, classify)).toBe(false)
  })

  it('rejects matches with missing positions', () => {
    const stats = emptyPatchStats('15.19')
    const parts = Array.from({ length: 10 }, (_, i) => participant(i, i === 3 ? { teamPosition: '' } : {}))
    expect(aggregateMatch(stats, match({ participants: parts }), null, classify)).toBe(false)
  })

  it('works without a timeline (no item data)', () => {
    const stats = emptyPatchStats('15.19')
    aggregateMatch(stats, match(), null, classify)
    expect(stats.champions['100:TOP'].core).toEqual({})
    expect(stats.champions['100:TOP'].runes).not.toEqual({})
  })
})
