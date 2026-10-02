import { BrowserWindow, globalShortcut, ipcMain, screen, type Rectangle } from 'electron'
import type { AugmentOffer, RcEvents } from '@shared/types'

type Part = 'panel' | 'frames' | 'minimap' | 'loading'

/**
 * One transparent, click-through, always-on-top window. On Windows every repaint of a transparent
 * window is copied to the desktop compositor as a whole, so each overlay part gets a window that is
 * only as large as its content – the animated card frames no longer repaint a full-screen surface.
 */
/** false = overlays also appear in screen shares / recordings (Discord, OBS) */
let hideFromCapture = true

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
    const b = bounds ?? { x: 0, y: 0, width: 400, height: 300 }
    const win = new BrowserWindow({
      ...b,
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
    // by default our own overlay stays out of screen captures (Windows 10 2004+:
    // WDA_EXCLUDEFROMCAPTURE), so the card recognition never sees its own frames. Users who want to
    // show it in Discord / OBS can turn that off (Settings → overlay).
    win.setContentProtection(hideFromCapture)
    this.loaded = new Promise((resolve) => win.webContents.once('did-finish-load', () => setTimeout(resolve, 300)))
    this.load(win, this.hash)
    win.on('closed', () => {
      this.win = null
      this.loaded = null
    })
    this.win = win
    return win
  }

  setBounds(b: Rectangle): void {
    const win = this.ensure(b)
    const cur = win.getBounds()
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) win.setBounds(b)
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

  destroy(): void {
    this.win?.destroy()
    this.win = null
  }
}

/** Margin (DIP) around the minimap inside the minimap window, for labels that stick out. */
export const MINIMAP_MARGIN = 36
const PANEL_WIDTH = 350
/** space around the cards for the crest above and the glow around them */
const FRAME_PAD = { top: 100, side: 60, bottom: 52 }

export class OverlayManager {
  readonly panel: OverlayWindow
  readonly frames: OverlayWindow
  readonly minimap: OverlayWindow
  readonly loading: OverlayWindow
  private tempKey: string | null = null
  private hotkey: string | null = null
  private previewTimer: NodeJS.Timeout | null = null
  private displayId: number | null = null

  constructor(preload: string, load: (win: BrowserWindow, hash: string) => void, private readonly onToggle: () => void) {
    this.panel = new OverlayWindow('panel', preload, load, '/overlay/panel')
    this.frames = new OverlayWindow('frames', preload, load, '/overlay/frames')
    this.minimap = new OverlayWindow('minimap', preload, load, `/overlay/minimap?m=${MINIMAP_MARGIN}`)
    this.loading = new OverlayWindow('loading', preload, load, '/overlay/loading')
    ipcMain.on('overlay:interactive', (e, interactive: boolean) => {
      BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(!interactive, { forward: true })
    })
  }

  private display(id = this.displayId): Electron.Display {
    return screen.getAllDisplays().find((d) => d.id === id) ?? screen.getPrimaryDisplay()
  }

  /** Moves the overlay onto the monitor the game runs on. */
  moveToDisplay(id: number): void {
    this.displayId = id
    if (this.panel.visible) this.showPanel()
  }

  get currentDisplayId(): number {
    return this.display().id
  }

  /** Creates the (hidden) windows early so they appear instantly later. */
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

  /** Frames around the offered cards: the window covers just the three cards (+ crest and glow). */
  showFrames(offer: AugmentOffer): void {
    const d = this.display(offer.displayId)
    const rects = offer.cards.map((c) => c.rect)
    const x0 = Math.max(0, Math.min(...rects.map((r) => r.x)) - FRAME_PAD.side)
    const y0 = Math.max(0, Math.min(...rects.map((r) => r.y)) - FRAME_PAD.top)
    const x1 = Math.min(d.bounds.width, Math.max(...rects.map((r) => r.x + r.width)) + FRAME_PAD.side)
    const y1 = Math.min(d.bounds.height, Math.max(...rects.map((r) => r.y + r.height)) + FRAME_PAD.bottom)
    const bounds = {
      x: Math.round(d.bounds.x + x0),
      y: Math.round(d.bounds.y + y0),
      width: Math.round(x1 - x0),
      height: Math.round(y1 - y0)
    }
    this.frames.setBounds(bounds)
    const local: AugmentOffer = {
      ...offer,
      cards: offer.cards.map((c) => ({ ...c, rect: { ...c.rect, x: c.rect.x - x0, y: c.rect.y - y0 } }))
    }
    void this.frames.send('framesOffer', local).then(() => this.frames.show())
  }

  hideFrames(): void {
    if (this.previewTimer) return
    this.frames.hide()
    void this.frames.send('framesOffer', null)
  }

  /** Minimap timers: `rect` in fractions of the display. Returns the minimap inside the window (DIP). */
  showMinimap(displayId: number, rect: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
    const d = this.display(displayId)
    const m = MINIMAP_MARGIN
    const x = Math.round(d.bounds.x + rect.x * d.bounds.width - m)
    const y = Math.round(d.bounds.y + rect.y * d.bounds.height - m)
    const right = Math.min(d.bounds.x + d.bounds.width, Math.round(d.bounds.x + (rect.x + rect.w) * d.bounds.width + m))
    const bottom = Math.min(d.bounds.y + d.bounds.height, Math.round(d.bounds.y + (rect.y + rect.h) * d.bounds.height + m))
    this.minimap.setBounds({ x, y, width: right - x, height: bottom - y })
    this.minimap.show()
    return {
      x: d.bounds.x + rect.x * d.bounds.width - x,
      y: d.bounds.y + rect.y * d.bounds.height - y,
      w: rect.w * d.bounds.width,
      h: rect.h * d.bounds.height
    }
  }

  /** Loading-screen panel, centred at the top of the game screen. */
  showLoading(displayId: number | null): void {
    const d = this.display(displayId)
    const width = Math.min(1040, d.bounds.width - 40)
    const height = 330
    this.loading.setBounds({ x: Math.round(d.bounds.x + (d.bounds.width - width) / 2), y: d.bounds.y + 18, width, height })
    this.loading.show()
  }

  hideLoading(): void {
    this.loading.hide()
  }

  /**
   * A key that only works while something needs it (e.g. Space on the loading screen). Global
   * shortcuts take the key away from every other program, so it is released right afterwards.
   */
  holdKey(accelerator: string | null, cb: () => void = () => undefined): void {
    if (this.tempKey === accelerator) return
    if (this.tempKey) globalShortcut.unregister(this.tempKey)
    this.tempKey = null
    if (!accelerator) return
    try {
      if (globalShortcut.register(accelerator, cb)) this.tempKey = accelerator
    } catch {
      /* taken by another program */
    }
  }

  hideMinimap(): void {
    this.minimap.hide()
  }

  /** Shows panel + frames for a while without a running game (for checking the look). */
  preview(offer: AugmentOffer | null, onReady: () => void, ms = 20_000): void {
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = null
    this.showPanel()
    onReady()
    if (offer) this.showFrames(offer)
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null
      this.panel.hide()
      this.hideFrames()
    }, ms)
  }

  /** Show the overlays in screen shares / recordings (Discord, OBS) or keep them out. */
  setVisibleInCapture(visible: boolean): void {
    if (hideFromCapture === !visible) return
    hideFromCapture = !visible
    for (const w of [this.panel, this.frames, this.minimap, this.loading]) w.applyCapture()
  }

  setHotkey(accelerator: string): void {
    if (this.hotkey) globalShortcut.unregister(this.hotkey)
    this.hotkey = null
    if (!accelerator) return
    try {
      if (globalShortcut.register(accelerator, () => this.onToggle())) this.hotkey = accelerator
    } catch {
      /* invalid accelerator */
    }
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
