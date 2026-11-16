import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LearnedTimers } from './watcher'
import type { RelicPad } from './timers'

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2))
  } catch {
    // best effort: a timer that isn't remembered is learned again next game
  }
}

/** Inhibitor respawn times seen in earlier games (userData/learned-timers.json). */
export class LearnedTimersFile implements LearnedTimers {
  private data: { inhibitorRespawn?: Partial<Record<'aram' | 'mayhem', number>> }

  constructor(private readonly file: string) {
    this.data = readJson(file, {})
  }

  inhibitorRespawn(mode: 'aram' | 'mayhem'): number | undefined {
    const value = this.data.inhibitorRespawn?.[mode]
    return typeof value === 'number' && value > 60 && value < 600 ? value : undefined
  }

  setInhibitorRespawn(mode: 'aram' | 'mayhem', seconds: number): void {
    const rounded = Math.round(seconds)
    if (this.data.inhibitorRespawn?.[mode] === rounded) return
    this.data = { ...this.data, inhibitorRespawn: { ...this.data.inhibitorRespawn, [mode]: rounded } }
    writeJson(this.file, this.data)
  }
}

/** The valid pads of a list (anything else is dropped), for the file and the admin tool. */
export function validPads(pads: unknown): RelicPad[] {
  if (!Array.isArray(pads)) return []
  return pads
    .filter(
      (pad): pad is RelicPad =>
        !!pad &&
        typeof pad.id === 'string' &&
        (pad.team === 'ORDER' || pad.team === 'CHAOS') &&
        (pad.kind === 'outer' || pad.kind === 'inner' || pad.kind === 'base') &&
        !!pad.pos &&
        pad.pos.x >= 0 &&
        pad.pos.x <= 1 &&
        pad.pos.y >= 0 &&
        pad.pos.y <= 1
    )
    .map((pad) => ({ id: pad.id, team: pad.team, kind: pad.kind, pos: { x: pad.pos.x, y: pad.pos.y } }))
}

/** Relic pads measured with the admin tool, by map number (userData/minimap-pads.json). */
export function readMeasuredPads(file: string): Record<string, RelicPad[]> {
  const raw = readJson<Record<string, unknown>>(file, {})
  const valid: Record<string, RelicPad[]> = {}
  for (const [map, pads] of Object.entries(raw)) {
    const clean = validPads(pads)
    if (clean.length) valid[map] = clean
  }
  return valid
}

export function writeMeasuredPads(file: string, pads: Record<string, RelicPad[]>): void {
  writeJson(file, pads)
}
