/**
 * Highlight videos: which clips are worth watching, and a montage of the best ones – for one game
 * or as a recap of a month.
 *
 * Every clip gets a score from 0 to 100, built like a highlight editor would judge it:
 *
 *   base  = weighted mean of the parts that could be measured (a part without data is left out
 *           and the others share its weight)
 *     action  50 %  what you did: kills, assists, multikills, aces, solo kills, the size of the fight
 *     hype    20 %  how loud it got against the rest of the game: the announcer, the fight – and
 *                   your friends on voice chat when the clip has the whole sound
 *     clutch  15 %  you won it on low health and lived, or alone
 *     stakes  15 %  how much it mattered: a fight won while far behind, a swing in the gold lead,
 *                   the fight that ended the game
 *   score = base + (1 − base) × ½ × intent      intent: you made it a favourite, shared it,
 *                                                bookmarked or clipped it yourself
 *
 * A pentakill is always worth showing and a quadra almost always (floors), and a clip where you only
 * died is worth little unless it got loud (a fail can be a highlight too).
 *
 * The facts come from what the recorder kept of the game: Riot's live event feed (who killed whom,
 * in game seconds), your health from the live API and the game clock of the recording (recording
 * seconds − game seconds), plus the game's gold curve from the summary and the loudness of the
 * clip measured by FFmpeg. Clips from before 1.3.3 have none of the game data; they are judged by
 * their kind, their sound and what you did with them.
 *
 * Pure: the main process (main/recorder/highlights.ts) loads the data, runs FFmpeg and exports.
 */
import { AUTO_CLIP_TIMING, samePlayer, type AutoClipKind, type FeedEvent } from './recorder'
import type { CurvePoint } from './summary'
import { timeline, type EditProject, type ProjectClip, type TextItem, type Transition } from './editProject'

// ---------------------------------------------------------------------------
// What the recorder keeps of a game
// ---------------------------------------------------------------------------

export type LiveTeam = 'ORDER' | 'CHAOS'

/** What happened in a recording, in game seconds (kept per recording, JSON). */
export interface RecordingFeed {
  /** your Riot ID as the live API names you */
  me: string | null
  myTeam: LiveTeam | null
  /** every player's team by Riot ID, to tell allies from enemies in the feed */
  teams: Record<string, LiveTeam>
  /** the events that matter for highlights (see FEED_EVENTS) */
  events: FeedEvent[]
  /** your health as a share of the maximum, [game second, 0–1], about one per live poll */
  health: [number, number][]
}

/** Live events a highlight can be about. */
export const FEED_EVENTS = new Set(['ChampionKill', 'Multikill', 'Ace', 'FirstBlood', 'TurretKilled', 'InhibKilled', 'GameEnd'])

export const emptyFeed = (): RecordingFeed => ({ me: null, myTeam: null, teams: {}, events: [], health: [] })

/** A feed read back from the database; null when it isn't one. */
export function parseFeed(json: string | null | undefined): RecordingFeed | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Partial<RecordingFeed>
    if (!raw || !Array.isArray(raw.events)) return null
    return {
      me: typeof raw.me === 'string' ? raw.me : null,
      myTeam: raw.myTeam === 'ORDER' || raw.myTeam === 'CHAOS' ? raw.myTeam : null,
      teams: raw.teams && typeof raw.teams === 'object' ? raw.teams : {},
      events: raw.events.filter((event) => event && Number.isFinite(event.EventTime)),
      health: Array.isArray(raw.health) ? raw.health.filter((sample) => Array.isArray(sample) && sample.length === 2) : []
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

/** Loudness of a clip, one value per second (RMS level in dBFS; silence is −90). */
export interface AudioStats {
  envelope: number[]
  /** the clip's typical level (median of the seconds) */
  median: number
  /** its loudest second and where it is (seconds into the clip) */
  peak: number
  peakAt: number
}

const SILENCE = -90

/**
 * FFmpeg arguments that print the sound level of every second of a file: the audio is cut into
 * one-second frames and astats measures each of them. Video is not decoded.
 */
export function ffmpegLoudnessArgs(file: string): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-i',
    file,
    '-vn',
    '-map',
    '0:a:0',
    '-af',
    'aresample=48000,asetnsamples=n=48000:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level',
    '-f',
    'null',
    '-'
  ]
}

/** Reads the per-second levels printed by ffmpegLoudnessArgs; null when there are none (no sound). */
export function parseLoudness(output: string): AudioStats | null {
  const envelope: number[] = []
  for (const match of output.matchAll(/RMS_level=(-?inf|-?\d+(?:\.\d+)?)/g)) {
    const value = match[1].endsWith('inf') ? SILENCE : Math.max(SILENCE, Number(match[1]))
    envelope.push(Math.round(value * 10) / 10)
  }
  if (!envelope.length) return null
  const sorted = [...envelope].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  let peakAt = 0
  envelope.forEach((value, i) => {
    if (value > envelope[peakAt]) peakAt = i
  })
  // the value of second i covers i … i+1: its middle is the moment
  return { envelope, median, peak: envelope[peakAt], peakAt: peakAt + 0.5 }
}

/** The typical level of a game's clips (median of their medians), the yardstick for "loud". */
export function loudnessBaseline(stats: readonly (AudioStats | null)[]): number | null {
  const medians = stats.flatMap((stat) => (stat && stat.median > SILENCE + 1 ? [stat.median] : [])).sort((a, b) => a - b)
  return medians.length ? medians[Math.floor(medians.length / 2)] : null
}

// ---------------------------------------------------------------------------
// Scoring one clip
// ---------------------------------------------------------------------------

export type HighlightTier = 'S' | 'A' | 'B' | 'C'

export interface HighlightCandidate {
  clipId: number
  kind: string
  durationMs: number
  favorite: boolean
  /** posted to Discord already */
  shared: boolean
  /** game second at the clip's first frame; null when the recording's game clock is unknown */
  gameStart: number | null
  feed: RecordingFeed | null
  /** of the clip's game; null without a saved summary */
  game: { duration: number; win: boolean; curve: CurvePoint[]; timeline: boolean } | null
  audio: AudioStats | null
  /** the typical level of this game's clips, null when unknown (the clip's own median is used then) */
  baseline: number | null
}

export interface HighlightParts {
  /** 0–1 each; null when it couldn't be measured */
  action: number
  stakes: number | null
  clutch: number | null
  hype: number | null
  intent: number
}

export interface HighlightScore {
  clipId: number
  /** 0–100 */
  score: number
  tier: HighlightTier
  /** what the clip is, e.g. "Clutch triple kill" */
  label: string
  /** why it scored, short phrases for the UI */
  reasons: string[]
  parts: HighlightParts
  /** the stretch worth showing, seconds inside the clip */
  core: { in: number; out: number }
  /** the climax (seconds inside the clip) – the slow motion goes there; null when unknown */
  peak: number | null
}

export const HIGHLIGHT_WEIGHTS = { action: 0.5, hype: 0.2, clutch: 0.15, stakes: 0.15 } as const
/** How much "you chose this clip" lifts the rest of the way to 100. */
const INTENT_LIFT = 0.5
const TIERS: [HighlightTier, number][] = [
  ['S', 75],
  ['A', 58],
  ['B', 40],
  ['C', 0]
]
export const tierOf = (score: number): HighlightTier => TIERS.find(([, min]) => score >= min)![0]

/** Points per multikill on top of the kills themselves. */
const MULTIKILL_POINTS: Record<number, number> = { 2: 0.5, 3: 1.5, 4: 3, 5: 5 }
/** Points at which action is at 63 % (1 − 1/e); a triple kill fight lands around 0.8. */
const ACTION_SCALE = 3.2
/** A clip of this kind is never below this score (when the feed confirms it or there is no feed). */
const FLOORS: Partial<Record<number, number>> = { 5: 85, 4: 70 }
/** Action of a clip whose content is unknown, by kind. */
const KIND_ACTION: Record<string, number> = {
  'auto:penta': 0.97,
  'auto:quadra': 0.9,
  'auto:triple': 0.8,
  'auto:ace': 0.6,
  'auto:firstBlood': 0.4,
  'auto:gameEnd': 0.4,
  'auto:death': 0.15,
  manual: 0.35,
  bookmark: 0.4
}
const KIND_STREAK: Record<string, number> = { 'auto:penta': 5, 'auto:quadra': 4, 'auto:triple': 3 }
const INTENT: Record<string, number> = { manual: 0.55, bookmark: 0.7 }

/** Seconds of build-up before the first moment and of aftermath after the last one. */
const LEAD = 6
const TAIL = 2.5
const MIN_CORE = 8
const MAX_CORE = 32
/** Health below which a fight you won counts as clutch. */
const LOW_HEALTH = 0.35
/** Gold behind from which a won fight counts fully as a comeback, and the swing that counts fully. */
const BEHIND_FULL = 4000
const SWING_FULL = 2500
/** A fight ending at most this long before the end of a won game decided it. */
const DECISIVE_SECONDS = 40
/** Level above the game's typical loudness (dB) from which a clip starts to count as loud, and the span to "very". */
const LOUD_FROM = 4
const LOUD_SPAN = 12
/** A second this far above the typical level is a loud burst. */
const BURST = 6

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
const playerKey = (name: string | undefined | null): string => (name ?? '').split('#')[0].replace(/\s+/g, '').toLowerCase()

const KIND_LABEL: Record<string, string> = {
  'auto:penta': 'Pentakill',
  'auto:quadra': 'Quadra kill',
  'auto:triple': 'Triple kill',
  'auto:ace': 'Ace',
  'auto:firstBlood': 'First blood',
  'auto:gameEnd': 'End of the game',
  'auto:death': 'Team fight',
  manual: 'Clip',
  bookmark: 'Bookmark'
}
const STREAK_LABEL: Record<number, string> = { 2: 'Double kill', 3: 'Triple kill', 4: 'Quadra kill', 5: 'Pentakill' }

/** Gold lead of your team at a moment (the last curve point at or before it). */
function goldAt(curve: readonly CurvePoint[], t: number): number | null {
  let gold: number | null = null
  for (const point of curve) {
    if (point.t > t) break
    gold = point.gold
  }
  return gold
}

/** What the feed says happened inside a clip's window (game seconds). */
interface Moment {
  myKills: number[]
  myAssists: number[]
  myDeaths: number[]
  soloKills: number
  enemyDeaths: number
  allyDeaths: number
  /** highest multikill of yours and when */
  streak: { size: number; t: number } | null
  ace: number | null
  firstBlood: number | null
  gameEnd: number | null
}

function readMoment(feed: RecordingFeed, from: number, to: number): Moment {
  const me = feed.me
  const teamByKey = new Map(Object.entries(feed.teams).map(([riotId, team]) => [playerKey(riotId), team]))
  const isEnemy = (name?: string): boolean => {
    const team = teamByKey.get(playerKey(name))
    return !!team && !!feed.myTeam && team !== feed.myTeam
  }
  const moment: Moment = {
    myKills: [],
    myAssists: [],
    myDeaths: [],
    soloKills: 0,
    enemyDeaths: 0,
    allyDeaths: 0,
    streak: null,
    ace: null,
    firstBlood: null,
    gameEnd: null
  }
  for (const event of feed.events) {
    const t = event.EventTime
    if (t < from - 0.5 || t > to + 0.5) continue
    switch (event.EventName) {
      case 'ChampionKill': {
        if (isEnemy(event.VictimName)) moment.enemyDeaths++
        else moment.allyDeaths++
        if (samePlayer(event.KillerName, me)) {
          moment.myKills.push(t)
          if (!event.Assisters?.length) moment.soloKills++
        } else if (event.Assisters?.some((name) => samePlayer(name, me))) moment.myAssists.push(t)
        if (samePlayer(event.VictimName, me)) moment.myDeaths.push(t)
        break
      }
      case 'Multikill':
        if (samePlayer(event.KillerName, me) && (event.KillStreak ?? 0) >= (moment.streak?.size ?? 0))
          moment.streak = { size: event.KillStreak ?? 0, t }
        break
      case 'Ace':
        if (feed.myTeam && event.AcingTeam === feed.myTeam) moment.ace = t
        break
      case 'FirstBlood':
        if (samePlayer(event.Recipient, me)) moment.firstBlood = t
        break
      case 'GameEnd':
        moment.gameEnd = t
        break
    }
  }
  return moment
}

/** Lowest health you had in the window while alive, null without samples. */
function lowestHealth(feed: RecordingFeed, from: number, to: number): number | null {
  const alive = feed.health.filter(([t, share]) => t >= from && t <= to && share > 0)
  return alive.length ? Math.min(...alive.map(([, share]) => share)) : null
}

/** The stretch of a clip worth showing: from a little before the first moment to a little after the last. */
function coreOf(moments: number[], duration: number, extraTail: number): { in: number; out: number } {
  const first = Math.min(...moments)
  const last = Math.max(...moments)
  let start = Math.max(0, first - LEAD)
  let end = Math.min(duration, last + TAIL + extraTail)
  if (end - start < MIN_CORE) start = Math.max(0, end - MIN_CORE)
  if (end - start < MIN_CORE) end = Math.min(duration, start + MIN_CORE)
  // a long multikill keeps its end (the last kills) rather than its beginning
  if (end - start > MAX_CORE) start = end - MAX_CORE
  return { in: round(start), out: round(end) }
}

/** The stretch of a clip without known moments: around the loud peak, or where its kind puts the moment. */
function fallbackCore(candidate: HighlightCandidate, duration: number): { core: { in: number; out: number }; peak: number | null } {
  const autoKind = candidate.kind.startsWith('auto:') ? (candidate.kind.slice(5) as AutoClipKind) : null
  const timing = autoKind ? AUTO_CLIP_TIMING[autoKind] : null
  if (timing && duration > timing.post) {
    const moment = duration - timing.post
    return { core: { in: round(Math.max(0, moment - Math.min(timing.pre, 12))), out: round(duration) }, peak: round(moment) }
  }
  if (candidate.audio && candidate.audio.peak > candidate.audio.median + BURST) {
    const at = candidate.audio.peakAt
    const start = Math.max(0, at - 9)
    return { core: { in: round(start), out: round(Math.min(duration, Math.max(at + 3, start + MIN_CORE))) }, peak: round(at) }
  }
  // a hotkey clip ends when you pressed it: the moment is right before the end
  return { core: { in: round(Math.max(0, duration - 15)), out: round(duration) }, peak: null }
}

const round = (value: number): number => Math.round(value * 100) / 100
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** The score of one clip, with its label, reasons and the part worth showing. */
export function scoreHighlight(candidate: HighlightCandidate): HighlightScore {
  const duration = Math.max(0.1, candidate.durationMs / 1000)
  const reasons: string[] = []
  const known = candidate.feed && candidate.feed.me && candidate.gameStart !== null
  const from = candidate.gameStart ?? 0
  const to = from + duration
  const moment = known ? readMoment(candidate.feed!, from, to) : null

  // --- action ---
  let action: number
  let streak = 0
  let label = KIND_LABEL[candidate.kind] ?? 'Clip'
  if (moment && (moment.myKills.length || moment.myAssists.length || moment.myDeaths.length || moment.ace !== null || moment.enemyDeaths)) {
    streak = moment.streak?.size ?? (moment.myKills.length >= 2 ? Math.min(5, moment.myKills.length) : 0)
    const points =
      moment.myKills.length +
      0.35 * moment.myAssists.length +
      (MULTIKILL_POINTS[streak] ?? 0) +
      (moment.ace !== null ? 1 : 0) +
      0.4 * moment.soloKills +
      0.15 * moment.enemyDeaths +
      (moment.firstBlood !== null ? 0.3 : 0)
    action = 1 - Math.exp(-points / ACTION_SCALE)
    const onlyDied = moment.myDeaths.length > 0 && !moment.myKills.length && !moment.myAssists.length
    if (onlyDied) action *= 0.35
    const kda = [
      moment.myKills.length ? plural(moment.myKills.length, 'kill') : '',
      moment.myAssists.length ? plural(moment.myAssists.length, 'assist') : ''
    ].filter(Boolean)
    if (kda.length) reasons.push(kda.join(', '))
    if (moment.ace !== null) reasons.push('your team aced them')
    if (moment.soloKills) reasons.push(moment.soloKills === 1 ? 'a solo kill' : `${moment.soloKills} solo kills`)
    if (onlyDied) reasons.push('you went down in it')
    label =
      streak >= 2
        ? STREAK_LABEL[streak]
        : moment.ace !== null
          ? 'Ace'
          : moment.firstBlood !== null
            ? 'First blood'
            : moment.soloKills
              ? 'Solo kill'
              : moment.myKills.length
                ? 'Kill'
                : onlyDied
                  ? 'Team fight'
                  : moment.myAssists.length
                    ? 'Team fight'
                    : label
  } else {
    action = KIND_ACTION[candidate.kind] ?? 0.3
    streak = KIND_STREAK[candidate.kind] ?? 0
  }

  // --- clutch ---
  let clutch: number | null = null
  if (moment) {
    const lastKill = moment.myKills.length ? Math.max(...moment.myKills) : null
    const survived = lastKill !== null && !moment.myDeaths.some((t) => t >= lastKill - 0.5)
    const low = lastKill !== null ? lowestHealth(candidate.feed!, from, lastKill + 1) : null
    const lowHealth = survived && low !== null && low < LOW_HEALTH ? 0.45 + 0.55 * ((LOW_HEALTH - low) / LOW_HEALTH) : 0
    const solo = Math.min(0.7, moment.soloKills * 0.3)
    const lived = streak >= 3 && survived ? 0.35 : 0
    // each one makes it more of a clutch, none alone makes it a perfect one
    clutch = 1 - (1 - lowHealth) * (1 - solo) * (1 - lived)
    if (lowHealth) reasons.push(`won it on ${Math.round(low! * 100)} % health`)
    if (lowHealth && streak < 5) label = `Clutch ${label.toLowerCase()}`
  }

  // --- stakes ---
  let stakes: number | null = null
  const game = candidate.game
  if (game && candidate.gameStart !== null) {
    const at = moment?.streak?.t ?? (moment?.myKills.length ? Math.max(...moment.myKills) : null) ?? moment?.ace ?? (from + to) / 2
    const end = Math.max(...[to, ...(moment?.myKills ?? [])])
    const decisive = game.win && (game.duration - end <= DECISIVE_SECONDS || moment?.gameEnd != null) ? 1 : 0
    let behind = 0
    let swing = 0
    if (game.timeline && game.curve.length > 1) {
      const before = goldAt(game.curve, at - 30)
      const after = goldAt(game.curve, at + 75)
      const wonFight = moment ? moment.enemyDeaths > moment.allyDeaths : false
      if (before !== null && wonFight) behind = clamp01(-before / BEHIND_FULL)
      if (before !== null && after !== null) swing = clamp01((after - before) / SWING_FULL)
      if (behind >= 0.35) reasons.push(`won the fight ${(Math.abs(before!) / 1000).toFixed(1)}k gold behind`)
      else if (swing >= 0.6) reasons.push('turned the gold lead around')
    }
    stakes = clamp01(0.4 * behind + 0.35 * swing + 0.45 * decisive)
    if (decisive) reasons.push('the fight that ended the game')
    if (decisive && streak < 5 && action >= 0.5) label = `Game-winning ${label.toLowerCase()}`
    else if (behind >= 0.5 && action >= 0.5 && !label.startsWith('Clutch')) label = `Comeback ${label.toLowerCase()}`
  }

  // --- hype ---
  let hype: number | null = null
  if (candidate.audio && candidate.audio.peak > SILENCE + 1) {
    const base = candidate.baseline ?? candidate.audio.median
    const loud = clamp01((candidate.audio.peak - base - LOUD_FROM) / LOUD_SPAN)
    const bursts = candidate.audio.envelope.filter((value) => value >= base + BURST).length
    hype = clamp01(0.7 * loud + 0.3 * Math.min(1, bursts / 5))
    if (hype >= 0.55) reasons.push('it got loud')
  }

  // --- intent ---
  const intent = candidate.favorite ? 1 : candidate.shared ? 0.8 : (INTENT[candidate.kind] ?? 0)
  if (candidate.favorite) reasons.push('one of your favourites')
  else if (candidate.shared) reasons.push('you shared it')
  else if (candidate.kind === 'bookmark') reasons.push('you bookmarked it')
  else if (candidate.kind === 'manual') reasons.push('you clipped it yourself')

  const parts: HighlightParts = { action, stakes, clutch, hype, intent }
  const weighted: [number, number | null][] = [
    [HIGHLIGHT_WEIGHTS.action, action],
    [HIGHLIGHT_WEIGHTS.hype, hype],
    [HIGHLIGHT_WEIGHTS.clutch, clutch],
    [HIGHLIGHT_WEIGHTS.stakes, stakes]
  ]
  const known_ = weighted.filter(([, value]) => value !== null) as [number, number][]
  const weight = known_.reduce((sum, [w]) => sum + w, 0)
  const base = known_.reduce((sum, [w, value]) => sum + w * value, 0) / weight
  let score = 100 * (base + (1 - base) * INTENT_LIFT * intent)
  score = Math.max(score, FLOORS[streak] ?? 0)

  // --- the part worth showing ---
  let core: { in: number; out: number }
  let peak: number | null
  const mine = moment
    ? [
        ...moment.myKills,
        ...moment.myAssists,
        ...(moment.ace !== null ? [moment.ace] : []),
        ...(moment.myKills.length ? [] : moment.myDeaths)
      ]
    : []
  if (moment && mine.length) {
    core = coreOf(
      mine.map((t) => t - from),
      duration,
      moment.ace !== null || moment.gameEnd !== null ? 1 : 0
    )
    const climax = moment.streak?.t ?? (moment.myKills.length ? Math.max(...moment.myKills) : Math.max(...mine))
    peak = round(climax - from)
  } else {
    const fallback = fallbackCore(candidate, duration)
    core = fallback.core
    peak = fallback.peak
  }
  return { clipId: candidate.clipId, score: Math.round(score), tier: tierOf(score), label, reasons, parts, core, peak }
}

// ---------------------------------------------------------------------------
// Picking the clips for a video
// ---------------------------------------------------------------------------

export type ReelKind = 'game' | 'month'

export interface ReelOptions {
  kind: ReelKind
  /** length of the video (without the slow motion), seconds */
  maxSeconds: number
  maxClips: number
  /** clips below this score are left out (the best one is kept down to MIN_ANY) */
  minScore: number
  /** month: at most this many clips of one game */
  perGame: number
}

export const REEL_GAME: ReelOptions = { kind: 'game', maxSeconds: 75, maxClips: 6, minScore: 35, perGame: 99 }
export const REEL_MONTH: ReelOptions = { kind: 'month', maxSeconds: 150, maxClips: 10, minScore: 50, perGame: 2 }
/** Below this not even the best clip makes a video. */
export const MIN_ANY = 20
/** Each further clip of the same champion counts this much less in a recap (variety). */
const SAME_CHAMPION = 0.9

/** What picking needs to know about a clip besides its score. */
export interface ReelClip {
  score: HighlightScore
  recordingId: number | null
  gameId: number | null
  championId: number | null
  /** position in its recording (to find two clips of the same moment) */
  startMs: number
  endMs: number
  createdAt: number
}

/** Two clips of the same recording that share more than 40 % of the shorter one show the same moment. */
function sameMoment(a: ReelClip, b: ReelClip): boolean {
  if (a.recordingId === null || a.recordingId !== b.recordingId) return false
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)
  return overlap > 0.4 * Math.min(a.endMs - a.startMs, b.endMs - b.startMs)
}

const coreSeconds = (clip: ReelClip): number => clip.score.core.out - clip.score.core.in

/**
 * The clips for a video, in the order they play. One clip per moment (the better of two that show
 * the same fight), best first until the length is used up; a recap takes at most `perGame` clips
 * of a game and favours variety of champions. A game's video plays in the order it happened; a
 * recap opens with its second-best clip, rises and ends on the best.
 */
export function pickHighlights(clips: readonly ReelClip[], options: ReelOptions): ReelClip[] {
  const ranked = [...clips].sort((a, b) => b.score.score - a.score.score || b.createdAt - a.createdAt)
  const unique: ReelClip[] = []
  for (const clip of ranked) if (!unique.some((kept) => sameMoment(kept, clip))) unique.push(clip)

  const picked: ReelClip[] = []
  let seconds = 0
  const pool = [...unique]
  while (pool.length && picked.length < options.maxClips) {
    // variety: the same champion again counts a little less each time
    const value = (clip: ReelClip): number =>
      clip.score.score *
      (options.kind === 'month' && clip.championId !== null
        ? SAME_CHAMPION ** picked.filter((other) => other.championId === clip.championId).length
        : 1)
    pool.sort((a, b) => value(b) - value(a))
    const next = pool.shift()!
    const floor = picked.length ? options.minScore : Math.min(options.minScore, MIN_ANY)
    if (next.score.score < floor) break
    if (
      options.kind === 'month' &&
      next.gameId !== null &&
      picked.filter((other) => other.gameId === next.gameId).length >= options.perGame
    )
      continue
    if (picked.length && seconds + coreSeconds(next) > options.maxSeconds) continue
    picked.push(next)
    seconds += coreSeconds(next)
  }
  if (options.kind === 'game') return picked.sort((a, b) => a.startMs - b.startMs || a.createdAt - b.createdAt)
  // recap: rising to the best, opened by the second best
  const rising = [...picked].sort((a, b) => a.score.score - b.score.score)
  if (rising.length >= 3) rising.unshift(rising.splice(rising.length - 2, 1)[0])
  return rising
}

// ---------------------------------------------------------------------------
// The video
// ---------------------------------------------------------------------------

export interface ReelText {
  /** big line at the start, e.g. "JINX · 14/3/9 · VICTORY" or "NOVEMBER 2026" */
  title: string
  /** smaller line under it */
  subtitle?: string
}

/** Slow motion around the climax of the best clip: from this long before to this long after it. */
const SLOW_BEFORE = 1.2
const SLOW_AFTER = 0.6
const TITLE_SECONDS = 2.8
const LABEL_SECONDS = 2.2

/**
 * The editor project of a highlight video: the core of each clip in a row, joined by fades (a
 * recap alternates glitch and fade), the best S-tier moment in half speed, a title at the start
 * and each clip's label as it begins. Exported for Discord by default; it can be opened in the
 * editor like any other project.
 */
export function buildHighlightProject(picked: readonly ReelClip[], kind: ReelKind, text: ReelText): EditProject | null {
  if (!picked.length) return null
  const best = picked.reduce((top, clip) => (clip.score.score > top.score.score ? clip : top), picked[0])
  const clips: ProjectClip[] = []
  const transitions: Transition[] = []
  /** index of the first part of each picked clip */
  const firstPart: number[] = []
  picked.forEach((clip, i) => {
    const { core, peak } = clip.score
    if (i > 0) transitions.push(kind === 'month' && i % 2 === 1 ? 'glitch' : 'fade')
    firstPart.push(clips.length)
    const slow =
      clip === best &&
      clip.score.tier === 'S' &&
      peak !== null &&
      peak - SLOW_BEFORE - core.in >= 1 &&
      core.out - (peak + SLOW_AFTER) >= 0.5
    if (slow) {
      clips.push({ clipId: clip.score.clipId, in: core.in, out: round(peak! - SLOW_BEFORE), speed: 1 })
      clips.push({ clipId: clip.score.clipId, in: round(peak! - SLOW_BEFORE), out: round(peak! + SLOW_AFTER), speed: 0.5 })
      clips.push({ clipId: clip.score.clipId, in: round(peak! + SLOW_AFTER), out: core.out, speed: 1 })
      transitions.push('cut', 'cut')
    } else clips.push({ clipId: clip.score.clipId, in: core.in, out: core.out, speed: 1 })
  })
  const parts = timeline({ clips, transitions })
  const texts: TextItem[] = [
    { id: 'title', kind: 'box', text: text.title, x: 0.5, y: 0.42, size: 0.085, color: '#ffffff', start: 0, end: TITLE_SECONDS, fade: 0.4 }
  ]
  if (text.subtitle)
    texts.push({
      id: 'subtitle',
      kind: 'box',
      text: text.subtitle,
      x: 0.5,
      y: 0.53,
      size: 0.042,
      color: '#f2c14e',
      start: 0.2,
      end: TITLE_SECONDS,
      fade: 0.4
    })
  picked.forEach((clip, i) => {
    const label = clip.score.label
    if (!label || label === 'Clip' || label === 'Bookmark') return
    // the first clip's label waits for the title to go
    const start = i === 0 ? TITLE_SECONDS + 0.2 : parts[firstPart[i]].start + parts[firstPart[i]].overlap
    const end = Math.min(start + LABEL_SECONDS, parts[firstPart[i]].end)
    if (end - start < 1) return
    texts.push({
      id: `label-${i}`,
      kind: 'box',
      text: label.toUpperCase(),
      x: 0.5,
      y: 0.84,
      size: 0.06,
      color: '#ffffff',
      start: round(start),
      end: round(end),
      fade: 0.3
    })
  })
  return {
    version: 1,
    clips,
    crop: { aspect: '16:9', x: 0.5, y: 0.5 },
    texts,
    stickers: [],
    overlays: { stats: null },
    // a recap gets a built-in loop under the game's sound; a game's video keeps only its own sound
    music:
      kind === 'month'
        ? { file: 'builtin:pentakill-rush', name: 'Pentakill Rush', offset: 0, volume: 0.35, duck: false, fadeIn: 1, fadeOut: 2.5 }
        : null,
    transitions,
    output: { preset: 'discord', targetMb: 20, gifFps: 15, gifWidth: 480 }
  }
}

/** Length of the picked clips' cores, seconds. */
export const reelSeconds = (picked: readonly ReelClip[]): number => round(picked.reduce((sum, clip) => sum + coreSeconds(clip), 0))

// ---------------------------------------------------------------------------
// What the window gets
// ---------------------------------------------------------------------------

/** A game's clips, or every clip of a month ("2026-11", local time). */
export type HighlightScope = { gameId: number } | { month: string }

export interface HighlightPlanClip {
  clipId: number
  score: number
  tier: HighlightTier
  label: string
  reasons: string[]
  /** the part that goes into the video, seconds inside the clip */
  core: { in: number; out: number }
  picked: boolean
}

/** What a highlight video of a scope would be made of, before it is made. */
export interface HighlightPlan {
  scope: HighlightScope
  title: string
  subtitle: string | null
  /** every clip that was looked at, best first */
  clips: HighlightPlanClip[]
  /** the clips of the video in the order they play */
  picked: number[]
  /** length of the video, seconds (the slow motion adds a little) */
  seconds: number
  /** why there is no video, null when there is one */
  empty: string | null
}

/** "2026-11" → first and last millisecond + 1 of that month, local time; null when it isn't a month. */
export function monthRange(month: string): { from: number; to: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return null
  const year = Number(match[1])
  const index = Number(match[2]) - 1
  if (index < 0 || index > 11) return null
  return { from: new Date(year, index, 1).getTime(), to: new Date(year, index + 1, 1).getTime() }
}

/** The month a time falls in, "2026-11" (local time). */
export const monthOf = (time: number): string => {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
