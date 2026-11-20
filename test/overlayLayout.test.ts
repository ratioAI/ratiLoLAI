import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { createWorker, PSM, type Worker } from 'tesseract.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cardRects,
  cardsVisible,
  detectLayout,
  layoutFits,
  matchAugment,
  prepareTitle,
  titleRects,
  type Bitmap
} from '../src/main/scanner/detect'
import { cardGeometry } from '../src/shared/cardLayout'
import { boundsDiffer, FRAME_PAD, frameWindowBounds, uiScale } from '../src/shared/overlayGeometry'
import { matchSourcesToDisplays, sourceForDisplay } from '../src/main/capture/sources'
import { parseClientGameSettings, parseGameCfg } from '../src/main/lcu/gameSettings'
import { overlayNotice } from '../src/shared/overlayNotice'

// ---------------------------------------------------------------------------
// Synthetic screens: the real 1080p screenshot scaled, letterboxed or pillarboxed the way other
// resolutions and aspect ratios can show it.
// ---------------------------------------------------------------------------

const load = (file: string): Bitmap => {
  const png = PNG.sync.read(readFileSync(join(__dirname, 'fixtures', file)))
  return { width: png.width, height: png.height, data: png.data, order: 'rgba' }
}
const shot = load('mayhem-augment-select-1080p.png')
const gold = load('mayhem-gold-cards-1080p.png')
// a choice of four cards (November 2026), prismatic and gold, everything around the cards blacked out
const four = load('mayhem-four-cards-1080p.png')
const fourGold = load('mayhem-four-gold-cards-1080p.png')

/** Bilinear resize. */
function resize(src: Bitmap, width: number, height: number): Bitmap {
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1.001, ((y + 0.5) * src.height) / height - 0.5)
    const y0 = Math.max(0, Math.floor(sy))
    const fy = Math.max(0, sy - y0)
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1.001, ((x + 0.5) * src.width) / width - 0.5)
      const x0 = Math.max(0, Math.floor(sx))
      const fx = Math.max(0, sx - x0)
      for (let c = 0; c < 4; c++) {
        const at = (xx: number, yy: number) => src.data[(yy * src.width + xx) * 4 + c]
        const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
        const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
        out[(y * width + x) * 4 + c] = Math.round(top * (1 - fy) + bottom * fy)
      }
    }
  }
  return { width, height, data: out, order: 'rgba' }
}

/** Puts `src` at (dx, dy) on a width×height canvas filled with a dark game-ish grey. */
function place(src: Bitmap, width: number, height: number, dx: number, dy: number, fill = 30): Bitmap {
  const out = Buffer.alloc(width * height * 4, fill)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = x - dx
      const sy = y - dy
      const o = (y * width + x) * 4
      out[o + 3] = 255
      if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue
      const i = (sy * src.width + sx) * 4
      out[o] = src.data[i]
      out[o + 1] = src.data[i + 1]
      out[o + 2] = src.data[i + 2]
    }
  }
  return { width, height, data: out, order: 'rgba' }
}

/** The 1080p screen as a 16:10 game would show it if it fits a 16:9 UI area inside the screen. */
const fit16x10 = place(shot, 1920, 1200, 0, 60)
/** …or if it scales the UI with the height and crops the sides. */
const height16x10 = (() => {
  const scaled = resize(shot, 2133, 1200)
  return place(scaled, 1920, 1200, -Math.round((2133 - 1920) / 2), 0)
})()
/** 21:9 ultrawide: the UI scales with the height, more of the world on the sides. */
const ultrawide = place(shot, 2520, 1080, 300, 0)
/** 4:3 with the 16:9 UI area fitted inside. */
const fourThree = place(resize(shot, 1440, 810), 1440, 1080, 0, 135)

describe('card layout fits', () => {
  it('only tries the height fit on 16:9 and wider screens', () => {
    expect(layoutFits(1920, 1080)).toEqual(['height'])
    expect(layoutFits(3440, 1440)).toEqual(['height'])
    expect(layoutFits(1366, 768)).toEqual(['height'])
    expect(layoutFits(1920, 1200)).toEqual(['height', 'fit16x9'])
    expect(layoutFits(1280, 1024)).toEqual(['height', 'fit16x9'])
  })

  it('keeps the measured 1080p positions for both fits on 16:9', () => {
    expect(cardRects(1920, 1080, 'fit16x9')).toEqual(cardRects(1920, 1080, 'height'))
    expect(titleRects(1920, 1080, 'fit16x9')).toEqual(titleRects(1920, 1080, 'height'))
  })

  it('fits the 16:9 area inside a 16:10 screen', () => {
    const rects = cardRects(1920, 1200, 'fit16x9')
    expect(rects.map((rect) => rect.x + rect.width / 2)).toEqual([598, 966, 1334])
    expect(rects[0]).toMatchObject({ y: 192 + 60, width: 320, height: 528 })
    expect(cardGeometry(1920, 1200, 'fit16x9').unit).toBe(1)
  })
})

describe('detectLayout on other screens', () => {
  it.each([
    ['1080p', shot, 'height'],
    ['1080p gold cards', gold, 'height'],
    ['720p', resize(shot, 1280, 720), 'height'],
    ['1440p', resize(shot, 2560, 1440), 'height'],
    ['4K', resize(shot, 3840, 2160), 'height'],
    ['1366×768 laptop', resize(shot, 1366, 768), 'height'],
    ['21:9 ultrawide', ultrawide, 'height'],
    ['16:10, UI fitted', fit16x10, 'fit16x9'],
    ['16:10, UI by height', height16x10, 'height'],
    ['4:3, UI fitted', fourThree, 'fit16x9'],
    ['preview of 16:10 (640 px)', resize(fit16x10, 640, 400), 'fit16x9']
  ] as const)('finds the cards on %s', (_name, bitmap, fit) => {
    expect(detectLayout(bitmap)).toEqual({ fit, count: 3 })
  })

  it.each([
    ['1080p', four, 'height'],
    ['1080p gold cards', fourGold, 'height'],
    ['a 640 px preview', resize(four, 640, 360), 'height'],
    ['a 640 px preview of gold cards', resize(fourGold, 640, 360), 'height'],
    ['1440p', resize(four, 2560, 1440), 'height'],
    ['21:9 ultrawide', place(four, 2520, 1080, 300, 0), 'height'],
    ['16:10, UI fitted', place(four, 1920, 1200, 0, 60), 'fit16x9']
  ] as const)('finds a row of four cards on %s', (_name, bitmap, fit) => {
    expect(detectLayout(bitmap)).toEqual({ fit, count: 4 })
  })

  it("doesn't take a row of four for three or the other way round", () => {
    for (const bitmap of [four, fourGold]) expect(cardsVisible(bitmap, 'height', 3)).toBe(false)
    for (const bitmap of [shot, gold]) expect(cardsVisible(bitmap, 'height', 4)).toBe(false)
  })

  it('tries the fit that matched last time first, and still finds the other one', () => {
    expect(detectLayout(fit16x10, 'fit16x9')?.fit).toBe('fit16x9')
    expect(detectLayout(height16x10, 'fit16x9')?.fit).toBe('height')
  })

  it('the old height-only check misses the cards on a fitted 16:10 screen', () => {
    // this is the "friend sees no overlay at all" case
    expect(cardsVisible(fit16x10, 'height')).toBe(false)
  })

  const preview = (name: string): Bitmap => load(join('preview', name))
  it.each(['neg-gameplay.png', 'neg-alttab.png', 'neg-window.png'])('finds nothing in %s, also as 16:10 and 4:3', (file) => {
    const negative = preview(file)
    expect(detectLayout(negative)).toBeNull()
    expect(detectLayout(place(negative, 640, 400, 0, 20))).toBeNull()
    expect(detectLayout(place(resize(negative, 480, 270), 480, 360, 0, 45))).toBeNull()
  })

  it('finds nothing on a black (exclusive fullscreen) capture', () => {
    const black: Bitmap = { width: 640, height: 400, data: Buffer.alloc(640 * 400 * 4), order: 'rgba' }
    expect(detectLayout(black)).toBeNull()
  })
})

describe('OCR on other screens', () => {
  let worker: Worker
  beforeAll(async () => {
    worker = await createWorker('eng', 1, {
      langPath: join(__dirname, '../node_modules/@tesseract.js-data/eng/4.0.0_best_int'),
      gzip: true,
      cacheMethod: 'none'
    })
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE })
  }, 60_000)
  afterAll(async () => {
    await worker?.terminate()
  })

  const candidates = [
    { id: 1011, names: ["Can't Touch This"] },
    { id: 2107, names: ['Hellbent'] },
    { id: 1349, names: ['Ultimate Awakening'] }
  ]

  it.each([
    ['1440p', resize(shot, 2560, 1440)],
    ['16:10, UI fitted', fit16x10],
    ['21:9 ultrawide', ultrawide]
  ] as const)(
    'reads the three titles on %s',
    async (_name, bitmap) => {
      const layout = detectLayout(bitmap)!
      const ids: (number | null)[] = []
      for (const rect of titleRects(bitmap.width, bitmap.height, layout.fit, layout.count)) {
        const title = prepareTitle(bitmap, rect)
        const png = new PNG({ width: title.width, height: title.height })
        title.data.copy(png.data)
        const { data } = await worker.recognize(PNG.sync.write(png))
        ids.push(matchAugment(data.text.trim(), candidates)?.id ?? null)
      }
      expect(ids).toEqual([1011, 2107, 1349])
    },
    30_000
  )

  const fourNames = [
    { id: 1, names: ['Overloaded'] },
    { id: 2, names: ['Dual Wield'] },
    { id: 3, names: ['Ultimate Revolution'] },
    { id: 4, names: ['Big Shot'] },
    { id: 5, names: ['One Hit Wonder'] },
    { id: 6, names: ['Endless Decimation'] },
    { id: 7, names: ['Vulnerability'] },
    { id: 8, names: ['Upgrade Stormsurge'] },
    ...candidates
  ]
  it.each([
    ['prismatic, 1080p', four, [1, 2, 3, 4]],
    ['gold, 1080p', fourGold, [5, 6, 7, 8]],
    ['prismatic, 1440p', resize(four, 2560, 1440), [1, 2, 3, 4]]
  ] as const)(
    'reads all four titles (%s)',
    async (_name, bitmap, expected) => {
      const layout = detectLayout(bitmap)!
      const ids: (number | null)[] = []
      for (const rect of titleRects(bitmap.width, bitmap.height, layout.fit, layout.count)) {
        const title = prepareTitle(bitmap, rect)
        const png = new PNG({ width: title.width, height: title.height })
        title.data.copy(png.data)
        const { data } = await worker.recognize(PNG.sync.write(png))
        ids.push(matchAugment(data.text.trim(), fourNames)?.id ?? null)
      }
      expect(ids).toEqual(expected)
    },
    30_000
  )
})

// ---------------------------------------------------------------------------
// Frames window placement
// ---------------------------------------------------------------------------

describe('frameWindowBounds', () => {
  const cards1080 = cardRects(1920, 1080)

  it('pads the cards and keeps them inside a 1080p display', () => {
    const placed = frameWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 }, cards1080)!
    expect(placed.scale).toBe(1)
    expect(placed.bounds).toEqual({
      x: cards1080[0].x - FRAME_PAD.side,
      y: cards1080[0].y - FRAME_PAD.top,
      width: cards1080[2].x + cards1080[2].width - cards1080[0].x + 2 * FRAME_PAD.side,
      height: cards1080[0].height + FRAME_PAD.top + FRAME_PAD.bottom
    })
    expect(placed.offset).toEqual({ x: placed.bounds.x, y: placed.bounds.y })
  })

  it('places the window on a second monitor right of the first one', () => {
    const placed = frameWindowBounds({ x: 1920, y: 0, width: 1920, height: 1080 }, cards1080)!
    expect(placed.bounds.x).toBe(1920 + cards1080[0].x - FRAME_PAD.side)
    expect(placed.offset.x).toBe(cards1080[0].x - FRAME_PAD.side)
  })

  it('places the window on a monitor left of / above the primary one (negative coordinates)', () => {
    const placed = frameWindowBounds({ x: -2560, y: -300, width: 2560, height: 1440 }, cardRects(2560, 1440))!
    expect(placed.bounds.x).toBeLessThan(0)
    expect(placed.bounds.x).toBeGreaterThan(-2560)
    expect(placed.bounds.y).toBeGreaterThanOrEqual(-300)
  })

  it('grows the padding with the cards (1440p at 100 %, 4K)', () => {
    const placed = frameWindowBounds({ x: 0, y: 0, width: 2560, height: 1440 }, cardRects(2560, 1440))!
    expect(placed.scale).toBeCloseTo(427 / 320, 2)
    // a 4K screen at 150 % scaling is 2560×1440 DIP, the same as above
    const fourK = frameWindowBounds({ x: 0, y: 0, width: 3840, height: 2160 }, cardRects(3840, 2160))!
    expect(fourK.scale).toBe(2)
  })

  it('clamps the padding at the display edge (720p: the crest area would stick out at the top)', () => {
    const placed = frameWindowBounds({ x: 0, y: 0, width: 1280, height: 720 }, cardRects(1280, 720))!
    expect(placed.bounds.y).toBeGreaterThanOrEqual(0)
    expect(placed.bounds.y + placed.bounds.height).toBeLessThanOrEqual(720)
  })

  it('refuses cards that are not on this display', () => {
    expect(frameWindowBounds({ x: 0, y: 0, width: 1280, height: 720 }, cardRects(2560, 1440))).toBeNull()
    expect(frameWindowBounds({ x: 0, y: 0, width: 1920, height: 1080 }, [])).toBeNull()
  })

  it('scales the UI with the card width, within limits', () => {
    expect(uiScale(320)).toBe(1)
    expect(uiScale(640)).toBe(2)
    expect(uiScale(10)).toBe(0.5)
    expect(uiScale(Number.NaN)).toBe(1)
  })

  it('treats one pixel of rounding as equal bounds', () => {
    expect(boundsDiffer({ x: 0, y: 0, width: 100, height: 100 }, { x: 1, y: 0, width: 101, height: 100 })).toBe(false)
    expect(boundsDiffer({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 125, height: 125 })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Screen source ↔ monitor pairing
// ---------------------------------------------------------------------------

describe('matchSourcesToDisplays', () => {
  const main = { id: 101, size: { width: 2560, height: 1440 }, scaleFactor: 1 }
  const side = { id: 202, size: { width: 1920, height: 1200 }, scaleFactor: 1.25 }

  it('pairs by display_id first', () => {
    const matched = matchSourcesToDisplays(
      [
        { id: 'screen:0:0', displayId: '202', width: 160, height: 100 },
        { id: 'screen:1:0', displayId: '101', width: 160, height: 90 }
      ],
      [main, side]
    )
    expect(matched.get('screen:0:0')).toEqual({ display: side, by: 'id' })
    expect(matched.get('screen:1:0')).toEqual({ display: main, by: 'id' })
    expect(sourceForDisplay(matched, 101)?.sourceId).toBe('screen:1:0')
  })

  it('without display_id it pairs by aspect ratio, not by order', () => {
    // capturer order is the reverse of the display order here
    const matched = matchSourcesToDisplays(
      [
        { id: 'screen:0:0', displayId: '', width: 160, height: 100 },
        { id: 'screen:1:0', displayId: '', width: 160, height: 90 }
      ],
      [main, side]
    )
    expect(matched.get('screen:0:0')).toEqual({ display: side, by: 'aspect' })
    expect(matched.get('screen:1:0')).toEqual({ display: main, by: 'aspect' })
  })

  it('pairs the last one left for certain and only guesses the order when nothing else is left', () => {
    const third = { id: 303, size: { width: 1920, height: 1080 }, scaleFactor: 1 }
    const matched = matchSourcesToDisplays(
      [
        { id: 'a', displayId: '', width: 160, height: 90 },
        { id: 'b', displayId: '', width: 160, height: 90 },
        { id: 'c', displayId: '', width: 160, height: 100 }
      ],
      [main, side, third]
    )
    expect(matched.get('c')).toEqual({ display: side, by: 'aspect' })
    expect(matched.get('a')?.by).toBe('order')
    expect(matched.get('b')?.by).toBe('order')
    const single = matchSourcesToDisplays([{ id: 'x', displayId: '', width: 0, height: 0 }], [main])
    expect(single.get('x')).toEqual({ display: main, by: 'only' })
  })

  it('leaves sources unpaired rather than guessing with mismatched counts', () => {
    const matched = matchSourcesToDisplays(
      [
        { id: 'a', displayId: '', width: 0, height: 0 },
        { id: 'b', displayId: '', width: 0, height: 0 }
      ],
      [main, side, { id: 303, size: { width: 1920, height: 1080 }, scaleFactor: 1 }]
    )
    expect(matched.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// League's window mode and the notice
// ---------------------------------------------------------------------------

describe('game window settings', () => {
  it('parses game.cfg', () => {
    const cfg = '[General]\r\nCfgVersion=14.1\r\nWidth=1920\r\nHeight=1200\r\nWindowMode=0\r\n\r\n[Performance]\r\nWindowMode=2\r\n'
    expect(parseGameCfg(cfg)).toEqual({ mode: 'fullscreen', width: 1920, height: 1200, source: 'game.cfg' })
    expect(parseGameCfg('[General]\nWindowMode=2')?.mode).toBe('borderless')
    expect(parseGameCfg('[General]\nWindowMode=1\nWidth=1600\nHeight=900')).toMatchObject({ mode: 'windowed', width: 1600 })
    expect(parseGameCfg('')).toBeNull()
  })

  it("parses the client's game settings", () => {
    expect(parseClientGameSettings({ General: { WindowMode: 2, Width: 2560, Height: 1440 } })).toEqual({
      mode: 'borderless',
      width: 2560,
      height: 1440,
      source: 'client'
    })
    expect(parseClientGameSettings({ General: { WindowMode: '0' } })?.mode).toBe('fullscreen')
    expect(parseClientGameSettings(null)).toBeNull()
    expect(parseClientGameSettings({ HUD: {} })).toBeNull()
  })

  it('explains what blocks the overlay', () => {
    expect(overlayNotice({ windowMode: 'borderless', blackCapture: false })).toBeNull()
    expect(overlayNotice({ windowMode: null, blackCapture: false })).toBeNull()
    expect(overlayNotice({ windowMode: 'fullscreen', blackCapture: true })?.kind).toBe('fullscreen')
    expect(overlayNotice({ windowMode: 'borderless', blackCapture: true })?.kind).toBe('blackCapture')
    expect(overlayNotice({ windowMode: 'windowed', blackCapture: false })?.detail).toMatch(/Borderless/)
  })
})
