import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PNG } from 'pngjs'
import { createWorker, PSM } from 'tesseract.js'
import { describe, expect, it } from 'vitest'
import {
  AugmentSchedule,
  cardRects,
  cardsVisible,
  matchAugment,
  normName,
  prepareTitle,
  signatureChanged,
  similarity,
  titleRects,
  titleSignature,
  type Bitmap,
  type PlayerTick,
  WINDOWS
} from '../src/main/scanner/detect'

// Real 1920×1080 screenshot of the Mayhem augment selection (Thresh, level 3)
const png = PNG.sync.read(readFileSync(join(__dirname, 'fixtures/mayhem-augment-select-1080p.png')))
const shot: Bitmap = { width: png.width, height: png.height, data: png.data, order: 'rgba' }

const candidates = [
  { id: 1011, names: ["Can't Touch This", 'Unantastbar'] },
  { id: 2107, names: ['Hellbent', 'Wild Entschlossen'] },
  { id: 1349, names: ['Ultimate Awakening', 'Ultimatives Erwachen'] },
  { id: 1088, names: ['Ultimate Revolution'] },
  { id: 1112, names: ['Ultimate Unstoppable'] }
]

describe('augment card layout', () => {
  it('matches the measured 1080p positions', () => {
    const cards = cardRects(1920, 1080)
    expect(cards.map((c) => c.x + c.width / 2)).toEqual([598, 966, 1334])
    expect(cards[0]).toMatchObject({ y: 192, width: 320, height: 528 })
  })
  it('scales with the screen height', () => {
    const cards = cardRects(2560, 1440)
    expect(Math.abs(cards[1].x + cards[1].width / 2 - 1288)).toBeLessThanOrEqual(1)
    expect(cards[1].width).toBeCloseTo(427, 0)
  })
})

describe('cardsVisible', () => {
  it('detects the augment selection', () => {
    expect(cardsVisible(shot)).toBe(true)
  })
  it('ignores a normal game frame', () => {
    const empty = Buffer.alloc(1920 * 1080 * 4, 40)
    expect(cardsVisible({ width: 1920, height: 1080, data: empty, order: 'rgba' })).toBe(false)
    const white = Buffer.alloc(1920 * 1080 * 4, 230)
    expect(cardsVisible({ width: 1920, height: 1080, data: white, order: 'rgba' })).toBe(false)
  })
})

describe('matchAugment', () => {
  it('tolerates OCR noise and frame artefacts', () => {
    expect(matchAugment("| Can't Touch This", candidates)?.id).toBe(1011)
    expect(matchAugment('Ultimate Awakemng', candidates)?.id).toBe(1349)
    expect(matchAugment('Hel1bent', candidates)?.id).toBe(2107)
    expect(matchAugment('Wild Entschlossen', candidates)?.id).toBe(2107)
  })
  it('rejects unrelated text', () => {
    expect(matchAugment('LEVEL UP! +3', candidates)).toBeNull()
    expect(matchAugment('|', candidates)).toBeNull()
  })
  it('normalises names', () => {
    expect(normName("Can't Touch This!")).toBe('canttouchthis')
    expect(similarity('abc', 'abc')).toBe(1)
  })
})

describe('OCR of the card titles (bundled Tesseract model)', () => {
  it('reads all three augments from the screenshot', async () => {
    const lang = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0_best_int')
    const worker = await createWorker('eng', 1, { langPath: lang, gzip: true, cacheMethod: 'none' })
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
    const ids: (number | null)[] = []
    for (const r of titleRects(1920, 1080)) {
      const t = prepareTitle(shot, r)
      const out = new PNG({ width: t.width, height: t.height })
      t.data.copy(out.data)
      const { data } = await worker.recognize(PNG.sync.write(out))
      ids.push(matchAugment(data.text, candidates)?.id ?? null)
    }
    await worker.terminate()
    expect(ids).toEqual([1011, 2107, 1349])
  }, 30_000)
})

/** nearest-neighbour downscale, like the small preview capture */
function downscale(b: Bitmap, width: number): Bitmap {
  const height = Math.round((width * b.height) / b.width)
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x * b.width) / width)
      const sy = Math.floor((y * b.height) / height)
      const src = (sy * b.width + sx) * 4
      ;(b.data as Buffer).copy(data, (y * width + x) * 4, src, src + 4)
    }
  return { width, height, data, order: b.order }
}

describe('cheap preview check', () => {
  const small = downscale(shot, 640)
  it('still detects the cards on a 640×360 preview', () => {
    expect(cardsVisible(small)).toBe(true)
  })
  it('title signature is stable for the same frame and changes after a reroll', () => {
    const sig = titleSignature(small)
    expect(signatureChanged(sig, titleSignature(small))).toBe(false)
    const rerolled = downscale(shot, 640)
    // wipe the middle title (as if the card was rerolled into another augment)
    const r = titleRects(640, 360)[1]
    for (let y = r.y; y < r.y + r.height; y++)
      for (let x = r.x; x < r.x + r.width; x++) (rerolled.data as Buffer).fill(0, (y * 640 + x) * 4, (y * 640 + x) * 4 + 3)
    expect(signatureChanged(sig, titleSignature(rerolled), 1)).toBe(true)
    expect(signatureChanged(null, sig)).toBe(true)
  })
})

describe('AugmentSchedule', () => {
  const tick = (level: number, dead: boolean, gameTime = 600, itemsKey = '1,2'): PlayerTick => ({ level, dead, gameTime, itemsKey })
  const T = 1_000_000

  it('never takes a screenshot while alive outside the fountain', () => {
    const s = new AugmentSchedule()
    expect(s.interval(T)).toBeNull() // no game yet
    s.update(tick(7, false), T)
    expect(s.pending).toBe(true)
    expect(s.interval(T)).toBeNull() // alive in lane → nothing
    s.update(tick(7, true), T)
    expect(s.interval(T)).toBe(1000) // dead with an augment waiting → look often
  })

  it('looks at game start, after respawn, after shopping and on the hotkey', () => {
    const s = new AugmentSchedule()
    s.update(tick(1, false, 20), T)
    expect(s.interval(T)).not.toBeNull() // standing on the spawn at the start
    s.update(tick(1, false, 150), T)
    expect(s.interval(T)).toBeNull()

    s.update(tick(7, true), T) // died
    s.update(tick(7, false), T + 5000) // respawned in the fountain
    expect(s.interval(T + 10_000)).not.toBeNull()
    expect(s.interval(T + 5000 + WINDOWS.respawn + 1)).toBeNull()

    const later = T + 100_000
    s.update(tick(7, false, 600, '1,2,3'), later) // bought an item → in the fountain
    expect(s.interval(later + 1000)).not.toBeNull()
    expect(s.interval(later + WINDOWS.shopping + 1)).toBeNull()

    s.openWindow(WINDOWS.manual, later + 60_000)
    expect(s.interval(later + 61_000)).not.toBeNull()
  })

  it('keeps looking after the selection was closed without a pick (regression)', () => {
    const s = new AugmentSchedule()
    s.update(tick(1, false, 10), T)
    s.observe(true) // level-1 cards seen
    expect(s.pending).toBe(false)
    s.observe(false)
    expect(s.observe(false)).toBe('gone') // closed (or picked) – can't tell
    s.observe(true) // reopened
    s.observe(false)
    s.observe(false)
    // level 7, dead: must be watched no matter how often cards came and went before
    s.update(tick(7, true), T)
    expect(s.pending).toBe(true)
    expect(s.interval(T)).toBe(1000)
    s.observe(true)
    expect(s.pending).toBe(false)
    s.observe(false)
    s.observe(false)
    // still dead, nothing pending: keep an eye on it, just less often
    expect(s.interval(T)).toBe(2000)
  })
})
