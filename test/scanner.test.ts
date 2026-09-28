import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PNG } from 'pngjs'
import { createWorker, PSM } from 'tesseract.js'
import { describe, expect, it } from 'vitest'
import { cardRects, cardsVisible, matchAugment, normName, prepareTitle, similarity, titleRects, type Bitmap } from '../src/main/scanner/detect'

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
