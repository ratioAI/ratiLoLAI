export interface RateWindow {
  limit: number
  windowMs: number
}

/** Default limits of a Riot *development* key: 20 requests / 1 s and 100 requests / 2 min. */
export const DEV_KEY_LIMITS: RateWindow[] = [
  { limit: 20, windowMs: 1_000 },
  { limit: 100, windowMs: 120_000 }
]

/** Parses Riot's `X-App-Rate-Limit` header, e.g. "20:1,100:120" (count:seconds pairs). */
export function parseRateLimitHeader(header: string | null | undefined): RateWindow[] | null {
  if (!header) return null
  const windows = header
    .split(',')
    .map((part) => part.trim().split(':').map(Number))
    .filter(([limit, seconds]) => Number.isFinite(limit) && Number.isFinite(seconds) && limit > 0 && seconds > 0)
    .map(([limit, seconds]) => ({ limit, windowMs: seconds * 1000 }))
  return windows.length ? windows : null
}

type Clock = { now(): number; sleep(ms: number): Promise<void> }
const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Sliding-window rate limiter that respects several windows at once (e.g. 20/s and 100/2 min).
 * `acquire` calls are served in FIFO order.
 */
export class RateLimiter {
  private windows: RateWindow[]
  private history: number[] = []
  private pausedUntil = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(
    windows: RateWindow[] = DEV_KEY_LIMITS,
    private readonly clock: Clock = realClock,
    /** headroom per window so clock skew with Riot's servers doesn't cause 429s */
    private readonly safety = 1
  ) {
    this.windows = windows
  }

  setWindows(windows: RateWindow[]): void {
    const same =
      windows.length === this.windows.length &&
      windows.every((rateWindow, i) => rateWindow.limit === this.windows[i].limit && rateWindow.windowMs === this.windows[i].windowMs)
    if (!same) this.windows = windows
  }

  getWindows(): RateWindow[] {
    return this.windows
  }

  /** Pause all requests, e.g. after a 429 with Retry-After. */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms)
  }

  /** Milliseconds to wait before the next request may be sent (0 = now). */
  waitTime(now = this.clock.now()): number {
    let wait = Math.max(0, this.pausedUntil - now)
    for (const rateWindow of this.windows) {
      const limit = Math.max(1, rateWindow.limit - this.safety)
      const inWindow = this.history.filter((t) => t > now - rateWindow.windowMs)
      if (inWindow.length >= limit) {
        // we can send again once this request drops out of the window
        const oldestRelevant = inWindow[inWindow.length - limit]
        wait = Math.max(wait, oldestRelevant + rateWindow.windowMs - now + 1)
      }
    }
    return wait
  }

  acquire(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const wait = this.waitTime()
        if (wait <= 0) break
        await this.clock.sleep(wait)
      }
      const now = this.clock.now()
      this.history.push(now)
      // only timestamps inside the longest window matter
      const longest = Math.max(...this.windows.map((rateWindow) => rateWindow.windowMs))
      this.history = this.history.filter((t) => t > now - longest)
    })
    // keep the chain alive even if one caller's wait fails
    this.chain = next.catch(() => undefined)
    return next
  }
}
