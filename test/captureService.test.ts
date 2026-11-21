import { describe, expect, it, vi } from 'vitest'
import type { CaptureCommand, CaptureReply } from '../src/shared/capture'

/** The hidden capture page, played by the test: which screens it has a stream for. */
const page = vi.hoisted(() => ({
  streams: new Set<number>(),
  opens: 0,
  /** hidden capture windows created so far */
  windows: 0,
  /** the renderer of the newest window dies */
  crash: null as (() => void) | null,
  reply: null as ((id: number, reply: CaptureReply) => void) | null
}))

vi.mock('electron', () => {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 640, height: 360 }, size: { width: 640, height: 360 }, scaleFactor: 1 }
  const answer = (command: CaptureCommand): CaptureReply => {
    switch (command.type) {
      case 'open':
        page.opens++
        for (const stream of command.streams) page.streams.add(stream.displayId)
        return { ok: true }
      case 'close':
        page.streams.clear()
        return { ok: true }
      case 'grab':
        return page.streams.has(command.displayId)
          ? { ok: true, frameWidth: 640, frameHeight: 360, frames: [{ width: 1, height: 1, data: new Uint8Array(4) }] }
          : { ok: false, error: `no stream for display ${command.displayId}` }
    }
  }
  class BrowserWindow {
    webContents = {
      send: (_channel: string, id: number, command: CaptureCommand) => queueMicrotask(() => page.reply?.(id, answer(command))),
      on: (event: string, listener: (event: unknown, details: { reason: string }) => void) => {
        if (event !== 'render-process-gone') return
        page.crash = () => {
          page.streams.clear()
          listener({}, { reason: 'crashed' })
        }
      }
    }
    constructor() {
      page.windows++
    }
    on(): void {}
    isDestroyed(): boolean {
      return false
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    destroy(): void {}
  }
  return {
    BrowserWindow,
    ipcMain: {
      on: (_channel: string, listener: (event: unknown, id: number, reply: CaptureReply) => void) => {
        page.reply = (id, reply) => listener({}, id, reply)
      }
    },
    desktopCapturer: {
      getSources: async () => [{ id: 'screen:1:0', display_id: '1', thumbnail: { getSize: () => ({ width: 160, height: 90 }) } }]
    },
    screen: { getAllDisplays: () => [display] }
  }
})

const { CaptureService } = await import('../src/main/capture/captureService')

describe('CaptureService', () => {
  const whole = [{ x: 0, y: 0, w: 1, h: 1 }]

  it('opens the streams again when the capture page lost them (reloaded or restarted)', async () => {
    // 2026-11-20: the dev server reloaded the page during a game, every grab after that failed until the game ended
    const logs: string[] = []
    const capture = new CaptureService('preload.js', 'renderer', (line) => logs.push(line))
    capture.demand('augments', { displays: [1], fps: 2 })
    expect(await capture.grab(1, whole)).toHaveLength(1)
    page.streams.clear() // the page reloads: its streams are gone, the service still has them as open
    expect(await capture.grab(1, whole)).toBeNull()
    expect(await capture.grab(1, whole)).toHaveLength(1)
    expect(page.opens).toBe(2)
    expect(logs).toContain('capture: the capture page has no streams any more – opening them again')
  })

  it('starts a new capture page and opens the streams again when its renderer crashed', async () => {
    const logs: string[] = []
    const capture = new CaptureService('preload.js', 'renderer', (line) => logs.push(line))
    capture.demand('augments', { displays: [1], fps: 2 })
    expect(await capture.grab(1, whole)).toHaveLength(1)
    const before = page.windows
    page.crash!()
    // without the restart every grab from here on timed out until the app was restarted
    expect(await capture.grab(1, whole)).toHaveLength(1)
    expect(page.windows).toBe(before + 1)
    expect(logs.join(' | ')).toContain('the capture page crashed (crashed)')
  })
})
