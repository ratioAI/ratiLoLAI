import { BrowserWindow, globalShortcut, ipcMain, screen, type Rectangle } from 'electron'
import type { AugmentOffer, RcEvents } from '@shared/types'
import { boundsDiffer, frameWindowBounds } from '@shared/overlayGeometry'

type Part = 'frames' | 'minimap' | 'loading'

/** false means the overlays also show up in screen shares and recordings (Discord, OBS) */
let hideFromCapture = true

/**
 * One transparent, click-through, always-on-top window. On Windows every repaint of a transparent
 * window is copied to the desktop compositor as a whole, so each overlay part gets its own window
 * that is only as large as its content. That way the animated card frames don't repaint a
 * full-screen surface.
 */
class OverlayWindow {
  win: BrowserWindow | null = null
  private loaded: Promise<void> | null = null

  applyCapture(): void {
    if (this.win && !this.win.isDestroyed()) this.win.setContentProtection(hideFromCapture)
  }

  constructor(
    private readonly part: Part,
    private readonly preload: string,
    private readonly load: (win: BrowserWindow, hash: string) => void,
    private readonly hash: string,
    private readonly log: (message: string) => void = () => undefined
  ) {}

  /** called after the page crashed and the window was thrown away, so the owner can show it again */
  onGone: () => void = () => undefined

  ensure(bounds?: Rectangle): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const initialBounds = bounds ?? { x: 0, y: 0, width: 400, height: 300 }
    const win = new BrowserWindow({
      ...initialBounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      title: `ratioAI ${this.part}`,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: false, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setIgnoreMouseEvents(true, { forward: true })
    // By default the overlay is excluded from screen captures (WDA_EXCLUDEFROMCAPTURE, Windows 10 2004+),
    // so the card recognition never sees our own frames. Users who want it in Discord or OBS can turn
    // this off in the overlay settings.
    win.setContentProtection(hideFromCapture)
    // give the page a moment after load to mount and subscribe to events
    this.loaded = new Promise((resolve) => win.webContents.once('did-finish-load', () => setTimeout(resolve, 300)))
    this.load(win, this.hash)
    win.on('closed', () => {
      if (this.win !== win) return
      this.win = null
      this.loaded = null
    })
    // A crashed or killed overlay page (GPU driver reset, out of memory) would leave an empty window
    // for the rest of the session. Throw it away; the next show builds a fresh one.
    win.webContents.on('render-process-gone', (_event, details) => {
      // destroy() and app shutdown let go of the window first, those are not crashes
      if (this.win !== win || details.reason === 'clean-exit') return
      this.log(`${this.part} overlay page gone (${details.reason}) – recreating`)
      this.win = null
      this.loaded = null
      if (!win.isDestroyed()) win.destroy()
      this.onGone()
    })
    this.win = win
    return win
  }

  setBounds(bounds: Rectangle): void {
    const win = this.ensure(bounds)
    // only touch the window when the bounds actually changed
    if (!boundsDiffer(win.getBounds(), bounds, 0)) return
    win.setBounds(bounds)
    // Windows sizes a window that moves onto a monitor with a different scale factor (100 % next to
    // 125 %, say) using the old monitor's factor, so it ends up too big or too small. Once it is on
    // the new monitor a second setBounds is converted correctly.
    if (boundsDiffer(win.getBounds(), bounds)) {
      win.setBounds(bounds)
      const actual = win.getBounds()
      if (boundsDiffer(actual, bounds)) this.log(`${this.part} window: wanted ${JSON.stringify(bounds)}, got ${JSON.stringify(actual)}`)
    }
  }

  show(): void {
    const win = this.ensure()
    if (!win.isVisible()) win.showInactive()
    // the game can push itself above other topmost windows when it gets focus, so claim the top again
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
  }

  hide(): void {
    if (this.win?.isVisible()) this.win.hide()
  }

  get visible(): boolean {
    return !!this.win?.isVisible()
  }

  /** Sends an event to this window only (after the page has loaded). */
  async send<K extends keyof RcEvents>(event: K, payload: RcEvents[K]): Promise<void> {
    this.ensure()
    await this.loaded
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('rc:event', event, payload)
  }

  /** Sends only if the window already exists and has loaded, so a broadcast never creates a window. */
  sendIfOpen<K extends keyof RcEvents>(event: K, payload: RcEvents[K]): void {
    if (this.win && !this.win.isDestroyed() && !this.win.webContents.isLoading()) this.win.webContents.send('rc:event', event, payload)
  }

  destroy(): void {
    const win = this.win
    this.win = null
    win?.destroy()
  }
}

/** Margin (DIP) around the minimap inside the minimap window, for labels that stick out. */
export const MINIMAP_MARGIN = 36

export class OverlayManager {
  readonly frames: OverlayWindow
  readonly minimap: OverlayWindow
  readonly loading: OverlayWindow
  private heldKey: string | null = null
  private hotkey: string | null = null
  private previewTimer: NodeJS.Timeout | null = null
  private displayId: number | null = null
  /** hotkeys of other features (the recorder's clip, bookmark and screenshot keys) */
  private extraKeys: string[] = []
  /** offer the frames show right now (display-relative), to restore them after a page crash */
  private shownOffer: AugmentOffer | null = null
  /** bumped by every show/hide of the frames, so a slow show can't undo a later hide */
  private framesToken = 0

  constructor(
    preload: string,
    load: (win: BrowserWindow, hash: string) => void,
    private readonly onToggle: () => void,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.frames = new OverlayWindow('frames', preload, load, '/overlay/frames', log)
    this.minimap = new OverlayWindow('minimap', preload, load, `/overlay/minimap?m=${MINIMAP_MARGIN}`, log)
    this.loading = new OverlayWindow('loading', preload, load, '/overlay/loading', log)
    this.frames.onGone = () => {
      const offer = this.shownOffer
      if (offer) setTimeout(() => this.shownOffer === offer && this.showFrames(offer), 500)
    }
    // the renderer turns click-through off while the mouse is over something clickable
    ipcMain.on('overlay:interactive', (event, interactive: boolean) => {
      BrowserWindow.fromWebContents(event.sender)?.setIgnoreMouseEvents(!interactive, { forward: true })
    })
  }

  /** The display with this id, or the primary display when `fallback` is set and it is gone. */
  private display(id: number | null = this.displayId, fallback = true): Electron.Display | null {
    return screen.getAllDisplays().find((display) => display.id === id) ?? (fallback ? screen.getPrimaryDisplay() : null)
  }

  /** Moves the overlay onto the monitor the game runs on. */
  moveToDisplay(id: number): void {
    this.displayId = id
  }

  get currentDisplayId(): number {
    return this.display()!.id
  }

  /**
   * Creates the hidden frames window early so it shows up instantly later. It is created on the game
   * screen right away: moving it there later from another monitor is where scaling goes wrong.
   */
  prepare(displayId: number | null = this.displayId): void {
    const { bounds } = this.display(displayId)!
    this.frames.ensure({
      x: bounds.x + Math.round(bounds.width / 2) - 200,
      y: bounds.y + Math.round(bounds.height / 2) - 150,
      width: 400,
      height: 300
    })
  }

  /**
   * Frames around the offered cards. The window only covers the cards plus crest and glow. Returns
   * false (and shows nothing) when the offer doesn't fit any current display, instead of guessing.
   */
  showFrames(offer: AugmentOffer): boolean {
    const display = this.display(offer.displayId, false)
    const placed = display
      ? frameWindowBounds(
          display.bounds,
          offer.cards.map((card) => card.rect)
        )
      : null
    if (!display || !placed) {
      this.log(
        display
          ? `frames: cards ${JSON.stringify(offer.cards.map((card) => card.rect))} are outside display ${display.id} – not shown`
          : `frames: display ${offer.displayId} is gone – not shown`
      )
      this.hideFrames()
      return false
    }
    this.shownOffer = offer
    const token = ++this.framesToken
    // a window that doesn't exist yet is created right where it belongs (see prepare)
    this.frames.ensure(placed.bounds)
    // the frames page draws in window coordinates
    const local: AugmentOffer = {
      ...offer,
      cards: offer.cards.map((card) => ({
        ...card,
        rect: { ...card.rect, x: card.rect.x - placed.offset.x, y: card.rect.y - placed.offset.y }
      }))
    }
    // content first, then bounds: moving a visible window before its content changed shows the old
    // frames at the new spot for a frame
    void this.frames.send('framesOffer', local).then(() => {
      if (token !== this.framesToken) return // hidden or replaced meanwhile
      this.frames.setBounds(placed.bounds)
      this.frames.show()
    })
    return true
  }

  hideFrames(): void {
    if (this.previewTimer) return
    this.shownOffer = null
    this.framesToken++
    this.frames.hide()
    void this.frames.send('framesOffer', null)
  }

  /** Minimap timers. `rect` is in fractions of the display; returns the minimap's position inside the window (DIP). */
  showMinimap(displayId: number, rect: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const { bounds } = this.display(displayId)!
    const margin = MINIMAP_MARGIN
    const x = Math.round(bounds.x + rect.x * bounds.width - margin)
    const y = Math.round(bounds.y + rect.y * bounds.height - margin)
    // the minimap sits in the corner, so the margin is cut off at the screen edge
    const right = Math.min(bounds.x + bounds.width, Math.round(bounds.x + (rect.x + rect.w) * bounds.width + margin))
    const bottom = Math.min(bounds.y + bounds.height, Math.round(bounds.y + (rect.y + rect.h) * bounds.height + margin))
    this.minimap.setBounds({ x, y, width: right - x, height: bottom - y })
    this.minimap.show()
    return {
      x: bounds.x + rect.x * bounds.width - x,
      y: bounds.y + rect.y * bounds.height - y,
      w: rect.w * bounds.width,
      h: rect.h * bounds.height
    }
  }

  /** Loading screen panel, centered at the top of the game screen. */
  showLoading(displayId: number | null): void {
    const { bounds } = this.display(displayId)!
    const width = Math.min(1040, bounds.width - 40)
    const height = 340
    this.loading.setBounds({ x: Math.round(bounds.x + (bounds.width - width) / 2), y: bounds.y + 18, width, height })
    this.loading.show()
  }

  hideLoading(): void {
    this.loading.hide()
  }

  /**
   * Registers a key only while something needs it (e.g. Space on the loading screen). A global
   * shortcut takes the key away from every other program, so pass null to release it again.
   */
  holdKey(accelerator: string | null, callback: () => void = () => undefined): void {
    if (this.heldKey === accelerator) return
    if (this.heldKey) globalShortcut.unregister(this.heldKey)
    this.heldKey = null
    if (!accelerator) return
    try {
      if (globalShortcut.register(accelerator, callback)) this.heldKey = accelerator
    } catch {
      // already taken by another program
    }
  }

  hideMinimap(): void {
    this.minimap.hide()
  }

  /** Shows the card frames for a while without a running game, to check how they look. */
  preview(offer: AugmentOffer, durationMs = 20_000): void {
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = null
    this.showFrames(offer)
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null
      this.hideFrames()
    }, durationMs)
  }

  /** Monitors were added, removed or rescaled: frames placed for the old setup are wrong now. */
  displaysChanged(): void {
    if (this.displayId !== null && !this.display(this.displayId, false)) this.displayId = null
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = null
    this.hideFrames()
  }

  /** Ends a running preview right away. */
  endPreview(): void {
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = null
    this.hideFrames()
  }

  /** Shows the overlays in screen shares and recordings (Discord, OBS) or keeps them out. */
  setVisibleInCapture(visible: boolean): void {
    if (hideFromCapture === !visible) return
    hideFromCapture = !visible
    for (const overlay of [this.frames, this.minimap, this.loading]) overlay.applyCapture()
  }

  setHotkey(accelerator: string): void {
    if (this.hotkey) globalShortcut.unregister(this.hotkey)
    this.hotkey = null
    if (!accelerator) return
    try {
      if (globalShortcut.register(accelerator, () => this.onToggle())) this.hotkey = accelerator
    } catch {
      // invalid accelerator
    }
  }

  /**
   * Global hotkeys of other features, e.g. the recorder's. Replaces the ones set before; an empty
   * list releases them all (a global shortcut takes the key away from every other program, so they
   * are only held while a recording runs).
   */
  setExtraHotkeys(bindings: { accelerator: string; run(): void }[]): void {
    for (const key of this.extraKeys) globalShortcut.unregister(key)
    this.extraKeys = []
    for (const binding of bindings) {
      try {
        if (globalShortcut.register(binding.accelerator, binding.run)) this.extraKeys.push(binding.accelerator)
      } catch {
        // invalid accelerator or taken by another program
      }
    }
  }

  /** Sends an app-wide event to every overlay window that exists. */
  broadcast<K extends keyof RcEvents>(event: K, payload: RcEvents[K]): void {
    for (const overlay of [this.frames, this.minimap, this.loading]) overlay.sendIfOpen(event, payload)
  }

  get anyVisible(): boolean {
    return this.frames.visible || this.minimap.visible || this.loading.visible
  }

  destroy(): void {
    globalShortcut.unregisterAll()
    this.frames.destroy()
    this.minimap.destroy()
    this.loading.destroy()
  }
}
