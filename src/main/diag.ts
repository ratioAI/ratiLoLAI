import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Small diagnostics log for the in-game overlay (userData/logs/overlay.log). Keeps the last lines in
 * memory for the settings page and appends everything to a file that rotates at 1 MB, so users can
 * send it when screen recognition doesn't work on their setup.
 */
export class DiagLog {
  private lines: string[] = []
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  log(message: string): void {
    // in-memory copy only needs the time of day
    const line = `${new Date().toISOString().slice(11, 23)} ${message}`
    this.lines.push(line)
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200)
    const file = this.file
    // writes are chained so lines stay in order and rotation can't race an append
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const size = await stat(file)
          .then((stats) => stats.size)
          .catch(() => 0)
        if (size > 1_000_000) await rename(file, file + '.old').catch(() => undefined)
        await appendFile(file, `${new Date().toISOString()} ${message}\n`)
      })
      .catch(() => undefined)
  }

  recent(count = 40): string[] {
    return this.lines.slice(-count)
  }
}
