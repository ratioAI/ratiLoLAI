/**
 * Pure helpers for spotting the ARAM: Mayhem augment selection on a screenshot.
 *
 * Geometry lives in @shared/cardLayout: positions are measured on a 1920x1080 reference screen and
 * mapped onto the real screen with a `CardGeometry`. Screens that are not 16:9 have more than one
 * candidate fit, `detectLayout` finds out which one the picture actually shows.
 */

import {
  CARD_COUNTS,
  cardCentres,
  cardGeometry,
  LAYOUT,
  layoutFits,
  layoutFitsOnScreen,
  screenY,
  titleRects,
  type CardCount,
  type CardLayout,
  type LayoutFit,
  type Rect
} from '@shared/cardLayout'
export {
  cardCentres,
  cardRects,
  titleRects,
  layoutFits,
  LAYOUT,
  type CardCount,
  type CardLayout,
  type LayoutFit,
  type Rect
} from '@shared/cardLayout'

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
 * Cheap check before running OCR. Returns true when at least two of the cards show a light side
 * frame with the dark card body right next to it.
 */
export function cardsVisible(bitmap: Bitmap, fit: LayoutFit = 'height', count: CardCount = 3): boolean {
  // Frame-to-body contrast instead of a fixed brightness threshold, because gold frames are much
  // darker than prismatic ones. Works for silver, gold and prismatic cards.
  return cardMetrics(bitmap, fit, count).filter((metrics) => metrics.edges >= 0.7 && metrics.dark >= 0.6).length >= 2
}

/**
 * Which fit and how many cards this picture shows, or null when no cards are visible. `preferred`
 * (the fit that matched on this screen last time) is tried first, three cards before four, so the
 * usual case costs one check. The rows of three and four don't line up (a frame of one falls on a
 * card body of the other), so one can't pass for the other.
 */
export function detectLayout(bitmap: Bitmap, preferred: LayoutFit | null = null): CardLayout | null {
  const fits = layoutFits(bitmap.width, bitmap.height)
  const ordered = preferred && fits.includes(preferred) ? [preferred, ...fits.filter((fit) => fit !== preferred)] : fits
  for (const fit of ordered)
    for (const count of CARD_COUNTS)
      if (layoutFitsOnScreen(bitmap.width, bitmap.height, fit, count) && cardsVisible(bitmap, fit, count)) return { fit, count }
  return null
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
 * A row counts as framed when the side frame is at least FRAME_MIN bright and FRAME_CONTRAST
 * brighter than the card body just inside it, on both sides. Silver frames are lit from the top
 * left: towards the bottom their right edge fades to about 65 over a body of 15, so stricter values
 * (105 / 55 until 1.3.2) only matched half of each silver card and the selection went unseen.
 */
const FRAME_MIN = 60
const FRAME_CONTRAST = 40

/**
 * Per card: `edges` is the share of rows where both side frames are light and clearly brighter
 * than the body just inside them (see FRAME_MIN), `dark` is the share of dark samples in the card
 * body. All distances are reference pixels (1080p) scaled by the geometry's unit.
 */
export function cardMetrics(bitmap: Bitmap, fit: LayoutFit = 'height', count: CardCount = 3): { edges: number; dark: number }[] {
  const geometry = cardGeometry(bitmap.width, bitmap.height, fit)
  const unit = geometry.unit
  const inside = (y: number): boolean => y >= 0 && y < bitmap.height
  const metrics: { edges: number; dark: number }[] = []
  const rowStep = Math.max(1, Math.round(6 * unit))
  for (const centreX of cardCentres(bitmap.width, bitmap.height, fit, count)) {
    let rows = 0
    let hits = 0
    for (let y = Math.round(screenY(geometry, 270)); y < screenY(geometry, 669.6); y += rowStep) {
      if (!inside(y)) continue
      rows++
      let framed = true
      for (const side of [-1, 1]) {
        const band = side < 0 ? [centreX - 162 * unit, centreX - 140 * unit] : [centreX + 140 * unit, centreX + 162 * unit]
        const inner = side < 0 ? [centreX - 126 * unit, centreX - 112 * unit] : [centreX + 112 * unit, centreX + 126 * unit]
        const frame = runMax(bitmap, band[0], band[1], y)
        const body = runMean(bitmap, inner[0], inner[1], y)
        if (frame < FRAME_MIN || frame - body < FRAME_CONTRAST) framed = false
      }
      if (framed) hits++
    }
    // the card body has to be dark
    let dark = 0
    let samples = 0
    const bodyY = screenY(geometry, LAYOUT.emptyY)
    for (let dx = -86.4; dx <= 86.4 + 1e-6; dx += 21.6) {
      const x = centreX + dx * unit
      if (x < 0 || x >= bitmap.width || !inside(bodyY)) continue
      samples++
      if (brightness(bitmap, x, bodyY) < 90) dark++
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
export function titleSignature(bitmap: Bitmap, fit: LayoutFit = 'height', count: CardCount = 3): number[][] {
  const H = bitmap.height
  const geometry = cardGeometry(bitmap.width, H, fit)
  const unit = geometry.unit
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
  const centres = cardCentres(bitmap.width, H, fit, count)
  return titleRects(bitmap.width, H, fit, count).map((rect, i) => {
    const signature: number[] = []
    sampleGrid(rect.x, rect.y, rect.width, rect.height, 12, 2, signature)
    // augment icon above the title, it changes completely on a reroll
    sampleGrid(centres[i] - 81 * unit, screenY(geometry, 232.2), 162 * unit, 151.2 * unit, 5, 5, signature)
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

/**
 * Levels at which ARAM: Mayhem grants an augment. 21 only exists with the Superfans Headliner (level
 * cap 21, an extra augment at 21); other Headliners add levels through AugmentSchedule.extraLevels.
 */
export const AUGMENT_LEVELS = [1, 7, 11, 15, 21]

/** What the scheduler needs to know about the local player (from the Live Client Data API). */
export interface PlayerTick {
  level: number
  dead: boolean
  /** in-game clock in seconds */
  gameTime: number
  /** changes whenever the inventory changes. In ARAM you can only shop while dead or in the fountain */
  itemsKey: string
}

/**
 * How long we assume the player is probably in the fountain, in ms. `intro` and `gameStart` are in
 * game seconds: since the November 2026 update a game opens with a sequence, and the first augment
 * choice only appears at about 0:10. `intro` leaves 2 s on top for the cards to fade in; `gameStart`
 * is the end of the opening window (the old 100 s plus the 10 s the sequence takes).
 */
export const WINDOWS = { respawn: 12_000, shopping: 15_000, manual: 20_000, intro: 12, gameStart: 110 }

/**
 * Decides when the screen is worth looking at. The augment choice only opens while dead or in the
 * fountain, so outside of those moments we don't take a screenshot at all.
 */
export class AugmentSchedule {
  // We look while dead, during the first 110 s (opening sequence, spawn and first augment), for a while after
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
  /** augment levels the game's Headliner adds (Pentakill: DOOM at 18), see mayhemContext */
  extraLevels: number[] = []

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
    return [...AUGMENT_LEVELS, ...this.extraLevels].filter((augmentLevel) => this.level >= augmentLevel).length
  }

  /** Normal augments the level allows, without the Headliner's own selections (extraLevels). */
  get earnedRegular(): number {
    return AUGMENT_LEVELS.filter((augmentLevel) => this.level >= augmentLevel).length
  }

  /** An augment level was reached whose cards haven't been seen yet. */
  get pending(): boolean {
    return this.level > 0 && this.earned > this.handled
  }

  /**
   * The opening sequence is still running, so the first choice isn't expected on screen yet. We
   * keep looking anyway (it costs a small preview and catches the cards whenever they do appear),
   * but not finding them now means nothing: no hint, no fallback to other screens, no snapshot.
   */
  get opening(): boolean {
    return !this.seen && this.handled === 0 && this.gameTime < WINDOWS.intro
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
    this.extraLevels = []
  }
}
