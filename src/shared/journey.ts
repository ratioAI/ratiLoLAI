import { add, cross, dot, length, lerp, normalize, placeOf, prng, scale, sub, type Galaxy, type Vec3 } from './universe'

/** Seconds from take-off until the camera has reached the target star. Landing on the planet follows. */
export const FLIGHT_S = 10.7
/** Whole flight including the landing. */
export const JOURNEY_S = 12

export interface CameraPose {
  eye: Vec3
  forward: Vec3
  up: Vec3
  /** vertical field of view in radians; widens at high speed */
  fovY: number
  /** 0 at rest, 1 at top speed */
  speed: number
}

export interface FlightPlan {
  from: Galaxy
  to: Galaxy
  /** length of the route in world units */
  distance: number
  cameraAt(seconds: number): CameraPose
  /** a point on the route, 0 = start and 1 = target */
  pointAt(fraction: number): Vec3
}

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Progress along the route over time. Distances in space span many orders of magnitude (a star's
 * neighbourhood, a galaxy, the gap between galaxies), so the camera speeds up exponentially when
 * leaving and brakes exponentially when arriving. That way every scale gets its share of the flight.
 */
function progress(x: number): number {
  const K = 9
  const rising = Math.exp(K * x) - 1
  const falling = Math.exp(K * (1 - x)) - 1
  return rising / (rising + falling)
}

/** The component of `v` inside the plane with normal `n`, normalised (or `fallback` if there is none). */
function inPlane(v: Vec3, n: Vec3, fallback: Vec3): Vec3 {
  const flat = sub(v, scale(n, dot(v, n)))
  return length(flat) > 1e-6 ? normalize(flat) : fallback
}

/**
 * The flight between two places as a camera path through the universe: up and out of the first
 * galaxy at a slant, across intergalactic space with the target galaxy ahead, then down over the
 * target's disk and into one of its arms until the camera stops at the target star.
 */
export function flightPlan(fromSeed: number, toSeed: number): FlightPlan {
  const start = placeOf(fromSeed)
  const end = placeOf(toSeed)
  const A = start.galaxy
  const B = end.galaxy
  const P0 = start.pos
  const P3 = end.pos
  const gap = sub(P3, P0)
  const distance = length(gap)
  // leave on the side of the disk that faces the target, arrive on the side that faces where we came from
  const nA = dot(A.normal, gap) >= 0 ? A.normal : scale(A.normal, -1)
  const nB = A.id === B.id ? nA : dot(B.normal, gap) <= 0 ? B.normal : scale(B.normal, -1)
  // take off at a shallow angle: the first seconds skim through the stars of the disk
  const out = normalize(add(scale(nA, 0.28), scale(inPlane(gap, nA, A.axisU), 0.96)))
  const back = normalize(add(scale(nB, 0.5), scale(inPlane(scale(gap, -1), nB, scale(B.axisU, -1)), 0.87)))
  const reach = Math.max(A.radius, B.radius)
  // Bezier handles. The one at the start is short so the first seconds stay among the stars around
  // the old planet; the one at the end is long so the target galaxy is approached in a wide sweep.
  const handleOut = 3 * A.radius
  const handleIn = Math.min(14 * B.radius, Math.max(4 * reach, 0.35 * distance))
  // a hop within one galaxy is an arc that comes back down, so there the camera just looks along the path
  const aiming = smooth(1.5 * reach, 5 * reach, distance)
  const C1 = add(P0, scale(out, handleOut))
  const C2 = add(P3, scale(back, handleIn))

  const pointAt = (u: number): Vec3 => {
    const v = 1 - u
    return [0, 1, 2].map((i) => v * v * v * P0[i] + 3 * v * v * u * C1[i] + 3 * v * u * u * C2[i] + u * u * u * P3[i]) as Vec3
  }
  const tangentAt = (u: number): Vec3 => {
    const v = 1 - u
    return normalize([0, 1, 2].map((i) => 3 * v * v * (C1[i] - P0[i]) + 6 * v * u * (C2[i] - C1[i]) + 3 * u * u * (P3[i] - C2[i])) as Vec3)
  }
  const arrival = normalize(sub(P3, C2))
  const forwardAt = (seconds: number): Vec3 => {
    const x = Math.min(1, Math.max(0, seconds / FLIGHT_S))
    const u = progress(x)
    const toTarget = sub(P3, pointAt(u))
    // first look where we're going, then turn to keep the target dead ahead
    const aim = length(toTarget) > 1e-7 ? normalize(toTarget) : arrival
    return normalize(lerp(tangentAt(u), aim, smooth(0.12, 0.42, x) * aiming))
  }

  // Up vector carried along the path in small steps (parallel transport). Unlike a fixed "up" this
  // never flips when the camera happens to look straight along it.
  const STEP = 0.02
  const ups: Vec3[] = []
  let up = inPlane(nA, forwardAt(0), cross(forwardAt(0), A.axisU))
  for (let i = 0; i <= Math.ceil(JOURNEY_S / STEP); i++) {
    up = inPlane(up, forwardAt(i * STEP), up)
    ups.push(up)
  }

  return {
    from: A,
    to: B,
    distance,
    pointAt,
    cameraAt(seconds) {
      const t = Math.min(JOURNEY_S, Math.max(0, seconds))
      const u = progress(Math.min(1, t / FLIGHT_S))
      const forward = forwardAt(t)
      const index = Math.min(ups.length - 2, Math.floor(t / STEP))
      const upNow = inPlane(lerp(ups[index], ups[index + 1], t / STEP - index), forward, ups[index])
      const speed = 4 * u * (1 - u)
      return { eye: pointAt(u), forward, up: upNow, fovY: 0.95 + 0.4 * speed, speed }
    }
  }
}

/**
 * Dust grains scattered in a tube around the route, as line vertices for UniverseGl.drawStreaks
 * (two vertices per grain: x, y, z, end).
 */
export function routeDust(plan: FlightPlan, grains: number): { data: Float32Array; range: number } {
  const rand = prng(Math.round(plan.distance * 1000) + plan.from.id * 31 + plan.to.id)
  const tube = Math.min(8, Math.max(1.5, plan.distance * 0.06))
  const data = new Float32Array(grains * 8)
  for (let i = 0; i < grains; i++) {
    const centre = plan.pointAt(0.02 + rand() * 0.96)
    const z = rand() * 2 - 1
    const angle = rand() * 2 * Math.PI
    const r = Math.sqrt(1 - z * z) * tube * Math.cbrt(rand())
    const pos: Vec3 = [centre[0] + r * Math.cos(angle), centre[1] + r * Math.sin(angle), centre[2] + z * tube * Math.cbrt(rand())]
    data.set([...pos, 0, ...pos, 1], i * 8)
  }
  return { data, range: tube * 2.5 }
}
