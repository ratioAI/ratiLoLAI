/**
 * A made-up ARAM: Mayhem game, for the Discord test message and tests. Not the web demo's history
 * (renderer/src/lib/mockApi.ts), which is bigger and random.
 */
import { buildSummary, type GameSummary, type RawGame } from './summary'

const PLAYERS: [name: string, championId: number, premade: boolean, stats: [number, number, number, number, number, number]][] = [
  ['You', 99, false, [11, 4, 19, 31_200, 14_000, 2_100]],
  ['Duo Partner', 86, true, [7, 9, 12, 22_400, 38_000, 0]],
  ['Random Ryze', 13, false, [2, 12, 10, 12_900, 16_000, 0]],
  ['Bard Enjoyer', 432, false, [3, 6, 27, 9_800, 21_000, 14_500]],
  ['Splitpushed', 157, false, [9, 8, 8, 24_100, 19_000, 0]],
  ['Enemy Jinx', 222, false, [14, 7, 9, 36_500, 15_000, 0]],
  ['Enemy Thresh', 412, false, [2, 9, 24, 10_100, 33_000, 6_000]],
  ['Enemy Ahri', 103, false, [8, 8, 13, 27_400, 17_000, 0]],
  ['Enemy Malphite', 54, false, [5, 6, 16, 15_800, 41_000, 0]],
  ['Enemy Lulu', 117, false, [3, 2, 21, 8_400, 12_000, 17_200]]
]

export function demoGame(now = Date.now()): GameSummary {
  const game: RawGame = {
    gameId: 1,
    gameCreation: now - 22 * 60_000,
    gameDuration: 18 * 60 + 41,
    queueId: 2400,
    gameMode: 'KIWI',
    participants: PLAYERS.map(([, championId, , stats], i) => ({
      participantId: i + 1,
      championId,
      teamId: i < 5 ? 100 : 200,
      stats: {
        win: i < 5,
        kills: stats[0],
        deaths: stats[1],
        assists: stats[2],
        totalDamageDealtToChampions: stats[3],
        totalDamageTaken: stats[4],
        totalHealsOnTeammates: stats[5],
        largestMultiKill: i === 0 ? 3 : 1,
        champLevel: 18
      }
    })),
    participantIdentities: PLAYERS.map(([name], i) => ({
      participantId: i + 1,
      player: { puuid: `demo-${i}`, gameName: name, tagLine: 'DEMO' }
    }))
  }
  const timeline = {
    frames: Array.from({ length: 19 }, (_, minute) => ({
      timestamp: minute * 60_000,
      participantFrames: Object.fromEntries(
        PLAYERS.map((_, i) => [
          String(i + 1),
          { totalGold: 500 + minute * 620 + (i < 5 ? Math.round(Math.sin(minute / 3) * 900 - 300) : 0) }
        ])
      )
    }))
  }
  const premades = new Set(PLAYERS.flatMap(([, , premade], i) => (premade ? [`demo-${i}`] : [])))
  return buildSummary(game, timeline, 'demo-0', premades)
}
