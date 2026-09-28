import type {
  ChampionBuild,
  ChampionRoleStats,
  Matchup,
  Option,
  PatchStats,
  RunePage,
  StatRole,
  Tier,
  TierEntry,
  WG
} from '@shared/types'
import { GAME_MODES } from '@shared/types'

/** Prior strength for the Bayesian win-rate estimate (virtual 50% games). */
export const WR_PRIOR_GAMES = 30
/** A champion must play at least this share of its games in a role to be listed there. */
export const MIN_ROLE_SHARE = 0.08

export const TIER_CUTOFFS: [Tier, number][] = [
  ['S+', 0.05],
  ['S', 0.15],
  ['A', 0.35],
  ['B', 0.6],
  ['C', 0.85],
  ['D', 1]
]

export function smoothedWinRate(w: number, g: number, prior = WR_PRIOR_GAMES): number {
  return (w + prior * 0.5) / (g + prior)
}

/**
 * Strength score used to rank champions inside a role. Win rate dominates; popularity and
 * ban rate add confidence that a champion is actually strong in the current meta.
 */
export function strengthScore(winRate: number, pickRate: number, banRate: number, aram = false): number {
  // in ARAM champions are assigned randomly, so pick rate says nothing about strength
  if (aram) return (winRate - 0.5) * 100
  return (winRate - 0.5) * 100 + Math.log1p(pickRate * 100) * 0.8 + banRate * 100 * 0.05
}

export function rolesOf(stats: PatchStats): readonly StatRole[] {
  return GAME_MODES[stats.mode ?? 'ranked'].roles
}

export function tierForPercentile(p: number): Tier {
  for (const [tier, cutoff] of TIER_CUTOFFS) if (p <= cutoff) return tier
  return 'D'
}

function championTotals(stats: PatchStats): Map<number, number> {
  const totals = new Map<number, number>()
  for (const s of Object.values(stats.champions)) totals.set(s.championId, (totals.get(s.championId) ?? 0) + s.g)
  return totals
}

export function buildTierList(stats: PatchStats, minGames: number): TierEntry[] {
  if (!stats.matches) return []
  const totals = championTotals(stats)
  const result: TierEntry[] = []

  const aram = stats.mode === 'aram'
  for (const role of rolesOf(stats)) {
    const rows = Object.values(stats.champions)
      .filter((s) => s.role === role && s.g >= minGames)
      .map((s) => {
        const roleShare = s.g / (totals.get(s.championId) ?? s.g)
        const winRate = smoothedWinRate(s.w, s.g)
        const pickRate = s.g / stats.matches
        const banRate = (stats.bans[s.championId] ?? 0) / stats.matches
        return { s, roleShare, winRate, pickRate, banRate, score: strengthScore(winRate, pickRate, banRate, aram) }
      })
      .filter((r) => r.roleShare >= MIN_ROLE_SHARE)
      .sort((a, b) => b.score - a.score)

    rows.forEach((r, i) => {
      result.push({
        championId: r.s.championId,
        role,
        tier: tierForPercentile((i + 1) / rows.length),
        score: r.score,
        games: r.s.g,
        winRate: r.s.w / r.s.g,
        pickRate: r.pickRate,
        banRate: r.banRate,
        roleShare: r.roleShare,
        rank: i + 1
      })
    })
  }
  return result
}

export function toOptions<T>(
  map: Record<string, WG>,
  total: number,
  parse: (key: string) => T,
  opts: { limit?: number; minGames?: number } = {}
): Option<T>[] {
  const { limit = 6, minGames = 1 } = opts
  return Object.entries(map)
    .filter(([, v]) => v.g >= minGames)
    .sort((a, b) => b[1].g - a[1].g || b[1].w / b[1].g - a[1].w / a[1].g)
    .slice(0, limit)
    .map(([k, v]) => ({ value: parse(k), g: v.g, w: v.w, winRate: v.w / v.g, pickRate: total ? v.g / total : 0 }))
}

export function parseRuneKey(key: string): RunePage {
  const [primaryStyle, primary, subStyle, secondary, shards] = key.split('|')
  const nums = (s: string): number[] => s.split(',').map(Number)
  return {
    primaryStyle: Number(primaryStyle),
    subStyle: Number(subStyle),
    primary: nums(primary),
    secondary: nums(secondary),
    shards: nums(shards)
  }
}

const ids = (k: string): number[] => (k ? k.split(',').map(Number) : [])

function matchups(s: ChampionRoleStats, minGames: number): { counters: Matchup[]; goodAgainst: Matchup[] } {
  const list = Object.entries(s.matchups)
    .filter(([, v]) => v.g >= minGames)
    .map(([id, v]) => ({ championId: Number(id), games: v.g, winRate: v.w / v.g }))
  const byWr = [...list].sort((a, b) => a.winRate - b.winRate)
  return {
    counters: byWr.slice(0, 6),
    goodAgainst: byWr.reverse().slice(0, 6)
  }
}

export function buildChampionView(
  stats: PatchStats,
  championId: number,
  role: StatRole | undefined,
  tierList: TierEntry[]
): ChampionBuild | null {
  const available = rolesOf(stats).map((r) => ({ role: r, games: stats.champions[`${championId}:${r}`]?.g ?? 0 }))
    .filter((r) => r.games > 0)
    .sort((a, b) => b.games - a.games)
  if (!available.length) return null

  const chosen = role && available.some((a) => a.role === role) ? role : available[0].role
  const s = stats.champions[`${championId}:${chosen}`]
  const tier = tierList.find((t) => t.championId === championId && t.role === chosen)?.tier ?? null

  const withTimeline = Object.values(s.skillMax).reduce((n, v) => n + v.g, 0) || s.g
  const core = toOptions(s.core, withTimeline, ids, { limit: 6 })
  const coreItems = new Set(core[0]?.value ?? [])
  const late = [3, 4, 5].map((slot) => {
    const filtered = Object.fromEntries(Object.entries(s.slots[slot] ?? {}).filter(([id]) => !coreItems.has(Number(id))))
    const slotTotal = Object.values(s.slots[slot] ?? {}).reduce((n, v) => n + v.g, 0)
    return toOptions(filtered, slotTotal, Number, { limit: 5 })
  })
  const minMatchup = Math.max(3, Math.round(s.g * 0.01))

  return {
    championId,
    role: chosen,
    mode: stats.mode ?? 'ranked',
    patch: stats.patch,
    games: s.g,
    winRate: s.w / s.g,
    pickRate: s.g / stats.matches,
    banRate: (stats.bans[championId] ?? 0) / stats.matches,
    tier,
    availableRoles: available,
    runes: toOptions(s.runes, s.g, parseRuneKey, { limit: 5 }),
    spells: toOptions(s.spells, s.g, ids, { limit: 4 }),
    starters: toOptions(s.starters, withTimeline, ids, { limit: 4 }),
    core,
    boots: toOptions(s.boots, withTimeline, Number, { limit: 4 }),
    late,
    skillMax: toOptions(s.skillMax, withTimeline, (k) => k, { limit: 3 }),
    skillPath: toOptions(s.skillPath, withTimeline, (k) => k, { limit: 3 }),
    ...matchups(s, minMatchup),
    avgDuration: s.duration / s.g
  }
}
