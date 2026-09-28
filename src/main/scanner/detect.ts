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
 * Cheap pre-check before OCR: each card has a bright frame on its left edge and a dark body.
 * Returns true when at least two of the three cards look like an augment card.
 */
export function cardsVisible(b: Bitmap): boolean {
  const H = b.height
  let cards = 0
  for (const cx of cardCentres(b.width, H)) {
    const x0 = Math.max(0, Math.round(cx + LAYOUT.frameFrom * H))
    const x1 = Math.min(b.width - 1, Math.round(cx + LAYOUT.frameTo * H))
    if (x1 <= x0) continue
    let rows = 0
    let bright = 0
    for (let y = Math.round(0.25 * H); y < 0.62 * H; y += Math.max(2, Math.round(H / 270))) {
      rows++
      for (let x = x0; x <= x1; x += 2) {
        if (brightness(b, x, y) > 165) {
          bright++
          break
        }
      }
    }
    // the card body next to the frame must be dark
    let dark = 0
    let samples = 0
    const ey = LAYOUT.emptyY * H
    for (let dx = -0.08 * H; dx <= 0.08 * H; dx += 0.02 * H) {
      samples++
      if (brightness(b, cx + dx, ey) < 90) dark++
    }
    if (rows && bright / rows > 0.8 && dark / samples > 0.6) cards++
  }
  return cards >= 2
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
 * Coarse fingerprint of the three title areas (mean brightness per cell). Used on the small
 * preview capture to notice a reroll without running OCR every time.
 */
export function titleSignature(b: Bitmap, cols = 16, rows = 3): number[] {
  const sig: number[] = []
  for (const r of titleRects(b.width, b.height)) {
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let sum = 0
        let n = 0
        const x0 = r.x + (cx * r.width) / cols
        const y0 = r.y + (cy * r.height) / rows
        for (let y = y0; y < y0 + r.height / rows; y += 1) {
          for (let x = x0; x < x0 + r.width / cols; x += 1) {
            if (x < 0 || y < 0 || x >= b.width || y >= b.height) continue
            sum += brightness(b, x, y)
            n++
          }
        }
        sig.push(n ? sum / n : 0)
      }
    }
  }
  return sig
}

export function signatureChanged(a: number[] | null, b: number[], tolerance = 18): boolean {
  if (!a || a.length !== b.length) return true
  let diff = 0
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
  return diff / a.length > tolerance
}

// ---------------------------------------------------------------------------
// When to look at the screen at all
// ---------------------------------------------------------------------------

/** Levels at which ARAM: Mayhem grants an augment. */
export const AUGMENT_LEVELS = [1, 7, 11, 15]

/**
 * Decides whether an augment choice can be open right now. A choice becomes pending when the
 * player reaches an augment level and is resolved once its cards disappear from the screen.
 * The selection only opens while dead or in the fountain, so scanning is slow while alive.
 */
export class AugmentSchedule {
  private picked = 0
  private level = 0
  private dead = false
  private seen = false
  private misses = 0

  update(level: number, dead: boolean): void {
    this.level = level
    this.dead = dead
  }

  get earned(): number {
    return AUGMENT_LEVELS.filter((l) => this.level >= l).length
  }

  get pending(): boolean {
    return this.level > 0 && this.earned > this.picked
  }

  /** Scan interval in ms, or null when there is nothing to look for. */
  get interval(): number | null {
    if (!this.pending) return null
    return this.dead || this.seen ? 900 : 2500
  }

  /** Feed the scan result: cards disappearing after being visible means the augment was picked. */
  observe(cardsOnScreen: boolean): 'picked' | null {
    if (cardsOnScreen) {
      this.seen = true
      this.misses = 0
      return null
    }
    // two misses in a row, so a single bad frame (animation, hover effect) doesn't count as a pick
    if (this.seen && ++this.misses >= 2) {
      this.seen = false
      this.misses = 0
      this.picked = Math.min(this.earned, this.picked + 1)
      return 'picked'
    }
    return null
  }

  reset(): void {
    this.picked = 0
    this.level = 0
    this.dead = false
    this.seen = false
    this.misses = 0
  }
}
