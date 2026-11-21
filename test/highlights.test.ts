import { describe, expect, it } from 'vitest'
import {
  buildHighlightProject,
  ffmpegLoudnessArgs,
  loudnessBaseline,
  monthOf,
  monthRange,
  parseFeed,
  parseLoudness,
  pickHighlights,
  reelSeconds,
  scoreHighlight,
  REEL_GAME,
  REEL_MONTH,
  type AudioStats,
  type HighlightCandidate,
  type HighlightScore,
  type RecordingFeed,
  type ReelClip
} from '../src/shared/highlights'
import { normalizeProject, projectDuration } from '../src/shared/editProject'
import type { FeedEvent } from '../src/shared/recorder'

/** You (ORDER) against five enemies; the feed names players by Riot ID. */
const TEAMS: RecordingFeed['teams'] = {
  'Me#EUW': 'ORDER',
  'Ally#EUW': 'ORDER',
  'Ally2#EUW': 'ORDER',
  'E1#EUW': 'CHAOS',
  'E2#EUW': 'CHAOS',
  'E3#EUW': 'CHAOS',
  'E4#EUW': 'CHAOS',
  'E5#EUW': 'CHAOS'
}

let nextId = 1
const kill = (t: number, killer: string, victim: string, assisters: string[] = []): FeedEvent => ({
  EventID: nextId++,
  EventName: 'ChampionKill',
  EventTime: t,
  KillerName: killer,
  VictimName: victim,
  Assisters: assisters
})
const multi = (t: number, streak: number): FeedEvent => ({
  EventID: nextId++,
  EventName: 'Multikill',
  EventTime: t,
  KillerName: 'Me',
  KillStreak: streak
})

const feed = (events: FeedEvent[], health: [number, number][] = []): RecordingFeed => ({
  me: 'Me#EUW',
  myTeam: 'ORDER',
  teams: TEAMS,
  events,
  health
})

/** A 30 s clip that starts at game second 600. */
function candidate(patch: Partial<HighlightCandidate> = {}): HighlightCandidate {
  return {
    clipId: 1,
    kind: 'manual',
    durationMs: 30_000,
    favorite: false,
    shared: false,
    gameStart: 600,
    feed: null,
    game: null,
    audio: null,
    baseline: null,
    ...patch
  }
}

const audio = (envelope: number[]): AudioStats =>
  parseLoudness(envelope.map((value) => `lavfi.astats.Overall.RMS_level=${value}`).join('\n'))!

describe('sound', () => {
  it('reads one level per second from FFmpeg, silence included', () => {
    const output = [
      '[Parsed_ametadata_3 @ 0000] frame:0    pts:0       pts_time:0',
      '[Parsed_ametadata_3 @ 0000] lavfi.astats.Overall.RMS_level=-inf',
      '[Parsed_ametadata_3 @ 0000] frame:1    pts:48000   pts_time:1',
      '[Parsed_ametadata_3 @ 0000] lavfi.astats.Overall.RMS_level=-24.51',
      '[Parsed_ametadata_3 @ 0000] lavfi.astats.Overall.RMS_level=-12.2',
      '[Parsed_ametadata_3 @ 0000] lavfi.astats.Overall.RMS_level=-26'
    ].join('\n')
    expect(parseLoudness(output)).toEqual({ envelope: [-90, -24.5, -12.2, -26], median: -24.5, peak: -12.2, peakAt: 2.5 })
    expect(parseLoudness('no audio stream')).toBeNull()
  })

  it('measures the sound only, one-second frames', () => {
    const args = ffmpegLoudnessArgs('C:/clips/a.mp4')
    expect(args).toEqual(expect.arrayContaining(['-vn', '-i', 'C:/clips/a.mp4']))
    expect(args.join(' ')).toContain('asetnsamples=n=48000')
    expect(args.join(' ')).toContain('astats=metadata=1:reset=1')
  })

  it('takes the typical level of a game from the medians of its clips, ignoring silent ones', () => {
    expect(loudnessBaseline([audio([-30, -30, -30]), audio([-20, -20, -20]), audio([-25, -25]), audio([-90, -90]), null])).toBe(-25)
    expect(loudnessBaseline([null])).toBeNull()
  })
})

describe('scoring a clip', () => {
  it('a pentakill is S tier, named, and its climax is the fifth kill', () => {
    const events = [
      kill(608, 'Me', 'E1#EUW'),
      kill(611, 'Me', 'E2#EUW', ['Ally#EUW']),
      kill(614, 'Me', 'E3#EUW'),
      multi(614, 3),
      kill(618, 'Me', 'E4#EUW'),
      multi(618, 4),
      kill(622, 'Me', 'E5#EUW'),
      multi(622, 5),
      { EventID: nextId++, EventName: 'Ace', EventTime: 622, Acer: 'Me', AcingTeam: 'ORDER' }
    ]
    const score = scoreHighlight(candidate({ kind: 'auto:penta', feed: feed(events) }))
    expect(score.label).toBe('Pentakill')
    expect(score.tier).toBe('S')
    expect(score.score).toBeGreaterThanOrEqual(85)
    expect(score.peak).toBe(22)
    // from 6 s before the first kill to 2.5 s (+1 for the ace) after the last
    expect(score.core).toEqual({ in: 2, out: 25.5 })
    expect(score.reasons[0]).toBe('5 kills')
  })

  it('a triple won on low health and survived is a clutch', () => {
    const events = [kill(610, 'Me', 'E1#EUW', ['Ally#EUW']), kill(613, 'Me', 'E2#EUW'), kill(616, 'Me', 'E3#EUW'), multi(616, 3)]
    const health: [number, number][] = [
      [606, 0.9],
      [610, 0.45],
      [614, 0.08],
      [618, 0.2]
    ]
    const clutch = scoreHighlight(candidate({ kind: 'auto:triple', feed: feed(events, health) }))
    const comfy = scoreHighlight(
      candidate({
        kind: 'auto:triple',
        feed: feed(
          events,
          health.map(([t]) => [t, 0.9])
        )
      })
    )
    expect(clutch.label).toBe('Clutch triple kill')
    expect(clutch.reasons).toContain('won it on 8 % health')
    expect(clutch.parts.clutch!).toBeGreaterThan(0.8)
    expect(clutch.score).toBeGreaterThan(comfy.score)
    expect(comfy.label).toBe('Triple kill')
  })

  it('dying without a kill or an assist is worth little – unless it got loud', () => {
    const events = [kill(610, 'Ally#EUW', 'E1#EUW'), kill(612, 'E2#EUW', 'Ally#EUW'), kill(614, 'E3#EUW', 'Me#EUW')]
    const quiet = scoreHighlight(candidate({ kind: 'auto:death', feed: feed(events), audio: audio(Array(30).fill(-28)), baseline: -28 }))
    const loud = scoreHighlight(
      candidate({
        kind: 'auto:death',
        feed: feed(events),
        audio: audio([...Array(20).fill(-28), -8, -9, -10, -12, -11, ...Array(5).fill(-28)]),
        baseline: -28
      })
    )
    expect(quiet.label).toBe('Team fight')
    expect(quiet.tier).toBe('C')
    expect(quiet.reasons).toContain('you went down in it')
    expect(loud.score).toBeGreaterThan(quiet.score + 10)
    expect(loud.reasons).toContain('it got loud')
    // the part to show ends shortly after your death
    expect(quiet.core.out).toBeCloseTo(16.5, 1)
  })

  it('a fight won far behind that turns the gold around is a comeback', () => {
    const events = [kill(605, 'Me', 'E1#EUW'), kill(607, 'Ally#EUW', 'E2#EUW', ['Me#EUW']), kill(609, 'Me', 'E3#EUW')]
    const curve = [
      { t: 540, gold: -5200, kills: -6 },
      { t: 600, gold: -5000, kills: -6 },
      { t: 660, gold: -2600, kills: -3 },
      { t: 720, gold: -1500, kills: -2 }
    ]
    const score = scoreHighlight(
      candidate({ kind: 'auto:triple', feed: feed(events), game: { duration: 1500, win: true, curve, timeline: true } })
    )
    expect(score.parts.stakes!).toBeGreaterThan(0.6)
    expect(score.reasons).toContain('won the fight 5.2k gold behind')
    expect(score.label).toBe('Comeback double kill')
  })

  it('the fight that ended a won game is the game-winning one', () => {
    const events = [
      kill(605, 'Me', 'E1#EUW'),
      kill(608, 'Me', 'E2#EUW'),
      multi(608, 2),
      { EventID: nextId++, EventName: 'GameEnd', EventTime: 628, Result: 'Win' }
    ]
    const score = scoreHighlight(
      candidate({ kind: 'auto:gameEnd', feed: feed(events), game: { duration: 630, win: true, curve: [], timeline: false } })
    )
    expect(score.label).toBe('Game-winning double kill')
    expect(score.reasons).toContain('the fight that ended the game')
  })

  it('without the game feed (older clips) the kind decides; a quadra still gets its floor', () => {
    const quadra = scoreHighlight(candidate({ kind: 'auto:quadra', durationMs: 25_000, gameStart: null }))
    expect(quadra.score).toBeGreaterThanOrEqual(70)
    expect(quadra.label).toBe('Quadra kill')
    // the moment of an automatic clip sits its lead-out (5 s) before the end
    expect(quadra.peak).toBe(20)
    expect(quadra.core).toEqual({ in: 8, out: 25 })
    const first = scoreHighlight(candidate({ kind: 'auto:firstBlood', durationMs: 16_000, gameStart: null }))
    expect(first.score).toBeLessThan(quadra.score)
  })

  it('what you did with a clip lifts it: clipped yourself < bookmarked < shared < favourite', () => {
    const scores = [
      candidate({ kind: 'manual' }),
      candidate({ kind: 'bookmark' }),
      candidate({ kind: 'manual', shared: true }),
      candidate({ kind: 'manual', favorite: true })
    ].map((entry) => scoreHighlight(entry).score)
    expect([...scores].sort((a, b) => a - b)).toEqual(scores)
    expect(scores[3]).toBeGreaterThan(scores[0] + 10)
  })

  it('a hotkey clip without known moments shows the stretch around its loudest second, or its end', () => {
    const loud = scoreHighlight(candidate({ gameStart: null, audio: audio([...Array(12).fill(-30), -10, ...Array(17).fill(-30)]) }))
    expect(loud.core).toEqual({ in: 3.5, out: 15.5 })
    expect(loud.peak).toBe(12.5)
    expect(scoreHighlight(candidate({ gameStart: null })).core).toEqual({ in: 15, out: 30 })
  })

  it('reads the feed back from the database and refuses anything else', () => {
    const stored = feed([kill(1, 'Me', 'E1#EUW')], [[1, 0.5]])
    expect(parseFeed(JSON.stringify(stored))).toEqual(stored)
    expect(parseFeed('{"events":"no"}')).toBeNull()
    expect(parseFeed('nope')).toBeNull()
    expect(parseFeed(null)).toBeNull()
  })
})

/** A clip for picking, with only what picking looks at. */
function reel(id: number, score: number, patch: Partial<ReelClip> = {}, core = { in: 0, out: 12 }): ReelClip {
  const tier = score >= 75 ? 'S' : score >= 58 ? 'A' : score >= 40 ? 'B' : 'C'
  const highlight: HighlightScore = {
    clipId: id,
    score,
    tier,
    label: `Clip ${id}`,
    reasons: [],
    parts: { action: 0.5, stakes: null, clutch: null, hype: null, intent: 0 },
    core,
    peak: core.out - 3
  }
  return {
    score: highlight,
    recordingId: 1,
    gameId: 1,
    championId: 10,
    startMs: id * 100_000,
    endMs: id * 100_000 + 20_000,
    createdAt: id,
    ...patch
  }
}

describe('picking the clips', () => {
  it('a game: one clip per moment, best first within the length, then in the order it happened', () => {
    const clips = [
      reel(1, 45),
      reel(2, 90),
      // the same fight as clip 2 (a hotkey clip over the automatic one): only the better one stays
      reel(3, 60, { startMs: 205_000, endMs: 225_000 }),
      reel(4, 70),
      reel(5, 30),
      reel(6, 55)
    ]
    const picked = pickHighlights(clips, REEL_GAME)
    expect(picked.map((clip) => clip.score.clipId)).toEqual([1, 2, 4, 6])
    expect(reelSeconds(picked)).toBe(48)
  })

  it('stops at the length of the video', () => {
    const clips = Array.from({ length: 6 }, (_, i) => reel(i + 1, 80 - i, {}, { in: 0, out: 30 }))
    const picked = pickHighlights(clips, REEL_GAME)
    expect(picked).toHaveLength(2)
    expect(reelSeconds(picked)).toBeLessThanOrEqual(REEL_GAME.maxSeconds)
  })

  it('keeps the best clip even when it is weak, but not a dull one', () => {
    expect(pickHighlights([reel(1, 25), reel(2, 22)], REEL_GAME).map((clip) => clip.score.clipId)).toEqual([1])
    expect(pickHighlights([reel(1, 12)], REEL_GAME)).toEqual([])
  })

  it('a month: at most two clips per game, variety of champions, opened by the second best and ending on the best', () => {
    const clips = [
      reel(1, 95, { gameId: 1, recordingId: 1 }),
      reel(2, 90, { gameId: 1, recordingId: 1 }),
      reel(3, 85, { gameId: 1, recordingId: 1 }),
      reel(4, 80, { gameId: 2, recordingId: 2, championId: 10 }),
      reel(5, 78, { gameId: 3, recordingId: 3, championId: 20 }),
      reel(6, 40, { gameId: 4, recordingId: 4, championId: 30 })
    ]
    const picked = pickHighlights(clips, REEL_MONTH)
    const ids = picked.map((clip) => clip.score.clipId)
    expect(ids).not.toContain(3)
    expect(ids).not.toContain(6)
    expect(ids[0]).toBe(2)
    expect(ids[ids.length - 1]).toBe(1)
    expect(new Set(ids)).toEqual(new Set([1, 2, 4, 5]))
  })
})

describe('the video', () => {
  it('cores in a row with fades, a title, a label per clip and slow motion on the best S-tier moment', () => {
    const picked = [reel(1, 62, {}, { in: 4, out: 16 }), reel(2, 92, {}, { in: 2, out: 24 })]
    const project = buildHighlightProject(picked, 'game', { title: 'JINX · 14/3/9 · VICTORY', subtitle: 'ARAM: Mayhem · 21 Nov 2026' })!
    expect(normalizeProject(project)).toEqual(project)
    // the best clip is split around its peak (21 s): 2–19.8 at full speed, 19.8–21.6 at half, 21.6–24
    expect(project.clips).toEqual([
      { clipId: 1, in: 4, out: 16, speed: 1 },
      { clipId: 2, in: 2, out: 19.8, speed: 1 },
      { clipId: 2, in: 19.8, out: 21.6, speed: 0.5 },
      { clipId: 2, in: 21.6, out: 24, speed: 1 }
    ])
    expect(project.transitions).toEqual(['fade', 'cut', 'cut'])
    expect(project.texts.map((text) => text.text)).toEqual(['JINX · 14/3/9 · VICTORY', 'ARAM: Mayhem · 21 Nov 2026', 'CLIP 1', 'CLIP 2'])
    // the first label waits for the title
    expect(project.texts[2].start).toBeGreaterThanOrEqual(project.texts[0].end!)
    expect(project.music).toBeNull()
    expect(project.output.preset).toBe('discord')
    expect(projectDuration(project)).toBeGreaterThan(12 + 22)
  })

  it('a recap alternates glitch and fade and has music under the game sound', () => {
    const picked = [reel(1, 60), reel(2, 70), reel(3, 80)]
    const project = buildHighlightProject(picked, 'month', { title: 'NOVEMBER 2026' })!
    // glitch, fade between the clips; the best one (S tier) is cut in three for its slow motion
    expect(project.transitions).toEqual(['glitch', 'fade', 'cut', 'cut'])
    expect(project.music).toMatchObject({ file: 'builtin:pentakill-rush', duck: false })
    expect(buildHighlightProject([], 'month', { title: 'X' })).toBeNull()
  })
})

describe('months', () => {
  it('turns "2026-11" into its range and back (local time)', () => {
    const range = monthRange('2026-11')!
    expect(new Date(range.from).getDate()).toBe(1)
    expect(new Date(range.to).getMonth()).toBe(11)
    expect(monthOf(range.from)).toBe('2026-11')
    expect(monthOf(range.to - 1)).toBe('2026-11')
    expect(monthRange('2026-13')).toBeNull()
    expect(monthRange('november')).toBeNull()
  })
})
