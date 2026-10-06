/**
 * Minimap timers for the Howling Abyss (ARAM / ARAM: Mayhem).
 *
 * Inhibitor timers come straight from the Live Client Data API event feed, no screen capture needed.
 *
 * For health relics the game only shows the countdown to the first spawn. After that, a relic that's
 * up is drawn as a small green cross on the minimap. We check the four pads once per second and start
 * a 92.5 s timer (2.5 s until the heal beam, then 90 s) when a cross disappears.
 */
import type { MinimapState } from '@shared/types'

/** 4:10, not 5:00 like on Summoner's Rift. Measured twice in ARAM: Mayhem (killed at 930 s, back at 1180 s). */
export const INHIBITOR_RESPAWN = 250

/** Inhibitor events as parsed from the Live Client Data API. */
export interface InhibitorEvent {
  type: 'killed' | 'respawned'
  inhibitor: string
  time: number
}

/** "Barracks_T1_L1" is ORDER (T1 = blue side structures), "Barracks_T2_..." is CHAOS. */
export function inhibitorTeam(name: string): 'ORDER' | 'CHAOS' | null {
  if (/_T1_|_T100|order/i.test(name)) return 'ORDER'
  if (/_T2_|_T200|chaos/i.test(name)) return 'CHAOS'
  return null
}

/** Inhibitors that are currently down, with the game time they come back. */
export function inhibitorTimers(events: InhibitorEvent[], gameTime: number): MinimapState['inhibitors'] {
  // only the latest event per inhibitor matters
  const latest = new Map<string, InhibitorEvent>()
  for (const event of [...events].sort((a, b) => a.time - b.time)) latest.set(event.inhibitor, event)
  const timers: MinimapState['inhibitors'] = []
  for (const event of latest.values()) {
    const team = inhibitorTeam(event.inhibitor)
    if (!team || event.type !== 'killed') continue
    const respawnAt = event.time + INHIBITOR_RESPAWN
    if (respawnAt > gameTime) timers.push({ team, respawnAt, pos: INHIBITOR_POS[team] })
  }
  return timers
}

/** Inhibitor icons on the Howling Abyss minimap (fractions of the minimap, measured at 1080p). */
export const INHIBITOR_POS = { ORDER: { x: 0.24, y: 0.748 }, CHAOS: { x: 0.754, y: 0.254 } } as const

/**
 * Minimap position as fractions of the screen, measured on a 1080p screenshot (bottom right, 285 px).
 * `scale` is the minimap size relative to that (Settings > Minimap size).
 */
export function minimapRect(width: number, height: number, scale = 1): { x: number; y: number; w: number; h: number } {
  const side = 0.2639 * height * scale
  const right = 0.0123 * height
  const bottom = 0.0139 * height
  return { x: (width - right - side) / width, y: (height - bottom - side) / height, w: side / width, h: side / height }
}

// ---------------------------------------------------------------------------
// Health relics
// ---------------------------------------------------------------------------

/** Game time in seconds (League wiki): outer 1:45, inner 2:30. Back 90 s after the beam, which comes 2.5 s after pickup. */
export const RELIC_TIMES = { outer: 105, inner: 150, respawn: 92.5 }

/**
 * Relic pads from the blue base (ORDER, bottom left) to the red one, as fractions of the minimap.
 * Measured where the game draws the first-spawn countdown and the green cross.
 */
export const RELICS = [
  { id: 'order-inner', team: 'ORDER', kind: 'inner', pos: { x: 0.37, y: 0.692 } },
  { id: 'order-outer', team: 'ORDER', kind: 'outer', pos: { x: 0.462, y: 0.594 } },
  { id: 'chaos-outer', team: 'CHAOS', kind: 'outer', pos: { x: 0.589, y: 0.472 } },
  { id: 'chaos-inner', team: 'CHAOS', kind: 'inner', pos: { x: 0.686, y: 0.386 } }
] as const

/** Pad sample size as a fraction of the minimap side. */
export const RELIC_PATCH = 0.065

export type RelicSeen = 'present' | 'absent' | 'unclear'

/**
 * Classifies a small RGBA patch around a relic pad. The relic is a pale green cross, while champion
 * icons (your own green ring, for example) are saturated green and make the sample unclear.
 */
export function relicSeen(patch: { width: number; height: number; data: Uint8Array }): RelicSeen {
  let pale = 0
  let strong = 0
  for (let i = 0; i < patch.data.length; i += 4) {
    const r = patch.data[i]
    const g = patch.data[i + 1]
    const b = patch.data[i + 2]
    const greenness = g - Math.max(r, b)
    if (g < 85) continue
    if (greenness >= 48) strong++
    else if (greenness >= 12) pale++
  }
  const scale = (patch.width * patch.height) / 289 // thresholds were tuned on a 17x17 patch (1080p)
  if (strong > 8 * scale) return 'unclear'
  if (pale >= 5 * scale) return 'present'
  if (pale <= 1 * scale && strong <= 2 * scale) return 'absent'
  return 'unclear'
}

interface RelicTrack {
  phase: 'spawn' | 'up'
  at: number | null
  /** the cross has been seen since the last spawn, only then can we trust a pickup */
  verified: boolean
  absentSince: number | null
  absentCount: number
  presentCount: number
  takenAt: number | null
}

/**
 * Per-pad state machine with hysteresis. It also learns the actual respawn time during the game,
 * since modes and maps can differ from the 90 s of classic ARAM.
 */
export class RelicTracker {
  // When a taken cross comes back for good we record how long it took. Once we have two of those
  // samples the timers switch to the learned value.
  private tracks: RelicTrack[] = []
  private lastGameTime = 0
  private respawnSamples: number[] = []

  constructor(private readonly log: (message: string) => void = () => undefined) {
    this.reset()
  }

  reset(): void {
    this.lastGameTime = 0
    this.respawnSamples = []
    this.tracks = RELICS.map((relic) => ({
      phase: 'spawn',
      at: RELIC_TIMES[relic.kind],
      verified: false,
      absentSince: null,
      absentCount: 0,
      presentCount: 0,
      takenAt: null
    }))
  }

  /** Respawn time in use: the median of learned samples once there are two, otherwise 92.5 s. */
  get respawnTime(): number {
    const sorted = [...this.respawnSamples].sort((a, b) => a - b)
    if (sorted.length < 2) return RELIC_TIMES.respawn
    return sorted[sorted.length >> 1]
  }

  tick(gameTime: number): void {
    // clock jumped back, so this is a new game
    if (gameTime + 5 < this.lastGameTime) this.reset()
    this.lastGameTime = gameTime
    for (const track of this.tracks) {
      if (track.phase === 'spawn' && track.at !== null && gameTime >= track.at) {
        track.phase = 'up'
        track.at = null
        track.verified = false
        track.absentCount = 0
        track.absentSince = null
        track.presentCount = 0
      }
    }
  }

  /** One classification per pad (null = no picture). Returns the ids of relics that were just taken. */
  observe(gameTime: number, seen: (RelicSeen | null)[]): string[] {
    this.tick(gameTime)
    const taken: string[] = []
    seen.forEach((result, i) => {
      const track = this.tracks[i]
      if (!track || !result || result === 'unclear') return
      if (track.phase === 'up') {
        if (result === 'present') {
          track.verified = true
          track.absentCount = 0
          track.absentSince = null
        } else if (track.verified) {
          track.absentSince ??= gameTime
          // 4 s without the cross means taken. A champion walking over it is shorter or reads as "unclear".
          if (++track.absentCount >= 4) {
            track.phase = 'spawn'
            track.takenAt = track.absentSince
            track.at = track.absentSince + this.respawnTime
            track.presentCount = 0
            taken.push(RELICS[i].id)
          }
        }
      } else if (track.phase === 'spawn' && track.at !== null && gameTime > RELIC_TIMES[RELICS[i].kind]) {
        track.presentCount = result === 'present' ? track.presentCount + 1 : 0
        if (track.presentCount >= 3) {
          const since = track.takenAt !== null ? gameTime - 2 - track.takenAt : 0
          if (since >= 20 && since <= 120) {
            // the relic is really back earlier or later than we assumed, so learn the actual respawn time
            this.respawnSamples.push(since)
            this.log(`relic ${RELICS[i].id} back after ${Math.round(since)} s (respawn now ${Math.round(this.respawnTime)} s)`)
          } else this.log(`relic ${RELICS[i].id} still there after ${Math.round(since)} s – not taken`)
          track.phase = 'up'
          track.at = null
          track.verified = true
          track.absentCount = 0
          track.absentSince = null
          track.presentCount = 0
        }
      }
    })
    return taken
  }

  snapshot(): MinimapState['relics'] {
    return RELICS.map((relic, i) => {
      const track = this.tracks[i]
      return {
        id: relic.id,
        team: relic.team,
        kind: relic.kind,
        pos: relic.pos,
        state: track.phase === 'spawn' ? 'spawn' : track.verified ? 'up' : 'unknown',
        at: track.phase === 'spawn' ? track.at : null
      }
    })
  }
}
