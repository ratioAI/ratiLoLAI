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
    expect(INHIBITOR_RESPAWN).toBe(250)
    // real names from an ARAM: Mayhem game
    expect(inhibitorTeam('Inhib_TChaos_L1_P1_2432143522_0')).toBe('CHAOS')
    expect(inhibitorTeam('Inhib_TOrder_L1_P1_196971597_0')).toBe('ORDER')
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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { RELIC_PATCH, RELICS, RelicTracker, relicSeen } from '../src/main/minimap/timers'

/** Relic pad patches from a 220×220 crop at (1060,500) of a real 1280×720 in-game capture. */
function pads(name: string) {
  const png = PNG.sync.read(readFileSync(join(__dirname, 'fixtures/minimap', name)))
  const r = minimapRect(1280, 720)
  const side = r.w * 1280
  const px = Math.max(9, Math.round(RELIC_PATCH * side))
  return RELICS.map((relic) => {
    const cx = r.x * 1280 + relic.pos.x * side - 1060
    const cy = r.y * 720 + relic.pos.y * side - 500
    const half = (RELIC_PATCH * side) / 2
    const data = new Uint8Array(px * px * 4)
    for (let y = 0; y < px; y++)
      for (let x = 0; x < px; x++) {
        const sx = Math.round(cx - half + ((x + 0.5) * 2 * half) / px)
        const sy = Math.round(cy - half + ((y + 0.5) * 2 * half) / px)
        const i = (sy * png.width + sx) * 4
        data.set(png.data.subarray(i, i + 4), (y * px + x) * 4)
      }
    return relicSeen({ width: px, height: px, data })
  })
}

describe('health relics on the minimap (real captures)', () => {
  it('sees the green crosses of the inner relics', () => {
    // order-inner, order-outer, chaos-outer, chaos-inner
    expect(pads('inner-up-own-champ.png')).toEqual(['present', 'absent', 'unclear', 'present'])
    expect(pads('inner-up-fight.png')[0]).toBe('present')
    expect(pads('inner-up-fight.png')[3]).toBe('present')
    expect(pads('inner-up-fight.png')[1]).toBe('absent')
  })
  it('sees nothing before the first spawn (the game shows its own countdown there)', () => {
    expect(pads('prespawn.png')).toEqual(['absent', 'absent', 'absent', 'absent'])
  })

  it('starts a timer only after the cross was seen and then missing for 4 s', () => {
    const t = new RelicTracker()
    const all = (s: 'present' | 'absent' | 'unclear') => [s, s, s, s] as const
    t.observe(100, [...all('absent')])
    expect(t.snapshot()[1]).toMatchObject({ state: 'spawn', at: 105 })
    for (const s of [106, 107, 108, 109]) t.observe(s, [...all('absent')]) // spawned, never seen → no pickup
    expect(t.snapshot()[1].state).toBe('unknown')
    t.observe(110, ['absent', 'present', 'absent', 'absent'])
    expect(t.snapshot()[1].state).toBe('up')
    t.observe(111, [...all('absent')])
    t.observe(112, ['absent', 'unclear', 'absent', 'absent']) // champion on the pad
    t.observe(113, [...all('absent')])
    t.observe(114, [...all('absent')])
    expect(t.observe(115, [...all('absent')])).toEqual(['order-outer'])
    expect(t.snapshot()[1]).toMatchObject({ state: 'spawn', at: 111 + 92.5 })
    // back after 8 s → it was covered, not taken (too early to be a respawn)
    for (const s of [119, 120, 121]) t.observe(s, ['absent', 'present', 'absent', 'absent'])
    expect(t.snapshot()[1].state).toBe('up')
    expect(t.respawnTime).toBe(92.5)
  })

  it('learns a different respawn time from two real respawns', () => {
    const t = new RelicTracker()
    const take = (from: number) => {
      t.observe(from, ['absent', 'present', 'absent', 'absent'])
      for (let s = from + 1; s <= from + 4; s++) t.observe(s, ['absent', 'absent', 'absent', 'absent'])
    }
    const back = (from: number) => {
      for (let s = from; s < from + 3; s++) t.observe(s, ['absent', 'present', 'absent', 'absent'])
    }
    take(200)
    back(241) // seen again 40 s after the pickup
    take(260)
    back(301)
    expect(t.respawnTime).toBeCloseTo(40, 0)
    take(320)
    expect(t.snapshot()[1].at).toBeCloseTo(321 + 40, 0)
  })
})
