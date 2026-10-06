import { screen } from 'electron'
import type { LiveGameState, MinimapState, Settings } from '@shared/types'
import type { CaptureService } from '../capture/captureService'
import { inhibitorTimers, minimapRect, RELIC_PATCH, RelicTracker, RELICS, relicSeen } from './timers'

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

  constructor(
    private readonly settings: () => Settings['minimap'],
    private readonly gameDisplay: () => number | null,
    private readonly emit: (state: MinimapState | null) => void,
    private readonly capture: CaptureService | null = null,
    private readonly log: (message: string) => void = () => undefined
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

  /** Called with every live-game update. `aram` means the game is played on the Howling Abyss. */
  update(live: LiveGameState | null, aram: boolean): void {
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
    this.gameTime = live.gameTime
    this.measuredAt = Date.now()
    this.inhibitorEvents = live.inhibitorEvents ?? []
    if (this.inhibitorEvents.length > this.loggedInhibitorEvents) {
      for (const event of this.inhibitorEvents.slice(this.loggedInhibitorEvents))
        this.log(`inhibitor ${event.type}: ${event.inhibitor} at ${Math.round(event.time)} s`)
      this.loggedInhibitorEvents = this.inhibitorEvents.length
    }
    this.relics.tick(live.gameTime)

    // We only know the relic pad positions for the Howling Abyss (map 12). Other Mayhem maps
    // (Butcher's Bridge, Koeshin's Crossing) put them elsewhere. Watching only starts shortly before
    // the first relics spawn.
    if (live.mapNumber !== this.loggedMap) {
      this.loggedMap = live.mapNumber ?? null
      this.log(
        `map ${live.mapNumber ?? '?'}${live.mapNumber != null && live.mapNumber !== 12 ? ' – relic timers off (pads unknown on this map)' : ''}`
      )
    }
    const knownMap = live.mapNumber == null || live.mapNumber === 12
    this.relicsOn = knownMap
    const watchRelics = settings.relics && knownMap && !!this.capture && live.gameTime > 95
    this.capture?.demand('relics', watchRelics ? { displays: [this.display().id], fps: 1 } : null)
    if (watchRelics && !this.timer) this.timer = setInterval(() => void this.sample(), 1000)
    if (!watchRelics && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.publish()
  }

  private async sample(): Promise<void> {
    if (this.sampling || !this.active || !this.capture) return
    this.sampling = true
    try {
      const display = this.display()
      const minimap = minimapRect(display.size.width, display.size.height, this.settings().scale)
      // square patch in physical pixels, at least 9 px
      const patchPx = Math.max(9, Math.round(RELIC_PATCH * minimap.w * display.size.width * display.scaleFactor))
      const regions = RELICS.map((relic) => {
        const w = (RELIC_PATCH * minimap.w * display.size.width) / display.size.width
        const h = (RELIC_PATCH * minimap.w * display.size.width) / display.size.height
        return {
          x: minimap.x + relic.pos.x * minimap.w - w / 2,
          y: minimap.y + relic.pos.y * minimap.h - h / 2,
          w,
          h,
          outW: patchPx,
          outH: patchPx
        }
      })
      const frames = await this.capture.grab(display, regions)
      if (!frames) return
      const taken = this.relics.observe(
        this.now(),
        frames.map((frame) => relicSeen(frame))
      )
      if (taken.length) this.log(`relic taken: ${taken.join(', ')} at ${Math.round(this.now())} s`)
      this.publish()
    } finally {
      this.sampling = false
    }
  }

  private publish(): void {
    const settings = this.settings()
    const display = this.display()
    const state: MinimapState = {
      gameTime: this.now(),
      measuredAt: Date.now(),
      rect: minimapRect(display.size.width, display.size.height, settings.scale),
      inhibitors: settings.inhibitors ? inhibitorTimers(this.inhibitorEvents, this.now()) : [],
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
    this.lastKey = ''
    this.emit(null)
  }
}
