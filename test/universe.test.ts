import { describe, expect, it } from 'vitest'
import {
  GALAXY_COUNT,
  STAR_STRIDE,
  UNIVERSE,
  UNIVERSE_RADIUS,
  cosmicSeed,
  cross,
  dot,
  galaxyOf,
  galaxyStars,
  length,
  placeOf,
  sub
} from '../src/shared/universe'
import { FLIGHT_S, JOURNEY_S, flightPlan, routeDust } from '../src/shared/journey'

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

  it('generates the same stars for a galaxy every time, inside its disk', () => {
    const stars = galaxyStars(UNIVERSE[5], 2000)
    expect(stars).toEqual(galaxyStars(UNIVERSE[5], 2000))
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
    ...Array.from({ length: 40 }, (_, i): [number, number] => [cosmicSeed(i * 97 + 5), cosmicSeed(i * 131 + 9)])
  ]

  it('starts at the old place, ends at the new one and never jumps', () => {
    for (const [from, to] of pairs) {
      const plan = flightPlan(from, to)
      expect(length(sub(plan.cameraAt(0).eye, placeOf(from).pos))).toBeLessThan(1e-9)
      expect(length(sub(plan.cameraAt(FLIGHT_S).eye, placeOf(to).pos))).toBeLessThan(1e-9)
      expect(plan.cameraAt(JOURNEY_S).eye).toEqual(plan.cameraAt(FLIGHT_S).eye)
      let previous = plan.cameraAt(0)
      for (let t = 0.02; t <= JOURNEY_S; t += 0.02) {
        const pose = plan.cameraAt(t)
        for (const value of [...pose.eye, ...pose.forward, ...pose.up, pose.fovY]) expect(Number.isFinite(value)).toBe(true)
        expect(Math.abs(length(pose.forward) - 1)).toBeLessThan(1e-9)
        expect(Math.abs(dot(pose.forward, pose.up))).toBeLessThan(1e-6)
        // the view never turns by more than a few degrees between two frames
        expect(dot(pose.forward, previous.forward)).toBeGreaterThan(0.99)
        expect(dot(pose.up, previous.up)).toBeGreaterThan(0.99)
        previous = pose
      }
    }
  })

  it('keeps the target dead ahead from mid-flight on', () => {
    // a pair of places in two galaxies far apart
    const far = Array.from({ length: 50 }, (_, i) => flightPlan(cosmicSeed(i), cosmicSeed(i + 1000))).find(
      (candidate) => candidate.distance > 60
    )
    expect(far).toBeDefined()
    const plan = far!
    const target = plan.cameraAt(FLIGHT_S).eye
    for (const t of [4.5, 5.5, 6.5, 7.5, 9]) {
      const pose = plan.cameraAt(t)
      const toTarget = sub(target, pose.eye)
      expect(dot(pose.forward, toTarget) / length(toTarget)).toBeGreaterThan(0.9)
    }
  })

  it('scatters dust around the route', () => {
    const plan = flightPlan(cosmicSeed(1), cosmicSeed(2))
    const { data, range } = routeDust(plan, 500)
    expect(data).toHaveLength(500 * 8)
    expect(range).toBeGreaterThan(0)
    expect(data.every((value) => Number.isFinite(value))).toBe(true)
  })
})
