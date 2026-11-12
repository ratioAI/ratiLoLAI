/**
 * The universe ratioAI lives in: a fixed catalogue of galaxies with real 3D positions.
 *
 * The catalogue is built once from a constant seed, so it is the same map on every machine and in
 * every version. Each game is played at one place in it (a star in one galaxy). The flight between
 * two games and the star map both render this catalogue with a perspective camera, so what you fly
 * past is what the map shows.
 */

export type Vec3 = [number, number, number]

export interface Galaxy {
  id: number
  name: string
  /** catalogue number, e.g. "RA-0417" */
  designation: string
  pos: Vec3
  /** radius of the visible disk in world units */
  radius: number
  /** orthonormal basis of the disk: axisU and axisV span it, normal points out of it */
  axisU: Vec3
  axisV: Vec3
  normal: Vec3
  /** number of spiral arms (2 to 4) */
  arms: number
  /** how tightly the arms are wound */
  twist: number
  /** position on the nebula palette, 0 to 1 */
  hue: number
  /** noise seed for dust and clumps */
  seed: number
}

/** Small seeded PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const normalize = (a: Vec3): Vec3 => {
  const len = length(a)
  return len > 1e-12 ? scale(a, 1 / len) : [0, 0, 1]
}
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Standard normal sample (Box-Muller). */
const gauss = (rand: () => number): number => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())

const randomUnit = (rand: () => number): Vec3 => {
  const z = rand() * 2 - 1
  const angle = rand() * 2 * Math.PI
  const r = Math.sqrt(1 - z * z)
  return [r * Math.cos(angle), r * Math.sin(angle), z]
}

const START = [
  'Vel',
  'Ar',
  'Kor',
  'Ny',
  'Thal',
  'Ix',
  'Or',
  'Zen',
  'Mir',
  'Sol',
  'Quo',
  'Eld',
  'Hy',
  'Ras',
  'Um',
  'Cael',
  'Dro',
  'Fen',
  'Lu',
  'Tor'
]
const MIDDLE = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'ar', 'en', 'il', 'om', 'ur', 'ys', 'an']
const END = ['ra', 'thos', 'mir', 'nix', 'dor', 'lune', 'vex', 'ris', 'gard', 'phon', 'tis', 'bra', 'quor', 'nea', 'rax', 'sei']

export const GALAXY_COUNT = 640
/** Radius of the sphere the catalogue fills. */
export const UNIVERSE_RADIUS = 110
const CATALOGUE_SEED = 0x7a710a1 // never change this: it would move every galaxy

function buildCatalogue(): Galaxy[] {
  const rand = prng(CATALOGUE_SEED)
  // galaxies gather in clusters, like the real thing, with a thin scatter in between
  const clusters = Array.from({ length: 30 }, () => {
    const direction = randomUnit(rand)
    const distance = 90 * Math.cbrt(rand())
    return { centre: [direction[0] * distance, direction[1] * distance * 0.7, direction[2] * distance] as Vec3, spread: 5 + rand() * 9 }
  })
  const galaxies: Galaxy[] = []
  const names = new Set<string>()
  let guard = 0
  while (galaxies.length < GALAXY_COUNT && guard++ < 100_000) {
    let pos: Vec3
    if (rand() < 0.82) {
      const cluster = clusters[Math.floor(rand() * clusters.length)]
      pos = [
        cluster.centre[0] + gauss(rand) * cluster.spread,
        cluster.centre[1] + gauss(rand) * cluster.spread,
        cluster.centre[2] + gauss(rand) * cluster.spread
      ]
    } else {
      pos = scale(randomUnit(rand), UNIVERSE_RADIUS * Math.cbrt(rand()))
    }
    const radius = 1 + rand() * rand() * 2.2
    // keep some room between neighbours so no two disks overlap
    if (length(pos) > UNIVERSE_RADIUS * 1.15 || galaxies.some((other) => length(sub(other.pos, pos)) < (other.radius + radius) * 1.6))
      continue
    const normal = randomUnit(rand)
    const helper: Vec3 = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const axisU = normalize(cross(helper, normal))
    const axisV = cross(normal, axisU)
    let name = ''
    do {
      name = START[Math.floor(rand() * START.length)] + MIDDLE[Math.floor(rand() * MIDDLE.length)] + END[Math.floor(rand() * END.length)]
    } while (names.has(name))
    names.add(name)
    const id = galaxies.length
    galaxies.push({
      id,
      name,
      designation: `RA-${String(id + 1).padStart(4, '0')}`,
      pos,
      radius,
      axisU,
      axisV,
      normal,
      arms: 2 + Math.floor(rand() * 3),
      twist: 2.4 + rand() * 2.8,
      hue: rand(),
      seed: rand() * 900
    })
  }
  return galaxies
}

/** Every galaxy there is. Index = id. */
export const UNIVERSE: readonly Galaxy[] = buildCatalogue()

/** Turns any value (game id, timestamp, string, ...) into a place seed. FNV-1a hash, scaled to a float. */
export const cosmicSeed = (value: number | string): number => {
  let hash = 2166136261
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return ((hash >>> 0) % 100000) / 7.31
}

const placeNumber = (seed: number): number => Math.abs(Math.round(seed * 7.31))

/** The galaxy a place seed (see cosmicSeed) lies in. */
export const galaxyOf = (seed: number): Galaxy => UNIVERSE[placeNumber(seed) % GALAXY_COUNT]

/** Point on the galaxy's spiral pattern at radius r (in disk radii), for arm number `arm`. */
const armAngle = (galaxy: Galaxy, r: number, arm: number): number => galaxy.twist * Math.log(r + 0.06) + (arm * 2 * Math.PI) / galaxy.arms

/** A point of the galaxy given in its own frame (x, y in the disk and z out of it, in disk radii) as a world position. */
export const toWorld = (galaxy: Galaxy, local: Vec3): Vec3 => [
  galaxy.pos[0] + galaxy.radius * (local[0] * galaxy.axisU[0] + local[1] * galaxy.axisV[0] + local[2] * galaxy.normal[0]),
  galaxy.pos[1] + galaxy.radius * (local[0] * galaxy.axisU[1] + local[1] * galaxy.axisV[1] + local[2] * galaxy.normal[1]),
  galaxy.pos[2] + galaxy.radius * (local[0] * galaxy.axisU[2] + local[1] * galaxy.axisV[2] + local[2] * galaxy.normal[2])
]

/**
 * Where in its galaxy a place lies: a star on one of the spiral arms. `local` is in the galaxy's
 * frame (disk radii), `pos` the same point in the world.
 */
export function placeOf(seed: number): { galaxy: Galaxy; local: Vec3; pos: Vec3 } {
  const galaxy = galaxyOf(seed)
  const rand = prng(placeNumber(seed) + 17)
  const r = 0.3 + rand() * 0.5
  const angle = armAngle(galaxy, r, Math.floor(rand() * galaxy.arms)) + (rand() - 0.5) * 0.25
  const local: Vec3 = [r * Math.cos(angle), r * Math.sin(angle), (rand() - 0.5) * 0.02]
  return { galaxy, local, pos: toWorld(galaxy, local) }
}

/**
 * The stars around a place: its stellar neighbourhood, much denser than galaxyStars can afford for
 * a whole galaxy. These are the stars that drift past right after take-off and just before landing.
 * Same layout as galaxyStars.
 */
export function neighbourhoodStars(seed: number, count: number): Float32Array {
  const { local } = placeOf(seed)
  const rand = prng(placeNumber(seed) + 4099)
  const stars = new Float32Array(count * STAR_STRIDE)
  for (let i = 0; i < count; i++) {
    const offset = i * STAR_STRIDE
    stars[offset] = local[0] + gauss(rand) * 0.09
    stars[offset + 1] = local[1] + gauss(rand) * 0.09
    stars[offset + 2] = local[2] + gauss(rand) * 0.035
    stars[offset + 3] = Math.pow(rand(), 4) * 0.7
    stars[offset + 4] = rand() * 0.8
  }
  return stars
}

/** Floats per star in galaxyStars: x, y, z (galaxy frame, in disk radii), brightness 0..1, warmth 0..1. */
export const STAR_STRIDE = 5

/**
 * The stars of one galaxy: a central bulge, spiral arms and a thin disk in between. Deterministic
 * per galaxy, so a galaxy looks the same every time you visit it.
 */
export function galaxyStars(galaxy: Galaxy, count: number): Float32Array {
  const rand = prng(0x5eed + galaxy.id * 7919)
  const stars = new Float32Array(count * STAR_STRIDE)
  for (let i = 0; i < count; i++) {
    const kind = rand()
    let x: number
    let y: number
    let z: number
    let warmth: number
    if (kind < 0.16) {
      // bulge: a slightly flattened ball of old, warm stars
      const direction = randomUnit(rand)
      const r = 0.16 * Math.pow(rand(), 1.6)
      x = direction[0] * r
      y = direction[1] * r
      z = direction[2] * r * 0.7
      warmth = 0.7 + rand() * 0.3
    } else {
      // exponential disk; most of it sits on the arms
      const r = Math.min(1.25, -0.34 * Math.log(1 - rand() * 0.97))
      const onArm = kind < 0.84
      const angle = onArm ? armAngle(galaxy, r, Math.floor(rand() * galaxy.arms)) + gauss(rand) * (0.16 + 0.1 * r) : rand() * 2 * Math.PI
      x = r * Math.cos(angle)
      y = r * Math.sin(angle)
      z = gauss(rand) * (0.028 + 0.018 * r)
      warmth = onArm ? rand() * 0.45 : 0.35 + rand() * 0.5
    }
    const offset = i * STAR_STRIDE
    stars[offset] = x
    stars[offset + 1] = y
    stars[offset + 2] = z
    // a few bright stars, many faint ones
    stars[offset + 3] = Math.pow(rand(), 3)
    stars[offset + 4] = warmth
  }
  return stars
}
