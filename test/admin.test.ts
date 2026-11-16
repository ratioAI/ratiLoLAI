import { describe, expect, it } from 'vitest'
import { SimGame } from '../src/main/admin'
import { validPads } from '../src/main/minimap/store'
import { inhibitorTimers, observedInhibitorRespawns, RELIC_TIMES, RelicTracker, RELICS } from '../src/main/minimap/timers'

const options = { mode: 'aram' as const, map: 12, startAt: 90, inhibitorRespawn: 240 }

describe('simulated game (admin tool)', () => {
  it('sends the warning and the respawn of a destroyed inhibitor on its own', () => {
    const sim = new SimGame(options, () => ({}))
    sim.advance(210) // 300 s
    sim.inhibitor('CHAOS', 'killed')
    expect(inhibitorTimers(sim.events, sim.gameTime)).toMatchObject([{ team: 'CHAOS', respawnAt: 300 + 250 }])
    sim.advance(225) // the warning comes 15 s before the real respawn at 540
    expect(sim.events.map((event) => event.type)).toEqual(['killed', 'soon'])
    expect(inhibitorTimers(sim.events, sim.gameTime)).toMatchObject([{ team: 'CHAOS', respawnAt: 540 }])
    sim.advance(20)
    expect(sim.events.map((event) => [event.type, event.time])).toEqual([
      ['killed', 300],
      ['soon', 525],
      ['respawned', 540]
    ])
    expect(observedInhibitorRespawns(sim.events)).toEqual([240])
    expect(sim.live().inhibitorEvents).toHaveLength(3)
  })

  it('a manual warning replaces the scheduled events', () => {
    const sim = new SimGame(options, () => ({}))
    sim.inhibitor('ORDER', 'killed')
    sim.advance(100)
    sim.inhibitor('ORDER', 'soon')
    sim.advance(400)
    expect(sim.events.map((event) => [event.type, event.time])).toEqual([
      ['killed', 90],
      ['soon', 190],
      ['respawned', 205]
    ])
  })

  it('feeds the relic tracker like the screen would', () => {
    const sim = new SimGame(options, () => ({}))
    const tracker = new RelicTracker()
    const step = (): void => {
      sim.advance(1)
      tracker.observe(sim.gameTime, sim.seen(RELICS, sim.gameTime))
    }
    while (sim.gameTime < 160) step()
    expect(tracker.snapshot().map((relic) => relic.state)).toEqual(['up', 'up', 'up', 'up'])
    sim.takenAt.set('order-outer', sim.gameTime)
    const takenAt = sim.gameTime
    for (let i = 0; i < 5; i++) step()
    const outer = tracker.snapshot().find((relic) => relic.id === 'order-outer')!
    expect(outer.state).toBe('spawn')
    expect(outer.at).toBeCloseTo(takenAt + 1 + RELIC_TIMES.respawn, 0)
    while (sim.gameTime < takenAt + 100) step()
    expect(tracker.snapshot().find((relic) => relic.id === 'order-outer')!.state).toBe('up')
  })

  it('uses the measured pads of its map', () => {
    const pads = [{ id: 'order-base', team: 'ORDER' as const, kind: 'base' as const, pos: { x: 0.2, y: 0.8 } }]
    const sim = new SimGame({ ...options, map: 30 }, () => ({ '30': pads }))
    expect(sim.pads()).toEqual(pads)
    // base relics are there from the start
    expect(sim.seen(pads, 10)).toEqual(['present'])
    expect(new SimGame({ ...options, map: 31 }, () => ({})).pads()).toEqual([])
  })
})

describe('measured relic pads', () => {
  it('keeps only valid pads', () => {
    expect(
      validPads([
        { id: 'a', team: 'ORDER', kind: 'base', pos: { x: 0.1, y: 0.9 }, seen: 'present' },
        { id: 'b', team: 'GREEN', kind: 'base', pos: { x: 0.1, y: 0.9 } },
        { id: 'c', team: 'CHAOS', kind: 'inner', pos: { x: 1.2, y: 0.5 } },
        null,
        'x'
      ])
    ).toEqual([{ id: 'a', team: 'ORDER', kind: 'base', pos: { x: 0.1, y: 0.9 } }])
    expect(validPads({})).toEqual([])
  })
})
