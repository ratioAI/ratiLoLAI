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

  it('compares patches numerically', () => {
    expect(comparePatch('15.9', '15.10')).toBeLessThan(0)
    expect(comparePatch('16.1', '15.24')).toBeGreaterThan(0)
  })
})
