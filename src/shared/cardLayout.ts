/**
 * Screen layout of the ARAM: Mayhem augment selection. The three cards are centred horizontally
 * and scale with the screen height (measured on 1920×1080: card centres 598 / 966 / 1334 px,
 * width 320 px, top 192 px, bottom 720 px, title around y = 444 px).
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const LAYOUT = {
  spacing: 368 / 1080,
  centreOffset: 6 / 1080,
  cardWidth: 320 / 1080,
  cardTop: 192 / 1080,
  cardBottom: 720 / 1080,
  titleY: 444 / 1080,
  titleWidth: 292 / 1080,
  titleHeight: 44 / 1080,
  /** left frame band, relative to the card centre */
  frameFrom: -160 / 1080,
  frameTo: -143 / 1080,
  /** empty area inside the card, used to check that the card body is dark */
  emptyY: 620 / 1080
}

export function cardCentres(width: number, height: number): number[] {
  const mid = width / 2 + LAYOUT.centreOffset * height
  return [-1, 0, 1].map((k) => mid + k * LAYOUT.spacing * height)
}

export function cardRects(width: number, height: number): Rect[] {
  return cardCentres(width, height).map((cx) => ({
    x: Math.round(cx - (LAYOUT.cardWidth * height) / 2),
    y: Math.round(LAYOUT.cardTop * height),
    width: Math.round(LAYOUT.cardWidth * height),
    height: Math.round((LAYOUT.cardBottom - LAYOUT.cardTop) * height)
  }))
}

export function titleRects(width: number, height: number): Rect[] {
  const w = Math.round(LAYOUT.titleWidth * height)
  const h = Math.round(LAYOUT.titleHeight * height)
  return cardCentres(width, height).map((cx) => ({
    x: Math.round(cx - w / 2),
    y: Math.round(LAYOUT.titleY * height - h / 2),
    width: w,
    height: h
  }))
}
