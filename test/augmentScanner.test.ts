import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureService } from '../src/main/capture/captureService'
import { AugmentScanner, type ScanState } from '../src/main/scanner/scanner'
import type { Bitmap } from '../src/main/scanner/detect'

const ocr = vi.hoisted(() => ({ reads: 0 }))

// one 640×360 screen at 100 %, the cursor far away from the cards
vi.mock('electron', () => {
  const display = { id: 1, bounds: { x: 0, y: 0, width: 640, height: 360 }, size: { width: 640, height: 360 }, scaleFactor: 1 }
  return {
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
    nativeImage: { createFromBitmap: () => ({ toPNG: () => Buffer.alloc(0) }) },
    desktopCapturer: { getSources: async () => [] }
  }
})

vi.mock('../src/main/scanner/ocr', () => ({
  TitleOcr: class {
    async read(): Promise<string> {
      ocr.reads++
      return 'Stats!'
    }
    async warmup(): Promise<number> {
      return 0
    }
    async dispose(): Promise<void> {}
  }
}))

const preview = (name: string): Bitmap => {
  const p = PNG.sync.read(readFileSync(join(__dirname, 'fixtures/preview', name)))
  return { width: p.width, height: p.height, data: p.data, order: 'rgba' }
}
const silver = preview('pos-silver.png')
const gameplay = preview('neg-gameplay.png')

describe('AugmentScanner frames', () => {
  let screenNow: Bitmap
  let states: ScanState[]
  let scanner: AugmentScanner
  const look = (): Promise<void> => (scanner as unknown as { tick(): Promise<void> }).tick()
  const shown = (): boolean => states.at(-1)?.visible ?? false

  beforeEach(() => {
    // the scanner schedules its own looks, here every look is triggered by hand
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ocr.reads = 0
    states = []
    screenNow = silver
    const capture = {
      failed: null,
      demand: () => undefined,
      grab: async () => [{ width: screenNow.width, height: screenNow.height, data: screenNow.data }]
    } as unknown as CaptureService
    scanner = new AugmentScanner('', () => [{ id: 1404, names: ['Stats!'] }], (state) => states.push(state), () => undefined, capture)
    scanner.start()
    // dead at level 11 in the middle of the game: the choice can be open
    scanner.update({ level: 11, dead: true, gameTime: 600, itemsKey: '' })
  })

  afterEach(() => {
    scanner.stop()
    vi.useRealTimers()
  })

  it('shows the frames over silver cards', async () => {
    await look()
    expect(shown()).toBe(true)
    expect(states.at(-1)?.offer?.cards.map((card) => card.augmentId)).toEqual([1404, 1404, 1404])
  })

  it('keeps the frames through a single look without cards', async () => {
    await look()
    const reads = ocr.reads
    screenNow = gameplay // tooltip, hover glow or an animation for one look
    await look()
    expect(shown()).toBe(true)
    screenNow = silver
    await look()
    expect(shown()).toBe(true)
    // the same cards again: nothing to read, the frames never went away
    expect(ocr.reads).toBe(reads)
  })

  it('hides the frames after two looks without cards', async () => {
    await look()
    screenNow = gameplay
    await look()
    expect(shown()).toBe(true)
    await look()
    expect(shown()).toBe(false)
  })
})
