/**
 * Pure geometry of the card-frames window, kept apart from Electron so it can be tested for every
 * screen size and scaling.
 */

import { LAYOUT } from './cardLayout'

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** Space around the cards (crest above them, glow around them) at the 1080p reference size, in DIP. */
export const FRAME_PAD = { top: 100, side: 60, bottom: 52 }

/**
 * Size of the overlay UI relative to the 1080p reference (1 = cards 320 DIP wide). The crest, label
 * and note grow and shrink with the cards, so they look the same on 720p, 1440p, 4K and at any
 * Windows scaling. Clamped so text stays readable and nothing explodes on odd input.
 */
export function uiScale(cardWidthDip: number): number {
  if (!Number.isFinite(cardWidthDip) || cardWidthDip <= 0) return 1
  return Math.min(2.5, Math.max(0.5, cardWidthDip / LAYOUT.cardWidth))
}

/**
 * Window bounds (absolute DIP) for frames around `cards` (DIP, relative to the display), clamped to
 * the display, plus the offset to turn display-relative rects into window-relative ones. Returns
 * null when the cards are not on the display at all (wrong screen, stale data).
 */
export function frameWindowBounds(display: Box, cards: Box[]): { bounds: Box; offset: { x: number; y: number }; scale: number } | null {
  if (!cards.length) return null
  const scale = uiScale(cards.reduce((sum, card) => sum + card.width, 0) / cards.length)
  const left = Math.min(...cards.map((card) => card.x))
  const top = Math.min(...cards.map((card) => card.y))
  const right = Math.max(...cards.map((card) => card.x + card.width))
  const bottom = Math.max(...cards.map((card) => card.y + card.height))
  // the cards have to be (mostly) on this display, otherwise they belong to another screen
  const visibleWidth = Math.min(right, display.width) - Math.max(left, 0)
  const visibleHeight = Math.min(bottom, display.height) - Math.max(top, 0)
  if (visibleWidth < (right - left) * 0.8 || visibleHeight < (bottom - top) * 0.8) return null

  const x0 = Math.max(0, Math.floor(left - FRAME_PAD.side * scale))
  const y0 = Math.max(0, Math.floor(top - FRAME_PAD.top * scale))
  const x1 = Math.min(display.width, Math.ceil(right + FRAME_PAD.side * scale))
  const y1 = Math.min(display.height, Math.ceil(bottom + FRAME_PAD.bottom * scale))
  return {
    bounds: { x: Math.round(display.x + x0), y: Math.round(display.y + y0), width: x1 - x0, height: y1 - y0 },
    offset: { x: x0, y: y0 },
    scale
  }
}

/** Bounds differ by more than a pixel (Windows rounds DIP bounds at fractional scalings). */
export function boundsDiffer(a: Box, b: Box, tolerance = 1): boolean {
  return (
    Math.abs(a.x - b.x) > tolerance ||
    Math.abs(a.y - b.y) > tolerance ||
    Math.abs(a.width - b.width) > tolerance ||
    Math.abs(a.height - b.height) > tolerance
  )
}
