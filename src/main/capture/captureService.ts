import { join } from 'node:path'
import { BrowserWindow, desktopCapturer, ipcMain, screen, type Display } from 'electron'
import type { CaptureCommand, CaptureFrame, CaptureRegion, CaptureReply } from '@shared/capture'

/** Who needs the screen, on which displays and how often. */
interface Demand {
  displays: number[]
  fps: number
}

/**
 * Owns the hidden capture page and its screen streams. Several features can ask for pictures at
 * the same time (augment scanner, minimap timers); the streams run at the highest requested frame
 * rate on the union of the requested screens and are closed a few seconds after nobody needs them.
 */
export class CaptureService {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private seq = 0
  private readonly waiting = new Map<number, { resolve: (r: CaptureReply) => void; timer: NodeJS.Timeout }>()
  private readonly demands = new Map<string, Demand>()
  private openKey = ''
  private closeTimer: NodeJS.Timeout | null = null
  private applying: Promise<void> = Promise.resolve()
  /** set when streams can't be opened on this machine → callers fall back to getSources() */
  failed: string | null = null

  constructor(
    private readonly preload: string,
    private readonly rendererDir: string,
    private readonly log: (msg: string) => void = () => undefined
  ) {
    ipcMain.on('capture:reply', (_e, id: number, reply: CaptureReply) => {
      const w = this.waiting.get(id)
      if (!w) return
      clearTimeout(w.timer)
      this.waiting.delete(id)
      w.resolve(reply)
    })
  }

  private page(): Promise<void> {
    if (this.win && !this.win.isDestroyed() && this.ready) return this.ready
    const win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: false, backgroundThrottling: false }
    })
    win.on('closed', () => {
      this.win = null
      this.ready = null
      this.openKey = ''
    })
    this.win = win
    this.ready = (
      process.env.ELECTRON_RENDERER_URL
        ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/capture.html`)
        : win.loadFile(join(this.rendererDir, 'capture.html'))
    ).then(() => undefined)
    return this.ready
  }

  private async send(cmd: CaptureCommand, timeoutMs = 5000): Promise<CaptureReply> {
    await this.page()
    const id = ++this.seq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve({ ok: false, error: 'capture timed out' })
      }, timeoutMs)
      this.waiting.set(id, { resolve, timer })
      this.win!.webContents.send('capture:cmd', id, cmd)
    })
  }

  /** Declare (or with null: withdraw) what a feature needs. */
  demand(owner: string, d: Demand | null): void {
    if (d && d.displays.length) this.demands.set(owner, d)
    else this.demands.delete(owner)
    this.applying = this.applying.then(() => this.apply()).catch(() => undefined)
  }

  get active(): boolean {
    return this.openKey !== ''
  }

  private async apply(): Promise<void> {
    const displays = [...new Set([...this.demands.values()].flatMap((d) => d.displays))].sort()
    const fps = Math.max(0, ...[...this.demands.values()].map((d) => d.fps))
    if (!displays.length) {
      // keep the capturer a moment – the next request usually follows shortly (death → respawn → shop)
      if (this.openKey && !this.closeTimer) {
        this.closeTimer = setTimeout(() => {
          this.closeTimer = null
          if (this.demands.size) return
          this.openKey = ''
          void this.send({ type: 'close' })
          this.log('capture streams closed')
        }, 4000)
      }
      return
    }
    if (this.closeTimer) clearTimeout(this.closeTimer)
    this.closeTimer = null
    const key = `${displays.join(',')}@${fps}`
    if (key === this.openKey) return

    const all = screen.getAllDisplays()
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    const streams = displays
      .map((id) => {
        const d = all.find((x) => x.id === id)
        if (!d) return null
        const src =
          sources.find((s) => s.display_id === String(id)) ??
          (sources.length === all.length ? sources[all.indexOf(d)] : undefined) ??
          (sources.length === 1 ? sources[0] : undefined)
        if (!src) return null
        return {
          displayId: id,
          sourceId: src.id,
          width: Math.round(d.size.width * d.scaleFactor),
          height: Math.round(d.size.height * d.scaleFactor),
          fps
        }
      })
      .filter((s): s is NonNullable<typeof s> => !!s)
    const t0 = Date.now()
    const r = await this.send({ type: 'open', streams }, 8000)
    if (r.ok) {
      this.openKey = key
      this.failed = null
      this.log(`capture streams open: displays ${displays.join(', ')} @ ${fps} fps (${Date.now() - t0} ms)`)
    } else {
      this.openKey = ''
      this.failed = r.error ?? 'unknown error'
      this.log(`capture streams failed: ${this.failed}`)
    }
  }

  /** Waits until pending stream changes are applied. */
  async settled(): Promise<void> {
    await this.applying
  }

  /** Cropped / scaled RGBA pictures of one screen from its running stream. */
  async grab(display: Display | number, regions: CaptureRegion[]): Promise<CaptureFrame[] | null> {
    await this.settled()
    const id = typeof display === 'number' ? display : display.id
    if (!this.active) return null
    const r = await this.send({ type: 'grab', displayId: id, regions })
    if (!r.ok || !r.frames) {
      this.log(`grab failed on display ${id}: ${r.error ?? '?'}`)
      return null
    }
    return r.frames
  }

  destroy(): void {
    this.win?.destroy()
    this.win = null
  }
}
