/**
 * Will to win: how much a team wanted to win, as a score from 0 to 100.
 *
 * It looks at effort, not at the result or at skill. Everything comes from Riot's own data – the
 * client's match history entry and its timeline – and is judged against what a typical team does
 * in the same situation, so getting stomped alone doesn't drag a team down:
 *
 *   will = clamp(base × presence − surrender, 0, 100)
 *
 *   base       weighted mean of three factors, each 0–100 with 50 = a typical team; a factor the
 *              game never put to the test is left out and the others share its weight
 *     teamplay  40 %  kill participation of the players who were there (do they fight together?)
 *     spirit    35 %  share of the kills won while ≥ 1.5k gold behind, against the share teams
 *                     usually win at that gold gap (do they keep fighting when it goes badly?)
 *     drive     25 %  buildings taken per minute while ≥ 1.5k gold ahead (do they close it out?)
 *   presence   share of the team that actually played: minutes a champion stood on the same spot
 *              for 3+ minutes in a row count as absent (AFK, left the game)
 *   surrender  15–25 points if the team gave up by surrender vote – more the closer the game was
 *
 * Calibrated on 45 ARAM: Mayhem games (90 teams) from the client's match history in November 2026.
 * A heuristic for fun, like the impact score – not a verdict on anybody.
 */
import type { GameSummary, RawGame, RawTimeline, SummaryPlayer } from './summary'

/** What the scale is built from, kept in the summary (games saved before 1.3.3 don't have it). */
export interface EffortSignals {
  /** the game ended by surrender vote; `ally` = your team gave up */
  surrender: { ally: boolean } | null
  /** ended by a remake vote in the first minutes – too short to judge */
  remake: boolean
  /** turrets and inhibitors destroyed, in seconds, and whether your team took them */
  buildings: { t: number; ally: boolean }[]
  /** minutes each player (puuid) stood still in stretches of IDLE_RUN+ minutes; empty without positions */
  idle: Record<string, number>
  /** minutes of positions the idle times were measured over; 0 when the timeline had none */
  tracked: number
}

export type WillFactorKey = 'teamplay' | 'spirit' | 'drive'

export interface WillFactor {
  key: WillFactorKey
  /** 0–100, 50 = a typical team; null when the game never put it to the test */
  score: number | null
  /** share of the base this factor had in this game (0 when untested) */
  weight: number
  /** teamplay: kill participation · spirit: share of the kills won while behind · drive: buildings per minute ahead */
  value: number
  /** what a typical team reaches there (for spirit: at the same gold gaps) */
  typical: number
  /** teamplay: the team's kills · spirit: kills (both sides) while behind · drive: buildings taken while ahead */
  count: number
  /** spirit: minutes behind · drive: minutes ahead · teamplay: 0 */
  minutes: number
}

export interface WillScore {
  /** 0–100 */
  score: number
  band: WillBand
  /** weighted mean of the tested factors, before presence and surrender */
  base: number
  /** share of the team that played, 0–1 */
  presence: number
  /** players who were away for a real part of the game, with the share they missed */
  absent: { puuid: string; share: number }[]
  /** points taken off for giving up by surrender vote, 0 if the team didn't */
  surrender: number
  factors: WillFactor[]
}

export interface WillBand {
  /** lowest score of the band */
  min: number
  label: string
  /** one line about what the band means */
  text: string
}

/** The five bands of the scale, lowest first. */
export const WILL_BANDS: WillBand[] = [
  { min: 0, label: 'Checked out', text: 'Barely played for the win.' },
  { min: 20, label: 'Half-hearted', text: 'Some effort, little conviction.' },
  { min: 40, label: 'Solid', text: 'A normal amount of fight.' },
  { min: 60, label: 'Determined', text: 'Played hard for the win.' },
  { min: 80, label: 'All in', text: 'Gave everything for the win.' }
]

export const bandOf = (score: number): WillBand => [...WILL_BANDS].reverse().find((band) => score >= band.min) ?? WILL_BANDS[0]

/** Factor weights before untested factors are left out. */
export const WILL_WEIGHTS: Record<WillFactorKey, number> = { teamplay: 0.4, spirit: 0.35, drive: 0.25 }

/** Gold gap (team gold minus enemy gold) from which a minute counts as behind or ahead. */
export const GAP = 1500
/** A factor needs this many minutes behind (spirit) or ahead (drive) to be tested. */
export const MIN_MINUTES = 2
/** Minutes in a row without moving from which a player counts as away. */
export const IDLE_RUN = 3
/** Distance (map units) below which a champion counts as not moved between two timeline frames. */
const STILL = 50

/**
 * Calibration (lo → 0, typical → 50, hi → 100). Kill participation differs by map: on the Howling
 * Abyss every fight is a teamfight (median 0.66 over the reference teams, 5–95 % at 0.53–0.79), on
 * Summoner's Rift about 0.55 is normal (estimate, not calibrated on own games).
 */
const TEAMPLAY_ARAM = { lo: 0.48, typical: 0.66, hi: 0.84 }
const TEAMPLAY_RIFT = { lo: 0.37, typical: 0.55, hi: 0.73 }
/** Virtual kills at the typical participation added, so that a team with few kills doesn't swing far. */
const TEAMPLAY_PRIOR = 10
/** Points of kill share above or below the expected share that make 0 or 100. */
const SPIRIT_SPAN = 0.15
/**
 * Virtual kills at the expected share added to the count: one kill is a coin flip, so the share
 * only means something over many (with 10 kills it would still be ± 16 points by chance alone).
 */
const SPIRIT_PRIOR = 10
/** Kills (both sides) while behind from which spirit is tested at all. */
const SPIRIT_MIN_KILLS = 4
/** Buildings per minute ahead (median of the reference teams 0.45). */
const DRIVE = { lo: 0, typical: 0.45, hi: 0.9 }
/** Virtual minutes ahead at the typical rate added, for the same reason. */
const DRIVE_PRIOR = 2
/**
 * Expected share of the kills at a gold gap: logistic, 50 % when even, 46 % at −5k, 43 % at −9k.
 * Fitted so that it predicts the 2,422 kills of the reference games that fell while one team was
 * behind (47.3 % won by the side behind, at −3.4k on average).
 */
const GOLD_SCALE = 31000
/** Points off for a surrender: the full amount in a close game, less the more hopeless it was. */
const SURRENDER_MAX = 25
const SURRENDER_MIN = 15
/** Without a gold curve the gap at the end is unknown: halfway. */
const SURRENDER_UNKNOWN = 20
/** Gold behind at which a surrender counts as fully understandable. */
const SURRENDER_HOPELESS = 10000
/** Shorter games (remakes, early disconnects) say nothing about the will to win. */
const MIN_DURATION = 5 * 60

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value))

/** Piecewise linear: lo → 0, typical → 50, hi → 100, clamped. */
export function ramp(value: number, { lo, typical, hi }: { lo: number; typical: number; hi: number }): number {
  const score = value <= typical ? 50 * ((value - lo) / (typical - lo)) : 50 + 50 * ((value - typical) / (hi - typical))
  return clamp(score, 0, 100)
}

/** Share of the kills a team usually wins at this gold gap (its gold minus the enemy's). */
export const expectedKillShare = (gap: number): number => 1 / (1 + Math.exp(-gap / GOLD_SCALE))

const flag = (stats: Record<string, unknown> | undefined, key: string): boolean => stats?.[key] === true

/**
 * Reads the signals from the client's match history entry and timeline. `myTeam` is the teamId of
 * your side, `puuidOf` maps participantId → puuid (as used in the summary).
 */
export function readEffort(game: RawGame, timeline: RawTimeline | null, myTeam: number, puuidOf: Map<number, string>): EffortSignals {
  const participants = game.participants
  // an "early surrender" is the remake vote of the first minutes
  const remake = participants.some((participant) => flag(participant.stats, 'gameEndedInEarlySurrender'))
  const surrendered = participants.some((participant) => flag(participant.stats, 'gameEndedInSurrender'))
  // the side that surrendered is the side that lost
  const myStats = participants.find((participant) => participant.teamId === myTeam)?.stats
  const surrender = surrendered && !remake ? { ally: myStats?.win !== true } : null

  const teamOf = new Map(participants.map((participant) => [participant.participantId, participant.teamId]))
  const buildings: EffortSignals['buildings'] = []
  const idle: Record<string, number> = {}
  let tracked = 0
  const frames = timeline?.frames ?? []
  for (const frame of frames) {
    for (const event of frame.events ?? []) {
      if (event.type !== 'BUILDING_KILL') continue
      // teamId is the side that lost the building; older timelines may only name the killer
      const owner = event.teamId || (event.killerId ? (teamOf.get(event.killerId) === 100 ? 200 : 100) : 0)
      if (owner) buildings.push({ t: event.timestamp / 1000, ally: owner !== myTeam })
    }
  }
  // from the second frame (1:00) on: in the first minute many still stand in the fountain
  const FIRST = 1
  if (frames.length > FIRST + 1 && frames.some((frame) => Object.values(frame.participantFrames ?? {}).some((player) => player.position))) {
    tracked = (frames[frames.length - 1].timestamp - frames[FIRST].timestamp) / 60000
    for (const participant of participants) {
      const id = String(participant.participantId)
      let run = 0
      let runMinutes = 0
      let away = 0
      for (let i = FIRST + 1; i < frames.length; i++) {
        const before = frames[i - 1].participantFrames?.[id]?.position
        const after = frames[i].participantFrames?.[id]?.position
        const minutes = (frames[i].timestamp - frames[i - 1].timestamp) / 60000
        if (before && after && Math.hypot(after.x - before.x, after.y - before.y) < STILL) {
          run++
          runMinutes += minutes
        } else {
          if (run >= IDLE_RUN) away += runMinutes
          run = 0
          runMinutes = 0
        }
      }
      if (run >= IDLE_RUN) away += runMinutes
      const puuid = puuidOf.get(participant.participantId)
      if (puuid) idle[puuid] = Math.round(away * 10) / 10
    }
  }
  return { surrender, remake, buildings, idle, tracked: Math.round(tracked * 10) / 10 }
}

/** Gold gap of one side at a moment: the last curve point at or before it. */
function gapAt(curve: GameSummary['curve'], t: number, sign: number): number | null {
  let gap: number | null = null
  for (const point of curve) {
    if (point.t > t) break
    gap = sign * point.gold
  }
  return gap
}

/** Minutes the side spent behind (side = -1) or ahead (side = 1) by GAP or more. */
function minutesAt(curve: GameSummary['curve'], sign: number, side: 1 | -1): number {
  let minutes = 0
  for (let i = 1; i < curve.length; i++) {
    const gap = sign * curve[i - 1].gold
    if (side * gap >= GAP) minutes += (curve[i].t - curve[i - 1].t) / 60
  }
  return minutes
}

/** How much a player took part: 1 = the whole game, 0 = never there. */
function activityOf(player: SummaryPlayer, effort: EffortSignals): number {
  if (effort.tracked > 0 && player.puuid in effort.idle) return clamp(1 - effort.idle[player.puuid] / effort.tracked, 0, 1)
  // no positions: only someone who did nothing at all counts as away
  return player.kills + player.deaths + player.assists === 0 && player.damage === 0 ? 0 : 1
}

const ARAM_MODES = new Set(['ARAM', 'KIWI'])
/** Arena: eight teams of two, there is no "the enemy team". */
const NOT_TWO_TEAMS = new Set(['CHERRY'])

/**
 * Will to win of your team (`ally` true) or the enemy team. Null for games without the signals
 * (saved before 1.3.3), remakes and very short games, and modes without two real teams.
 */
export function willToWin(summary: GameSummary, ally = true): WillScore | null {
  const effort = summary.effort
  if (!effort || effort.remake || summary.duration < MIN_DURATION || NOT_TWO_TEAMS.has(summary.mode)) return null
  const team = summary.players.filter((player) => player.ally === ally)
  const enemies = summary.players.filter((player) => player.ally !== ally)
  if (team.length < 2 || enemies.length < 2) return null
  // the curve and the kills are from your side; flip them for the enemy
  const sign = ally ? 1 : -1
  const timeline = summary.curveSource === 'timeline'

  // presence
  const activity = team.map((player) => activityOf(player, effort))
  const presence = activity.reduce((total, value) => total + value, 0) / team.length
  const absent = team
    .map((player, i) => ({ puuid: player.puuid, share: Math.round((1 - activity[i]) * 100) / 100 }))
    .filter((player) => player.share >= 0.1)

  // teamplay: kill participation of the players who were there, weighted by how long they were
  const teamKills = team.reduce((total, player) => total + player.kills, 0)
  const anchors = ARAM_MODES.has(summary.mode) ? TEAMPLAY_ARAM : TEAMPLAY_RIFT
  const present = activity.reduce((total, value) => total + value, 0)
  const participation =
    teamKills > 0 && present > 0
      ? team.reduce((total, player, i) => total + activity[i] * ((player.kills + player.assists) / teamKills), 0) / present
      : 0
  const settled = (participation * teamKills + anchors.typical * TEAMPLAY_PRIOR) / (teamKills + TEAMPLAY_PRIOR)
  const teamplay: WillFactor = {
    key: 'teamplay',
    score: teamKills >= 5 && present > 0 ? ramp(settled, anchors) : null,
    weight: WILL_WEIGHTS.teamplay,
    value: participation,
    typical: anchors.typical,
    count: teamKills,
    minutes: 0
  }

  // spirit: kills won while behind against the share expected at those gold gaps
  const behind = timeline ? minutesAt(summary.curve, sign, -1) : 0
  let won = 0
  let fought = 0
  let expected = 0
  if (timeline) {
    for (const kill of summary.kills) {
      const gap = gapAt(summary.curve, kill.t, sign)
      if (gap === null || gap > -GAP) continue
      fought++
      if (kill.ally === ally) won++
      expected += expectedKillShare(gap)
    }
  }
  const spirit: WillFactor = {
    key: 'spirit',
    score:
      behind >= MIN_MINUTES && fought >= SPIRIT_MIN_KILLS
        ? clamp(50 + 50 * ((won - expected) / (fought + SPIRIT_PRIOR) / SPIRIT_SPAN), 0, 100)
        : null,
    weight: WILL_WEIGHTS.spirit,
    value: fought ? won / fought : 0,
    typical: fought ? expected / fought : 0.5,
    count: fought,
    minutes: behind
  }

  // drive: buildings taken while ahead
  const ahead = timeline ? minutesAt(summary.curve, sign, 1) : 0
  let taken = 0
  for (const building of effort.buildings) {
    if (building.ally !== ally) continue
    const gap = gapAt(summary.curve, building.t, sign)
    if (gap !== null && gap >= GAP) taken++
  }
  const driveRate = (taken + DRIVE.typical * DRIVE_PRIOR) / (ahead + DRIVE_PRIOR)
  const drive: WillFactor = {
    key: 'drive',
    score: ahead >= MIN_MINUTES ? ramp(driveRate, DRIVE) : null,
    weight: WILL_WEIGHTS.drive,
    value: ahead > 0 ? taken / ahead : 0,
    typical: DRIVE.typical,
    count: taken,
    minutes: ahead
  }

  const factors = [teamplay, spirit, drive]
  const tested = factors.filter((factor) => factor.score !== null)
  const totalWeight = tested.reduce((total, factor) => total + factor.weight, 0)
  for (const factor of factors) factor.weight = factor.score === null || !totalWeight ? 0 : factor.weight / totalWeight
  const base = totalWeight ? tested.reduce((total, factor) => total + factor.weight * (factor.score as number), 0) : 50

  // surrender: the closer the game still was, the more it costs
  let surrender = 0
  if (effort.surrender && effort.surrender.ally === ally) {
    const last = summary.curve[summary.curve.length - 1]
    surrender = last
      ? SURRENDER_MAX - (SURRENDER_MAX - SURRENDER_MIN) * clamp(Math.max(0, -sign * last.gold) / SURRENDER_HOPELESS, 0, 1)
      : SURRENDER_UNKNOWN
  }

  const score = Math.round(clamp(base * presence - surrender, 0, 100))
  return { score, band: bandOf(score), base, presence, absent, surrender, factors }
}

// ---------------------------------------------------------------------------
// Text (the game page and the Discord post say the same)
// ---------------------------------------------------------------------------

export const WILL_FACTOR_NAMES: Record<WillFactorKey, string> = {
  teamplay: 'Teamplay',
  spirit: 'Fighting spirit',
  drive: 'Closing drive'
}

const pct = (value: number): string => `${Math.round(value * 100)} %`
const mins = (value: number): string => `${Math.round(value)} min`
const GOLD = `${GAP / 1000}k`

/** What a factor measured for one team, in one line. */
export function willFactorText(factor: WillFactor): string {
  if (factor.key === 'teamplay') {
    if (factor.score === null) return 'Too few kills to judge'
    return `${pct(factor.value)} kill participation · typical ${pct(factor.typical)}`
  }
  if (factor.key === 'spirit') {
    if (factor.score === null) {
      return factor.minutes >= 1
        ? `Only ${factor.count} kill${factor.count === 1 ? '' : 's'} while ${GOLD}+ behind – too few to judge`
        : `Never ${GOLD}+ gold behind for long – not tested`
    }
    return `Won ${pct(factor.value)} of ${factor.count} kills while ${GOLD}+ behind (${mins(factor.minutes)}) · expected ${pct(factor.typical)}`
  }
  if (factor.score === null) return `Never ${GOLD}+ gold ahead for long – not tested`
  return `${factor.count} building${factor.count === 1 ? '' : 's'} taken in ${mins(factor.minutes)} ahead · typical ${(factor.typical * factor.minutes).toFixed(1)}`
}

/** Who was away, in one line; `name` turns a puuid into what to show. */
export function willPresenceText(will: WillScore, name: (puuid: string) => string): string {
  if (!will.absent.length) return 'Everyone played the whole game'
  return `${will.absent.map((player) => `${name(player.puuid)} away ${pct(player.share)}`).join(', ')} of the game`
}

export const willSurrenderText = (will: WillScore): string => (will.surrender ? 'Gave up by surrender vote' : 'Played it out')

/** Which team wanted it more, or null when the enemy can't be judged. */
export function willVerdict(ours: WillScore, theirs: WillScore | null): string | null {
  if (!theirs) return null
  if (Math.abs(ours.score - theirs.score) < 10) return 'Both teams wanted it about the same.'
  return ours.score > theirs.score ? 'Your team wanted it more.' : 'The enemy wanted it more.'
}
