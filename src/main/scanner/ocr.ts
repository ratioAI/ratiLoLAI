import { dirname, join } from 'node:path'
import { createWorker, PSM, type Worker } from 'tesseract.js'

// Worker threads and WASM can't be loaded from inside app.asar, so these files ship unpacked.
const unpacked = (path: string): string => path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')

function tesseractPaths(): { langPath: string; workerPath: string; corePath: string } {
  const langDir = dirname(require.resolve('@tesseract.js-data/eng/package.json'))
  const tesseractDir = dirname(require.resolve('tesseract.js/package.json'))
  const coreDir = dirname(require.resolve('tesseract.js-core/package.json'))
  return {
    langPath: unpacked(join(langDir, '4.0.0_best_int')),
    workerPath: unpacked(join(tesseractDir, 'src', 'worker-script', 'node', 'index.js')),
    corePath: unpacked(coreDir)
  }
}

/** Single-line OCR with a bundled English model. Works offline, about 50-150 ms per augment title. */
export class TitleOcr {
  private worker: Promise<Worker> | null = null

  constructor(private readonly cacheDir: string) {}

  private get(): Promise<Worker> {
    this.worker ??= (async () => {
      const debug = process.env.RC_OCR_DEBUG ? { logger: (message: unknown) => console.log('[ocr]', JSON.stringify(message)) } : {}
      // Give up after 20 s if the engine hasn't started. Worker errors reject the race as well.
      let failed: (err: unknown) => void = () => undefined
      const failure = new Promise<never>((_, reject) => (failed = reject))
      const timeout = setTimeout(() => failed(new Error('OCR engine did not start')), 20_000)
      const worker = await Promise.race([
        createWorker('eng', 1, {
          ...tesseractPaths(),
          gzip: true,
          cachePath: this.cacheDir,
          errorHandler: (err: unknown) => failed(err),
          ...debug
        }),
        failure
      ]).finally(() => clearTimeout(timeout))
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
      return worker
    })().catch((err) => {
      // forget the failed start so the next call tries again
      this.worker = null
      throw err
    })
    return this.worker
  }

  /** Starts the engine now; resolves with the start-up time (0 when it was already running). */
  async warmup(): Promise<number> {
    if (this.worker) return (await this.worker, 0)
    const startedAt = Date.now()
    await this.get()
    return Date.now() - startedAt
  }

  /** `image` is an encoded PNG. */
  async read(image: Buffer): Promise<string> {
    const worker = await this.get()
    const { data } = await worker.recognize(image)
    return data.text.trim()
  }

  async dispose(): Promise<void> {
    const pending = this.worker
    this.worker = null
    if (pending) await (await pending).terminate().catch(() => undefined)
  }
}
