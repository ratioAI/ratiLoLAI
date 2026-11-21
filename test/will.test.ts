import { describe, expect, it } from 'vitest'
import { buildSummary, type RawGame, type RawTimeline } from '../src/shared/summary'
import { bandOf, expectedKillShare, ramp, willToWin, WILL_BANDS } from '../src/shared/will'

type Stats = Record<string, unknown>

/**
 * A 15-minute ARAM: Mayhem game, you are participant 1 on team 100. Default stat lines give both
 * teams a kill participation of exactly 0.66 (the calibrated typical value): 20 kills, 46 assists.
 */
function makeGame(options: { ally?: Stats[]; enemy?: Stats[]; all?: Stats; allyWins?: boolean; duration?: number } = {}): RawGame {
  const line = (i: number): Stats => ({ kills: 4, deaths: 4, assists: i === 4 ? 10 : 9, totalDamageDealtToChampions: 15000 })
  const allyWins = options.allyWins ?? true
  return {
    gameId: 42,
    gameCreation: 0,
    gameDuration: options.duration ?? 900,
    queueId: 2400,
    gameMode: 'KIWI',
    participants: Array.from({ length: 10 }, (_, i) => {
      const ally = i < 5
      const custom = (ally ? options.ally : options.enemy)?.[i % 5] ?? {}
      return {
        participantId: i + 1,
        championId: 100 + i,
        teamId: ally ? 100 : 200,
        stats: { win: ally === allyWins, ...line(i % 5), ...options.all, ...custom }
      }
    }),
    participantIdentities: Array.from({ length: 10 }, (_, i) => ({
      participantId: i + 1,
      player: { puuid: `p${i + 1}`, gameName: `N${i + 1}`, tagLine: 'EUW' }
    }))
  }
}

type Event = NonNullable<NonNullable<RawTimeline['frames']>[number]['events']>[number]

/**
 * One frame per minute (0–15). `gap(minute)` is team 100's gold lead from minute 1 on, `still`
 * says when a participant doesn't move, `events` adds kills and buildings per minute.
 */
function makeTimeline(
  options: {
    gap?: (minute: number) => number
    still?: (participantId: number, minute: number) => boolean
    events?: (minute: number) => Event[]
  } = {}
): RawTimeline {
  return {
    frames: Array.from({ length: 16 }, (_, minute) => ({
      timestamp: minute * 60_000,
      participantFrames: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => {
          const id = i + 1
          const lead = minute > 0 ? (options.gap?.(minute) ?? 0) / 5 : 0
          // moving players walk 400 units a minute, still ones stay where they were at minute 1
          const step = options.still?.(id, minute) ? 1 : minute
          return [
            String(id),
            { totalGold: 500 + minute * 700 + (id <= 5 ? lead : 0), position: { x: 1000 + step * 400 + id, y: 1000 + id * 37 } }
          ]
        })
      ),
      events: minute > 0 ? (options.events?.(minute) ?? []) : []
    }))
  }
}

const kill = (minute: number, killerId: number, second = 40): Event => ({
  type: 'CHAMPION_KILL',
  timestamp: (minute - 1) * 60_000 + second * 1000,
  killerId,
  victimId: killerId <= 5 ? 6 : 1
})
const tower = (minute: number, owner: number, killerId: number): Event => ({
  type: 'BUILDING_KILL',
  timestamp: (minute - 1) * 60_000 + 30_000,
  killerId,
  teamId: owner
})

describe('will to win', () => {
  it('maps values onto the scale around the typical value', () => {
    const anchors = { lo: 0.48, typical: 0.66, hi: 0.84 }
    expect(ramp(0.66, anchors)).toBe(50)
    expect(ramp(0.48, anchors)).toBe(0)
    expect(ramp(0.3, anchors)).toBe(0)
    expect(ramp(0.75, anchors)).toBeCloseTo(75)
    expect(ramp(0.95, anchors)).toBe(100)
    expect(expectedKillShare(0)).toBe(0.5)
    expect(expectedKillShare(-5000)).toBeCloseTo(0.46, 2)
    expect(expectedKillShare(5000)).toBeCloseTo(1 - expectedKillShare(-5000))
    expect(bandOf(0).label).toBe('Checked out')
    expect(bandOf(59).label).toBe('Solid')
    expect(bandOf(60).label).toBe('Determined')
    expect(bandOf(100)).toBe(WILL_BANDS[WILL_BANDS.length - 1])
  })

  it('gives a typical team in an even game 50', () => {
    const summary = buildSummary(makeGame(), makeTimeline(), 'p1', new Set())
    const will = willToWin(summary)!
    const teamplay = will.factors.find((factor) => factor.key === 'teamplay')!
    expect(teamplay).toMatchObject({ weight: 1, count: 20, minutes: 0 })
    expect(teamplay.value).toBeCloseTo(0.66)
    expect(teamplay.score).toBeCloseTo(50)
    // never behind or ahead: spirit and drive are not tested and get no weight
    expect(will.factors.filter((factor) => factor.score === null).map((factor) => factor.key)).toEqual(['spirit', 'drive'])
    expect(will.factors.filter((factor) => factor.score === null).every((factor) => factor.weight === 0)).toBe(true)
    expect(will).toMatchObject({ score: 50, presence: 1, absent: [], surrender: 0 })
    expect(will.band.label).toBe('Solid')
  })

  it('reads surrender, remakes, buildings and standing still from the client data', () => {
    const game = makeGame({ all: { gameEndedInSurrender: true } })
    const timeline = makeTimeline({
      // p3 never moves (AFK), p8 stops after minute 5 (left), p9 stands still for two minutes only (dead, shopping)
      still: (id, minute) => id === 3 || (id === 8 && minute >= 5) || (id === 9 && (minute === 7 || minute === 8)),
      events: (minute) => (minute === 4 ? [tower(4, 200, 2)] : minute === 9 ? [tower(9, 100, 0)] : [])
    })
    const effort = buildSummary(game, timeline, 'p1', new Set()).effort!
    // you won, so the enemy surrendered
    expect(effort.surrender).toEqual({ ally: false })
    expect(effort.remake).toBe(false)
    // teamId is the side that lost the building, also when a minion took it (killerId 0)
    expect(effort.buildings).toEqual([
      { t: 210, ally: true },
      { t: 510, ally: false }
    ])
    expect(effort.tracked).toBe(14)
    expect(effort.idle.p3).toBe(14)
    expect(effort.idle.p8).toBe(10)
    expect(effort.idle.p9).toBe(0)
    expect(effort.idle.p1).toBe(0)

    const remake = buildSummary(makeGame({ all: { gameEndedInEarlySurrender: true }, duration: 200 }), null, 'p1', new Set())
    expect(remake.effort).toMatchObject({ remake: true, surrender: null, tracked: 0, idle: {} })
    expect(willToWin(remake)).toBeNull()
  })

  it('multiplies by the share of the team that played and names who was away', () => {
    const game = makeGame({ ally: [{}, {}, { kills: 0, deaths: 0, assists: 0, totalDamageDealtToChampions: 0 }] })
    const timeline = makeTimeline({ still: (id, minute) => id === 3 || (id === 8 && minute >= 5) })
    const summary = buildSummary(game, timeline, 'p1', new Set())
    const ours = willToWin(summary)!
    expect(ours.presence).toBe(0.8)
    expect(ours.absent).toEqual([{ puuid: 'p3', share: 1 }])
    expect(ours.score).toBe(Math.round(ours.base * 0.8))
    const theirs = willToWin(summary, false)!
    expect(theirs.presence).toBeCloseTo((4 + 4 / 14) / 5)
    expect(theirs.absent).toEqual([{ puuid: 'p8', share: 0.71 }])

    // without a timeline only someone who did nothing at all counts as away
    const blind = willToWin(buildSummary(game, null, 'p1', new Set()))!
    expect(blind.presence).toBe(0.8)
    expect(blind.factors.every((factor) => factor.key === 'teamplay' || factor.score === null)).toBe(true)
  })

  it('takes points off the side that surrendered, more in a close game', () => {
    const close = buildSummary(makeGame({ all: { gameEndedInSurrender: true }, allyWins: false }), makeTimeline(), 'p1', new Set())
    expect(willToWin(close)!.surrender).toBe(25)
    expect(willToWin(close)!.score).toBe(25)
    expect(willToWin(close, false)!.surrender).toBe(0)

    // 4k behind at the end: 25 − 10 × 0.4
    const behind = buildSummary(
      makeGame({ all: { gameEndedInSurrender: true }, allyWins: false }),
      makeTimeline({ gap: (minute) => (minute === 15 ? -4000 : 0) }),
      'p1',
      new Set()
    )
    expect(willToWin(behind)!.surrender).toBeCloseTo(21)
    // 10k or more behind: the minimum of 15
    const hopeless = buildSummary(
      makeGame({ all: { gameEndedInSurrender: true }, allyWins: false }),
      makeTimeline({ gap: (minute) => (minute === 15 ? -14000 : 0) }),
      'p1',
      new Set()
    )
    expect(willToWin(hopeless)!.surrender).toBe(15)
  })

  it('rates fighting spirit while behind against the kill share expected at that gap', () => {
    // 3k behind from minute 1 on; 10 kills in that time, 6 of them ours
    const events = (minute: number): Event[] => (minute >= 2 && minute <= 11 ? [kill(minute, minute <= 7 ? 2 : 7)] : [])
    const summary = buildSummary(makeGame({ allyWins: false }), makeTimeline({ gap: () => -3000, events }), 'p1', new Set())
    const spirit = willToWin(summary)!.factors.find((factor) => factor.key === 'spirit')!
    const expected = 10 * expectedKillShare(-3000)
    expect(spirit.value).toBe(0.6)
    expect(spirit.typical).toBeCloseTo(expected / 10)
    expect(spirit).toMatchObject({ count: 10, minutes: 14 })
    // ten virtual kills at the expected share calm it down: 50 + 50 × (6 − 4.76) / 20 / 0.15
    expect(spirit.score).toBeCloseTo(50 + (50 * ((6 - expected) / 20)) / 0.15)
    expect(spirit.score!).toBeGreaterThan(65)
    // the enemy was ahead the whole time: no spirit, but drive (no buildings → below typical)
    const theirs = willToWin(summary, false)!
    expect(theirs.factors.find((factor) => factor.key === 'spirit')!.score).toBeNull()
    expect(theirs.factors.find((factor) => factor.key === 'drive')!.score).toBeCloseTo((50 * (0.45 * 2)) / 16 / 0.45)
  })

  it('leaves fighting spirit untested when there were too few kills while behind', () => {
    const events = (minute: number): Event[] => (minute === 3 || minute === 5 || minute === 8 ? [kill(minute, 2)] : [])
    const summary = buildSummary(makeGame({ allyWins: false }), makeTimeline({ gap: () => -3000, events }), 'p1', new Set())
    expect(willToWin(summary)!.factors.find((factor) => factor.key === 'spirit')).toMatchObject({ score: null, count: 3, minutes: 14 })
  })

  it('takes the middle amount off for a surrender when the gold gap at the end is unknown', () => {
    const summary = buildSummary(makeGame({ all: { gameEndedInSurrender: true }, allyWins: false }), null, 'p1', new Set())
    expect(summary.curve).toEqual([])
    expect(willToWin(summary)!.surrender).toBe(20)
  })

  it('rates closing drive by the buildings taken while ahead', () => {
    const events = (minute: number): Event[] =>
      [3, 6, 9].includes(minute) ? [tower(minute, 200, 2)] : minute === 12 ? [tower(12, 100, 7)] : []
    const summary = buildSummary(makeGame(), makeTimeline({ gap: () => 3000, events }), 'p1', new Set())
    const will = willToWin(summary)!
    const drive = will.factors.find((factor) => factor.key === 'drive')!
    expect(drive.value).toBeCloseTo(3 / 14)
    // (3 + 2 virtual minutes × 0.45) / 16 minutes, on 0 … 0.45 … 0.9
    expect(drive.score).toBeCloseTo((50 * ((3 + 0.9) / 16)) / 0.45)
    // teamplay and drive share the base 40 : 25
    expect(will.factors.find((factor) => factor.key === 'teamplay')!.weight).toBeCloseTo(0.4 / 0.65)
    expect(drive.weight).toBeCloseTo(0.25 / 0.65)
    expect(will.base).toBeCloseTo((0.4 * 50 + 0.25 * drive.score!) / 0.65)
  })

  it('has nothing to say about older summaries, short games and teams of one', () => {
    const summary = buildSummary(makeGame(), makeTimeline(), 'p1', new Set())
    expect(willToWin({ ...summary, effort: undefined })).toBeNull()
    expect(willToWin({ ...summary, duration: 240 })).toBeNull()
    expect(willToWin({ ...summary, players: summary.players.filter((player) => !player.ally || player.me) })).toBeNull()
    expect(willToWin({ ...summary, mode: 'CHERRY' })).toBeNull()
  })
})
