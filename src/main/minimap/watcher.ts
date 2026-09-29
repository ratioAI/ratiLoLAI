import { screen } from 'electron'
import type { LiveGameState, MinimapState, Settings } from '@shared/types'
import { inhibitorTimers, minimapRect } from './timers'

/**
 * Keeps the minimap timers of an ARAM game up to date. Only uses the Live Client API data that is
 * polled anyway – it never takes a screenshot.
 */
export class MinimapWatcher {
  private active = false
  private gameTime = 0
  private measuredAt = 0
  private inhibEvents: NonNullable<LiveGameState['inhibitorEvents']> = []
  private lastKey = ''

  constructor(
    private readonly settings: () => Settings['minimap'],
    private readonly gameDisplay: () => number | null,
    private readonly emit: (s: MinimapState | null) => void
  ) {}

  private display(): Electron.Display {
    const id = this.gameDisplay()
    return screen.getAllDisplays().find((d) => d.id === id) ?? screen.getPrimaryDisplay()
  }

  /** Screen the timers belong on. */
  get displayId(): number {
    return this.display().id
  }

  /** Called with every live-game update; `aram` = the game is played on the Howling Abyss. */
  update(live: LiveGameState | null, aram: boolean): void {
    const s = this.settings()
    if (!live?.active || !aram || !s.enabled || !s.inhibitors) {
      if (this.active) this.stop()
      return
    }
    this.active = true
    this.gameTime = live.gameTime
    this.measuredAt = Date.now()
    this.inhibEvents = live.inhibitorEvents ?? []
    const d = this.display()
    const state: MinimapState = {
      gameTime: this.gameTime,
      measuredAt: this.measuredAt,
      rect: minimapRect(d.size.width, d.size.height, s.scale),
      inhibitors: inhibitorTimers(this.inhibEvents, this.gameTime)
    }
    // the overlay counts down on its own – only resend when something changed (or to resync)
    const key = JSON.stringify({ ...state, gameTime: Math.floor(state.gameTime / 30), measuredAt: 0 })
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit(state)
  }

  stop(): void {
    this.active = false
    this.lastKey = ''
    this.emit(null)
  }
}
