import { describe, expect, it } from 'vitest'
import { INHIBITOR_RESPAWN, inhibitorTeam, inhibitorTimers, minimapRect } from '../src/main/minimap/timers'
import { parseLiveData } from '../src/main/live/liveClient'

describe('inhibitor timers', () => {
  it('maps structure names to teams', () => {
    expect(inhibitorTeam('Barracks_T1_L1')).toBe('ORDER')
    expect(inhibitorTeam('Barracks_T2_C1')).toBe('CHAOS')
    expect(inhibitorTeam('Turret_Something')).toBeNull()
  })

  it('counts down 5 minutes from the kill and forgets respawned inhibitors', () => {
    const events = [
      { type: 'killed' as const, inhibitor: 'Barracks_T2_L1', time: 600 },
      { type: 'killed' as const, inhibitor: 'Barracks_T1_L1', time: 100 },
      { type: 'respawned' as const, inhibitor: 'Barracks_T1_L1', time: 400 }
    ]
    const t = inhibitorTimers(events, 700)
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ team: 'CHAOS', respawnAt: 600 + INHIBITOR_RESPAWN })
    expect(inhibitorTimers(events, 600 + INHIBITOR_RESPAWN + 1)).toHaveLength(0)
    // killed again after respawning
    expect(inhibitorTimers([...events, { type: 'killed', inhibitor: 'Barracks_T1_L1', time: 650 }], 700)).toHaveLength(2)
  })
})

describe('minimap position', () => {
  it('matches the minimap on a real 1080p screenshot', () => {
    const r = minimapRect(1920, 1080)
    expect(Math.round(r.x * 1920)).toBeCloseTo(1622, -1)
    expect(Math.round(r.y * 1080)).toBeCloseTo(780, -1)
    expect(Math.round(r.w * 1920)).toBe(285)
    expect(r.w * 1920).toBeCloseTo(r.h * 1080, 5) // square
  })
  it('scales with resolution and minimap scale', () => {
    const r = minimapRect(2560, 1440, 1.2)
    expect(r.w * 2560).toBeCloseTo(0.2639 * 1440 * 1.2, 3)
    expect(r.x + r.w).toBeLessThan(1)
  })
})

describe('live data', () => {
  it('extracts inhibitor events and the language-independent champion id', () => {
    const s = parseLiveData({
      activePlayer: { riotId: 'me#1' },
      allPlayers: [
        {
          riotId: 'me#1',
          championName: 'Wukong',
          rawChampionName: 'game_character_displayname_MonkeyKing',
          team: 'ORDER',
          level: 3,
          position: '',
          isDead: false,
          respawnTimer: 0,
          scores: { kills: 0, deaths: 0, assists: 0, creepScore: 0 },
          items: [],
          summonerSpells: {}
        }
      ],
      events: {
        Events: [
          { EventName: 'InhibKilled', EventTime: 812.5, InhibKilled: 'Barracks_T2_L1' },
          { EventName: 'InhibRespawned', EventTime: 1112.5, InhibRespawned: 'Barracks_T2_L1' }
        ]
      },
      gameData: { gameTime: 1200, gameMode: 'KIWI' }
    })
    expect(s?.activeChampionKey).toBe('MonkeyKing')
    expect(s?.inhibitorEvents).toEqual([
      { type: 'killed', inhibitor: 'Barracks_T2_L1', time: 812.5 },
      { type: 'respawned', inhibitor: 'Barracks_T2_L1', time: 1112.5 }
    ])
  })
})
