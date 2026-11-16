/**
 * The universe ratioAI lives in: a fixed catalogue of galaxies with real 3D positions.
 *
 * The catalogue is built once from a constant seed, so it is the same map on every machine and in
 * every version. Each game is played at one place in it (a star in one galaxy). The flight between
 * two games and the star map both render this catalogue with a perspective camera, so what you fly
 * past is what the map shows.
 */

export type Vec3 = [number, number, number]

/**
 * Kinds of galaxies in the catalogue. The index of each type is its code in the shaders
 * (spaceGlsl.ts), so only ever append to this list.
 */
export const GALAXY_TYPES = ['spiral', 'barred', 'elliptical', 'lenticular', 'irregular', 'dwarf', 'ring', 'merger'] as const
export type GalaxyType = (typeof GALAXY_TYPES)[number]
export const typeCode = (type: GalaxyType): number => GALAXY_TYPES.indexOf(type)

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
  type: GalaxyType
  /** number of spiral arms (2 to 4; barred spirals have 2) */
  arms: number
  /** how tightly the arms are wound */
  twist: number
  /** position on the nebula palette, 0 to 1 */
  hue: number
  /** noise seed for dust and clumps */
  seed: number
  /**
   * Two shape parameters, 0 to 1, whose meaning depends on the type:
   *   elliptical  flattening (E0 to E7), core brightness
   *   barred      bar length, strength of the inner ring
   *   lenticular  bulge size, dust ring
   *   irregular   clumpiness, elongation
   *   dwarf       spheroidal below 0.5 and irregular above, size
   *   ring        ring radius, offset of the nucleus (above 0.6 a Cartwheel with spokes)
   *   merger      size of the companion, where it sits
   */
  shape: number
  shape2: number
  /** how fast the galaxy turns on the star map, in radians per second (sign = direction) */
  spin: number
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

/**
 * Type and shape of a galaxy. Drawn from its own random stream, not the catalogue's: adding types
 * must not move a single galaxy or rename it.
 */
function classify(id: number, radius: number): Pick<Galaxy, 'type' | 'shape' | 'shape2' | 'spin'> {
  const rand = prng(0x9a1a7e5 ^ Math.imul(id + 1, 0x9e3779b1))
  const roll = rand()
  const pick = rand()
  let type: GalaxyType
  if (radius < 1.3 && roll < 0.3) type = 'dwarf'
  else if (pick < 0.33) type = 'spiral'
  else if (pick < 0.55) type = 'barred'
  else if (pick < 0.71) type = 'elliptical'
  else if (pick < 0.8) type = 'lenticular'
  else if (pick < 0.89) type = 'irregular'
  else if (pick < 0.925) type = 'ring'
  // two galaxies colliding need some room
  else type = radius > 1.4 ? 'merger' : 'spiral'
  const shape = rand()
  const shape2 = rand()
  const spin = (rand() < 0.5 ? -1 : 1) * (0.035 + rand() * 0.04)
  return { type, shape, shape2, spin }
}

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
    const arms = 2 + Math.floor(rand() * 3)
    const twist = 2.4 + rand() * 2.8
    const hue = rand()
    const seed = rand() * 900
    const kind = classify(id, radius)
    galaxies.push({
      id,
      name,
      designation: `RA-${String(id + 1).padStart(4, '0')}`,
      pos,
      radius,
      axisU,
      axisV,
      normal,
      ...kind,
      arms: kind.type === 'barred' ? 2 : arms,
      twist,
      hue,
      seed
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

/*
 * Layout of the other types. The same formulas are written out in GLSL (galaxyDisk in spaceGlsl.ts)
 * so the painted galaxy and its single stars agree. They use plain arithmetic only (no hash
 * functions), which gives the same numbers in JavaScript and in the shaders' 32-bit floats.
 */
const fract = (x: number): number => x - Math.floor(x)

/** Half length of the bar of a barred spiral, in disk radii. */
export const barLength = (galaxy: Galaxy): number => 0.22 + 0.16 * galaxy.shape
/** The arms of a barred spiral leave the two ends of the bar and wind outwards from there. */
const barredArmAngle = (galaxy: Galaxy, r: number, arm: number): number =>
  galaxy.twist * 0.55 * Math.log(Math.max(r, 1e-3) / barLength(galaxy)) + arm * Math.PI

/** Radius of a ring galaxy's ring, and how far its centre sits from the nucleus (lopsided, Cartwheel-like rings). */
export const ringRadius = (galaxy: Galaxy): number => 0.5 + 0.28 * galaxy.shape
export const ringOffset = (galaxy: Galaxy): number => (galaxy.shape2 > 0.6 ? (galaxy.shape2 - 0.6) * 0.4 : 0)

/** Axis ratio of an elliptical (1 = round E0, 0.3 = E7). */
export const ellipticalRatio = (galaxy: Galaxy): number => 1 - Math.round(galaxy.shape * 7) / 10

/** Size of a dwarf galaxy relative to its catalogue radius; 1 for every other type. */
export const extentOf = (galaxy: Galaxy): number => (galaxy.type === 'dwarf' ? 0.5 + 0.25 * galaxy.shape2 : 1)

export interface Clump {
  x: number
  y: number
  size: number
  bright: number
}

/** The star-forming knots of an irregular galaxy (seven of them, golden-angle spaced). */
export function irregularClumps(galaxy: Galaxy): Clump[] {
  const stretch = 1 + 0.45 * galaxy.shape2
  return Array.from({ length: 7 }, (_, i) => {
    const angle = galaxy.seed * 0.37 + i * 2.39996
    const r = 0.1 + 0.5 * fract(galaxy.seed * 0.0731 + i * 0.618034)
    return {
      x: r * Math.cos(angle) * stretch,
      y: (r * Math.sin(angle)) / stretch,
      size: 0.07 + 0.11 * fract(galaxy.seed * 0.0533 + i * 0.381966),
      bright: 0.45 + 0.55 * fract(galaxy.seed * 0.0917 + i * 0.7548777)
    }
  })
}

/** Two galaxies in collision: where each one sits, how big it is, and their tidal tails. */
export function mergerLayout(galaxy: Galaxy) {
  const angle = galaxy.shape2 * 2 * Math.PI
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const m2 = 0.3 + 0.18 * galaxy.shape
  return {
    angle,
    main: { x: -0.24 * c, y: -0.24 * s, size: 0.58 },
    companion: { x: 0.46 * c, y: 0.46 * s, size: m2 },
    /** each tail leaves its galaxy pointing away from the other one and curls by 1.7 rad */
    tails: [
      { x: -0.24 * c, y: -0.24 * s, start: 0.29, length: 0.8, angle: angle + Math.PI },
      { x: 0.46 * c, y: 0.46 * s, start: m2 * 0.5, length: 0.65, angle }
    ]
  }
}
const TAIL_CURL = 1.7

/** One or two words per type, for lists. */
export const TYPE_NAMES: Record<GalaxyType, string> = {
  spiral: 'Spiral',
  barred: 'Barred spiral',
  elliptical: 'Elliptical',
  lenticular: 'Lenticular',
  irregular: 'Irregular',
  dwarf: 'Dwarf',
  ring: 'Ring',
  merger: 'Colliding pair'
}

/** Short description for the UI, e.g. "Barred spiral · 2 arms". */
export function galaxyKind(galaxy: Galaxy): string {
  switch (galaxy.type) {
    case 'spiral':
      return `Spiral galaxy · ${galaxy.arms} arms`
    case 'barred':
      return 'Barred spiral · 2 arms'
    case 'elliptical':
      return `Elliptical galaxy · E${Math.round(galaxy.shape * 7)}`
    case 'lenticular':
      return 'Lenticular galaxy · S0'
    case 'irregular':
      return 'Irregular galaxy'
    case 'dwarf':
      return galaxy.shape < 0.5 ? 'Dwarf spheroidal galaxy' : 'Dwarf irregular galaxy'
    case 'ring':
      return ringOffset(galaxy) > 0 ? 'Ring galaxy · Cartwheel type' : 'Ring galaxy'
    case 'merger':
      return 'Colliding galaxies'
  }
}

/**
 * Where in its galaxy a place lies: a star on one of the spiral arms, in a clump, on the ring...
 * `local` is in the galaxy's frame (disk radii), `pos` the same point in the world.
 */
export function placeOf(seed: number): { galaxy: Galaxy; local: Vec3; pos: Vec3 } {
  const galaxy = galaxyOf(seed)
  const rand = prng(placeNumber(seed) + 17)
  const local = placeLocal(galaxy, rand)
  return { galaxy, local, pos: toWorld(galaxy, local) }
}

function placeLocal(galaxy: Galaxy, rand: () => number): Vec3 {
  const thin = (): number => (rand() - 0.5) * 0.02
  const inDisk = (r: number, angle: number): Vec3 => [r * Math.cos(angle), r * Math.sin(angle), thin()]
  switch (galaxy.type) {
    case 'spiral': {
      // unchanged since 1.0: places in spiral galaxies stay where they were
      const r = 0.3 + rand() * 0.5
      const angle = armAngle(galaxy, r, Math.floor(rand() * galaxy.arms)) + (rand() - 0.5) * 0.25
      return [r * Math.cos(angle), r * Math.sin(angle), (rand() - 0.5) * 0.02]
    }
    case 'barred': {
      const r = barLength(galaxy) + 0.08 + rand() * 0.4
      return inDisk(r, barredArmAngle(galaxy, r, Math.floor(rand() * 2)) + (rand() - 0.5) * 0.25)
    }
    case 'elliptical': {
      const direction = randomUnit(rand)
      const r = 0.25 + rand() * 0.4
      return [direction[0] * r, direction[1] * r, direction[2] * r * ellipticalRatio(galaxy)]
    }
    case 'lenticular':
      return inDisk(0.3 + rand() * 0.5, rand() * 2 * Math.PI)
    case 'ring': {
      const angle = rand() * 2 * Math.PI
      const r = ringRadius(galaxy)
      return [ringOffset(galaxy) + r * Math.cos(angle), r * Math.sin(angle), thin()]
    }
    case 'merger': {
      const layout = mergerLayout(galaxy)
      const body = rand() < 0.6 ? layout.main : layout.companion
      const r = body.size * (0.3 + rand() * 0.4)
      const angle = rand() * 2 * Math.PI
      return [body.x + r * Math.cos(angle), body.y + r * Math.sin(angle), thin()]
    }
    case 'irregular':
    case 'dwarf': {
      const extent = extentOf(galaxy)
      if (galaxy.type === 'dwarf' && galaxy.shape < 0.5) {
        const direction = randomUnit(rand)
        const r = extent * (0.2 + rand() * 0.3)
        return [direction[0] * r, direction[1] * r, direction[2] * r * 0.7]
      }
      const clumps = irregularClumps(galaxy)
      const clump = clumps[Math.floor(rand() * clumps.length)]
      return [
        extent * (clump.x + (rand() - 0.5) * clump.size * 0.8),
        extent * (clump.y + (rand() - 0.5) * clump.size * 0.8),
        (rand() - 0.5) * 0.04 * extent
      ]
    }
  }
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

type Star = [x: number, y: number, z: number, warmth: number]

/** Radius of an exponential disk, capped. */
const diskRadius = (rand: () => number, scaleLength: number, cap = 1.25): number =>
  Math.min(cap, -scaleLength * Math.log(1 - rand() * 0.97))

/** A ball of stars: radius `r`, flattened to `flat` along the normal. */
const ball = (rand: () => number, r: number, flat: number): [number, number, number] => {
  const direction = randomUnit(rand)
  return [direction[0] * r, direction[1] * r, direction[2] * r * flat]
}

/** One star of a galaxy of the given type, in the galaxy frame. `kind` is a uniform 0..1 roll. */
function starOf(galaxy: Galaxy, rand: () => number, kind: number): Star {
  switch (galaxy.type) {
    case 'barred': {
      const bar = barLength(galaxy)
      if (kind < 0.13) return [...ball(rand, 0.15 * Math.pow(rand(), 1.6), 0.7), 0.7 + rand() * 0.3]
      if (kind < 0.33)
        return [Math.max(-1, Math.min(1, gauss(rand) * 0.55)) * bar, gauss(rand) * bar * 0.14, gauss(rand) * 0.03, 0.55 + rand() * 0.35]
      if (kind < 0.4 && galaxy.shape2 > 0.5) {
        // inner ring around the bar
        const angle = rand() * 2 * Math.PI
        const r = bar * (1.05 + gauss(rand) * 0.06)
        return [r * Math.cos(angle), r * Math.sin(angle), gauss(rand) * 0.025, rand() * 0.5]
      }
      const r = Math.min(1.25, bar * 0.9 + diskRadius(rand, 0.3))
      const onArm = kind < 0.86
      const angle = onArm ? barredArmAngle(galaxy, r, Math.floor(rand() * 2)) + gauss(rand) * (0.14 + 0.1 * r) : rand() * 2 * Math.PI
      return [r * Math.cos(angle), r * Math.sin(angle), gauss(rand) * (0.028 + 0.018 * r), onArm ? rand() * 0.45 : 0.35 + rand() * 0.5]
    }
    case 'elliptical': {
      // most stars close to the centre, a long faint halo; old and warm
      const r = Math.min(1.3, 0.16 * Math.pow(-Math.log(1 - rand() * 0.995), 1.6))
      return [...ball(rand, r, ellipticalRatio(galaxy)), 0.62 + rand() * 0.38]
    }
    case 'lenticular': {
      if (kind < 0.28 + 0.2 * galaxy.shape)
        return [...ball(rand, (0.13 + 0.1 * galaxy.shape) * Math.pow(rand(), 1.4), 0.75), 0.7 + rand() * 0.3]
      const r = diskRadius(rand, 0.3, 1.2)
      const angle = rand() * 2 * Math.PI
      return [r * Math.cos(angle), r * Math.sin(angle), gauss(rand) * (0.02 + 0.012 * r), 0.5 + rand() * 0.4]
    }
    case 'ring': {
      const ring = ringRadius(galaxy)
      const offset = ringOffset(galaxy)
      if (kind < 0.18) return [...ball(rand, 0.1 * Math.pow(rand(), 1.5), 0.75), 0.75 + rand() * 0.25]
      if (kind < 0.78) {
        const angle = rand() * 2 * Math.PI
        const r = ring + gauss(rand) * (0.035 + offset * 0.25 * (1 + Math.cos(angle)))
        return [offset + r * Math.cos(angle), r * Math.sin(angle), gauss(rand) * 0.03, rand() * 0.4]
      }
      if (kind < 0.84 && offset > 0) {
        // spokes from the nucleus out to the ring
        const angle = Math.floor(rand() * 10) * 0.6283 + galaxy.seed
        const t = 0.15 + 0.85 * rand()
        const x = t * (offset + ring * Math.cos(angle))
        const y = t * ring * Math.sin(angle)
        return [x + gauss(rand) * 0.03, y + gauss(rand) * 0.03, gauss(rand) * 0.02, 0.3 + rand() * 0.4]
      }
      const r = rand() * ring
      const angle = rand() * 2 * Math.PI
      return [r * Math.cos(angle), r * Math.sin(angle), gauss(rand) * 0.03, 0.4 + rand() * 0.5]
    }
    case 'merger': {
      const layout = mergerLayout(galaxy)
      if (kind < 0.72) {
        const body = kind < 0.45 ? layout.main : layout.companion
        const turn = kind < 0.45 ? 0 : layout.angle + 1.2
        const r = body.size * Math.min(1.2, -0.34 * Math.log(1 - rand() * 0.97))
        const onArm = rand() < 0.7
        const angle = onArm
          ? galaxy.twist * 0.8 * Math.log(r / body.size + 0.06) + Math.floor(rand() * 2) * Math.PI + turn + gauss(rand) * (0.2 + 0.15 * r)
          : rand() * 2 * Math.PI
        return [
          body.x + r * Math.cos(angle),
          body.y + r * Math.sin(angle),
          gauss(rand) * 0.035,
          r < body.size * 0.2 ? 0.7 + rand() * 0.3 : rand() * 0.6
        ]
      }
      if (kind < 0.94) {
        const tail = layout.tails[rand() < 0.55 ? 0 : 1]
        const t = rand()
        const angle = tail.angle + TAIL_CURL * t
        const r = tail.start + tail.length * t
        const width = 0.03 + 0.07 * t
        return [
          tail.x + r * Math.cos(angle) + gauss(rand) * width,
          tail.y + r * Math.sin(angle) + gauss(rand) * width,
          gauss(rand) * 0.05,
          rand() * 0.5
        ]
      }
      // the bridge of stars pulled out between the two
      const t = rand()
      return [
        layout.main.x + (layout.companion.x - layout.main.x) * t + gauss(rand) * 0.05,
        layout.main.y + (layout.companion.y - layout.main.y) * t + gauss(rand) * 0.05,
        gauss(rand) * 0.04,
        rand() * 0.5
      ]
    }
    case 'irregular':
    case 'dwarf': {
      const extent = extentOf(galaxy)
      if (galaxy.type === 'dwarf' && galaxy.shape < 0.5) {
        const r = extent * Math.min(1.3, 0.3 * Math.pow(-Math.log(1 - rand() * 0.99), 1.3))
        return [...ball(rand, r, 0.75), 0.55 + rand() * 0.4]
      }
      const stretch = 1 + 0.45 * galaxy.shape2
      if (kind < 0.42) {
        const clumps = irregularClumps(galaxy)
        const clump = clumps[Math.floor(rand() * clumps.length)]
        return [
          extent * (clump.x + gauss(rand) * clump.size * 0.6 * (0.6 + rand() * 0.8)),
          extent * (clump.y + gauss(rand) * clump.size * 0.6 * (0.6 + rand() * 0.8)),
          gauss(rand) * 0.05 * extent,
          rand() * 0.35
        ]
      }
      return [
        extent * gauss(rand) * 0.34 * stretch,
        (extent * gauss(rand) * 0.34) / stretch,
        gauss(rand) * 0.07 * extent,
        0.3 + rand() * 0.5
      ]
    }
    case 'spiral':
      throw new Error('spirals are generated by galaxyStars itself')
  }
}

/**
 * The stars of one galaxy, laid out by its type: bulge, arms and disk of a spiral, the ball of an
 * elliptical, knots of an irregular and so on. Deterministic per galaxy, so a galaxy looks the
 * same every time you visit it.
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
    if (galaxy.type !== 'spiral') {
      ;[x, y, z, warmth] = starOf(galaxy, rand, kind)
      // keep everything inside the painted quad
      const r = Math.hypot(x, y)
      if (r > 1.45) {
        x *= 1.45 / r
        y *= 1.45 / r
      }
    } else if (kind < 0.16) {
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
