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

  log(msg: string): void {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}`
    this.lines.push(line)
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200)
    const file = this.file
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const size = await stat(file)
          .then((s) => s.size)
          .catch(() => 0)
        if (size > 1_000_000) await rename(file, file + '.old').catch(() => undefined)
        await appendFile(file, `${new Date().toISOString()} ${msg}\n`)
      })
      .catch(() => undefined)
  }

  recent(n = 40): string[] {
    return this.lines.slice(-n)
  }
}
