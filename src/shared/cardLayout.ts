/**
 * Screen layout of the ARAM: Mayhem augment choice.
 *
 * Everything is measured once on a 1920x1080 reference screen (card centres at 598 / 966 / 1334 px,
 * width 320 px, top 192 px, bottom 720 px, title around y = 444 px) and then mapped onto the real
 * screen with a `CardGeometry`: a scale (screen px per reference px) and the screen centre.
 *
 * How League scales its UI on screens that are not 16:9 is not something we want to assume, so
 * there are several candidate fits and the screen recognition checks which one matches the picture:
 *
 * - `height`: the UI scales with the screen height and stays centred. Exact for 16:9 and wider
 *   (21:9, 32:9), and what the game does in most cases.
 * - `fit16x9`: the UI is scaled so a 16:9 area fits inside the screen and is centred in it. Only
 *   differs from `height` on screens narrower than 16:9 (16:10 laptops, 4:3, 5:4).
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Reference screen all measurements below are taken on. */
export const REF = { width: 1920, height: 1080 }

export type LayoutFit = 'height' | 'fit16x9'

/** Positions on the 1920x1080 reference screen, in reference pixels. */
export const LAYOUT = {
  /** horizontal distance between card centres */
  spacing: 368,
  /** the middle card sits slightly right of the screen centre */
  centreOffset: 6,
  cardWidth: 320,
  cardTop: 192,
  cardBottom: 720,
  titleY: 444,
  titleWidth: 292,
  titleHeight: 44,
  /** empty spot inside the card, used to check that the card body is dark */
  emptyY: 620
}

/** Maps reference pixels onto one screen (or one captured frame of it). */
export interface CardGeometry {
  fit: LayoutFit
  /** screen pixels per reference pixel */
  unit: number
  /** screen position of the reference screen's centre */
  originX: number
  originY: number
}

const ASPECT_16_9 = REF.width / REF.height

/** Fits worth trying on a screen of this size, most likely first. */
export function layoutFits(width: number, height: number): LayoutFit[] {
  // on 16:9 and wider screens both fits are the same, so there is only one to try
  return width / Math.max(1, height) >= ASPECT_16_9 - 0.01 ? ['height'] : ['height', 'fit16x9']
}

export function cardGeometry(width: number, height: number, fit: LayoutFit = 'height'): CardGeometry {
  const unit = fit === 'fit16x9' ? Math.min(height / REF.height, width / REF.width) : height / REF.height
  return { fit, unit, originX: width / 2, originY: height / 2 }
}

/** Screen x of a reference x (0-1920). */
export const screenX = (geometry: CardGeometry, refX: number): number => geometry.originX + (refX - REF.width / 2) * geometry.unit
/** Screen y of a reference y (0-1080). */
export const screenY = (geometry: CardGeometry, refY: number): number => geometry.originY + (refY - REF.height / 2) * geometry.unit

export function cardCentres(width: number, height: number, fit: LayoutFit = 'height'): number[] {
  const geometry = cardGeometry(width, height, fit)
  const mid = REF.width / 2 + LAYOUT.centreOffset
  return [-1, 0, 1].map((k) => screenX(geometry, mid + k * LAYOUT.spacing))
}

export function cardRects(width: number, height: number, fit: LayoutFit = 'height'): Rect[] {
  const geometry = cardGeometry(width, height, fit)
  const cardWidth = LAYOUT.cardWidth * geometry.unit
  return cardCentres(width, height, fit).map((centreX) => ({
    x: Math.round(centreX - cardWidth / 2),
    y: Math.round(screenY(geometry, LAYOUT.cardTop)),
    width: Math.round(cardWidth),
    height: Math.round((LAYOUT.cardBottom - LAYOUT.cardTop) * geometry.unit)
  }))
}

export function titleRects(width: number, height: number, fit: LayoutFit = 'height'): Rect[] {
  const geometry = cardGeometry(width, height, fit)
  const w = Math.round(LAYOUT.titleWidth * geometry.unit)
  const h = Math.round(LAYOUT.titleHeight * geometry.unit)
  return cardCentres(width, height, fit).map((centreX) => ({
    x: Math.round(centreX - w / 2),
    y: Math.round(screenY(geometry, LAYOUT.titleY) - h / 2),
    width: w,
    height: h
  }))
}

/** True when all three cards (plus their side frames) lie inside a screen of this size. */
export function layoutFitsOnScreen(width: number, height: number, fit: LayoutFit): boolean {
  const rects = cardRects(width, height, fit)
  const margin = 20 * cardGeometry(width, height, fit).unit
  return rects.every(
    (rect) => rect.x - margin >= 0 && rect.y >= 0 && rect.x + rect.width + margin <= width && rect.y + rect.height <= height
  )
}
