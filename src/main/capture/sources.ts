/**
 * Pairs desktopCapturer screen sources with Electron displays.
 *
 * `source.display_id` is the reliable link, but some Windows setups leave it empty. The old fallback
 * (n-th source = n-th display) is a guess: desktopCapturer lists screens in DXGI output order while
 * `screen.getAllDisplays()` uses the monitor enumeration order, and the two differ on many multi-monitor
 * PCs. A wrong pair means we watch the wrong screen and draw the frames on the wrong monitor, so the
 * order is only used when nothing better is left, and only for what the earlier steps couldn't pair.
 */

export interface SourceInfo {
  id: string
  /** desktopCapturer's display_id, '' when Windows didn't report it */
  displayId: string
  /** thumbnail size, 0 when no thumbnail was requested */
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  size: { width: number; height: number }
  scaleFactor: number
}

export type PairedBy = 'id' | 'aspect' | 'order' | 'only'

export interface SourcePair<D> {
  display: D
  /** how the pair was made, logged so a wrong guess can be spotted in overlay.log */
  by: PairedBy
}

/** Source id → its display. Sources that can't be paired are left out. */
export function matchSourcesToDisplays<D extends DisplayInfo>(sources: SourceInfo[], displays: D[]): Map<string, SourcePair<D>> {
  const result = new Map<string, SourcePair<D>>()
  const freeDisplays = new Set(displays)
  const pair = (source: SourceInfo, display: D, by: PairedBy): void => {
    result.set(source.id, { display, by })
    freeDisplays.delete(display)
  }

  // 1. display_id
  for (const source of sources) {
    const display = source.displayId ? displays.find((candidate) => String(candidate.id) === source.displayId) : undefined
    if (display && freeDisplays.has(display)) pair(source, display, 'id')
  }

  // 2. aspect ratio of the thumbnail, only when it points at exactly one free display
  const aspect = (width: number, height: number): number => width / Math.max(1, height)
  for (const source of sources) {
    if (result.has(source.id) || !source.width || !source.height) continue
    const sourceAspect = aspect(source.width, source.height)
    const candidates = [...freeDisplays].filter(
      (display) => Math.abs(aspect(display.size.width, display.size.height) - sourceAspect) / sourceAspect < 0.02
    )
    const others = sources.filter(
      (other) =>
        other !== source &&
        !result.has(other.id) &&
        other.width > 0 &&
        Math.abs(aspect(other.width, other.height) - sourceAspect) / sourceAspect < 0.02
    )
    if (candidates.length === 1 && others.length === 0) pair(source, candidates[0], 'aspect')
  }

  // 3. what's left: a single pair is certain, several are paired in enumeration order
  const leftSources = sources.filter((source) => !result.has(source.id))
  const leftDisplays = displays.filter((display) => freeDisplays.has(display))
  if (leftSources.length === 1 && leftDisplays.length === 1) pair(leftSources[0], leftDisplays[0], 'only')
  else if (leftSources.length === leftDisplays.length) leftSources.forEach((source, i) => pair(source, leftDisplays[i], 'order'))
  return result
}

/** Inverse lookup: the source paired with one display. */
export function sourceForDisplay<D extends DisplayInfo>(
  matched: Map<string, SourcePair<D>>,
  displayId: number
): { sourceId: string; by: PairedBy } | null {
  for (const [sourceId, { display, by }] of matched) if (display.id === displayId) return { sourceId, by }
  return null
}
