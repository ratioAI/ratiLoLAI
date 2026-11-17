/**
 * Achievements. Each one is a constellation in the sky of the star map: locked ones are a few faint
 * stars, unlocked ones light up in their rank's colour with their lines drawn in.
 *
 * Everything is worked out from the saved games (oldest first) plus a little the games don't know:
 * the flights you watched and the galaxies they took you to. Pure and deterministic: the same
 * history always unlocks the same achievements at the same games. An achievement unlocks at the
 * game that first meets its condition; unlocks that come from flights alone have no game.
 */
import type { Tier } from './types'
import { teamBlame, type GameSummary, type SummaryPlayer } from './summary'
import { ratioApproved } from './quips'
import { GALAXY_TYPES, UNIVERSE, cosmicSeed, cross, extentOf, galaxyOf, length, normalize, type Vec3 } from './universe'

export type AchievementCategory = 'combat' | 'augments' | 'team' | 'endurance' | 'cosmos' | 'secret'
export type AchievementRank = 'bronze' | 'silver' | 'gold' | 'cosmic'

export const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  combat: 'Combat',
  augments: 'Augments',
  team: 'Team',
  endurance: 'Endurance',
  cosmos: 'Cosmos',
  secret: 'Secret'
}
export const RANK_ORDER: AchievementRank[] = ['bronze', 'silver', 'gold', 'cosmic']

/** Flights watched per kind (see shared/journey.ts). */
export type FlightCounts = Partial<Record<'wormhole' | 'slingshot', number>>

/** What the saved games don't know. */
export interface AchievementExtra {
  flights: FlightCounts
  /** ids of galaxies the flights took you to (games add their own galaxy) */
  galaxiesVisited: number[]
}

export interface AchievementOptions {
  /** augment tiers of a game's players by puuid (shared/mayhem summaryAugmentTiers); without it augment achievements stay locked */
  augTiers?: (summary: GameSummary) => Record<string, (Tier | undefined)[]>
  /** local hour of a timestamp (tests pass their own) */
  hourOf?: (timestamp: number) => number
  /** local calendar day of a timestamp as a running day number */
  dayOf?: (timestamp: number) => number
}

/** One game as the achievements see it. */
export interface GameView {
  summary: GameSummary
  me: SummaryPlayer
  allies: SummaryPlayer[]
  /** tiers of your augments for your champion */
  myTiers: (Tier | undefined)[]
  galaxy: number
  hour: number
  day: number
}

/** Running numbers of one achievement: fed game by game, read out with or without the extra. */
interface Tracker {
  add(game: GameView): void
  value(extra: AchievementExtra): number
}

export interface AchievementDef {
  id: string
  name: string
  description: string
  category: AchievementCategory
  rank: AchievementRank
  /** hidden until unlocked */
  secret?: boolean
  /** progress needed (1 when missing) */
  goal?: number
  track(): Tracker
}

export interface AchievementProgress {
  id: string
  unlocked: boolean
  /** the game that unlocked it (none when the flights did) */
  gameId?: number
  /** when that game ended */
  at?: number
  progress: number
  goal: number
}

// --- building blocks ---------------------------------------------------------------------------

/** Unlocked by a single game that meets the condition. */
const once = (test: (game: GameView) => boolean) => (): Tracker => {
  let hit = false
  return {
    add: (game) => void (hit ||= test(game)),
    value: () => (hit ? 1 : 0)
  }
}

/** Number of games that meet the condition. */
const count = (test: (game: GameView) => boolean) => (): Tracker => {
  let n = 0
  return {
    add: (game) => void (n += test(game) ? 1 : 0),
    value: () => n
  }
}

/** Longest run of games in a row that meet the condition. */
const streak = (test: (game: GameView) => boolean) => (): Tracker => {
  let run = 0
  let best = 0
  return {
    add: (game) => {
      run = test(game) ? run + 1 : 0
      best = Math.max(best, run)
    },
    value: () => best
  }
}

/** Galaxies seen: from games, plus those of the flights. `measure` turns the set into a number. */
const galaxies = (measure: (ids: Set<number>) => number) => (): Tracker => {
  const seen = new Set<number>()
  return {
    add: (game) => void seen.add(game.galaxy),
    value: (extra) => measure(new Set([...seen, ...extra.galaxiesVisited]))
  }
}

const troll = (game: GameView): boolean => game.allies.length > 1 && teamBlame(game.summary)?.puuid === game.me.puuid
const goldExtremes = (game: GameView): { top: number; low: number } => {
  const curve = game.summary.curve ?? []
  return { top: Math.max(0, ...curve.map((point) => point.gold)), low: Math.min(0, ...curve.map((point) => point.gold)) }
}
const D_TIER: Tier = 'D'

// --- the catalogue -----------------------------------------------------------------------------

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // combat
  {
    id: 'penta',
    name: 'Pentakill',
    description: 'Get a pentakill.',
    category: 'combat',
    rank: 'gold',
    track: once((game) => (game.me.pentas ?? 0) > 0)
  },
  {
    id: 'quadra',
    name: 'Quadra',
    description: 'Get a quadra kill.',
    category: 'combat',
    rank: 'silver',
    track: once((game) => (game.me.multikill ?? 0) >= 4)
  },
  {
    id: 'triple',
    name: 'Triple Threat',
    description: 'Get a triple kill.',
    category: 'combat',
    rank: 'bronze',
    track: once((game) => (game.me.multikill ?? 0) >= 3)
  },
  {
    id: 'kills20',
    name: 'Body Count',
    description: 'Get 20 or more kills in one game.',
    category: 'combat',
    rank: 'silver',
    track: once((game) => game.me.kills >= 20)
  },
  {
    id: 'untouchable',
    name: 'Untouchable',
    description: 'Win a game without dying once.',
    category: 'combat',
    rank: 'gold',
    track: once((game) => game.summary.win && game.me.deaths === 0)
  },
  {
    id: 'oneManArmy',
    name: 'One-Man Army',
    description: 'Get at least half of your team’s kills (10 or more team kills).',
    category: 'combat',
    rank: 'silver',
    track: once((game) => {
      const teamKills = game.allies.reduce((sum, player) => sum + player.kills, 0)
      return teamKills >= 10 && game.me.kills * 2 >= teamKills
    })
  },
  // augments
  {
    id: 'ratioApproved',
    name: 'Ratio Approved',
    description: 'Take only S-tier augments for your champion (two or more).',
    category: 'augments',
    rank: 'silver',
    track: once((game) => ratioApproved(game.myTiers))
  },
  {
    id: 'ratioCertified',
    name: 'Ratio Certified',
    description: 'Get Ratio Approved in 10 games.',
    category: 'augments',
    rank: 'gold',
    goal: 10,
    track: count((game) => ratioApproved(game.myTiers))
  },
  {
    id: 'trapEnjoyer',
    name: 'Trap Enjoyer',
    description: 'Take three D-tier augments in one game.',
    category: 'augments',
    rank: 'bronze',
    track: once((game) => game.myTiers.filter((tier) => tier === D_TIER).length >= 3)
  },
  // team
  {
    id: 'mvp10',
    name: 'Most Valuable',
    description: 'Be your team’s MVP 10 times.',
    category: 'team',
    rank: 'silver',
    goal: 10,
    track: count((game) => game.summary.mvp === game.me.puuid)
  },
  {
    id: 'mvp50',
    name: 'Hall of Fame',
    description: 'Be your team’s MVP 50 times.',
    category: 'team',
    rank: 'gold',
    goal: 50,
    track: count((game) => game.summary.mvp === game.me.puuid)
  },
  {
    id: 'serialOffender',
    name: 'Serial Offender',
    description: 'Be your team’s troll three games in a row.',
    category: 'team',
    rank: 'bronze',
    goal: 3,
    track: streak(troll)
  },
  {
    id: 'fullStack',
    name: 'Full Stack',
    description: 'Win with four premades.',
    category: 'team',
    rank: 'silver',
    track: once((game) => game.summary.win && game.allies.filter((player) => player.premade && !player.me).length >= 4)
  },
  {
    id: 'bestDuo',
    name: 'Best Duo',
    description: 'Play 50 games with the same premade.',
    category: 'team',
    rank: 'gold',
    goal: 50,
    track: () => {
      const games = new Map<string, number>()
      let best = 0
      return {
        add: (game) => {
          for (const player of game.allies) {
            if (!player.premade || player.me) continue
            const n = (games.get(player.puuid) ?? 0) + 1
            games.set(player.puuid, n)
            best = Math.max(best, n)
          }
        },
        value: () => best
      }
    }
  },
  // endurance
  {
    id: 'games100',
    name: 'Regular',
    description: 'Play 100 games.',
    category: 'endurance',
    rank: 'bronze',
    goal: 100,
    track: count(() => true)
  },
  {
    id: 'games500',
    name: 'Veteran',
    description: 'Play 500 games.',
    category: 'endurance',
    rank: 'silver',
    goal: 500,
    track: count(() => true)
  },
  {
    id: 'games1000',
    name: 'Touch Grass',
    description: 'Play 1000 games.',
    category: 'endurance',
    rank: 'cosmic',
    goal: 1000,
    track: count(() => true)
  },
  {
    id: 'days7',
    name: 'Daily Dose',
    description: 'Play on seven days in a row.',
    category: 'endurance',
    rank: 'silver',
    goal: 7,
    track: () => {
      let lastDay: number | null = null
      let run = 0
      let best = 0
      return {
        add: (game) => {
          if (game.day === lastDay) return
          run = lastDay !== null && game.day === lastDay + 1 ? run + 1 : 1
          lastDay = game.day
          best = Math.max(best, run)
        },
        value: () => best
      }
    }
  },
  {
    id: 'winStreak10',
    name: 'Unstoppable',
    description: 'Win 10 games in a row.',
    category: 'endurance',
    rank: 'gold',
    goal: 10,
    track: streak((game) => game.summary.win)
  },
  // cosmos
  {
    id: 'galaxies25',
    name: 'Stargazer',
    description: 'Visit 25 galaxies.',
    category: 'cosmos',
    rank: 'bronze',
    goal: 25,
    track: galaxies((ids) => ids.size)
  },
  {
    id: 'galaxies100',
    name: 'Cartographer',
    description: 'Visit 100 galaxies.',
    category: 'cosmos',
    rank: 'gold',
    goal: 100,
    track: galaxies((ids) => ids.size)
  },
  {
    id: 'bothFlights',
    name: 'Frequent Flyer',
    description: 'Travel through a wormhole and swing by a black hole.',
    category: 'cosmos',
    rank: 'bronze',
    goal: 2,
    track: () => ({
      add: () => undefined,
      value: (extra) => ((extra.flights.wormhole ?? 0) > 0 ? 1 : 0) + ((extra.flights.slingshot ?? 0) > 0 ? 1 : 0)
    })
  },
  {
    id: 'allKinds',
    name: 'Taxonomist',
    description: `Visit every kind of galaxy (${GALAXY_TYPES.length}).`,
    category: 'cosmos',
    rank: 'cosmic',
    goal: GALAXY_TYPES.length,
    track: galaxies((ids) => new Set([...ids].map((id) => UNIVERSE[id]?.type).filter(Boolean)).size)
  },
  // secret
  {
    id: 'throwOfTheCentury',
    name: 'Throw of the Century',
    description: 'Lose a game your team led by 8k gold or more.',
    category: 'secret',
    rank: 'silver',
    secret: true,
    track: once((game) => !game.summary.win && goldExtremes(game).top >= 8000)
  },
  {
    id: 'miracle',
    name: 'Miracle',
    description: 'Win a game your team was down 8k gold or more.',
    category: 'secret',
    rank: 'gold',
    secret: true,
    track: once((game) => game.summary.win && goldExtremes(game).low <= -8000)
  },
  {
    id: 'donationAccount',
    name: 'Donation Account',
    description: 'Die 15 times or more in one game.',
    category: 'secret',
    rank: 'bronze',
    secret: true,
    track: once((game) => game.me.deaths >= 15)
  },
  {
    id: 'speedrun',
    name: 'Speedrun',
    description: 'Win a game in under 14 minutes.',
    category: 'secret',
    rank: 'silver',
    secret: true,
    track: once((game) => game.summary.win && game.summary.duration > 0 && game.summary.duration < 14 * 60)
  },
  {
    id: 'nightOwl',
    name: 'Night Owl',
    description: 'Start a game between 3 and 5 in the morning.',
    category: 'secret',
    rank: 'bronze',
    secret: true,
    track: once((game) => game.hour >= 3 && game.hour < 5)
  }
]

export const ACHIEVEMENT_BY_ID: ReadonlyMap<string, AchievementDef> = new Map(ACHIEVEMENTS.map((def) => [def.id, def]))
export const goalOf = (def: AchievementDef): number => def.goal ?? 1

// --- evaluation --------------------------------------------------------------------------------

const localHour = (timestamp: number): number => new Date(timestamp).getHours()
const localDay = (timestamp: number): number => {
  const date = new Date(timestamp)
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
}
const NO_EXTRA: AchievementExtra = { flights: {}, galaxiesVisited: [] }
const byTime = (a: GameSummary, b: GameSummary): number => a.createdAt - b.createdAt || a.gameId - b.gameId

/**
 * Feeds games one by one (oldest first) and remembers where each achievement unlocked. A full
 * evaluation is a fresh tracker fed the whole history; after a game the same tracker just gets that
 * game (`add`), which gives the same result. A game that isn't newer than everything before can't
 * be added (`canAdd`), then a full evaluation is needed.
 */
export class AchievementTracker {
  private readonly trackers = ACHIEVEMENTS.map((def) => def.track())
  private readonly unlockedAt = new Map<string, { gameId: number; at: number }>()
  private readonly seen = new Set<number>()
  private last: GameSummary | null = null

  constructor(private readonly options: AchievementOptions = {}) {}

  canAdd(summary: GameSummary): boolean {
    return !this.seen.has(summary.gameId) && (!this.last || byTime(this.last, summary) < 0)
  }

  /** Adds the next game; returns the ids it unlocked. Games without you in them are skipped. */
  add(summary: GameSummary): string[] {
    if (!this.canAdd(summary)) throw new Error(`game ${summary.gameId} is not newer than the games before`)
    this.seen.add(summary.gameId)
    this.last = summary
    const me = summary.players.find((player) => player.me)
    if (!me) return []
    const game: GameView = {
      summary,
      me,
      allies: summary.players.filter((player) => player.ally),
      myTiers: this.options.augTiers?.(summary)[me.puuid] ?? [],
      galaxy: galaxyOf(cosmicSeed(summary.cosmos ?? summary.gameId)).id,
      hour: (this.options.hourOf ?? localHour)(summary.createdAt),
      day: (this.options.dayOf ?? localDay)(summary.createdAt)
    }
    const unlocked: string[] = []
    ACHIEVEMENTS.forEach((def, i) => {
      this.trackers[i].add(game)
      if (!this.unlockedAt.has(def.id) && this.trackers[i].value(NO_EXTRA) >= goalOf(def)) {
        this.unlockedAt.set(def.id, { gameId: summary.gameId, at: summary.createdAt + Math.max(0, summary.duration) * 1000 })
        unlocked.push(def.id)
      }
    })
    return unlocked
  }

  /** Every achievement with its progress, the extra (flights) included. */
  results(extra: AchievementExtra = NO_EXTRA): AchievementProgress[] {
    return ACHIEVEMENTS.map((def, i) => {
      const goal = goalOf(def)
      const progress = Math.min(goal, this.trackers[i].value(extra))
      const byGame = this.unlockedAt.get(def.id)
      return byGame
        ? { id: def.id, unlocked: true, gameId: byGame.gameId, at: byGame.at, progress: goal, goal }
        : { id: def.id, unlocked: progress >= goal, progress, goal }
    })
  }
}

/** All achievements for a history (any order) and the extra. */
export function evaluateAchievements(
  history: readonly GameSummary[],
  extra: AchievementExtra = NO_EXTRA,
  options: AchievementOptions = {}
): AchievementProgress[] {
  const tracker = new AchievementTracker(options)
  const unique = new Map(history.map((summary) => [summary.gameId, summary]))
  for (const summary of [...unique.values()].sort(byTime)) tracker.add(summary)
  return tracker.results(extra)
}

// --- constellations ----------------------------------------------------------------------------

export interface Constellation {
  /** direction of its centre from the middle of the universe (unit vector) */
  dir: Vec3
  /** star positions in the world */
  stars: Vec3[]
  /** the same stars flat, in a -1..1 box (for icons and the unlock animation) */
  flat: [number, number][]
  /** brightness per star, 0.5 to 1 */
  mags: number[]
  /** lines between stars (indices), in the order they are drawn */
  lines: [number, number][]
}

/**
 * Radius of the sky sphere the constellations sit on: far outside every galaxy, and beyond the star
 * map's overview camera, so from there they hang around and behind the universe like a night sky.
 */
export const SKY_RADIUS = Math.ceil(Math.max(...UNIVERSE.map((galaxy) => length(galaxy.pos) + galaxy.radius * extentOf(galaxy))) * 2.6)
/** Angular radius of one constellation's patch of sky (radians). */
export const CONSTELLATION_SPREAD = 0.24

// FNV-1a
const hashText = (text: string): number => {
  let value = 2166136261
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619)
  return value >>> 0
}
const mulberry = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Evenly spread directions (Fibonacci sphere): point i of n. */
export function fibonacciDir(i: number, n: number): Vec3 {
  const y = 1 - (2 * (i + 0.5)) / n
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const angle = i * Math.PI * (3 - Math.sqrt(5))
  return [r * Math.cos(angle), y, r * Math.sin(angle)]
}

const constellationCache = new Map<string, Constellation>()

/**
 * The star pattern of an achievement: 4 to 9 stars (seeded by the id) joined by a minimal spanning
 * tree plus at most one extra line, on its own patch of the sky sphere (placed by its index in the
 * catalogue, so no two overlap).
 */
export function constellationOf(id: string): Constellation {
  const cached = constellationCache.get(id)
  if (cached) return cached
  const rand = mulberry(hashText(id))
  const index = Math.max(
    0,
    ACHIEVEMENTS.findIndex((def) => def.id === id)
  )
  const count = 4 + Math.floor(rand() * 6)
  // stars in a unit disk, not too close to each other
  const flat: [number, number][] = []
  for (let attempt = 0; flat.length < count && attempt < 500; attempt++) {
    const angle = rand() * Math.PI * 2
    const radius = Math.sqrt(rand()) * 0.95
    const point: [number, number] = [Math.cos(angle) * radius, Math.sin(angle) * radius]
    if (flat.every((other) => Math.hypot(other[0] - point[0], other[1] - point[1]) > 0.38)) flat.push(point)
  }
  const mags = flat.map(() => 0.5 + 0.5 * rand())
  // minimal spanning tree (Prim), in the order the edges are found: that's the drawing order
  const distance = (a: number, b: number): number => Math.hypot(flat[a][0] - flat[b][0], flat[a][1] - flat[b][1])
  const inTree = new Set([0])
  const lines: [number, number][] = []
  while (inTree.size < flat.length) {
    let best: [number, number] | null = null
    for (const a of inTree)
      for (let b = 0; b < flat.length; b++) if (!inTree.has(b) && (!best || distance(a, b) < distance(best[0], best[1]))) best = [a, b]
    lines.push(best!)
    inTree.add(best![1])
  }
  // sometimes one more line closes a loop: the shortest one not in the tree
  if (flat.length >= 5 && rand() < 0.5) {
    const has = (a: number, b: number) => lines.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
    let extra: [number, number] | null = null
    for (let a = 0; a < flat.length; a++)
      for (let b = a + 1; b < flat.length; b++) if (!has(a, b) && (!extra || distance(a, b) < distance(extra[0], extra[1]))) extra = [a, b]
    if (extra) lines.push(extra)
  }
  // onto the sky: a tangent plane around the patch's direction
  const dir = fibonacciDir(index, ACHIEVEMENTS.length)
  const helper: Vec3 = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const u = normalize(cross(dir, helper))
  const v = cross(dir, u)
  const twist = rand() * Math.PI * 2
  const spread = Math.tan(CONSTELLATION_SPREAD)
  const stars = flat.map(([x, y]): Vec3 => {
    const rx = (x * Math.cos(twist) - y * Math.sin(twist)) * spread
    const ry = (x * Math.sin(twist) + y * Math.cos(twist)) * spread
    const point = normalize([dir[0] + rx * u[0] + ry * v[0], dir[1] + rx * u[1] + ry * v[1], dir[2] + rx * u[2] + ry * v[2]])
    return [point[0] * SKY_RADIUS, point[1] * SKY_RADIUS, point[2] * SKY_RADIUS]
  })
  const constellation: Constellation = { dir, stars, flat, mags, lines }
  constellationCache.set(id, constellation)
  return constellation
}

/** Colour of a rank (cosmic shifts along the stars: pass the star's position 0..1). */
export function rankColor(rank: AchievementRank, along = 0): Vec3 {
  switch (rank) {
    case 'bronze':
      return [0.85, 0.55, 0.32]
    case 'silver':
      return [0.8, 0.85, 0.95]
    case 'gold':
      return [1, 0.8, 0.3]
    case 'cosmic': {
      // pink → violet → cyan
      const stops: Vec3[] = [
        [1, 0.48, 0.85],
        [0.71, 0.55, 1],
        [0.44, 0.91, 1]
      ]
      const t = Math.min(1, Math.max(0, along)) * (stops.length - 1)
      const i = Math.min(stops.length - 2, Math.floor(t))
      const f = t - i
      return [0, 1, 2].map((c) => stops[i][c] + (stops[i + 1][c] - stops[i][c]) * f) as Vec3
    }
  }
}

/** CSS colour of a rank (cosmic gets a gradient). */
export const RANK_CSS: Record<AchievementRank, string> = {
  bronze: '#d98c52',
  silver: '#cfd8f2',
  gold: '#ffcc4d',
  cosmic: 'linear-gradient(90deg, #ff7ad9, #b58bff, #6fe8ff)'
}
