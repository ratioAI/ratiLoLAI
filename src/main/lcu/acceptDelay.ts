import type { AcceptDelay } from '@shared/types'

/**
 * Random accept delay in ms. Triangular distribution (two uniform draws averaged), so most values
 * sit in the middle of the range like a person reacting, never exactly the same twice. Always
 * leaves at least 2.5 s of the ~12 s ready check.
 */
export function acceptDelayMs(mode: AcceptDelay, elapsed = 0, rand: () => number = Math.random): number {
  if (mode === 'instant') return 0
  const [min, max] = mode === 'slow' ? [4000, 8000] : [2000, 6000]
  const ms = min + ((rand() + rand()) / 2) * (max - min)
  return Math.round(Math.max(0, Math.min(ms, 9500 - elapsed * 1000)))
}
