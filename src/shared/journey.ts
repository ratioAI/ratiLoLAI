import { add, cross, dot, extentOf, length, lerp, normalize, placeOf, prng, scale, sub, type Galaxy, type Vec3 } from './universe'

/*
 * The flight from the planet of the last game to the planet of the next one, as a camera path
 * through the universe catalogue. There are two kinds, picked at random:
 *
 *   wormhole   up and across the home galaxy to a wormhole hanging above it. In its sphere you
 *              already see the target galaxy. Into the throat, through the tunnel, out of the
 *              other mouth high above the target galaxy, down into it.
 *   blackhole  out of the home galaxy towards a supermassive black hole between the galaxies, a
 *              close swing-by just above its accretion disk that bends the course towards the
 *              target, then on to the target galaxy and down into it.
 *
 * Both start with the take-off from the old planet and end with the same arrival: into an arm (or
 * clump, or ring) of the target galaxy, its stars rushing past, the target star turning into a sun
 * with planets, landing. Timeline in seconds:
 *
 *   0    to 2.4    take-off, the old planet's horizon drops away (painted by the flight shader)
 *   wormhole: 2 to 9.2 across the galaxy to the wormhole · 9.2 to 10.8 through the throat ·
 *             10.8 to 14.6 out above the target galaxy and down to the target star
 *   blackhole: 2 to 6.4 out towards the black hole · 6.4 to 10.6 swing-by · 10.6 to 14.6 on to
 *              the target galaxy and down to the target star
 *   14.6 to 16     landing, the new planet becomes the horizon and its night sky fades in
 *
 * Distances in space span many orders of magnitude (a star's neighbourhood, a galaxy, the gap
 * between galaxies), so every leg moves on a logarithmic schedule: fast where everything is far,
 * slow where something is close. Where two legs meet they have the same speed and direction.
 */

/** Seconds from take-off until the camera has reached the target star. Landing on the planet follows. */
export const FLIGHT_S = 14.6
/** Whole flight including the landing. */
export const JOURNEY_S = 16
/** How much later the arrival happens than in the 12-second flight of 1.0 (the landing shader keeps its old timings). */
export const ARRIVAL_SHIFT = FLIGHT_S - 10.7

export const FLIGHT_VARIANTS = ['wormhole', 'blackhole'] as const
export type FlightVariant = (typeof FLIGHT_VARIANTS)[number]

export interface CameraPose {
  eye: Vec3
  forward: Vec3
  up: Vec3
  /** vertical field of view in radians */
  fovY: number
  /** 0 to 1: how much the renderer may shake the camera (in the wormhole's throat, close to the black hole) */
  shake: number
}

export interface Wormhole {
  /** centres of the two mouths */
  entry: Vec3
  exit: Vec3
  /** throat radius at each end, in world units */
  entryRadius: number
  exitRadius: number
  /** 3x3 rotation (column-major, as uniformMatrix3fv wants it) taking a direction at the entry to the same direction at the exit */
  turn: number[]
  /** start and end of the passage through the throat, in seconds */
  transit: [number, number]
}

export interface BlackHole {
  pos: Vec3
  /** Schwarzschild radius in world units; everything else here is in units of it */
  rs: number
  /** frame of the accretion disk: axisX and axisZ span it, normal is its axis */
  axisX: Vec3
  normal: Vec3
  axisZ: Vec3
  diskInner: number
  diskOuter: number
  /** closest approach of the camera */
  periapsis: number
  /** start and end of the swing-by leg, in seconds */
  flyby: [number, number]
}

export interface FlightPlan {
  variant: FlightVariant
  from: Galaxy
  to: Galaxy
  /** straight distance between the two places, in world units */
  distance: number
  cameraAt(seconds: number): CameraPose
  wormhole?: Wormhole
  blackHole?: BlackHole
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
const bump = (a: number, b: number, c: number, x: number): number => smooth(a, b, x) * (1 - smooth(b, c, x))

/** The component of `v` inside the plane with normal `n`, normalised (or `fallback` if there is none). */
function inPlane(v: Vec3, n: Vec3, fallback: Vec3): Vec3 {
  const flat = sub(v, scale(n, dot(v, n)))
  return length(flat) > 1e-6 ? normalize(flat) : fallback
}

/** Unit vector perpendicular to `v`. */
function perpendicular(v: Vec3): Vec3 {
  return normalize(cross(v, Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
}

/** Rotates `v` about the unit axis `k` by `angle` (Rodrigues). */
function rotate(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)))
}

/**
 * Logarithmic schedule along a leg of length `span`: x (0..1, time) to the fraction of the way
 * covered. Near the start the distance travelled grows like s0 * (e^(ax) - 1), near the end the
 * distance left shrinks like s1 * (e^(b(1-x)) - 1). s0 and s1 are the length scales at the two ends:
 * a star's neighbourhood, a wormhole, a black hole's surroundings.
 */
function logProgress(x: number, span: number, s0: number, s1: number): number {
  const a = Math.log(1 + span / s0)
  const b = Math.log(1 + span / s1)
  const rising = s0 * Math.expm1(a * x)
  const falling = s1 * Math.expm1(b * (1 - x))
  return rising / (rising + falling)
}

function cubic(P0: Vec3, P1: Vec3, P2: Vec3, P3: Vec3): (u: number) => Vec3 {
  return (u) => {
    const v = 1 - u
    return [0, 1, 2].map((i) => v * v * v * P0[i] + 3 * v * v * u * P1[i] + 3 * v * u * u * P2[i] + u * u * u * P3[i]) as Vec3
  }
}

interface Leg {
  t0: number
  t1: number
  at(seconds: number): Vec3
}

function bezierLeg(t0: number, t1: number, P0: Vec3, P1: Vec3, P2: Vec3, P3: Vec3, s0: number, s1: number): Leg {
  const curve = cubic(P0, P1, P2, P3)
  const span = Math.max(1e-9, length(sub(P1, P0)) + length(sub(P2, P1)) + length(sub(P3, P2)))
  return { t0, t1, at: (seconds) => curve(logProgress(clamp01((seconds - t0) / (t1 - t0)), span, s0, s1)) }
}

/** Speed at the start or the end of a leg, in world units per second. */
function legSpeed(leg: Leg, end: 'start' | 'end'): number {
  const h = (leg.t1 - leg.t0) * 1e-4
  return end === 'start' ? length(sub(leg.at(leg.t0 + h), leg.at(leg.t0))) / h : length(sub(leg.at(leg.t1), leg.at(leg.t1 - h))) / h
}

/** The length scale for `build` that gives `speed` at the given end of the leg (bisection, speed grows with the scale). */
function scaleForSpeed(build: (s: number) => Leg, speed: number, end: 'start' | 'end', reference: number): number {
  let lo = Math.log(reference * 1e-7)
  let hi = Math.log(reference * 1e3)
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (legSpeed(build(Math.exp(mid)), end) < speed) lo = mid
    else hi = mid
  }
  return Math.exp((lo + hi) / 2)
}

/** Direction of travel at time t, from the positions around it. */
function tangentOf(at: (t: number) => Vec3, t: number, t0: number, t1: number): Vec3 {
  const h = 1e-3
  const a = at(Math.max(t0, t - h))
  const b = at(Math.min(t1, t + h))
  const d = sub(b, a)
  return length(d) > 1e-12 ? normalize(d) : [0, 0, 1]
}

/** Visible radius of a galaxy (dwarfs are smaller than their catalogue radius). */
const sizeOf = (galaxy: Galaxy): number => galaxy.radius * extentOf(galaxy)

/** Side of the target galaxy's disk we arrive on: the one facing where we come from. */
function arrivalNormal(A: Galaxy, B: Galaxy, gap: Vec3, nA: Vec3): Vec3 {
  if (A.id === B.id) return scale(nA, -1)
  return dot(B.normal, gap) <= 0 ? B.normal : scale(B.normal, -1)
}

/**
 * Up vectors along the flight, carried along in small steps (parallel transport). Unlike a fixed
 * "up" this never flips when the camera happens to look straight along it. `restart` lists times
 * at which the transport starts over from a given vector (the far side of the wormhole).
 */
function transportUps(
  forwardAt: (t: number) => Vec3,
  start: Vec3,
  restart: { at: number; up: () => Vec3 }[] = [],
  /** optionally rolls the camera towards an up vector of its own (how much, 0 to 1, for this step) */
  steer?: (t: number, forward: Vec3) => { towards: Vec3; amount: number } | null
): (t: number) => Vec3 {
  const STEP = 0.02
  const ups: Vec3[] = []
  let up = inPlane(start, forwardAt(0), perpendicular(forwardAt(0)))
  let next = 0
  for (let i = 0; i <= Math.ceil(JOURNEY_S / STEP); i++) {
    const t = i * STEP
    if (next < restart.length && t >= restart[next].at) up = restart[next++].up()
    const forward = forwardAt(t)
    up = inPlane(up, forward, up)
    const roll = steer?.(t, forward)
    if (roll) up = inPlane(blend(up, inPlane(roll.towards, forward, up), roll.amount), forward, up)
    ups.push(up)
  }
  return (t) => {
    const index = Math.min(ups.length - 2, Math.floor(t / STEP))
    // never blend across a restart
    const cut = restart.find((candidate) => index * STEP < candidate.at && (index + 1) * STEP >= candidate.at)
    const mix = cut ? (t >= cut.at ? 1 : 0) : t / STEP - index
    return inPlane(lerp(ups[index], ups[index + 1], mix), forwardAt(t), ups[index])
  }
}

/** Where to aim: the direction from `eye` to `target`, or `fallback` once we are there. */
const aim = (eye: Vec3, target: Vec3, fallback: Vec3): Vec3 => {
  const d = sub(target, eye)
  return length(d) > 1e-7 ? normalize(d) : fallback
}

/** Turns direction `a` towards `b` along the great circle (slerp), so even far-apart directions blend without a flip. */
function blend(a: Vec3, b: Vec3, t: number): Vec3 {
  if (t <= 0) return a
  if (t >= 1) return b
  const cos = Math.min(1, Math.max(-1, dot(a, b)))
  const angle = Math.acos(cos)
  if (angle < 1e-4) return normalize(lerp(a, b, t))
  const side = inPlane(b, a, perpendicular(a))
  return normalize(add(scale(a, Math.cos(angle * t)), scale(side, Math.sin(angle * t))))
}

/** A seeded random stream per pair of places, for the choices a flight makes (which side, how big). */
const pairRandom = (fromSeed: number, toSeed: number): (() => number) =>
  prng(Math.abs(Math.round(fromSeed * 7.31)) * 31 + Math.abs(Math.round(toSeed * 7.31)) + 7)

/**
 * The arrival leg shared by both kinds: from `X` heading along `heading` down to the target star.
 * `start` is either the speed to start with (matching the leg before) or, after the wormhole, the
 * length scale to start from.
 */
function arrivalLeg(t0: number, X: Vec3, heading: Vec3, start: { speed: number } | { scale: number }, B: Galaxy, P3: Vec3, nB: Vec3): Leg {
  const RB = sizeOf(B)
  const span = length(sub(P3, X))
  const back = normalize(add(scale(nB, 0.5), scale(inPlane(sub(X, P3), nB, scale(B.axisU, -1)), 0.87)))
  // from far away the galaxy is approached in a wide sweep; from close by the handles stay short
  const handleIn = span > 8 * RB ? Math.min(14 * RB, Math.max(4 * RB, 0.35 * span)) : 0.45 * span
  const handleOut = span > 8 * RB ? Math.min(0.45 * span, Math.max(0.8 * RB, 0.3 * span)) : 0.3 * span
  const build = (s0: number) =>
    bezierLeg(t0, FLIGHT_S, X, add(X, scale(heading, handleOut)), add(P3, scale(back, handleIn)), P3, s0, 0.0012 * RB)
  return build('speed' in start ? scaleForSpeed(build, start.speed, 'start', span) : start.scale)
}

// ---------------------------------------------------------------------------------------------
// wormhole

const W_ENTER = 9.2
const W_EXIT = 10.8

function wormholePlan(fromSeed: number, toSeed: number): FlightPlan {
  const start = placeOf(fromSeed)
  const end = placeOf(toSeed)
  const A = start.galaxy
  const B = end.galaxy
  const P0 = start.pos
  const P3 = end.pos
  const RA = sizeOf(A)
  const RB = sizeOf(B)
  const gap = sub(B.pos, A.pos)
  const nA = A.id === B.id || dot(A.normal, gap) >= 0 ? A.normal : scale(A.normal, -1)
  const nB = arrivalNormal(A, B, gap, nA)

  // the entry mouth hangs just above the far rim of the home galaxy, as seen from the home star:
  // flying in low across the disk, the galaxy lies below it in the picture and is lensed around it
  const radialA = inPlane(sub(P0, A.pos), nA, A.axisU)
  const rhoA = 0.18 * RA
  const W1 = add(add(A.pos, scale(radialA, -1.15 * RA)), scale(nA, 0.42 * RA))
  const fin = normalize(add(scale(radialA, -0.995), scale(nA, -0.05)))
  const A1 = sub(W1, scale(fin, 1.15 * rhoA))
  const out = normalize(add(scale(nA, 0.35), scale(radialA, -0.94)))
  const approach = bezierLeg(0, W_ENTER, P0, add(P0, scale(out, 0.7 * RA)), sub(A1, scale(fin, 1.4 * RA)), A1, 0.0012 * RA, 1.6 * rhoA)

  // the exit mouth hangs high above the far side of the target galaxy and looks down across it
  const radialB = inPlane(sub(P3, B.pos), nB, B.axisU)
  const rhoB = 0.18 * RB
  const W2 = add(add(B.pos, scale(radialB, -1.3 * RB)), scale(nB, 0.95 * RB))
  const fout = normalize(sub(add(B.pos, scale(radialB, 0.25 * RB)), W2))
  const X1 = add(W2, scale(fout, 1.15 * rhoB))
  // out of the mouth slowly enough to take in the view, then down into the galaxy
  const arrival = arrivalLeg(W_EXIT, X1, fout, { scale: 1.2 * rhoB }, B, P3, nB)

  const eyeAt = (t: number): Vec3 => (t < W_EXIT ? approach.at(Math.min(t, W_ENTER)) : arrival.at(t))
  const forwardAt = (t: number): Vec3 => {
    if (t < W_ENTER) {
      const eye = approach.at(t)
      return blend(tangentOf(approach.at, t, 0, W_ENTER), aim(eye, W1, fin), smooth(2.2, 5.0, t))
    }
    if (t < W_EXIT) return fin
    const eye = arrival.at(t)
    const arrive = tangentOf(arrival.at, FLIGHT_S, W_EXIT, FLIGHT_S)
    return blend(
      blend(tangentOf(arrival.at, t, W_EXIT, FLIGHT_S), fout, 1 - smooth(W_EXIT, 11.6, t)),
      aim(eye, P3, arrive),
      smooth(11.0, 12.6, t)
    )
  }

  // the rotation that carries the entry frame (forward, up) onto the exit frame
  const upsBefore = transportUps(forwardAt, nA)
  const upIn = inPlane(upsBefore(W_ENTER - 1e-6), fin, perpendicular(fin))
  const upOut = inPlane(nB, fout, perpendicular(fout))
  const frameIn = [cross(fin, upIn), upIn, fin]
  const frameOut = [cross(fout, upOut), upOut, fout]
  // R = Fout * Fin^T, column-major: column j is R applied to the unit vector e_j
  const turn: number[] = []
  for (let j = 0; j < 3; j++)
    for (let i = 0; i < 3; i++) turn.push(frameOut[0][i] * frameIn[0][j] + frameOut[1][i] * frameIn[1][j] + frameOut[2][i] * frameIn[2][j])
  const upAt = transportUps(forwardAt, nA, [{ at: W_EXIT, up: () => upOut }])

  return {
    variant: 'wormhole',
    from: A,
    to: B,
    distance: length(sub(P3, P0)),
    wormhole: { entry: W1, exit: W2, entryRadius: rhoA, exitRadius: rhoB, turn, transit: [W_ENTER, W_EXIT] },
    cameraAt(seconds) {
      const t = Math.min(JOURNEY_S, Math.max(0, seconds))
      const fovY =
        t < W_ENTER
          ? 0.95 + 0.22 * bump(3, 5.2, 7.4, t) + 0.25 * smooth(7.8, W_ENTER, t)
          : t < W_EXIT
            ? 1.2
            : 1.2 - 0.25 * smooth(W_EXIT, 12.4, t) + 0.2 * bump(12.2, 13.2, 14.3, t)
      const shake = t < W_ENTER ? 0.35 * smooth(8.2, W_ENTER, t) : t < W_EXIT ? 1 : 0.5 * (1 - smooth(W_EXIT, 11.6, t))
      return { eye: eyeAt(t), forward: forwardAt(t), up: upAt(t), fovY, shake }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// black hole

const B_FLYBY: [number, number] = [6.4, 10.6]
const DISK_INNER = 3
const DISK_OUTER = 14
const PERIAPSIS = 20
/** how far from the hole (in rs) the swing-by leg starts and ends */
const FLYBY_EDGE = 110
/** angle between the camera's path and the disk plane: just above it, for the classic view of the disk edge-on */
const DISK_TILT = (10 * Math.PI) / 180

function blackholePlan(fromSeed: number, toSeed: number): FlightPlan {
  const start = placeOf(fromSeed)
  const end = placeOf(toSeed)
  const A = start.galaxy
  const B = end.galaxy
  const P0 = start.pos
  const P3 = end.pos
  const RA = sizeOf(A)
  const RB = sizeOf(B)
  const rand = pairRandom(fromSeed, toSeed)
  const gap = sub(B.pos, A.pos)
  const D = length(gap)
  const nA = A.id === B.id || dot(A.normal, gap) >= 0 ? A.normal : scale(A.normal, -1)
  const nB = arrivalNormal(A, B, gap, nA)

  // the hole sits off to the side between the two galaxies, so the swing-by has to bend the course
  const along = D > 1e-6 ? scale(gap, 1 / D) : inPlane(A.axisU, nA, perpendicular(nA))
  const side = scale(perpendicular(along), rand() < 0.5 ? 1 : -1)
  const twist = rotate(side, along, rand() * 2 * Math.PI)
  const M = add(add(A.pos, scale(gap, 0.5)), scale(twist, 0.45 * D + 14 * Math.max(RA, RB)))
  const rs = 0.09 + 0.03 * rand()

  const din = normalize(sub(M, A.pos))
  let dout = normalize(sub(B.pos, M))
  // keep the turn between 50 and 150 degrees: a hyperbola needs some bend, and must not be a U-turn
  const bend = Math.acos(Math.min(1, Math.max(-1, dot(din, dout))))
  const turnAngle = Math.min((150 * Math.PI) / 180, Math.max((50 * Math.PI) / 180, bend))
  const across = inPlane(dout, din, perpendicular(din))
  dout = normalize(add(scale(din, Math.cos(turnAngle)), scale(across, Math.sin(turnAngle))))
  const e = 1 / Math.sin(turnAngle / 2)
  const p = PERIAPSIS * (1 + e)
  const e1 = normalize(sub(din, dout)) // towards the closest approach
  const e2 = normalize(add(din, dout)) // direction of travel there
  const nTraj = normalize(cross(e1, e2))
  const normal = normalize(add(scale(e1, Math.sin(DISK_TILT)), scale(nTraj, Math.cos(DISK_TILT))))
  const axisX = inPlane(e1, normal, perpendicular(normal))
  const axisZ = cross(axisX, normal)

  const hyperbola = (nu: number): Vec3 =>
    add(M, scale(add(scale(e1, Math.cos(nu)), scale(e2, Math.sin(nu))), (rs * p) / (1 + e * Math.cos(nu))))
  const nuEdge = Math.acos(Math.min(1, Math.max(-1, (p / FLYBY_EDGE - 1) / e)))
  // time along the swing-by: speed grows with the distance to the hole, so it slows down where it matters
  const SAMPLES = 1600
  const nus: number[] = []
  const times: number[] = [0]
  for (let i = 0; i <= SAMPLES; i++) nus.push(-nuEdge + (2 * nuEdge * i) / SAMPLES)
  for (let i = 1; i <= SAMPLES; i++) {
    const a = hyperbola(nus[i - 1])
    const b = hyperbola(nus[i])
    const r = length(sub(lerp(a, b, 0.5), M)) / rs
    times.push(times[i - 1] + length(sub(b, a)) / Math.pow(r, 1.25))
  }
  const total = times[SAMPLES]
  const [f0, f1] = B_FLYBY
  const flybyAt = (seconds: number): Vec3 => {
    const target = (clamp01((seconds - f0) / (f1 - f0)) * total) as number
    let lo = 0
    let hi = SAMPLES
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (times[mid] < target) lo = mid
      else hi = mid
    }
    const k = (target - times[lo]) / Math.max(1e-12, times[hi] - times[lo])
    return hyperbola(nus[lo] + (nus[hi] - nus[lo]) * clamp01(k))
  }
  const flyby: Leg = { t0: f0, t1: f1, at: flybyAt }
  const H0 = hyperbola(-nuEdge)
  const H1 = hyperbola(nuEdge)
  const inSpeed = legSpeed(flyby, 'start')
  const outSpeed = legSpeed(flyby, 'end')
  const tanIn = tangentOf(flybyAt, f0, f0, f1)
  const tanOut = tangentOf(flybyAt, f1, f0, f1)

  // out of the home galaxy at a shallow angle, onto the incoming branch of the hyperbola
  const span = length(sub(H0, P0))
  const out = normalize(add(scale(nA, 0.3), scale(inPlane(sub(H0, P0), nA, A.axisU), 0.95)))
  const buildDeparture = (s1: number) =>
    bezierLeg(0, f0, P0, add(P0, scale(out, Math.min(3 * RA, 0.3 * span))), sub(H0, scale(tanIn, 0.3 * span)), H0, 0.0012 * RA, s1)
  const departure = buildDeparture(scaleForSpeed(buildDeparture, inSpeed, 'end', span))
  const arrival = arrivalLeg(f1, H1, tanOut, { speed: outSpeed }, B, P3, nB)

  const eyeAt = (t: number): Vec3 => (t < f0 ? departure.at(t) : t < f1 ? flybyAt(t) : arrival.at(t))
  const arrive = tangentOf(arrival.at, FLIGHT_S, f1, FLIGHT_S)
  const travel = (t: number): Vec3 => (t < f1 ? tangentOf(flybyAt, t, f0, f1) : tangentOf(arrival.at, t, f1, FLIGHT_S))
  const forwardAt = (t: number): Vec3 => {
    const eye = eyeAt(t)
    if (t < f0) return blend(tangentOf(departure.at, t, 0, f0), aim(eye, M, din), smooth(1.8, 4.8, t))
    // eyes on the hole until it is beside us, then along the way we go, then on the target
    const passing = blend(blend(aim(eye, M, e2), travel(t), 0.22), travel(t), smooth(8.7, 9.9, t))
    return blend(passing, aim(eye, P3, arrive), smooth(10.2, 11.6, t))
  }
  // roll so that the disk lies level in the picture, the way the film frames it
  const upAt = transportUps(forwardAt, nA, [], (t) => ({
    towards: normal,
    amount: 0.035 * smooth(3.8, 5.2, t) * (1 - smooth(9.8, 10.8, t))
  }))

  return {
    variant: 'blackhole',
    from: A,
    to: B,
    distance: length(sub(P3, P0)),
    blackHole: { pos: M, rs, axisX, normal, axisZ, diskInner: DISK_INNER, diskOuter: DISK_OUTER, periapsis: PERIAPSIS, flyby: B_FLYBY },
    cameraAt(seconds) {
      const t = Math.min(JOURNEY_S, Math.max(0, seconds))
      const fovY = 0.95 + 0.28 * bump(2.4, 4.4, 6.2, t) + 0.12 * bump(7, 8.6, 10.2, t) + 0.22 * bump(11, 12.2, 13.8, t)
      const shake = 0.45 * bump(7.4, 8.5, 9.6, t)
      return { eye: eyeAt(t), forward: forwardAt(t), up: upAt(t), fovY, shake }
    }
  }
}

/** The flight between two places. */
export function flightPlan(fromSeed: number, toSeed: number, variant: FlightVariant = 'wormhole'): FlightPlan {
  return variant === 'blackhole' ? blackholePlan(fromSeed, toSeed) : wormholePlan(fromSeed, toSeed)
}

/**
 * Which kind of flight to take to `seed`: a coin toss, except that the same kind never comes three
 * times in a row. `recent` is the list of the last kinds flown, newest first.
 */
export function pickVariant(seed: number, recent: readonly FlightVariant[]): FlightVariant {
  const coin = prng(Math.abs(Math.round(seed * 7.31)) + 991)()
  const variant: FlightVariant = coin < 0.5 ? 'wormhole' : 'blackhole'
  if (recent.length >= 2 && recent[0] === variant && recent[1] === variant) return variant === 'wormhole' ? 'blackhole' : 'wormhole'
  return variant
}
