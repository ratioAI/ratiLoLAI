/**
 * Pure helpers for recognising the ARAM: Mayhem augment selection on a screenshot.
 *
 * The three cards are centred horizontally and scale with the screen height (measured on
 * 1920×1080: card centres 598 / 966 / 1334 px, width 320 px, top 192 px, bottom 720 px,
 * title baseline around y = 444 px). All geometry is expressed as a fraction of the height.
 */

import { cardCentres, LAYOUT, titleRects, type Rect } from '@shared/cardLayout'
export { cardCentres, cardRects, titleRects, LAYOUT, type Rect } from '@shared/cardLayout'

/** Minimal view on a BGRA/RGBA bitmap. */
export interface Bitmap {
  width: number
  height: number
  data: Uint8Array | Buffer
  /** Electron's NativeImage.toBitmap() is BGRA, pngjs is RGBA */
  order: 'rgba' | 'bgra'
}

function brightness(b: Bitmap, x: number, y: number): number {
  const i = (Math.round(y) * b.width + Math.round(x)) * 4
  return Math.max(b.data[i], b.data[i + 1], b.data[i + 2])
}

/**
 * Cheap pre-check before OCR: each card has a light frame on both sides with the dark card body
 * right inside it. Works for silver, gold and prismatic cards (gold frames are much darker than
 * prismatic ones, so an absolute brightness threshold is not enough – the frame→body contrast is
 * what identifies a card). Returns true when at least two of the three cards are found.
 */
export function cardsVisible(b: Bitmap): boolean {
  return cardMetrics(b).filter((m) => m.edges >= 0.7 && m.dark >= 0.6).length >= 2
}

/** Mean brightness over a horizontal run of pixels. */
function runMean(b: Bitmap, x0: number, x1: number, y: number): number {
  let sum = 0
  let n = 0
  for (let x = Math.max(0, Math.round(x0)); x <= Math.min(b.width - 1, Math.round(x1)); x++) {
    sum += brightness(b, x, y)
    n++
  }
  return n ? sum / n : 0
}

function runMax(b: Bitmap, x0: number, x1: number, y: number): number {
  let m = 0
  for (let x = Math.max(0, Math.round(x0)); x <= Math.min(b.width - 1, Math.round(x1)); x++) m = Math.max(m, brightness(b, x, y))
  return m
}

/**
 * Per card: `edges` = share of rows where both side frames are light (≥ 105) and at least 55
 * brighter than the body just inside them; `dark` = share of dark samples in the card body.
 */
export function cardMetrics(b: Bitmap): { edges: number; dark: number }[] {
  const H = b.height
  const u = H / 1080 // layout unit: 1 px at 1080p
  const out: { edges: number; dark: number }[] = []
  for (const cx of cardCentres(b.width, H)) {
    let rows = 0
    let hits = 0
    for (let y = Math.round(0.25 * H); y < 0.62 * H; y += Math.max(1, Math.round(H / 180))) {
      rows++
      let ok = true
      for (const side of [-1, 1]) {
        const band = side < 0 ? [cx - 162 * u, cx - 140 * u] : [cx + 140 * u, cx + 162 * u]
        const inner = side < 0 ? [cx - 126 * u, cx - 112 * u] : [cx + 112 * u, cx + 126 * u]
        const frame = runMax(b, band[0], band[1], y)
        const body = runMean(b, inner[0], inner[1], y)
        if (frame < 105 || frame - body < 55) ok = false
      }
      if (ok) hits++
    }
    // the card body must be dark
    let dark = 0
    let samples = 0
    const ey = LAYOUT.emptyY * H
    for (let dx = -0.08 * H; dx <= 0.08 * H; dx += 0.02 * H) {
      samples++
      if (brightness(b, cx + dx, ey) < 90) dark++
    }
    out.push({ edges: rows ? hits / rows : 0, dark: samples ? dark / samples : 0 })
  }
  return out
}

/** Mean brightness 0–255 (sparse sample) – ~0 means the capture is black. */
export function meanBrightness(b: Bitmap): number {
  let sum = 0
  let n = 0
  for (let y = 0; y < b.height; y += 8) {
    for (let x = 0; x < b.width; x += 8) {
      sum += brightness(b, x, y)
      n++
    }
  }
  return n ? sum / n : 0
}

/**
 * Crops a region, scales it up and inverts it to dark text on a light background
 * (Tesseract reads that best). Returns an RGBA buffer.
 */
export function prepareTitle(b: Bitmap, r: Rect, scale = 2): { width: number; height: number; data: Buffer } {
  const width = r.width * scale
  const height = r.height * scale
  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(b.width - 1, r.x + Math.floor(x / scale))
      const sy = Math.min(b.height - 1, r.y + Math.floor(y / scale))
      const v = 255 - brightness(b, sx, sy)
      const o = (y * width + x) * 4
      out[o] = out[o + 1] = out[o + 2] = v
      out[o + 3] = 255
    }
  }
  return { width, height, data: out }
}

// ---------------------------------------------------------------------------
// Fuzzy matching of OCR text to augment names
// ---------------------------------------------------------------------------

export const normName = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

export interface NameCandidate {
  id: number
  names: string[]
}

/** Best matching augment for an OCR line (strips frame artefacts like "|" first). */
export function matchAugment(text: string, candidates: NameCandidate[], min = 0.72): { id: number; score: number } | null {
  const t = normName(text.replace(/^[^A-Za-zÀ-ÿ]+/, ''))
  if (t.length < 3) return null
  let best: { id: number; score: number } | null = null
  for (const c of candidates) {
    for (const n of c.names) {
      const s = similarity(t, normName(n))
      if (!best || s > best.score) best = { id: c.id, score: s }
    }
  }
  return best && best.score >= min ? best : null
}

/**
 * Coarse fingerprint of each card (icon + title area, mean brightness per cell). Used on the small
 * preview capture to notice a reroll without running OCR every time. One entry per card.
 */
export function titleSignature(b: Bitmap): number[][] {
  const H = b.height
  const cells = (x0: number, y0: number, w: number, h: number, cols: number, rows: number, out: number[]): void => {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let sum = 0
        let n = 0
        const xs = x0 + (cx * w) / cols
        const ys = y0 + (cy * h) / rows
        for (let y = ys; y < ys + h / rows; y += 1) {
          for (let x = xs; x < xs + w / cols; x += 1) {
            if (x < 0 || y < 0 || x >= b.width || y >= b.height) continue
            sum += brightness(b, x, y)
            n++
          }
        }
        out.push(n ? sum / n : 0)
      }
    }
  }
  return titleRects(b.width, H).map((r, i) => {
    const out: number[] = []
    cells(r.x, r.y, r.width, r.height, 12, 2, out)
    // the augment icon above the title (changes completely on a reroll)
    const cx = cardCentres(b.width, H)[i]
    cells(cx - 0.075 * H, 0.215 * H, 0.15 * H, 0.14 * H, 5, 5, out)
    return out
  })
}

/** True when any card's fingerprint differs noticeably (a reroll changes one card). */
export function signatureChanged(a: number[][] | null, b: number[][], tolerance = 10): boolean {
  if (!a || a.length !== b.length) return true
  return a.some((card, i) => {
    const other = b[i]
    if (!other || other.length !== card.length) return true
    let diff = 0
    for (let k = 0; k < card.length; k++) diff += Math.abs(card[k] - other[k])
    return diff / card.length > tolerance
  })
}

// ---------------------------------------------------------------------------
// When to look at the screen at all
// ---------------------------------------------------------------------------

/** Levels at which ARAM: Mayhem grants an augment. */
export const AUGMENT_LEVELS = [1, 7, 11, 15]

/** What the scheduler needs to know about the local player (from the Live Client Data API). */
export interface PlayerTick {
  level: number
  dead: boolean
  /** in-game clock in seconds */
  gameTime: number
  /** changes whenever the inventory changes – in ARAM you can only shop while dead or in the fountain */
  itemsKey: string
}

/** Length of the "probably in the fountain" windows, in ms. */
export const WINDOWS = { respawn: 12_000, shopping: 15_000, manual: 20_000, gameStart: 100 }

/**
 * Decides when the screen is worth looking at. The augment choice only opens while dead or in the
 * fountain, so outside of those moments **no picture is taken at all**:
 *  - while dead,
 *  - in the first 100 s of the game (spawn, level-1 augment),
 *  - 20 s after respawning (standing in the fountain),
 *  - 15 s after an inventory change (shopping is only possible in the fountain),
 *  - 20 s after pressing the overlay hotkey,
 *  - while the cards are on screen.
 *
 * Inside those windows it always looks – it does not try to count picks, because the selection
 * can be closed and reopened (leaving the fountain, the toggle button) and a miscounted pick used
 * to switch recognition off for the rest of the game. `pending` (an augment level reached whose
 * cards haven't been seen yet) only makes it look more often and shows the "augment ready" pill.
 */
export class AugmentSchedule {
  private level = 0
  private dead = false
  private gameTime = 0
  private itemsKey: string | null = null
  private windowUntil = 0
  private seen = false
  private misses = 0
  /** number of augment levels whose cards have been on screen */
  private handled = 0

  update(t: PlayerTick, now = Date.now()): void {
    if (this.dead && !t.dead) this.openWindow(WINDOWS.respawn, now)
    if (this.itemsKey !== null && t.itemsKey !== this.itemsKey) this.openWindow(WINDOWS.shopping, now)
    this.itemsKey = t.itemsKey
    this.level = t.level
    this.dead = t.dead
    this.gameTime = t.gameTime
  }

  openWindow(ms: number, now = Date.now()): void {
    this.windowUntil = Math.max(this.windowUntil, now + ms)
  }

  get earned(): number {
    return AUGMENT_LEVELS.filter((l) => this.level >= l).length
  }

  /** An augment level was reached whose cards haven't been seen yet. */
  get pending(): boolean {
    return this.level > 0 && this.earned > this.handled
  }

  /** True while the choice can actually be open (dead, fountain, cards on screen). */
  canOpen(now = Date.now()): boolean {
    return this.level > 0 && (this.dead || this.seen || this.gameTime < WINDOWS.gameStart || now < this.windowUntil)
  }

  /** Scan interval in ms, or null when the choice can't be open right now. */
  interval(now = Date.now()): number | null {
    if (!this.canOpen(now)) return null
    if (this.seen) return 350 // cards open: notice a reroll / close quickly (cheap preview only)
    return this.pending ? 1000 : 2000
  }

  get cardsSeen(): boolean {
    return this.seen
  }

  /** Feed the scan result. Returns 'gone' when visible cards disappeared (picked or closed). */
  observe(cardsOnScreen: boolean): 'gone' | null {
    if (cardsOnScreen) {
      this.seen = true
      this.misses = 0
      this.handled = this.earned
      return null
    }
    // two misses in a row, so a single bad frame (animation, hover effect) doesn't count
    if (this.seen && ++this.misses >= 2) {
      this.seen = false
      this.misses = 0
      return 'gone'
    }
    return null
  }

  reset(): void {
    this.level = 0
    this.dead = false
    this.gameTime = 0
    this.itemsKey = null
    this.windowUntil = 0
    this.seen = false
    this.misses = 0
    this.handled = 0
  }
}
