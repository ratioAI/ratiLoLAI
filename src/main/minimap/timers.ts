/**
 * Inhibitor respawn timers for the Howling Abyss (ARAM / ARAM: Mayhem), straight from the Live
 * Client Data API event feed – no screen capture involved.
 *
 * Health relics: the game only shows the countdown to the *first* spawn. Afterwards a relic that is
 * up is drawn as a small green cross on the minimap – ratioAI watches the four pads once per second
 * and starts a 92.5 s timer (2.5 s until the heal beam + 90 s) when a cross disappears.
 */
import type { MinimapState } from '@shared/types'

export const INHIBITOR_RESPAWN = 300

/** Inhibitor events as parsed from the Live Client Data API. */
export interface InhibitorEvent {
  type: 'killed' | 'respawned'
  inhibitor: string
  time: number
}

/** "Barracks_T1_L1" → ORDER (T1 = blue side structures), "Barracks_T2_…" → CHAOS. */
export function inhibitorTeam(name: string): 'ORDER' | 'CHAOS' | null {
  if (/_T1_|_T100|order/i.test(name)) return 'ORDER'
  if (/_T2_|_T200|chaos/i.test(name)) return 'CHAOS'
  return null
}

/** Inhibitors that are currently down, with the game time they come back. */
export function inhibitorTimers(events: InhibitorEvent[], gameTime: number): MinimapState['inhibitors'] {
  const last = new Map<string, InhibitorEvent>()
  for (const e of [...events].sort((a, b) => a.time - b.time)) last.set(e.inhibitor, e)
  const out: MinimapState['inhibitors'] = []
  for (const e of last.values()) {
    const team = inhibitorTeam(e.inhibitor)
    if (!team || e.type !== 'killed') continue
    const respawnAt = e.time + INHIBITOR_RESPAWN
    if (respawnAt > gameTime) out.push({ team, respawnAt, pos: INHIBITOR_POS[team] })
  }
  return out
}

/** Inhibitor icons on the Howling Abyss minimap (fractions of the minimap, measured at 1080p). */
export const INHIBITOR_POS = { ORDER: { x: 0.24, y: 0.748 }, CHAOS: { x: 0.754, y: 0.254 } } as const

/**
 * Minimap position as fractions of the screen. Measured on a 1080p screenshot (bottom right,
 * 285 px); `scale` is the minimap size relative to that (Settings → Minimap size).
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

/** Game-time seconds (League wiki): outer 1:45, inner 2:30; back 90 s after the beam (2.5 s after pickup). */
export const RELIC_TIMES = { outer: 105, inner: 150, respawn: 92.5 }

/**
 * Relic pads ordered from the blue (ORDER, bottom left) to the red base, as fractions of the
 * minimap – measured where the game draws their first-spawn countdown and their green cross.
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
 * Classifies a small RGBA patch around a relic pad: the relic is a pale green cross; champion
 * icons (e.g. your own green ring) are saturated green and make the sample unclear.
 */
export function relicSeen(p: { width: number; height: number; data: Uint8Array }): RelicSeen {
  let pale = 0
  let strong = 0
  for (let i = 0; i < p.data.length; i += 4) {
    const r = p.data[i]
    const g = p.data[i + 1]
    const b = p.data[i + 2]
    const d = g - Math.max(r, b)
    if (g < 85) continue
    if (d >= 48) strong++
    else if (d >= 12) pale++
  }
  const scale = (p.width * p.height) / 289 // thresholds tuned on a 17×17 patch (1080p)
  if (strong > 8 * scale) return 'unclear'
  if (pale >= 5 * scale) return 'present'
  if (pale <= 1 * scale && strong <= 2 * scale) return 'absent'
  return 'unclear'
}

interface RelicTrack {
  phase: 'spawn' | 'up'
  at: number | null
  /** the cross has been seen since the last spawn – only then can a pickup be trusted */
  verified: boolean
  absentSince: number | null
  absentCount: number
  presentCount: number
}

export class RelicTracker {
  private tracks: RelicTrack[] = []
  private last = 0

  constructor() {
    this.reset()
  }

  reset(): void {
    this.last = 0
    this.tracks = RELICS.map((r) => ({
      phase: 'spawn',
      at: RELIC_TIMES[r.kind],
      verified: false,
      absentSince: null,
      absentCount: 0,
      presentCount: 0
    }))
  }

  tick(gameTime: number): void {
    if (gameTime + 5 < this.last) this.reset()
    this.last = gameTime
    for (const t of this.tracks) {
      if (t.phase === 'spawn' && t.at !== null && gameTime >= t.at) {
        t.phase = 'up'
        t.at = null
        t.verified = false
        t.absentCount = 0
        t.absentSince = null
      }
    }
  }

  /** One classification per pad (null = no picture). Returns the ids of relics seen taken. */
  observe(gameTime: number, seen: (RelicSeen | null)[]): string[] {
    this.tick(gameTime)
    const taken: string[] = []
    seen.forEach((s, i) => {
      const t = this.tracks[i]
      if (!t || !s || s === 'unclear') return
      if (t.phase === 'up') {
        if (s === 'present') {
          t.verified = true
          t.absentCount = 0
          t.absentSince = null
        } else if (t.verified) {
          t.absentSince ??= gameTime
          // 3 s without the cross: taken (a champion walking over it is shorter or "unclear")
          if (++t.absentCount >= 3) {
            t.phase = 'spawn'
            t.at = t.absentSince + RELIC_TIMES.respawn
            t.presentCount = 0
            taken.push(RELICS[i].id)
          }
        }
      } else if (t.phase === 'spawn' && t.at !== null && gameTime > RELIC_TIMES[RELICS[i].kind]) {
        // the cross is clearly back long before the timer ends → that was no pickup
        t.presentCount = s === 'present' ? t.presentCount + 1 : 0
        if (t.presentCount >= 2 && t.at - gameTime > 5) {
          t.phase = 'up'
          t.at = null
          t.verified = true
          t.absentCount = 0
          t.absentSince = null
        }
      }
    })
    return taken
  }

  snapshot(): MinimapState['relics'] {
    return RELICS.map((r, i) => {
      const t = this.tracks[i]
      return {
        id: r.id,
        team: r.team,
        kind: r.kind,
        pos: r.pos,
        state: t.phase === 'spawn' ? 'spawn' : t.verified ? 'up' : 'unknown',
        at: t.phase === 'spawn' ? t.at : null
      }
    })
  }
}
