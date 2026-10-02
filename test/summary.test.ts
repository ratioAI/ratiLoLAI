import { describe, expect, it } from 'vitest'
import { buildSummary, impactScores, type RawGame } from '../src/shared/summary'

const player = (i: number, team: number, k: number, d: number, a: number, dmg: number, win: boolean) => ({
  participantId: i,
  championId: 10 + i,
  teamId: team,
  stats: { win, kills: k, deaths: d, assists: a, totalDamageDealtToChampions: dmg, totalDamageTaken: 20000, playerAugment1: 1000 + i, item0: 3020 }
})

const game: RawGame = {
  gameId: 1,
  gameCreation: 0,
  gameDuration: 900,
  queueId: 2400,
  gameMode: 'KIWI',
  participants: [
    player(1, 100, 2, 10, 5, 9000, false), // me – fed the enemy
    player(2, 100, 8, 4, 9, 30000, false), // premade, good
    player(3, 100, 5, 5, 8, 20000, false),
    player(4, 100, 4, 6, 7, 18000, false),
    player(5, 100, 3, 5, 9, 16000, false),
    ...[6, 7, 8, 9, 10].map((i) => player(i, 200, 5, 4, 10, 20000, true))
  ],
  participantIdentities: Array.from({ length: 10 }, (_, i) => ({ participantId: i + 1, player: { puuid: `p${i + 1}`, gameName: `N${i + 1}`, tagLine: 'EUW' } }))
}

describe('post-game summary', () => {
  it('scores impact relative to the own team', () => {
    const s = impactScores([
      { kills: 10, deaths: 2, assists: 5, damage: 30000, tanked: 20000, support: 0 },
      { kills: 1, deaths: 9, assists: 2, damage: 8000, tanked: 20000, support: 0 }
    ])
    expect(s[0]).toBeGreaterThan(60)
    expect(s[1]).toBeLessThan(40)
  })

  it('finds the result, MVP, blame within the premade group and everyone’s augments', () => {
    const s = buildSummary(game, null, 'p1', new Set(['p2']))
    expect(s.win).toBe(false)
    expect(s.players.filter((p) => p.ally)).toHaveLength(5)
    expect(s.players.find((p) => p.me)?.riotId).toBe('N1#EUW')
    expect(s.players.find((p) => p.puuid === 'p2')?.premade).toBe(true)
    expect(s.mvp).toBe('p2')
    expect(s.blame).toBe('p1') // only you and your premade compete for the blame
    expect(s.players.find((p) => p.puuid === 'p7')?.augments).toEqual([1007])
    expect(s.curveSource).toBe('none')
  })

  it('builds the gold curve and kills from the timeline, from your side', () => {
    const s = buildSummary(
      game,
      {
        frames: [
          { timestamp: 0, participantFrames: { '1': { totalGold: 500 }, '6': { totalGold: 500 } } },
          {
            timestamp: 60_000,
            participantFrames: { '1': { totalGold: 2500 }, '6': { totalGold: 1000 } },
            events: [
              { type: 'CHAMPION_KILL', timestamp: 50_000, killerId: 1, victimId: 6 },
              { type: 'CHAMPION_KILL', timestamp: 55_000, killerId: 7, victimId: 2 }
            ]
          }
        ]
      },
      'p1',
      new Set()
    )
    expect(s.curve).toEqual([
      { t: 0, gold: 0, kills: 0 },
      { t: 60, gold: 1500, kills: 0 }
    ])
    expect(s.kills).toEqual([
      { t: 50, ally: true },
      { t: 55, ally: false }
    ])
    expect(s.blame).toBe('p1') // alone: weakest of the team
  })
})
