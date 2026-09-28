/**
 * Pure helpers for recognising the ARAM: Mayhem augment selection on a screenshot.
 *
 * The three cards are centred horizontally and scale with the screen height (measured on
 * 1920×1080: card centres 598 / 966 / 1334 px, width 320 px, top 192 px, bottom 720 px,
 * title baseline around y = 444 px). All geometry is expressed as a fraction of the height.
 */

import { cardCentres, LAYOUT, type Rect } from '@shared/cardLayout'
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
