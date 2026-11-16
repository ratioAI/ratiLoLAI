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
import {
  FLIGHT_S,
  FLIGHT_VARIANTS,
  JOURNEY_S,
  PLANET_OFFSET,
  PLANET_RADIUS,
  captionAt,
  cinemaAt,
  destPlanetAt,
  flightPlan,
  homePlanetAt,
  pickVariant,
  sunGlowAt,
  type FlightVariant
} from '../src/shared/journey'

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
    it(`${variant}: starts at the old planet, ends at the new one beside its sun, and never jumps`, () => {
      for (const [from, to] of pairs) {
        const plan = flightPlan(from, to, variant)
        expect(length(sub(plan.cameraAt(0).eye, placeOf(from).pos))).toBeLessThan(1e-9)
        expect(plan.home).toEqual(placeOf(from).pos)
        expect(plan.sun).toEqual(placeOf(to).pos)
        expect(length(sub(plan.cameraAt(FLIGHT_S).eye, plan.planet))).toBeLessThan(1e-9)
        expect(length(sub(plan.planet, plan.sun))).toBeGreaterThan(0)
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
          // inside the throat the camera holds still (the passage is painted around it)
          if (t - 0.02 > jumpFrom && t < jumpTo) expect(length(sub(pose.eye, previous.eye))).toBeLessThan(1e-9)
          previous = pose
        }
      }
    }, 60_000) // heavy: ~27 flights sampled every 20 ms; the Windows release runner needs >5 s

    it(`${variant}: looks back at the home planet first, and has the target planet dead ahead at the end`, () => {
      for (const [from, to] of pairs.slice(0, 12)) {
        const plan = flightPlan(from, to, variant)
        for (const t of [1, 2, 3]) {
          const pose = plan.cameraAt(t)
          const toHome = sub(plan.home, pose.eye)
          expect(dot(pose.forward, toHome) / length(toHome)).toBeGreaterThan(0.999)
        }
        for (const t of [18, 19, 20, 21]) {
          const pose = plan.cameraAt(t)
          const toPlanet = sub(plan.planet, pose.eye)
          expect(dot(pose.forward, toPlanet) / length(toPlanet)).toBeGreaterThan(0.999)
          // and its sun is in the picture beside it, not behind us
          const toSun = sub(plan.sun, pose.eye)
          expect(dot(pose.forward, toSun) / length(toSun)).toBeGreaterThan(0.9)
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
    // the far side is painted from exactly where we come out
    expect(plan.cameraAt(exit).eye).toEqual(wormhole.exitEye)
    expect(dot(plan.cameraAt(exit).forward, wormhole.exitForward)).toBeGreaterThan(1 - 1e-9)
    // the turn is a rotation: it maps the view into the mouth onto the view out of the other one
    const R = wormhole.turn
    const apply = (v: number[]) => [0, 1, 2].map((i) => R[i] * v[0] + R[3 + i] * v[1] + R[6 + i] * v[2]) as [number, number, number]
    const into = plan.cameraAt(enter + 0.1)
    const out = plan.cameraAt(exit)
    expect(dot(apply(into.forward), out.forward)).toBeGreaterThan(0.9999)
    // ... including the roll, so the first frame outside continues the last one inside
    expect(dot(apply(plan.cameraAt(exit - 1e-6).up), out.up)).toBeGreaterThan(0.9999)
    expect(Math.abs(length(apply([0.3, -0.5, 0.8])) - Math.hypot(0.3, 0.5, 0.8))).toBeLessThan(1e-9)
  })

  it('swings by the black hole just above its disk, never through it and never into it', () => {
    for (const [from, to] of pairs) {
      const plan = flightPlan(from, to, 'slingshot')
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

  it('takes off from the plain night sky and lands on it', () => {
    expect(homePlanetAt(0)).toMatchObject({ ground: true, pitch: 0, drop: 0 })
    expect(destPlanetAt(JOURNEY_S)).toMatchObject({ ground: true, pitch: 0, drop: 0 })
    expect(cinemaAt(0)).toBe(0)
    expect(cinemaAt(JOURNEY_S)).toBe(0)
    expect(captionAt(0)).toBe(0)
    expect(captionAt(JOURNEY_S)).toBe(0)
    expect(sunGlowAt(10)).toBe(0)
  })

  it('never runs backwards: we only ever leave the old planet and only ever come closer to the new one', () => {
    let home = homePlanetAt(0)
    let dest = destPlanetAt(0)
    for (let t = 0.01; t <= JOURNEY_S; t += 0.01) {
      const [h, d] = [homePlanetAt(t), destPlanetAt(t)]
      // taking off: tipping down, rising, then the globe shrinking, without a jump
      expect(h.pitch).toBeGreaterThanOrEqual(home.pitch)
      expect(h.drop).toBeGreaterThanOrEqual(home.drop)
      expect(h.pitch - home.pitch).toBeLessThan(0.05)
      if (home.radius > 0) expect(h.radius).toBeLessThan(home.radius + 1e-12)
      if (h.radius > 0 && home.radius > 0) expect(h.radius / home.radius).toBeGreaterThan(0.97)
      expect(h.pinned).toBeLessThanOrEqual(home.pinned)
      // once the painted sky is gone it does not come back (and the other way round when landing)
      if (!home.ground) expect(h.ground).toBe(false)
      if (dest.ground) expect(d.ground).toBe(true)
      // landing: the globe growing, then tipping up and sinking, without a jump
      expect(d.radius).toBeGreaterThanOrEqual(dest.radius)
      if (d.radius > 0 && dest.radius > 0) expect(d.radius / dest.radius).toBeLessThan(1.03)
      expect(d.pitch).toBeLessThanOrEqual(dest.pitch)
      expect(dest.pitch - d.pitch).toBeLessThan(0.05)
      expect(d.drop).toBeLessThanOrEqual(dest.drop)
      expect(d.pinned).toBeGreaterThanOrEqual(dest.pinned)
      expect(d.night).toBeGreaterThanOrEqual(dest.night)
      home = h
      dest = d
    }
    // the painted sky is swapped for the universe (and back) only while the planet fills the screen
    for (let t = 0; t <= JOURNEY_S; t += 0.01) {
      const [h, d] = [homePlanetAt(t), destPlanetAt(t)]
      if (!h.ground && h.pitch < PLANET_OFFSET) expect(h.radius).toBeGreaterThan(PLANET_RADIUS * 0.4)
      if (!h.ground && h.pinned < 1) expect(h.pitch).toBe(PLANET_OFFSET)
      if (t > FLIGHT_S + 0.21) expect(d.radius).toBe(PLANET_RADIUS)
      if (d.pitch < PLANET_OFFSET) expect(d.radius).toBeGreaterThan(PLANET_RADIUS * 0.45)
      if (d.ground) expect(d.radius).toBe(PLANET_RADIUS)
    }
  })

  it('picks both kinds of flight, never the same three times in a row', () => {
    const recent: FlightVariant[] = []
    const counts = { wormhole: 0, slingshot: 0 }
    for (let i = 0; i < 400; i++) {
      const variant = pickVariant(cosmicSeed(1_790_000_000_000 + i * 60_000), recent)
      counts[variant]++
      if (recent.length >= 2) expect(recent[0] === variant && recent[1] === variant).toBe(false)
      recent.unshift(variant)
      recent.length = Math.min(recent.length, 2)
    }
    expect(counts.wormhole).toBeGreaterThan(120)
    expect(counts.slingshot).toBeGreaterThan(120)
  })
})
