/**
 * Inhibitor respawn timers for the Howling Abyss (ARAM / ARAM: Mayhem), straight from the Live
 * Client Data API event feed – no screen capture involved.
 *
 * Health relics are not tracked: the game itself shows their countdowns on the minimap.
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
  if (/_T1_/i.test(name)) return 'ORDER'
  if (/_T2_/i.test(name)) return 'CHAOS'
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
