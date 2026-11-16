import { describe, expect, it } from 'vitest'
import {
  GALAXY_COUNT,
  GALAXY_TYPES,
  STAR_STRIDE,
  UNIVERSE,
  UNIVERSE_RADIUS,
  cosmicSeed,
  cross,
  dot,
  galaxyKind,
  galaxyOf,
  galaxyStars,
  length,
  placeOf,
  sub
} from '../src/shared/universe'
import { FLIGHT_S, FLIGHT_VARIANTS, JOURNEY_S, flightPlan, pickVariant, type FlightVariant } from '../src/shared/journey'

describe('universe catalogue', () => {
  it('is a fixed map: same galaxies every time, unique names, no overlaps', () => {
    expect(UNIVERSE).toHaveLength(GALAXY_COUNT)
    expect(new Set(UNIVERSE.map((galaxy) => galaxy.name)).size).toBe(GALAXY_COUNT)
    // pinned values: if these change, every saved game moves to another galaxy
    expect(UNIVERSE[0].designation).toBe('RA-0001')
    expect(UNIVERSE[0].pos.map((value) => Math.round(value * 100) / 100)).toMatchInlineSnapshot(`
      [
        -52.21,
        12.09,
        -76.05,
      ]
    `)
    expect(UNIVERSE[GALAXY_COUNT - 1].name).toMatchInlineSnapshot(`"Nyiltis"`)
    for (const galaxy of UNIVERSE) {
      expect(length(galaxy.pos)).toBeLessThanOrEqual(UNIVERSE_RADIUS * 1.15)
      expect(Math.abs(dot(galaxy.axisU, galaxy.axisV))).toBeLessThan(1e-9)
      expect(length(sub(cross(galaxy.axisU, galaxy.axisV), galaxy.normal))).toBeLessThan(1e-9)
    }
    let closest = Infinity
    for (let a = 0; a < UNIVERSE.length; a++)
      for (let b = a + 1; b < UNIVERSE.length; b++)
        closest = Math.min(closest, length(sub(UNIVERSE[a].pos, UNIVERSE[b].pos)) / (UNIVERSE[a].radius + UNIVERSE[b].radius))
    expect(closest).toBeGreaterThan(1.5)
  })

  it('puts every game at a stable place inside its galaxy', () => {
    const seed = cosmicSeed(1_790_000_000_000)
    const place = placeOf(seed)
    expect(place.galaxy).toBe(galaxyOf(seed))
    expect(placeOf(seed).pos).toEqual(place.pos)
    expect(length(sub(place.pos, place.galaxy.pos))).toBeLessThan(place.galaxy.radius)
    // spread over the catalogue
    const visited = new Set(Array.from({ length: 400 }, (_, i) => galaxyOf(cosmicSeed(1_790_000_000_000 + i * 1_234_567)).id))
    expect(visited.size).toBeGreaterThan(250)
  })

  it('has every kind of galaxy, and adding the types moved nothing', () => {
    for (const type of GALAXY_TYPES) expect(UNIVERSE.filter((galaxy) => galaxy.type === type).length).toBeGreaterThan(8)
    expect(UNIVERSE.filter((galaxy) => galaxy.type === 'spiral').length).toBeGreaterThan(150)
    // pinned like the positions above: the type of a galaxy must not change between versions
    expect(UNIVERSE.slice(0, 12).map((galaxy) => galaxy.type)).toMatchInlineSnapshot(`
      [
        "elliptical",
        "spiral",
        "barred",
        "barred",
        "spiral",
        "lenticular",
        "spiral",
        "spiral",
        "lenticular",
        "barred",
        "spiral",
        "elliptical",
      ]
    `)
    for (const galaxy of UNIVERSE) {
      expect(galaxyKind(galaxy).length).toBeGreaterThan(3)
      if (galaxy.type === 'barred') expect(galaxy.arms).toBe(2)
    }
  })

  it('places games inside their galaxy for every type', () => {
    for (let i = 0; i < 3000; i++) {
      const place = placeOf(cosmicSeed(1_790_000_000_000 + i * 104_729))
      expect(length(sub(place.pos, place.galaxy.pos))).toBeLessThan(place.galaxy.radius)
    }
  })

  it('lays out the stars of each type inside the painted quad', () => {
    for (const type of GALAXY_TYPES) {
      const galaxy = UNIVERSE.find((candidate) => candidate.type === type)!
      const stars = galaxyStars(galaxy, 3000)
      expect(stars).toEqual(galaxyStars(galaxy, 3000))
      for (let i = 0; i < 3000; i++) {
        const [x, y, z, mag, warm] = stars.subarray(i * STAR_STRIDE, (i + 1) * STAR_STRIDE)
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(1.4501)
        expect(Math.abs(z)).toBeLessThan(type === 'elliptical' ? 1.31 : 1)
        expect(mag).toBeGreaterThanOrEqual(0)
        expect(warm).toBeLessThanOrEqual(1)
      }
    }
  })

  it('generates the same stars for a galaxy every time, inside its disk', () => {
    const spiral = UNIVERSE.find((galaxy) => galaxy.type === 'spiral')!
    const stars = galaxyStars(spiral, 2000)
    expect(stars).toEqual(galaxyStars(spiral, 2000))
    for (let i = 0; i < 2000; i++) {
      const [x, y, z, mag, warm] = stars.subarray(i * STAR_STRIDE, (i + 1) * STAR_STRIDE)
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(1.26)
      expect(Math.abs(z)).toBeLessThan(0.3)
      expect(mag).toBeGreaterThanOrEqual(0)
      expect(mag).toBeLessThanOrEqual(1)
      expect(warm).toBeLessThanOrEqual(1)
    }
  })
})

describe('flight plan', () => {
  const pairs: [number, number][] = [
    [cosmicSeed(1), cosmicSeed(2)],
    [cosmicSeed('a'), cosmicSeed('b')],
    [cosmicSeed(77), cosmicSeed(77)], // same place
    ...Array.from({ length: 24 }, (_, i): [number, number] => [cosmicSeed(i * 97 + 5), cosmicSeed(i * 131 + 9)])
  ]

  for (const variant of FLIGHT_VARIANTS) {
    it(`${variant}: starts at the old place, ends at the new one and never jumps`, () => {
      for (const [from, to] of pairs) {
        const plan = flightPlan(from, to, variant)
        expect(length(sub(plan.cameraAt(0).eye, placeOf(from).pos))).toBeLessThan(1e-9)
        expect(length(sub(plan.cameraAt(FLIGHT_S).eye, placeOf(to).pos))).toBeLessThan(1e-9)
        expect(plan.cameraAt(JOURNEY_S).eye).toEqual(plan.cameraAt(FLIGHT_S).eye)
        // the only jump allowed: out of the far mouth of the wormhole
        const [jumpFrom, jumpTo] = plan.wormhole?.transit ?? [-1, -1]
        let previous = plan.cameraAt(0)
        for (let t = 0.02; t <= JOURNEY_S; t += 0.02) {
          const pose = plan.cameraAt(t)
          for (const value of [...pose.eye, ...pose.forward, ...pose.up, pose.fovY, pose.shake]) expect(Number.isFinite(value)).toBe(true)
          expect(Math.abs(length(pose.forward) - 1)).toBeLessThan(1e-9)
          expect(Math.abs(dot(pose.forward, pose.up))).toBeLessThan(1e-6)
          if (!(t - 0.02 < jumpTo && t >= jumpTo - 1e-9)) {
            // the view never turns by more than a few degrees between two frames
            expect(dot(pose.forward, previous.forward)).toBeGreaterThan(0.99)
            expect(dot(pose.up, previous.up)).toBeGreaterThan(0.99)
          }
          // inside the throat the camera holds still (the tunnel is painted around it)
          if (t - 0.02 > jumpFrom && t < jumpTo) expect(length(sub(pose.eye, previous.eye))).toBeLessThan(1e-9)
          previous = pose
        }
      }
    }, 60_000) // heavy: ~27 flights sampled every 20 ms; the Windows release runner needs >5 s

    it(`${variant}: keeps the target dead ahead for the last seconds`, () => {
      for (const [from, to] of pairs.slice(0, 12)) {
        const plan = flightPlan(from, to, variant)
        const target = plan.cameraAt(FLIGHT_S).eye
        for (const t of [12.8, 13.4, 14]) {
          const pose = plan.cameraAt(t)
          const toTarget = sub(target, pose.eye)
          expect(dot(pose.forward, toTarget) / length(toTarget)).toBeGreaterThan(0.9)
        }
      }
    })
  }

  it('flies into the wormhole and comes out of the other mouth', () => {
    const plan = flightPlan(cosmicSeed(3), cosmicSeed(4), 'wormhole')
    const wormhole = plan.wormhole!
    const [enter, exit] = wormhole.transit
    expect(length(sub(plan.cameraAt(enter).eye, wormhole.entry)) / wormhole.entryRadius).toBeLessThan(1.2)
    expect(length(sub(plan.cameraAt(exit).eye, wormhole.exit)) / wormhole.exitRadius).toBeLessThan(1.2)
    // the turn is a rotation: it maps the view into the mouth onto the view out of the other one
    const R = wormhole.turn
    const apply = (v: number[]) => [0, 1, 2].map((i) => R[i] * v[0] + R[3 + i] * v[1] + R[6 + i] * v[2]) as [number, number, number]
    const into = plan.cameraAt(enter + 0.1).forward
    const out = plan.cameraAt(exit).forward
    expect(dot(apply(into), out)).toBeGreaterThan(0.9999)
    expect(Math.abs(length(apply([0.3, -0.5, 0.8])) - Math.hypot(0.3, 0.5, 0.8))).toBeLessThan(1e-9)
  })

  it('swings by the black hole just above its disk, never through it', () => {
    for (const [from, to] of pairs) {
      const plan = flightPlan(from, to, 'blackhole')
      const hole = plan.blackHole!
      let closest = Infinity
      for (let t = 0; t <= JOURNEY_S; t += 0.01) {
        const rel = sub(plan.cameraAt(t).eye, hole.pos)
        const r = length(rel) / hole.rs
        closest = Math.min(closest, r)
        // inside the disk's radius the camera is always above it
        if (r < hole.diskOuter + 1) expect(dot(rel, hole.normal) / hole.rs).toBeGreaterThan(0.5)
      }
      expect(closest).toBeGreaterThan(hole.periapsis - 0.3)
      expect(closest).toBeLessThan(hole.periapsis + 0.3)
    }
  })

  it('picks both kinds of flight, never the same three times in a row', () => {
    const recent: FlightVariant[] = []
    const counts = { wormhole: 0, blackhole: 0 }
    for (let i = 0; i < 400; i++) {
      const variant = pickVariant(cosmicSeed(1_790_000_000_000 + i * 60_000), recent)
      counts[variant]++
      if (recent.length >= 2) expect(recent[0] === variant && recent[1] === variant).toBe(false)
      recent.unshift(variant)
      recent.length = Math.min(recent.length, 2)
    }
    expect(counts.wormhole).toBeGreaterThan(120)
    expect(counts.blackhole).toBeGreaterThan(120)
  })
})
