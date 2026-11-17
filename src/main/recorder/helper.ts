import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setPriority, constants } from 'node:os'

/** The game window as the helper found it (the picture without title bar and border, in pixels). */
export interface GameWindow {
  pid: number
  hwnd: number
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  /** index of the screen the window is on */
  monitor: number
  monitorX: number
  monitorY: number
  monitorWidth: number
  monitorHeight: number
}

type HelperEvent = { event: string; [key: string]: unknown }

/** Below-normal priority, so a helper process never competes with the game for CPU time. */
export function lowerPriority(pid: number | undefined): void {
  if (!pid) return
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // the process is already gone
  }
}

/**
 * Talks to ratio-audio.exe (native/audio): JSON lines in, JSON lines out. The helper records the
 * sound of the game process only (WASAPI process loopback) into a named pipe that FFmpeg reads,
 * and finds the game window. It is started when a recording begins and ends with it.
 */
export class AudioHelper {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private waiters: { match: (event: HelperEvent) => boolean; resolve: (event: HelperEvent | null) => void; timer: NodeJS.Timeout }[] = []

  constructor(
    private readonly exe: string,
    private readonly log: (message: string) => void
  ) {}

  get available(): boolean {
    return process.platform === 'win32' && existsSync(this.exe)
  }

  private ensure(): ChildProcessWithoutNullStreams | null {
    if (this.child) return this.child
    if (!this.available) return null
    const child = spawn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    lowerPriority(child.pid)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.onData(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => this.log(`audio helper: ${chunk.trim().slice(0, 300)}`))
    child.on('error', (error) => this.log(`audio helper failed to start: ${error.message}`))
    child.on('close', () => {
      if (this.child === child) this.child = null
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.resolve(null)
      }
    })
    // a write to a helper that just died must not take the app down
    child.stdin.on('error', () => undefined)
    this.child = child
    return child
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let event: HelperEvent
      try {
        event = JSON.parse(line) as HelperEvent
      } catch {
        continue
      }
      if (event.event === 'error') this.log(`audio helper: ${String(event.message)}`)
      const index = this.waiters.findIndex((waiter) => waiter.match(event))
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(event)
      }
    }
  }

  private send(command: Record<string, unknown>): boolean {
    const child = this.ensure()
    if (!child) return false
    child.stdin.write(JSON.stringify(command) + '\n')
    return true
  }

  private wait(match: (event: HelperEvent) => boolean, timeoutMs: number): Promise<HelperEvent | null> {
    return new Promise((resolve) => {
      const waiter = {
        match,
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((other) => other !== waiter)
          resolve(null)
        }, timeoutMs)
      }
      this.waiters.push(waiter)
    })
  }

  /** The League game window, null when there is none (or no helper). */
  async findWindow(): Promise<GameWindow | null> {
    const answer = this.wait((event) => event.event === 'window', 3000)
    if (!this.send({ cmd: 'find' })) return null
    const event = await answer
    if (!event || event.found !== true) return null
    const { pid, hwnd, x, y, width, height, minimized, monitor, monitorX, monitorY, monitorWidth, monitorHeight } = event as unknown as GameWindow
    if (!(Number(pid) > 0) || !(Number(width) > 0) || !(Number(height) > 0)) return null
    return { pid, hwnd, x, y, width, height, minimized: !!minimized, monitor, monitorX, monitorY, monitorWidth, monitorHeight }
  }

  /**
   * Starts recording the sound of process `pid` into a new named pipe. Resolves with the pipe's
   * name once it exists (FFmpeg opens it as its audio input), null when the helper cannot do it.
   */
  async start(options: { pid: number; game: boolean; mic: boolean; micVolume: number }): Promise<string | null> {
    const pipe = `\\\\.\\pipe\\ratio-audio-${process.pid}-${Date.now().toString(36)}`
    const answer = this.wait((event) => event.event === 'listening' || event.event === 'error', 4000)
    if (!this.send({ cmd: 'start', pipe, ...options })) return null
    const event = await answer
    return event?.event === 'listening' ? pipe : null
  }

  stop(): void {
    if (this.child) this.send({ cmd: 'stop' })
  }

  /** Ends the helper process. */
  quit(): void {
    const child = this.child
    if (!child) return
    this.child = null
    try {
      child.stdin.end(JSON.stringify({ cmd: 'quit' }) + '\n')
    } catch {
      // already gone
    }
    setTimeout(() => child.kill(), 1500).unref()
  }
}
