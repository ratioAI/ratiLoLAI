import { join } from 'node:path'
import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'

/**
 * Transparent, click-through, always-on-top window laid over the game (requires the game to run in
 * borderless or windowed mode – exclusive fullscreen cannot be overlaid). The renderer turns mouse
 * interaction on only while the cursor is over the augment panel, so the game keeps every click.
 */
export class OverlayManager {
  private win: BrowserWindow | null = null
  private hotkey: string | null = null
  private previewTimer: NodeJS.Timeout | null = null
  private displayId: number | null = null

  constructor(
    private readonly preload: string,
    private readonly load: (win: BrowserWindow, hash: string) => void,
    private readonly onToggle: () => void
  ) {
    ipcMain.on('overlay:interactive', (_e, interactive: boolean) => {
      this.win?.setIgnoreMouseEvents(!interactive, { forward: true })
    })
  }

  private display(): Electron.Display {
    return screen.getAllDisplays().find((d) => d.id === this.displayId) ?? screen.getPrimaryDisplay()
  }

  /** Moves the overlay onto the monitor the game runs on. */
  moveToDisplay(id: number): void {
    if (id === this.displayId) return
    this.displayId = id
    this.win?.setBounds(this.display().bounds)
  }

  get currentDisplayId(): number {
    return this.display().id
  }

  private create(): BrowserWindow {
    const { bounds } = this.display()
    const win = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: false, nodeIntegration: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setIgnoreMouseEvents(true, { forward: true })
    this.load(win, '/overlay')
    win.on('closed', () => (this.win = null))
    return win
  }

  get window(): BrowserWindow | null {
    return this.win
  }

  /** Creates the window hidden, so showing it later is instant. */
  prepare(): void {
    this.win ??= this.create()
  }

  show(): void {
    this.win ??= this.create()
    if (!this.win.isVisible()) this.win.showInactive()
  }

  hide(): void {
    if (this.previewTimer) return // keep a running preview visible
    this.win?.hide()
  }

  /** Shows the overlay for a while without a running game (for testing the look). */
  preview(send: () => void, ms = 20_000): void {
    this.show()
    const wc = this.win!.webContents
    // the overlay page must be loaded (and React listening) before it can receive the preview event
    if (wc.isLoading()) wc.once('did-finish-load', () => setTimeout(send, 600))
    else send()
    if (this.previewTimer) clearTimeout(this.previewTimer)
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null
      this.win?.hide()
    }, ms)
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

  destroy(): void {
    globalShortcut.unregisterAll()
    this.win?.destroy()
    this.win = null
  }
}

export const overlayPreloadPath = (dir: string): string => join(dir, '../preload/index.js')
