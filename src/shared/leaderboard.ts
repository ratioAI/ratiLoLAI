import type { LeaderboardEntry } from './types'
import { teamBlame, type GameSummary } from './summary'

/**
 * MVP / troll leaderboard over a list of games: you and your premades, each counted in the games
 * they played in your group. The app reads the same numbers from the game database (GameStore);
 * this version works on plain summaries and is what the web demo and the tests use.
 */
export function leaderboardFromSummaries(summaries: GameSummary[]): LeaderboardEntry[] {
  const rows = new Map<string, LeaderboardEntry & { score: number; champions: Map<number, number>; latest: number }>()
  for (const summary of summaries) {
    const allies = summary.players.filter((player) => player.ally)
    const troll = allies.length > 1 ? teamBlame(summary)?.puuid : null
    for (const player of allies) {
      if (!player.me && !player.premade) continue
      const row = rows.get(player.puuid) ?? {
        puuid: player.puuid,
        riotId: player.riotId,
        me: false,
        championId: player.championId,
        games: 0,
        wins: 0,
        mvps: 0,
        trolls: 0,
        avgScore: 0,
        score: 0,
        champions: new Map<number, number>(),
        latest: -Infinity
      }
      row.games++
      row.me ||= player.me
      if (summary.win) row.wins++
      if (summary.mvp === player.puuid) row.mvps++
      if (troll === player.puuid) row.trolls++
      row.score += player.score
      row.champions.set(player.championId, (row.champions.get(player.championId) ?? 0) + 1)
      if (summary.createdAt >= row.latest) {
        row.latest = summary.createdAt
        row.riotId = player.riotId
      }
      rows.set(player.puuid, row)
    }
  }
  return [...rows.values()]
    .map(({ score, champions, latest: _latest, ...row }) => ({
      ...row,
      championId: [...champions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? row.championId,
      avgScore: Math.round(score / row.games)
    }))
    .sort((a, b) => b.mvps - a.mvps || b.games - a.games)
}

export type PodiumKind = 'mvp' | 'troll'

/**
 * The ranking for one podium: most MVP (or troll) games first; with equal counts the one who needed
 * fewer games for them is ahead. Players who never were one are left out.
 */
export function podium(entries: LeaderboardEntry[], kind: PodiumKind): LeaderboardEntry[] {
  const count = (entry: LeaderboardEntry) => (kind === 'mvp' ? entry.mvps : entry.trolls)
  return entries
    .filter((entry) => count(entry) > 0)
    .sort((a, b) => count(b) - count(a) || count(b) / b.games - count(a) / a.games || a.riotId.localeCompare(b.riotId))
}
