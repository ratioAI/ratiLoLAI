import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { comparePatch, Crawler } from '../src/main/crawler/crawler'
import { StatsStore } from '../src/main/crawler/statsStore'
import { RiotClient } from '../src/main/riot/client'
import { buildTierList } from '../src/shared/analysis'
import { classify, match, standardTimeline } from './fixtures'

/** Fake Riot API: 2 challengers, each with 3 matches (one of them on an old patch). */
function fakeRiot(): (url: string) => Promise<Response> {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
  return async (url: string) => {
    const path = new URL(url).pathname
    if (path.includes('challengerleagues')) return json({ tier: 'CHALLENGER', entries: [{ puuid: 'a' }, { puuid: 'b' }] })
    if (path.includes('leagues/by-queue')) return json({ tier: 'X', entries: [] })
    if (path.endsWith('/ids')) return json(path.includes('/a/') ? ['EUW1_1', 'EUW1_2', 'EUW1_OLD'] : ['EUW1_2', 'EUW1_3'])
    if (path.endsWith('/timeline')) return json(standardTimeline())
    const id = path.split('/').pop()!
    if (id === 'EUW1_OLD') return json(match({ gameVersion: '15.18.1.1' }, id))
    return json(match({}, id))
  }
}

describe('Crawler', () => {
  it('crawls, de-duplicates, skips old patches and persists the stats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-'))
    const store = new StatsStore(dir)
    const client = new RiotClient(() => 'k', fakeRiot())
    const updates: string[] = []
    const crawler = new Crawler(client, store, () => undefined, (p) => updates.push(p))

    await crawler.start({ patch: '15.19', platforms: ['euw1'], seedTiers: ['CHALLENGER', 'MASTER'], maxMatches: 100, matchesPerPlayer: 10, classify })

    const status = crawler.getStatus()
    expect(status.phase).toBe('done')
    expect(status.matchesThisRun).toBe(3) // EUW1_1, EUW1_2, EUW1_3 – EUW1_2 only once
    expect(status.skippedOldPatch).toBe(1)
    expect(updates).toContain('15.19')

    // a fresh store instance reads the persisted data from disk
    const reloaded = await new StatsStore(dir).load('15.19')
    expect(reloaded.stats.matches).toBe(3)
    expect(reloaded.processed.has('EUW1_OLD')).toBe(true)
    expect(buildTierList(reloaded.stats, 1).length).toBe(10)

    // second run finds nothing new
    await crawler.start({ patch: '15.19', platforms: ['euw1'], seedTiers: ['CHALLENGER'], maxMatches: 100, matchesPerPlayer: 10, classify })
    expect(crawler.getStatus().matchesThisRun).toBe(0)
  })

  it('keeps matches whose fetch failed (expired key) for the next run and clears the old key error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-key-'))
    const store = new StatsStore(dir)
    const ok = fakeRiot()
    let keyValid = true
    const fetch = async (url: string) => {
      // the key expires right after the match list was loaded
      if (new URL(url).pathname.includes('/matches/EUW1_')) keyValid = false
      return keyValid ? ok(url) : new Response(JSON.stringify({ status: { message: 'Forbidden' } }), { status: 403 })
    }
    const crawler = new Crawler(new RiotClient(() => 'k', fetch), store, () => undefined, () => undefined)
    const opts = { patch: '15.19', platforms: ['euw1'] as const, seedTiers: ['CHALLENGER'] as const, maxMatches: 100, matchesPerPlayer: 10, classify }
    await crawler.start({ ...opts, platforms: [...opts.platforms], seedTiers: [...opts.seedTiers] })
    expect(crawler.getStatus().phase).toBe('error')
    expect((await new StatsStore(dir).load('15.19')).processed.has('EUW1_1')).toBe(false)

    crawler.clearKeyError()
    expect(crawler.getStatus()).toMatchObject({ phase: 'idle', lastError: null })

    // with a working key the same matches are crawled
    const again = new Crawler(new RiotClient(() => 'k', ok), new StatsStore(dir), () => undefined, () => undefined)
    await again.start({ ...opts, platforms: [...opts.platforms], seedTiers: [...opts.seedTiers] })
    expect(again.getStatus().matchesThisRun).toBe(3)
  })

  it('compares patches numerically', () => {
    expect(comparePatch('15.9', '15.10')).toBeLessThan(0)
    expect(comparePatch('16.1', '15.24')).toBeGreaterThan(0)
  })
})

describe('Crawler (ARAM)', () => {
  it('only keeps ARAM games and snowballs through their participants', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-aram-'))
    const store = new StatsStore(dir)
    const seen: string[] = []
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    const fetch = async (url: string) => {
      const u = new URL(url)
      if (u.pathname.includes('challengerleagues')) return json({ entries: [{ puuid: 'seed' }] })
      if (u.pathname.endsWith('/ids')) {
        seen.push(u.pathname.split('/')[6])
        expect(u.searchParams.get('queue')).toBe('450')
        return json(u.pathname.includes('/seed/') ? ['EUW1_A1', 'EUW1_R1'] : [])
      }
      if (u.pathname.endsWith('/timeline')) return json(standardTimeline())
      const id = u.pathname.split('/').pop()!
      return json(match({ queueId: id.startsWith('EUW1_A') ? 450 : 420 }, id))
    }
    const crawler = new Crawler(new RiotClient(() => 'k', fetch), store, () => undefined, () => undefined)
    await crawler.start({ patch: '15.19', mode: 'aram', platforms: ['euw1'], seedTiers: ['CHALLENGER'], maxMatches: 10, matchesPerPlayer: 5, classify })
    expect(crawler.getStatus()).toMatchObject({ mode: 'aram', matchesThisRun: 1 })
    expect(seen).toContain('puuid-3') // participant of the ARAM game was added to the pool
    expect((await store.load('15.19', 'aram')).stats.champions['100:ARAM'].g).toBe(1)
    expect((await store.patches('ranked')).length).toBe(0)
  })
})
