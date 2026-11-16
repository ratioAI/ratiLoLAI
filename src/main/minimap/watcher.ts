import { screen } from 'electron'
import type { LiveGameState, MinimapState, Settings } from '@shared/types'
import type { CaptureService } from '../capture/captureService'
import {
  INHIBITOR_RESPAWN,
  inhibitorTimers,
  minimapRect,
  observedInhibitorRespawns,
  RELIC_PATCH,
  relicPadsFor,
  RelicTracker,
  relicSeen,
  type RelicPad,
  type RelicSeen
} from './timers'

/** Respawn times learned in earlier games, kept per mode (classic ARAM and Mayhem may differ). */
export interface LearnedTimers {
  inhibitorRespawn(mode: 'aram' | 'mayhem'): number | undefined
  setInhibitorRespawn(mode: 'aram' | 'mayhem', seconds: number): void
}

/** What the four (or more) relic pads look like right now, for the admin tool. */
export interface RelicProbe {
  map: number | null
  pads: (RelicPad & { seen: RelicSeen | null })[]
}

/**
 * Keeps the minimap timers of an ARAM game up to date. Inhibitors come from the Live Client API event
 * feed, health relics from one tiny capture of each relic pad per second (shared screen stream).
 */
export class MinimapWatcher {
  private active = false
  private gameTime = 0
  private measuredAt = 0
  private inhibitorEvents: NonNullable<LiveGameState['inhibitorEvents']> = []
  private lastKey = ''
  private lastEmit = 0
  private readonly relics: RelicTracker
  private timer: NodeJS.Timeout | null = null
  private sampling = false
  private loggedInhibitorEvents = 0
  private loggedMap: number | null | undefined = undefined
  private relicsOn = true
  private mode: 'aram' | 'mayhem' = 'aram'
  private map: number | null = null
  private lastSeen: (RelicSeen | null)[] = []
  /** relic pads measured with the admin tool, by map number */
  measuredPads: Record<string, RelicPad[]> = {}
  /** admin tool: what the pads show in a simulated game, instead of looking at the screen */
  seenOverride: ((pads: readonly RelicPad[], gameTime: number) => (RelicSeen | null)[]) | null = null

  constructor(
    private readonly settings: () => Settings['minimap'],
    private readonly gameDisplay: () => number | null,
    private readonly emit: (state: MinimapState | null) => void,
    private readonly capture: CaptureService | null = null,
    private readonly log: (message: string) => void = () => undefined,
    private readonly learned: LearnedTimers | null = null
  ) {
    this.relics = new RelicTracker(log)
  }

  private display(): Electron.Display {
    const id = this.gameDisplay()
    return screen.getAllDisplays().find((display) => display.id === id) ?? screen.getPrimaryDisplay()
  }

  /** Screen the timers belong on. */
  get displayId(): number {
    return this.display().id
  }

  private now(): number {
    return this.gameTime + (Date.now() - this.measuredAt) / 1000
  }

  /** Inhibitor respawn to assume: what this game showed, else what earlier games of this mode showed, else 4:10. */
  private inhibitorRespawn(): number {
    const seen = observedInhibitorRespawns(this.inhibitorEvents)
    if (seen.length) return [...seen].sort((a, b) => a - b)[seen.length >> 1]
    return this.learned?.inhibitorRespawn(this.mode) ?? INHIBITOR_RESPAWN
  }

  /** Called with every live-game update. `aram` means the game is played on an ARAM map, `mayhem` that it's ARAM: Mayhem. */
  update(live: LiveGameState | null, aram: boolean, mayhem = false): void {
    const settings = this.settings()
    if (!live?.active || !aram || !settings.enabled || (!settings.inhibitors && !settings.relics)) {
      if (this.active) this.stop()
      return
    }
    if (!this.active) {
      this.active = true
      this.relics.reset()
      this.loggedInhibitorEvents = 0
      this.log(`map timers on (inhibitors ${settings.inhibitors ? 'on' : 'off'}, relics ${settings.relics ? 'on' : 'off'})`)
    }
    this.mode = mayhem ? 'mayhem' : 'aram'
    this.gameTime = live.gameTime
    this.measuredAt = Date.now()
    this.inhibitorEvents = live.inhibitorEvents ?? []
    if (this.inhibitorEvents.length > this.loggedInhibitorEvents) {
      const before = observedInhibitorRespawns(this.inhibitorEvents.slice(0, this.loggedInhibitorEvents)).length
      for (const event of this.inhibitorEvents.slice(this.loggedInhibitorEvents))
        this.log(`inhibitor ${event.type}: ${event.inhibitor} at ${Math.round(event.time)} s`)
      this.loggedInhibitorEvents = this.inhibitorEvents.length
      // a respawn we saw from start to end: remember how long it took for the next games of this mode
      const durations = observedInhibitorRespawns(this.inhibitorEvents)
      if (durations.length > before) {
        const latest = durations[durations.length - 1]
        this.log(`inhibitor respawn took ${Math.round(latest)} s (${this.mode})`)
        this.learned?.setInhibitorRespawn(this.mode, latest)
      }
    }
    this.relics.tick(live.gameTime)

    // Relic pads are only known where they were measured: the Howling Abyss (map 12) built in,
    // other maps (Butcher's Bridge, Koeshin's Crossing) once measured with the admin tool.
    this.map = live.mapNumber ?? null
    const pads = relicPadsFor(live.mapNumber, this.measuredPads)
    if (live.mapNumber !== this.loggedMap) {
      this.loggedMap = live.mapNumber ?? null
      this.log(
        `map ${live.mapNumber ?? '?'} (${live.mapName ?? '?'}, terrain ${live.mapTerrain ?? '?'}, ${this.mode})` +
          (pads ? ` – ${pads.length} relic pads` : ' – relic timers off (pads unknown on this map)')
      )
    }
    if (pads) this.relics.setPads(pads)
    this.relicsOn = !!pads
    const watchRelics = settings.relics && !!pads && (!!this.capture || !!this.seenOverride) && live.gameTime > 95
    this.capture?.demand('relics', watchRelics && !this.seenOverride ? { displays: [this.display().id], fps: 1 } : null)
    if (watchRelics && !this.timer) this.timer = setInterval(() => void this.sample(), 1000)
    if (!watchRelics && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.publish()
  }

  /** Screen regions of the watched pads (fractions of the display) and their output size in pixels. */
  private padRegions(display: Electron.Display, pads: readonly RelicPad[]) {
    const minimap = minimapRect(display.size.width, display.size.height, this.settings().scale)
    // square patch in physical pixels, at least 9 px
    const patchPx = Math.max(9, Math.round(RELIC_PATCH * minimap.w * display.size.width * display.scaleFactor))
    return pads.map((pad) => {
      const w = RELIC_PATCH * minimap.w
      const h = (RELIC_PATCH * minimap.w * display.size.width) / display.size.height
      return {
        x: minimap.x + pad.pos.x * minimap.w - w / 2,
        y: minimap.y + pad.pos.y * minimap.h - h / 2,
        w,
        h,
        outW: patchPx,
        outH: patchPx
      }
    })
  }

  private async sample(): Promise<void> {
    if (this.sampling || !this.active || (!this.capture && !this.seenOverride)) return
    this.sampling = true
    try {
      if (this.seenOverride) this.lastSeen = this.seenOverride(this.relics.watched, this.now())
      else {
        const display = this.display()
        const frames = await this.capture!.grab(display, this.padRegions(display, this.relics.watched))
        if (!frames) return
        this.lastSeen = frames.map((frame) => relicSeen(frame))
      }
      const taken = this.relics.observe(this.now(), this.lastSeen)
      if (taken.length) this.log(`relic taken: ${taken.join(', ')} at ${Math.round(this.now())} s`)
      this.publish()
    } finally {
      this.sampling = false
    }
  }

  /** What the watched pads look like at the last sample (admin tool). */
  probe(): RelicProbe {
    return { map: this.map, pads: this.relics.watched.map((pad, i) => ({ ...pad, seen: this.lastSeen[i] ?? null })) }
  }

  /** Sends the next state even if nothing changed (after the admin tool moved the game clock). */
  resync(): void {
    this.lastKey = ''
  }

  private publish(): void {
    const settings = this.settings()
    const display = this.display()
    const state: MinimapState = {
      gameTime: this.now(),
      measuredAt: Date.now(),
      rect: minimapRect(display.size.width, display.size.height, settings.scale),
      inhibitors: settings.inhibitors ? inhibitorTimers(this.inhibitorEvents, this.now(), this.inhibitorRespawn()) : [],
      relics: settings.relics && this.relicsOn ? this.relics.snapshot() : []
    }
    // The overlay counts down on its own, so only resend when something changed (or every 15 s to resync).
    const key = JSON.stringify({ ...state, gameTime: 0, measuredAt: 0 })
    if (key === this.lastKey && Date.now() - this.lastEmit < 15_000) return
    this.lastKey = key
    this.lastEmit = Date.now()
    this.emit(state)
  }

  stop(): void {
    this.active = false
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.capture?.demand('relics', null)
    this.relics.reset()
    this.lastSeen = []
    this.lastKey = ''
    this.emit(null)
  }
}
