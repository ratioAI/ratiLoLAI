/**
 * Pure helpers for spotting the ARAM: Mayhem augment selection on a screenshot.
 *
 * The three cards are centred horizontally and scale with the screen height. Measured at
 * 1920x1080: card centres at 598 / 966 / 1334 px, width 320 px, top 192 px, bottom 720 px,
 * title baseline around y = 444 px. All geometry is stored as a fraction of the height.
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

function brightness(bitmap: Bitmap, x: number, y: number): number {
  const i = (Math.round(y) * bitmap.width + Math.round(x)) * 4
  return Math.max(bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2])
}

/**
 * Cheap check before running OCR. Returns true when at least two of the three cards show a light
 * side frame with the dark card body right next to it.
 */
export function cardsVisible(bitmap: Bitmap): boolean {
  // Frame-to-body contrast instead of a fixed brightness threshold, because gold frames are much
  // darker than prismatic ones. Works for silver, gold and prismatic cards.
  return cardMetrics(bitmap).filter((metrics) => metrics.edges >= 0.7 && metrics.dark >= 0.6).length >= 2
}

/** Mean brightness over a horizontal run of pixels. */
function runMean(bitmap: Bitmap, x0: number, x1: number, y: number): number {
  let sum = 0
  let count = 0
  for (let x = Math.max(0, Math.round(x0)); x <= Math.min(bitmap.width - 1, Math.round(x1)); x++) {
    sum += brightness(bitmap, x, y)
    count++
  }
  return count ? sum / count : 0
}

function runMax(bitmap: Bitmap, x0: number, x1: number, y: number): number {
  let max = 0
  for (let x = Math.max(0, Math.round(x0)); x <= Math.min(bitmap.width - 1, Math.round(x1)); x++)
    max = Math.max(max, brightness(bitmap, x, y))
  return max
}

/**
 * Per card: `edges` is the share of rows where both side frames are light (>= 105) and at least 55
 * brighter than the body just inside them, `dark` is the share of dark samples in the card body.
 */
export function cardMetrics(bitmap: Bitmap): { edges: number; dark: number }[] {
  const H = bitmap.height
  const unit = H / 1080 // 1 px at 1080p
  const metrics: { edges: number; dark: number }[] = []
  for (const centreX of cardCentres(bitmap.width, H)) {
    let rows = 0
    let hits = 0
    for (let y = Math.round(0.25 * H); y < 0.62 * H; y += Math.max(1, Math.round(H / 180))) {
      rows++
      let framed = true
      for (const side of [-1, 1]) {
        const band = side < 0 ? [centreX - 162 * unit, centreX - 140 * unit] : [centreX + 140 * unit, centreX + 162 * unit]
        const inner = side < 0 ? [centreX - 126 * unit, centreX - 112 * unit] : [centreX + 112 * unit, centreX + 126 * unit]
        const frame = runMax(bitmap, band[0], band[1], y)
        const body = runMean(bitmap, inner[0], inner[1], y)
        if (frame < 105 || frame - body < 55) framed = false
      }
      if (framed) hits++
    }
    // the card body has to be dark
    let dark = 0
    let samples = 0
    const bodyY = LAYOUT.emptyY * H
    for (let dx = -0.08 * H; dx <= 0.08 * H; dx += 0.02 * H) {
      samples++
      if (brightness(bitmap, centreX + dx, bodyY) < 90) dark++
    }
    metrics.push({ edges: rows ? hits / rows : 0, dark: samples ? dark / samples : 0 })
  }
  return metrics
}

/** Mean brightness 0-255 over a sparse sample. Close to 0 means the capture came back black. */
export function meanBrightness(bitmap: Bitmap): number {
  let sum = 0
  let count = 0
  for (let y = 0; y < bitmap.height; y += 8) {
    for (let x = 0; x < bitmap.width; x += 8) {
      sum += brightness(bitmap, x, y)
      count++
    }
  }
  return count ? sum / count : 0
}

/**
 * Crops a region, scales it up and inverts it to dark text on a light background, which is what
 * Tesseract reads best. Returns an RGBA buffer.
 */
export function prepareTitle(bitmap: Bitmap, rect: Rect, scale = 2): { width: number; height: number; data: Buffer } {
  const width = rect.width * scale
  const height = rect.height * scale
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(bitmap.width - 1, rect.x + Math.floor(x / scale))
      const srcY = Math.min(bitmap.height - 1, rect.y + Math.floor(y / scale))
      const value = 255 - brightness(bitmap, srcX, srcY)
      const offset = (y * width + x) * 4
      pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = value
      pixels[offset + 3] = 255
    }
  }
  return { width, height, data: pixels }
}

// ---------------------------------------------------------------------------
// Fuzzy matching of OCR text to augment names
// ---------------------------------------------------------------------------

export const normName = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')

/** Normalised Levenshtein similarity, 1 = identical. */
export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = above
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

export interface NameCandidate {
  id: number
  names: string[]
}

/** Best matching augment for an OCR line. Leading frame artefacts like "|" are stripped first. */
export function matchAugment(text: string, candidates: NameCandidate[], minScore = 0.72): { id: number; score: number } | null {
  const needle = normName(text.replace(/^[^A-Za-zÀ-ÿ]+/, ''))
  if (needle.length < 3) return null
  let best: { id: number; score: number } | null = null
  for (const candidate of candidates) {
    for (const name of candidate.names) {
      const score = similarity(needle, normName(name))
      if (!best || score > best.score) best = { id: candidate.id, score }
    }
  }
  return best && best.score >= minScore ? best : null
}

/**
 * Coarse fingerprint of each card (icon and title area, mean brightness per cell), one entry per
 * card. Runs on the small preview capture so we notice a reroll without OCR on every frame.
 */
export function titleSignature(bitmap: Bitmap): number[][] {
  const H = bitmap.height
  const sampleGrid = (x0: number, y0: number, w: number, h: number, cols: number, rows: number, out: number[]): void => {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let sum = 0
        let count = 0
        const cellX = x0 + (col * w) / cols
        const cellY = y0 + (row * h) / rows
        for (let y = cellY; y < cellY + h / rows; y += 1) {
          for (let x = cellX; x < cellX + w / cols; x += 1) {
            if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) continue
            sum += brightness(bitmap, x, y)
            count++
          }
        }
        out.push(count ? sum / count : 0)
      }
    }
  }
  return titleRects(bitmap.width, H).map((rect, i) => {
    const signature: number[] = []
    sampleGrid(rect.x, rect.y, rect.width, rect.height, 12, 2, signature)
    // augment icon above the title, it changes completely on a reroll
    const centreX = cardCentres(bitmap.width, H)[i]
    sampleGrid(centreX - 0.075 * H, 0.215 * H, 0.15 * H, 0.14 * H, 5, 5, signature)
    return signature
  })
}

/** True when any card's fingerprint differs noticeably (a reroll only changes one card). */
export function signatureChanged(previous: number[][] | null, current: number[][], tolerance = 10): boolean {
  if (!previous || previous.length !== current.length) return true
  return previous.some((card, i) => {
    const other = current[i]
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
  /** changes whenever the inventory changes. In ARAM you can only shop while dead or in the fountain */
  itemsKey: string
}

/** How long we assume the player is probably in the fountain, in ms (gameStart is in game seconds). */
export const WINDOWS = { respawn: 12_000, shopping: 15_000, manual: 20_000, gameStart: 100 }

/**
 * Decides when the screen is worth looking at. The augment choice only opens while dead or in the
 * fountain, so outside of those moments we don't take a screenshot at all.
 */
export class AugmentSchedule {
  // We look while dead, during the first 100 s (spawn and level-1 augment), for a while after
  // respawning, after an inventory change (shopping only works in the fountain), after the overlay
  // hotkey, and while the cards are on screen.
  //
  // Inside those windows we always look and don't try to count picks. The selection can be closed
  // and reopened (leaving the fountain, the toggle button), and a miscounted pick used to switch
  // recognition off for the rest of the game. `pending` (augment level reached, cards not seen yet)
  // only makes us look more often and shows the "augment ready" pill.
  private level = 0
  private dead = false
  private gameTime = 0
  private itemsKey: string | null = null
  private windowUntil = 0
  private seen = false
  private misses = 0
  /** number of augment levels whose cards have been on screen */
  private handled = 0

  update(tick: PlayerTick, now = Date.now()): void {
    if (this.dead && !tick.dead) this.openWindow(WINDOWS.respawn, now)
    if (this.itemsKey !== null && tick.itemsKey !== this.itemsKey) this.openWindow(WINDOWS.shopping, now)
    this.itemsKey = tick.itemsKey
    this.level = tick.level
    this.dead = tick.dead
    this.gameTime = tick.gameTime
  }

  openWindow(ms: number, now = Date.now()): void {
    this.windowUntil = Math.max(this.windowUntil, now + ms)
  }

  get earned(): number {
    return AUGMENT_LEVELS.filter((augmentLevel) => this.level >= augmentLevel).length
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
    if (this.seen) return 350 // cards are open, catch a reroll or close quickly (cheap preview only)
    return this.pending ? 1000 : 2000
  }

  get cardsSeen(): boolean {
    return this.seen
  }

  /** Feed in the scan result. Returns 'gone' once visible cards have disappeared (picked or closed). */
  observe(cardsOnScreen: boolean): 'gone' | null {
    if (cardsOnScreen) {
      this.seen = true
      this.misses = 0
      this.handled = this.earned
      return null
    }
    // need two misses in a row so a single bad frame (animation, hover effect) doesn't count
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
