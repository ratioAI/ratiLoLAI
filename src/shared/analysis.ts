import type { ChampionBuild, ChampionRoleStats, Matchup, Option, PatchStats, RunePage, StatRole, Tier, TierEntry, WG } from '@shared/types'
import { GAME_MODES } from '@shared/types'

/** Prior strength for the Bayesian win rate: this many virtual games at 50%. */
export const WR_PRIOR_GAMES = 30
/** A champion has to play at least this share of its games in a role to be listed there. */
export const MIN_ROLE_SHARE = 0.08

export const TIER_CUTOFFS: [Tier, number][] = [
  ['S+', 0.05],
  ['S', 0.15],
  ['A', 0.35],
  ['B', 0.6],
  ['C', 0.85],
  ['D', 1]
]

export function smoothedWinRate(wins: number, games: number, prior = WR_PRIOR_GAMES): number {
  return (wins + prior * 0.5) / (games + prior)
}

/**
 * Score used to rank champions within a role. Win rate dominates, pick and ban rate add a bit of
 * confidence that the champion is actually strong in the current meta.
 */
export function strengthScore(winRate: number, pickRate: number, banRate: number, aram = false): number {
  // ARAM champions are random, so pick rate says nothing about strength
  if (aram) return (winRate - 0.5) * 100
  return (winRate - 0.5) * 100 + Math.log1p(pickRate * 100) * 0.8 + banRate * 100 * 0.05
}

export function rolesOf(stats: PatchStats): readonly StatRole[] {
  return GAME_MODES[stats.mode ?? 'ranked'].roles
}

export function tierForPercentile(percentile: number): Tier {
  for (const [tier, cutoff] of TIER_CUTOFFS) if (percentile <= cutoff) return tier
  return 'D'
}

function championTotals(stats: PatchStats): Map<number, number> {
  const totals = new Map<number, number>()
  for (const roleStats of Object.values(stats.champions)) {
    totals.set(roleStats.championId, (totals.get(roleStats.championId) ?? 0) + roleStats.g)
  }
  return totals
}

export function buildTierList(stats: PatchStats, minGames: number): TierEntry[] {
  if (!stats.matches) return []
  const totals = championTotals(stats)
  const result: TierEntry[] = []

  const aram = stats.mode === 'aram'
  for (const role of rolesOf(stats)) {
    const rows = Object.values(stats.champions)
      .filter((roleStats) => roleStats.role === role && roleStats.g >= minGames)
      .map((roleStats) => {
        const roleShare = roleStats.g / (totals.get(roleStats.championId) ?? roleStats.g)
        const winRate = smoothedWinRate(roleStats.w, roleStats.g)
        const pickRate = roleStats.g / stats.matches
        const banRate = (stats.bans[roleStats.championId] ?? 0) / stats.matches
        return { roleStats, roleShare, winRate, pickRate, banRate, score: strengthScore(winRate, pickRate, banRate, aram) }
      })
      .filter((row) => row.roleShare >= MIN_ROLE_SHARE)
      .sort((a, b) => b.score - a.score)

    rows.forEach((row, i) => {
      result.push({
        championId: row.roleStats.championId,
        role,
        tier: tierForPercentile((i + 1) / rows.length),
        score: row.score,
        games: row.roleStats.g,
        // shown win rate is the raw one, the smoothed one only feeds the score
        winRate: row.roleStats.w / row.roleStats.g,
        pickRate: row.pickRate,
        banRate: row.banRate,
        roleShare: row.roleShare,
        rank: i + 1
      })
    })
  }
  return result
}

/** Turns a `key -> wins/games` map into options sorted by games, then win rate. */
export function toOptions<T>(
  map: Record<string, WG>,
  total: number,
  parse: (key: string) => T,
  opts: { limit?: number; minGames?: number } = {}
): Option<T>[] {
  const { limit = 6, minGames = 1 } = opts
  return Object.entries(map)
    .filter(([, counter]) => counter.g >= minGames)
    .sort((a, b) => b[1].g - a[1].g || b[1].w / b[1].g - a[1].w / a[1].g)
    .slice(0, limit)
    .map(([key, counter]) => ({
      value: parse(key),
      g: counter.g,
      w: counter.w,
      winRate: counter.w / counter.g,
      pickRate: total ? counter.g / total : 0
    }))
}

export function parseRuneKey(key: string): RunePage {
  const [primaryStyle, primary, subStyle, secondary, shards] = key.split('|')
  const toNumbers = (part: string): number[] => part.split(',').map(Number)
  return {
    primaryStyle: Number(primaryStyle),
    subStyle: Number(subStyle),
    primary: toNumbers(primary),
    secondary: toNumbers(secondary),
    shards: toNumbers(shards)
  }
}

const parseIdList = (key: string): number[] => (key ? key.split(',').map(Number) : [])

function matchups(champStats: ChampionRoleStats, minGames: number): { counters: Matchup[]; goodAgainst: Matchup[] } {
  const list = Object.entries(champStats.matchups)
    .filter(([, counter]) => counter.g >= minGames)
    .map(([id, counter]) => ({ championId: Number(id), games: counter.g, winRate: counter.w / counter.g }))
  const byWinRate = [...list].sort((a, b) => a.winRate - b.winRate)
  return {
    counters: byWinRate.slice(0, 6),
    goodAgainst: byWinRate.reverse().slice(0, 6)
  }
}

export function buildChampionView(
  stats: PatchStats,
  championId: number,
  role: StatRole | undefined,
  tierList: TierEntry[]
): ChampionBuild | null {
  const available = rolesOf(stats)
    .map((statRole) => ({ role: statRole, games: stats.champions[`${championId}:${statRole}`]?.g ?? 0 }))
    .filter((entry) => entry.games > 0)
    .sort((a, b) => b.games - a.games)
  if (!available.length) return null

  const chosen = role && available.some((entry) => entry.role === role) ? role : available[0].role
  const champStats = stats.champions[`${championId}:${chosen}`]
  const tier = tierList.find((entry) => entry.championId === championId && entry.role === chosen)?.tier ?? null

  // items and skills only come from games with a timeline, so rates use that count, not all games
  const timelineGames = Object.values(champStats.skillMax).reduce((total, counter) => total + counter.g, 0) || champStats.g
  const core = toOptions(champStats.core, timelineGames, parseIdList, { limit: 6 })
  const coreItems = new Set(core[0]?.value ?? [])
  const late = [3, 4, 5].map((slot) => {
    const filtered = Object.fromEntries(Object.entries(champStats.slots[slot] ?? {}).filter(([id]) => !coreItems.has(Number(id))))
    const slotTotal = Object.values(champStats.slots[slot] ?? {}).reduce((total, counter) => total + counter.g, 0)
    return toOptions(filtered, slotTotal, Number, { limit: 5 })
  })
  // at least 3 games or 1% of the champion's games before a matchup is shown
  const minMatchupGames = Math.max(3, Math.round(champStats.g * 0.01))

  return {
    championId,
    role: chosen,
    mode: stats.mode ?? 'ranked',
    patch: stats.patch,
    games: champStats.g,
    winRate: champStats.w / champStats.g,
    pickRate: champStats.g / stats.matches,
    banRate: (stats.bans[championId] ?? 0) / stats.matches,
    tier,
    availableRoles: available,
    runes: toOptions(champStats.runes, champStats.g, parseRuneKey, { limit: 5 }),
    spells: toOptions(champStats.spells, champStats.g, parseIdList, { limit: 4 }),
    starters: toOptions(champStats.starters, timelineGames, parseIdList, { limit: 4 }),
    core,
    boots: toOptions(champStats.boots, timelineGames, Number, { limit: 4 }),
    late,
    skillMax: toOptions(champStats.skillMax, timelineGames, (key) => key, { limit: 3 }),
    skillPath: toOptions(champStats.skillPath, timelineGames, (key) => key, { limit: 3 }),
    ...matchups(champStats, minMatchupGames),
    avgDuration: champStats.duration / champStats.g
  }
}
