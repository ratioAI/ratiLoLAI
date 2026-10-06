import { BrowserWindow, globalShortcut, ipcMain, screen, type Rectangle } from 'electron'
import type { AugmentOffer, RcEvents } from '@shared/types'

type Part = 'panel' | 'frames' | 'minimap' | 'loading'

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
    private readonly hash: string
  ) {}

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
      this.win = null
      this.loaded = null
    })
    this.win = win
    return win
  }

  setBounds(bounds: Rectangle): void {
    const win = this.ensure(bounds)
    const current = win.getBounds()
    // only touch the window when the bounds actually changed
    if (current.x !== bounds.x || current.y !== bounds.y || current.width !== bounds.width || current.height !== bounds.height)
      win.setBounds(bounds)
  }

  show(): void {
    const win = this.ensure()
    if (!win.isVisible()) win.showInactive()
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
    this.win?.destroy()
    this.win = null
  }
}

/** Margin (DIP) around the minimap inside the minimap window, for labels that stick out. */
export const MINIMAP_MARGIN = 36
const PANEL_WIDTH = 350
/** Space around the cards for the crest above them and the glow. */
const FRAME_PAD = { top: 100, side: 60, bottom: 52 }

export class OverlayManager {
  readonly panel: OverlayWindow
  readonly frames: OverlayWindow
  readonly minimap: OverlayWindow
  readonly loading: OverlayWindow
  private heldKey: string | null = null
  private hotkey: string | null = null
  private previewTimer: NodeJS.Timeout | null = null
  private displayId: number | null = null

  constructor(
    preload: string,
    load: (win: BrowserWindow, hash: string) => void,
    private readonly onToggle: () => void
  ) {
    this.panel = new OverlayWindow('panel', preload, load, '/overlay/panel')
    this.frames = new OverlayWindow('frames', preload, load, '/overlay/frames')
    this.minimap = new OverlayWindow('minimap', preload, load, `/overlay/minimap?m=${MINIMAP_MARGIN}`)
    this.loading = new OverlayWindow('loading', preload, load, '/overlay/loading')
    // the renderer turns click-through off while the mouse is over something clickable
    ipcMain.on('overlay:interactive', (event, interactive: boolean) => {
      BrowserWindow.fromWebContents(event.sender)?.setIgnoreMouseEvents(!interactive, { forward: true })
    })
  }

  private display(id = this.displayId): Electron.Display {
    return screen.getAllDisplays().find((display) => display.id === id) ?? screen.getPrimaryDisplay()
  }

  /** Moves the overlay onto the monitor the game runs on. */
  moveToDisplay(id: number): void {
    this.displayId = id
    if (this.panel.visible) this.showPanel()
  }

  get currentDisplayId(): number {
    return this.display().id
  }

  /** Creates the hidden windows early so they show up instantly later. */
  prepare(): void {
    this.panel.ensure(this.panelBounds())
    this.frames.ensure()
  }

  private panelBounds(): Rectangle {
    const { bounds } = this.display()
    const height = Math.round(bounds.height * 0.78)
    return { x: bounds.x + bounds.width - PANEL_WIDTH - 6, y: bounds.y + Math.round(bounds.height * 0.12), width: PANEL_WIDTH, height }
  }

  showPanel(): void {
    this.panel.setBounds(this.panelBounds())
    this.panel.show()
  }

  hidePanel(): void {
    if (this.previewTimer) return // keep a running preview visible
    this.panel.hide()
  }

  /** Frames around the offered cards. The window only covers the cards plus crest and glow. */
  showFrames(offer: AugmentOffer): void {
    const display = this.display(offer.displayId)
    const rects = offer.cards.map((card) => card.rect)
    // card rects are relative to the display, clamp the padded area to it
    const x0 = Math.max(0, Math.min(...rects.map((rect) => rect.x)) - FRAME_PAD.side)
    const y0 = Math.max(0, Math.min(...rects.map((rect) => rect.y)) - FRAME_PAD.top)
    const x1 = Math.min(display.bounds.width, Math.max(...rects.map((rect) => rect.x + rect.width)) + FRAME_PAD.side)
    const y1 = Math.min(display.bounds.height, Math.max(...rects.map((rect) => rect.y + rect.height)) + FRAME_PAD.bottom)
    const bounds = {
      x: Math.round(display.bounds.x + x0),
      y: Math.round(display.bounds.y + y0),
      width: Math.round(x1 - x0),
      height: Math.round(y1 - y0)
    }
    this.frames.setBounds(bounds)
    // the frames page draws in window coordinates
    const local: AugmentOffer = {
      ...offer,
      cards: offer.cards.map((card) => ({ ...card, rect: { ...card.rect, x: card.rect.x - x0, y: card.rect.y - y0 } }))
    }
    void this.frames.send('framesOffer', local).then(() => this.frames.show())
  }

  hideFrames(): void {
    if (this.previewTimer) return
    this.frames.hide()
    void this.frames.send('framesOffer', null)
  }

  /** Minimap timers. `rect` is in fractions of the display; returns the minimap's position inside the window (DIP). */
  showMinimap(displayId: number, rect: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const { bounds } = this.display(displayId)
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
    const { bounds } = this.display(displayId)
    const width = Math.min(1040, bounds.width - 40)
    const height = 330
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

  /** Shows the panel and frames for a while without a running game, to check how they look. */
  preview(offer: AugmentOffer | null, onReady: () => void, durationMs = 20_000): void {
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = null
    this.showPanel()
    onReady()
    if (offer) this.showFrames(offer)
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null
      this.panel.hide()
      this.hideFrames()
    }, durationMs)
  }

  /** Shows the overlays in screen shares and recordings (Discord, OBS) or keeps them out. */
  setVisibleInCapture(visible: boolean): void {
    if (hideFromCapture === !visible) return
    hideFromCapture = !visible
    for (const overlay of [this.panel, this.frames, this.minimap, this.loading]) overlay.applyCapture()
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

  /** Sends an app-wide event to every overlay window that exists. */
  broadcast<K extends keyof RcEvents>(event: K, payload: RcEvents[K]): void {
    for (const overlay of [this.panel, this.frames, this.minimap, this.loading]) overlay.sendIfOpen(event, payload)
  }

  get anyVisible(): boolean {
    return this.panel.visible || this.frames.visible || this.minimap.visible || this.loading.visible
  }

  destroy(): void {
    globalShortcut.unregisterAll()
    this.panel.destroy()
    this.frames.destroy()
    this.minimap.destroy()
    this.loading.destroy()
  }
}
