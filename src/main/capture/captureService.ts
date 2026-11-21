import { join } from 'node:path'
import { BrowserWindow, desktopCapturer, ipcMain, screen, type Display } from 'electron'
import type { CaptureCommand, CaptureFrame, CaptureRegion, CaptureReply } from '@shared/capture'
import { matchSourcesToDisplays, sourceForDisplay } from './sources'

/** Who needs the screen, on which displays and how often. */
interface Demand {
  displays: number[]
  fps: number
}

/**
 * Owns the hidden capture page and its screen streams. Several features (augment scanner, minimap
 * timers) can request frames at the same time.
 */
export class CaptureService {
  // Streams run at the highest requested frame rate on all requested screens combined, and are
  // closed a few seconds after nobody needs them anymore.
  private captureWindow: BrowserWindow | null = null
  private ready: Promise<void> | null = null
  private lastRequestId = 0
  private readonly waiting = new Map<number, { resolve: (reply: CaptureReply) => void; timer: NodeJS.Timeout }>()
  private readonly demands = new Map<string, Demand>()
  private openKey = ''
  private closeTimer: NodeJS.Timeout | null = null
  private applying: Promise<void> = Promise.resolve()
  /** set when streams can't be opened on this machine, callers then fall back to getSources() */
  failed: string | null = null

  constructor(
    private readonly preload: string,
    private readonly rendererDir: string,
    private readonly log: (message: string) => void = () => undefined
  ) {
    ipcMain.on('capture:reply', (_event, id: number, reply: CaptureReply) => {
      const request = this.waiting.get(id)
      if (!request) return
      clearTimeout(request.timer)
      this.waiting.delete(id)
      request.resolve(reply)
    })
  }

  private page(): Promise<void> {
    if (this.captureWindow && !this.captureWindow.isDestroyed() && this.ready) return this.ready
    const win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      skipTaskbar: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: false, backgroundThrottling: false }
    })
    win.on('closed', () => {
      // (a window replaced after a crash must not clear its successor)
      if (this.captureWindow !== win) return
      this.captureWindow = null
      this.ready = null
      this.openKey = ''
    })
    // Its renderer died (GPU reset, out of memory): nothing answers any more, every grab would time
    // out until the app is restarted. Start a new page and open the streams again.
    win.webContents.on('render-process-gone', (_event, details) => {
      if (this.captureWindow !== win) return
      this.log(`capture: the capture page crashed (${details.reason}) – starting it again`)
      this.captureWindow = null
      this.ready = null
      win.destroy()
      this.reset()
    })
    this.captureWindow = win
    this.ready = (
      process.env.ELECTRON_RENDERER_URL
        ? win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/capture.html`)
        : win.loadFile(join(this.rendererDir, 'capture.html'))
    ).then(() => undefined)
    return this.ready
  }

  private async send(command: CaptureCommand, timeoutMs = 5000): Promise<CaptureReply> {
    await this.page()
    const id = ++this.lastRequestId
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        resolve({ ok: false, error: 'capture timed out' })
      }, timeoutMs)
      this.waiting.set(id, { resolve, timer })
      this.captureWindow!.webContents.send('capture:cmd', id, command)
    })
  }

  /** Declares what a feature needs, or withdraws it when passed null. */
  demand(owner: string, need: Demand | null): void {
    if (need && need.displays.length) this.demands.set(owner, need)
    else this.demands.delete(owner)
    this.applying = this.applying.then(() => this.apply()).catch(() => undefined)
  }

  get active(): boolean {
    return this.openKey !== ''
  }

  private async apply(): Promise<void> {
    const displays = [...new Set([...this.demands.values()].flatMap((need) => need.displays))].sort()
    const fps = Math.max(0, ...[...this.demands.values()].map((need) => need.fps))
    if (!displays.length) {
      // keep the streams open for a moment, the next request usually follows soon (death, respawn, shop)
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
    // small thumbnails are enough to tell screens apart by aspect ratio when display_id is missing
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 160, height: 160 } })
    const matched = matchSourcesToDisplays(
      sources.map((source) => ({ id: source.id, displayId: source.display_id, ...source.thumbnail.getSize() })),
      all
    )
    const streams = displays
      .map((id) => {
        const display = all.find((candidate) => candidate.id === id)
        const source = display ? sourceForDisplay(matched, id) : null
        if (!display || !source) {
          this.log(`capture: no screen source for display ${id}`)
          return null
        }
        if (source.by !== 'id') this.log(`capture: display ${id} paired with ${source.sourceId} by ${source.by} (no display_id)`)
        return {
          displayId: id,
          sourceId: source.sourceId,
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor),
          fps
        }
      })
      .filter((stream): stream is NonNullable<typeof stream> => !!stream)
    const startedAt = Date.now()
    const reply = await this.send({ type: 'open', streams }, 8000)
    if (reply.ok) {
      this.openKey = key
      this.failed = null
      this.log(`capture streams open: displays ${displays.join(', ')} @ ${fps} fps (${Date.now() - startedAt} ms)`)
    } else {
      this.openKey = ''
      this.failed = reply.error ?? 'unknown error'
      this.log(`capture streams failed: ${this.failed}`)
    }
  }

  /** Monitors changed (added, removed, rescaled): reopen the streams so they pair with the new setup. */
  reset(): void {
    this.openKey = ''
    this.applying = this.applying.then(() => this.apply()).catch(() => undefined)
  }

  /** Waits until pending stream changes are applied. */
  async settled(): Promise<void> {
    await this.applying
  }

  /** Cropped and scaled RGBA frames of one screen, taken from its running stream. */
  async grab(display: Display | number, regions: CaptureRegion[]): Promise<CaptureFrame[] | null> {
    await this.settled()
    const id = typeof display === 'number' ? display : display.id
    if (!this.active) return null
    const reply = await this.send({ type: 'grab', displayId: id, regions })
    if (!reply.ok || !reply.frames) {
      this.log(`grab failed on display ${id}: ${reply.error ?? '?'}`)
      // The page lost its streams although we opened them: it was reloaded (in dev on every change of
      // shared code) or its renderer restarted. Nothing else would ever open them again, so do it now.
      if (reply.error?.startsWith('no stream for display') && this.openKey) {
        this.log('capture: the capture page has no streams any more – opening them again')
        this.reset()
      }
      return null
    }
    return reply.frames
  }

  destroy(): void {
    this.captureWindow?.destroy()
    this.captureWindow = null
  }
}
