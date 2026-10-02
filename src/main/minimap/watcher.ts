import { screen } from 'electron'
import type { LiveGameState, MinimapState, Settings } from '@shared/types'
import type { CaptureService } from '../capture/captureService'
import { inhibitorTimers, minimapRect, RELIC_PATCH, RelicTracker, RELICS, relicSeen } from './timers'

/**
 * Keeps the minimap timers of an ARAM game up to date: inhibitors from the Live Client API event
 * feed, health relics from one tiny picture of each relic pad per second (shared screen stream).
 */
export class MinimapWatcher {
  private active = false
  private gameTime = 0
  private measuredAt = 0
  private inhibEvents: NonNullable<LiveGameState['inhibitorEvents']> = []
  private lastKey = ''
  private lastEmit = 0
  private readonly relics: RelicTracker
  private timer: NodeJS.Timeout | null = null
  private sampling = false
  private loggedInhibs = 0
  private loggedMap: number | null | undefined = undefined
  private relicsOn = true

  constructor(
    private readonly settings: () => Settings['minimap'],
    private readonly gameDisplay: () => number | null,
    private readonly emit: (s: MinimapState | null) => void,
    private readonly capture: CaptureService | null = null,
    private readonly log: (msg: string) => void = () => undefined
  ) {
    this.relics = new RelicTracker(log)
  }

  private display(): Electron.Display {
    const id = this.gameDisplay()
    return screen.getAllDisplays().find((d) => d.id === id) ?? screen.getPrimaryDisplay()
  }

  /** Screen the timers belong on. */
  get displayId(): number {
    return this.display().id
  }

  private now(): number {
    return this.gameTime + (Date.now() - this.measuredAt) / 1000
  }

  /** Called with every live-game update; `aram` = the game is played on the Howling Abyss. */
  update(live: LiveGameState | null, aram: boolean): void {
    const s = this.settings()
    if (!live?.active || !aram || !s.enabled || (!s.inhibitors && !s.relics)) {
      if (this.active) this.stop()
      return
    }
    if (!this.active) {
      this.active = true
      this.relics.reset()
      this.loggedInhibs = 0
      this.log(`map timers on (inhibitors ${s.inhibitors ? 'on' : 'off'}, relics ${s.relics ? 'on' : 'off'})`)
    }
    this.gameTime = live.gameTime
    this.measuredAt = Date.now()
    this.inhibEvents = live.inhibitorEvents ?? []
    if (this.inhibEvents.length > this.loggedInhibs) {
      for (const e of this.inhibEvents.slice(this.loggedInhibs)) this.log(`inhibitor ${e.type}: ${e.inhibitor} at ${Math.round(e.time)} s`)
      this.loggedInhibs = this.inhibEvents.length
    }
    this.relics.tick(live.gameTime)

    // relic pads are only worth watching once the first relics are about to spawn
    // relic pad positions are known for the Howling Abyss (map 12) only – other Mayhem maps
    // (Butcher's Bridge, Koeshin's Crossing) put them elsewhere
    if (live.mapNumber !== this.loggedMap) {
      this.loggedMap = live.mapNumber ?? null
      this.log(`map ${live.mapNumber ?? '?'}${live.mapNumber != null && live.mapNumber !== 12 ? ' – relic timers off (pads unknown on this map)' : ''}`)
    }
    const knownMap = live.mapNumber == null || live.mapNumber === 12
    this.relicsOn = knownMap
    const watchRelics = s.relics && knownMap && !!this.capture && live.gameTime > 95
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
      const d = this.display()
      const r = minimapRect(d.size.width, d.size.height, this.settings().scale)
      const px = Math.max(9, Math.round(RELIC_PATCH * r.w * d.size.width * d.scaleFactor))
      const regions = RELICS.map((relic) => {
        const w = (RELIC_PATCH * r.w * d.size.width) / d.size.width
        const h = (RELIC_PATCH * r.w * d.size.width) / d.size.height
        return { x: r.x + relic.pos.x * r.w - w / 2, y: r.y + relic.pos.y * r.h - h / 2, w, h, outW: px, outH: px }
      })
      const frames = await this.capture.grab(d, regions)
      if (!frames) return
      const taken = this.relics.observe(this.now(), frames.map((f) => relicSeen(f)))
      if (taken.length) this.log(`relic taken: ${taken.join(', ')} at ${Math.round(this.now())} s`)
      this.publish()
    } finally {
      this.sampling = false
    }
  }

  private publish(): void {
    const s = this.settings()
    const d = this.display()
    const state: MinimapState = {
      gameTime: this.now(),
      measuredAt: Date.now(),
      rect: minimapRect(d.size.width, d.size.height, s.scale),
      inhibitors: s.inhibitors ? inhibitorTimers(this.inhibEvents, this.now()) : [],
      relics: s.relics && this.relicsOn ? this.relics.snapshot() : []
    }
    // the overlay counts down on its own – only resend when something changed (or to resync)
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
