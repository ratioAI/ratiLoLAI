import { describe, expect, it } from 'vitest'
import { parseRateLimitHeader, RateLimiter } from '../src/main/riot/rateLimiter'

function fakeClock() {
  let now = 0
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
    get time() {
      return now
    }
  }
}

describe('parseRateLimitHeader', () => {
  it('parses Riot rate limit headers', () => {
    expect(parseRateLimitHeader('20:1,100:120')).toEqual([
      { limit: 20, windowMs: 1000 },
      { limit: 100, windowMs: 120000 }
    ])
  })
  it('handles missing or garbage headers', () => {
    expect(parseRateLimitHeader(null)).toBeNull()
    expect(parseRateLimitHeader('abc')).toBeNull()
  })
})

describe('RateLimiter', () => {
  it('never exceeds any window', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter(
      [
        { limit: 5, windowMs: 1000 },
        { limit: 8, windowMs: 10_000 }
      ],
      clock,
      0
    )
    const times: number[] = []
    for (let i = 0; i < 20; i++) {
      await limiter.acquire()
      times.push(clock.time)
    }
    for (const t of times) {
      expect(times.filter((x) => x > t - 1000 && x <= t).length).toBeLessThanOrEqual(5)
      expect(times.filter((x) => x > t - 10_000 && x <= t).length).toBeLessThanOrEqual(8)
    }
    // 20 requests with 8 per 10s need at least two full long windows
    expect(clock.time).toBeGreaterThanOrEqual(20_000)
  })

  it('honours pause() (Retry-After)', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter([{ limit: 100, windowMs: 1000 }], clock, 0)
    limiter.pause(5000)
    await limiter.acquire()
    expect(clock.time).toBeGreaterThanOrEqual(5000)
  })
})
