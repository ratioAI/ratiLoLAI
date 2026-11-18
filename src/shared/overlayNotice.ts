/**
 * Why the in-game overlay can't work right now, in words the player can act on. Shown as a banner
 * in the app and in Settings > Diagnostics. Pure so it can be tested.
 */

export type WindowMode = 'fullscreen' | 'windowed' | 'borderless'

export interface OverlayNotice {
  kind: 'fullscreen' | 'windowed' | 'blackCapture'
  title: string
  detail: string
}

const HOW_TO = 'In game: Esc → Video → Window Mode → Borderless.'

export function overlayNotice(input: {
  windowMode: WindowMode | null
  /** the screen capture keeps coming back black while an augment is waiting */
  blackCapture: boolean
}): OverlayNotice | null {
  if (input.windowMode === 'fullscreen')
    return {
      kind: 'fullscreen',
      title: 'Overlay blocked by Fullscreen',
      detail: `League runs in exclusive fullscreen, nothing can be drawn over it. ${HOW_TO}`
    }
  if (input.blackCapture)
    return {
      kind: 'blackCapture',
      title: 'Overlay can’t see the game',
      detail: `The screen capture of the game is black, which usually means exclusive fullscreen. ${HOW_TO}`
    }
  if (input.windowMode === 'windowed')
    return {
      kind: 'windowed',
      title: 'Overlay needs Borderless',
      detail: `League runs in a window, so the augment cards are not where the overlay expects them. ${HOW_TO}`
    }
  return null
}
