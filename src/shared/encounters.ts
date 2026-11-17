/**
 * "Have I met this player before?" – for every stranger on the loading screen, what your saved
 * games say about them: how often you played with and against them, how that went, and the last
 * time you met. Pure functions; the numbers come from the game database (GameStore.encounters).
 */

/** You with them / against them, from your point of view: `wins` are games you won. */
export interface WinCount {
  games: number
  wins: number
}

/** The last game you shared with a player, from their side: their champion and K/D/A. */
export interface EncounterGame {
  gameId: number
  createdAt: number
  championId: number
  kda: [number, number, number]
  /** they were on your team */
  ally: boolean
  /** you won */
  win: boolean
}

/** What the database knows about you and one other player. */
export interface EncounterStats {
  together: WinCount
  against: WinCount
  last: EncounterGame
  /** the Riot ID they had in that last game */
  riotId: string
}

export type EncounterKind = 'nemesis' | 'victim' | 'luckyCharm' | 'jinx' | 'rival' | 'familiar'

export interface Encounter {
  kind: EncounterKind
  together: WinCount
  against: WinCount
  last: EncounterGame
  /** their Riot ID back then, when it differs from the current one */
  formerRiotId?: string
}

/** Where one kind starts. Win rates are yours: against a nemesis you win little, with a lucky charm a lot. */
export const ENCOUNTER_RULES = {
  /** games against them before they count as nemesis or victim */
  againstGames: 3,
  nemesisMaxWinRate: 1 / 3,
  victimMinWinRate: 2 / 3,
  /** games with them before they count as lucky charm or jinx */
  togetherGames: 3,
  luckyCharmMinWinRate: 0.75,
  jinxMaxWinRate: 0.25,
  /** games against them for a rival */
  rivalGames: 2
} as const

/** Display names of the kinds, also used as the badge tooltip. */
export const ENCOUNTER_LABELS: Record<EncounterKind, string> = {
  nemesis: 'Nemesis',
  victim: 'Victim',
  luckyCharm: 'Lucky charm',
  jinx: 'Jinx',
  rival: 'Rival',
  familiar: 'Familiar face'
}

/** Longest line the loading screen row has room for. */
export const MAX_ENCOUNTER_LINE = 48

// rounding errors must not move a game across a border (2 of 3 is exactly 0.667, which counts as 67 %)
const EPSILON = 1e-9
const rate = (count: WinCount): number => (count.games ? count.wins / count.games : 0)

/** The kind of a player you met before, null when you never played with or against them. */
export function classifyEncounter(together: WinCount, against: WinCount): EncounterKind | null {
  const rules = ENCOUNTER_RULES
  if (against.games >= rules.againstGames) {
    if (rate(against) <= rules.nemesisMaxWinRate + EPSILON) return 'nemesis'
    if (rate(against) >= rules.victimMinWinRate - EPSILON) return 'victim'
  }
  if (together.games >= rules.togetherGames) {
    if (rate(together) >= rules.luckyCharmMinWinRate - EPSILON) return 'luckyCharm'
    if (rate(together) <= rules.jinxMaxWinRate + EPSILON) return 'jinx'
  }
  if (against.games >= rules.rivalGames) return 'rival'
  if (together.games + against.games >= 1) return 'familiar'
  return null
}

/** Turns the database numbers into an encounter. `currentRiotId` is how the player is called today. */
export function toEncounter(stats: EncounterStats | null | undefined, currentRiotId = ''): Encounter | null {
  if (!stats) return null
  const kind = classifyEncounter(stats.together, stats.against)
  if (!kind) return null
  const encounter: Encounter = { kind, together: stats.together, against: stats.against, last: stats.last }
  const before = stats.riotId.trim()
  if (before && currentRiotId.trim() && before.toLowerCase() !== currentRiotId.trim().toLowerCase()) encounter.formerRiotId = before
  return encounter
}

// FNV-1a like quips.ts, so the same player gets the same line on every loading screen of a game
const hash = (text: string): number => {
  let value = 2166136261
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619)
  return value >>> 0
}

/** "today", "yesterday", "12 days ago", "3 months ago". */
export function agoText(timestamp: number, now: number): string {
  const days = Math.floor((now - timestamp) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  const months = Math.round(days / 30.4)
  return months < 24 ? `${months} months ago` : `${Math.round(days / 365)} years ago`
}

interface LineContext {
  e: Encounter
  /** your wins and losses against / with them */
  w: number
  l: number
  champ: string
  kda: string
  ago: string
  old: string
}
type Line = (ctx: LineContext) => string

const lastTime: Line = (ctx) => `Last time: ${ctx.kda} ${ctx.champ}, ${ctx.ago}`

/** A few lines per kind. Friendly roasting about the games, never about the person. */
const LINES: Record<EncounterKind, Line[]> = {
  nemesis: [
    (ctx) => `Nemesis: beat you ${ctx.l}–${ctx.w}`,
    (ctx) => `Your nemesis. ${ctx.l}–${ctx.w} for them.`,
    (ctx) => `Has your number: ${ctx.l}–${ctx.w}`,
    (ctx) => `Owns you ${ctx.l}–${ctx.w}. Dodge? Too late.`,
    (ctx) => `${ctx.l}–${ctx.w} against you. Revenge time.`
  ],
  victim: [
    (ctx) => `Victim: you're ${ctx.w}–${ctx.l} against them`,
    (ctx) => `Free win? ${ctx.w}–${ctx.l} for you so far`,
    (ctx) => `You farm them: ${ctx.w}–${ctx.l}`,
    (ctx) => `${ctx.w}–${ctx.l} for you. Be gentle.`
  ],
  luckyCharm: [
    (ctx) => `Lucky charm: ${ctx.w}–${ctx.l} together`,
    (ctx) => `Good omen: ${ctx.w}–${ctx.l} as teammates`,
    (ctx) => `${ctx.w}–${ctx.l} together. Keep them close.`,
    (ctx) => `Your four-leaf clover: ${ctx.w}–${ctx.l}`
  ],
  jinx: [
    (ctx) => `Jinx: ${ctx.w}–${ctx.l} together. Uh-oh.`,
    (ctx) => `Bad omen: ${ctx.w}–${ctx.l} as teammates`,
    (ctx) => `${ctx.w}–${ctx.l} together. Pray.`,
    (ctx) => `Cursed duo: ${ctx.w}–${ctx.l} with them`
  ],
  rival: [
    (ctx) => `Rival: ${ctx.w}–${ctx.l} head to head`,
    (ctx) => `Rematch! ${ctx.w}–${ctx.l} so far`,
    (ctx) => `Old rivals: ${ctx.w}–${ctx.l}`,
    lastTime
  ],
  familiar: [
    lastTime,
    (ctx) => `Met ${ctx.ago}: ${ctx.kda} ${ctx.champ}`,
    (ctx) => (ctx.e.last.ally ? `Teammate ${ctx.ago} on ${ctx.champ}` : `Enemy ${ctx.ago} on ${ctx.champ}`),
    (ctx) => (ctx.old ? `Seen before as ${ctx.old}` : lastTime(ctx))
  ]
}

const fit = (line: string): string => (line.length <= MAX_ENCOUNTER_LINE ? line : `${line.slice(0, MAX_ENCOUNTER_LINE - 1).trimEnd()}…`)

/**
 * A short, cheeky one-liner (at most MAX_ENCOUNTER_LINE characters) about you and a player you met
 * before, e.g. "Nemesis: beat you 3–0" or "Last time: 2/14 Yasuo, 12 days ago". The same encounter
 * always gets the same line. `champName` turns a champion id into a name.
 */
export function encounterLine(e: Encounter, options: { champName?: (championId: number) => string; now?: number } = {}): string {
  const versus = e.kind === 'nemesis' || e.kind === 'victim' || e.kind === 'rival'
  const count = versus ? e.against : e.together
  const [k, d, a] = e.last.kda
  const ctx: LineContext = {
    e,
    w: count.wins,
    l: count.games - count.wins,
    champ: options.champName?.(e.last.championId) || 'someone',
    kda: `${k}/${d}/${a}`,
    ago: agoText(e.last.createdAt, options.now ?? Date.now()),
    old: (e.formerRiotId ?? '').split('#')[0]
  }
  const pool = LINES[e.kind]
  const start = hash(`${e.kind}:${e.last.gameId}:${count.games}`) % pool.length
  // the first line from the hashed start that fits, else the shortest one cut down
  for (let i = 0; i < pool.length; i++) {
    const line = pool[(start + i) % pool.length](ctx)
    if (line.length <= MAX_ENCOUNTER_LINE) return line
  }
  return fit(pool.map((line) => line(ctx)).sort((x, y) => x.length - y.length)[0])
}

/**
 * The same numbers as GameStore.encounters, computed from summaries (web demo, tests). `me` is your
 * puuid, or null for whoever is marked as you in each game.
 */
export function encounterStatsFromSummaries(
  summaries: readonly {
    gameId: number
    createdAt: number
    win: boolean
    players: readonly {
      puuid: string
      riotId: string
      me: boolean
      ally: boolean
      championId: number
      kills: number
      deaths: number
      assists: number
    }[]
  }[],
  me: string | null,
  puuids: readonly string[],
  excludeGameId: number | null = null
): Map<string, EncounterStats> {
  const wanted = new Set(puuids.filter((puuid) => puuid !== me))
  const result = new Map<string, EncounterStats>()
  const newestFirst = [...summaries].sort((a, b) => b.createdAt - a.createdAt || b.gameId - a.gameId)
  for (const summary of newestFirst) {
    if (summary.gameId === excludeGameId) continue
    const self = summary.players.find((player) => player.me && (!me || player.puuid === me))
    if (!self) continue
    for (const player of summary.players) {
      if (player.me || player.puuid === self.puuid || !wanted.has(player.puuid)) continue
      let stats = result.get(player.puuid)
      if (!stats) {
        stats = {
          together: { games: 0, wins: 0 },
          against: { games: 0, wins: 0 },
          riotId: player.riotId,
          last: {
            gameId: summary.gameId,
            createdAt: summary.createdAt,
            championId: player.championId,
            kda: [player.kills, player.deaths, player.assists],
            ally: player.ally,
            win: summary.win
          }
        }
        result.set(player.puuid, stats)
      }
      const side = player.ally ? stats.together : stats.against
      side.games++
      side.wins += summary.win ? 1 : 0
    }
  }
  return result
}

/** The players of a game that get an encounter: everyone except you and the people you queued with. */
export function encounterTargets(players: readonly { puuid: string; me: boolean; premade: boolean }[]): string[] {
  return players.filter((player) => !player.me && !player.premade && player.puuid).map((player) => player.puuid)
}
