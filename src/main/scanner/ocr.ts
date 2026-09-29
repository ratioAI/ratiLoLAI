import { dirname, join } from 'node:path'
import { createWorker, PSM, type Worker } from 'tesseract.js'

/** Files that must not live inside app.asar (worker threads and WASM can't be read from it). */
const unpacked = (p: string): string => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

function tesseractPaths(): { langPath: string; workerPath: string; corePath: string } {
  const lang = dirname(require.resolve('@tesseract.js-data/eng/package.json'))
  const tess = dirname(require.resolve('tesseract.js/package.json'))
  const core = dirname(require.resolve('tesseract.js-core/package.json'))
  return {
    langPath: unpacked(join(lang, '4.0.0_best_int')),
    workerPath: unpacked(join(tess, 'src', 'worker-script', 'node', 'index.js')),
    corePath: unpacked(core)
  }
}

/** Single-line OCR with a bundled English model – works offline, ~50–150 ms per augment title. */
export class TitleOcr {
  private worker: Promise<Worker> | null = null

  constructor(private readonly cacheDir: string) {}

  private get(): Promise<Worker> {
    this.worker ??= (async () => {
      const debug = process.env.RC_OCR_DEBUG ? { logger: (m: unknown) => console.log('[ocr]', JSON.stringify(m)) } : {}
      let failed: (e: unknown) => void = () => undefined
      const failure = new Promise<never>((_, reject) => (failed = reject))
      const timeout = setTimeout(() => failed(new Error('OCR engine did not start')), 20_000)
      const w = await Promise.race([
        createWorker('eng', 1, {
          ...tesseractPaths(),
          gzip: true,
          cachePath: this.cacheDir,
          errorHandler: (e: unknown) => failed(e),
          ...debug
        }),
        failure
      ]).finally(() => clearTimeout(timeout))
      await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
      return w
    })().catch((e) => {
      this.worker = null
      throw e
    })
    return this.worker
  }

  /** Starts the engine now; resolves with the start-up time (0 when it was already running). */
  async warmup(): Promise<number> {
    if (this.worker) return (await this.worker, 0)
    const t0 = Date.now()
    await this.get()
    return Date.now() - t0
  }

  /** `image` is an encoded PNG. */
  async read(image: Buffer): Promise<string> {
    const w = await this.get()
    const { data } = await w.recognize(image)
    return data.text.trim()
  }

  async dispose(): Promise<void> {
    const w = this.worker
    this.worker = null
    if (w) await (await w).terminate().catch(() => undefined)
  }
}
