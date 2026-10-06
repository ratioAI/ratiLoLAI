import type { GameSummary } from '@shared/summary'
import { QUEUE_IDS } from '@shared/types'

/** gameId → did this player win. Using game ids lets results from several sources be merged without counting a game twice. */
export type GameResults = Map<number, boolean>

export type RecordMode = 'mayhem' | 'aram'

export function summaryMatchesMode(summary: Pick<GameSummary, 'mode' | 'queueId'>, mode: RecordMode): boolean {
  if (mode === 'mayhem') return summary.mode === 'KIWI' || (QUEUE_IDS.mayhem as readonly number[]).includes(summary.queueId)
  return summary.mode === 'ARAM' || (QUEUE_IDS.aram as readonly number[]).includes(summary.queueId)
}

/**
 * Results per player from our own saved game summaries. Every game played with ratioAI running is
 * saved with all ten players, so premades build up a record here even when their match history
 * can't be read.
 */
export function resultsFromSummaries(summaries: GameSummary[], puuids: string[], mode: RecordMode): Map<string, GameResults> {
  const wanted = new Set(puuids)
  const results = new Map<string, GameResults>()
  for (const summary of summaries) {
    if (!summaryMatchesMode(summary, mode)) continue
    for (const player of summary.players) {
      if (!wanted.has(player.puuid)) continue
      // the summary is from our point of view: allies won when we won
      const won = player.ally ? summary.win : !summary.win
      const forPlayer = results.get(player.puuid) ?? new Map<number, boolean>()
      forPlayer.set(summary.gameId, won)
      results.set(player.puuid, forPlayer)
    }
  }
  return results
}

/** Games and wins over the union of all sources. */
export function mergeResults(...sources: (GameResults | null | undefined)[]): { games: number; wins: number } {
  const merged: GameResults = new Map()
  for (const source of sources) for (const [gameId, won] of source ?? []) merged.set(gameId, won)
  let wins = 0
  for (const won of merged.values()) if (won) wins++
  return { games: merged.size, wins }
}
