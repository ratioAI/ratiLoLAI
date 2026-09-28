import type { CrawlerStatus, GameMode, Platform, SeedTier } from '@shared/types'
import { GAME_MODES } from '@shared/types'
import type { ItemClassifier } from './aggregator'
import { aggregateMatch, patchOf } from './aggregator'
import type { RiotClient } from '../riot/client'
import { regionalOf } from '../riot/client'
import type { StatsStore } from './statsStore'

export interface CrawlOptions {
  patch: string
  mode?: GameMode
  platforms: Platform[]
  seedTiers: SeedTier[]
  maxMatches: number
  matchesPerPlayer: number
  classify: ItemClassifier
}

/** Upper bound for the snowball player pool (ARAM needs it, apex players rarely play ARAM). */
const MAX_PLAYERS = 50_000
const LOOKBACK_MS = 21 * 24 * 3600 * 1000
const WORKERS = 3
const FLUSH_EVERY = 10

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Compares "15.9" and "15.10" numerically. */
export function comparePatch(a: string, b: string): number {
  const [a1, a2] = a.split('.').map(Number)
  const [b1, b2] = b.split('.').map(Number)
  return a1 - b1 || a2 - b2
}

/**
 * Crawls high-elo ranked games through the official Riot API and feeds them into the
 * aggregated statistics. Uses a small worker pool; throughput is bounded by the rate limiter.
 */
export class Crawler {
  private abort: AbortController | null = null
  private status: CrawlerStatus = Crawler.idleStatus()

  constructor(
    private readonly client: RiotClient,
    private readonly store: StatsStore,
    private readonly onStatus: (s: CrawlerStatus) => void,
    private readonly onStatsUpdated: (patch: string, mode: GameMode) => void
  ) {}

  static idleStatus(mode: GameMode = 'ranked'): CrawlerStatus {
    return {
      running: false,
      mode,
      phase: 'idle',
      message: 'Bereit',
      patch: null,
      players: 0,
      playersDone: 0,
      matchesThisRun: 0,
      matchesTotal: 0,
      skippedOldPatch: 0,
      requests: 0,
      startedAt: null,
      lastError: null
    }
  }

  getStatus(): CrawlerStatus {
    return { ...this.status, requests: this.client.requestCount }
  }

  private update(p: Partial<CrawlerStatus>): void {
    this.status = { ...this.status, ...p }
    this.onStatus(this.getStatus())
  }

  stop(): void {
    if (this.abort) {
      this.update({ phase: 'stopping', message: 'Wird gestoppt …' })
      this.abort.abort()
    }
  }

  async start(opts: CrawlOptions): Promise<void> {
    if (this.status.running) return
    const mode = opts.mode ?? 'ranked'
    const queue = GAME_MODES[mode].queue
    this.abort = new AbortController()
    const signal = this.abort.signal
    const stored = await this.store.load(opts.patch, mode)

    this.status = {
      ...Crawler.idleStatus(mode),
      running: true,
      phase: 'seeding',
      message: 'Lade High-Elo-Spieler …',
      patch: opts.patch,
      matchesTotal: stored.stats.matches,
      startedAt: Date.now()
    }
    this.onStatus(this.getStatus())

    try {
      // 1) seed players from the apex leagues of every selected platform
      const perPlatform: { platform: Platform; puuid: string }[][] = []
      for (const platform of opts.platforms) {
        const list: { platform: Platform; puuid: string }[] = []
        for (const tier of opts.seedTiers) {
          if (signal.aborted) break
          const league = await this.client.apexLeague(platform, tier, signal)
          for (const e of league?.entries ?? []) if (e.puuid) list.push({ platform, puuid: e.puuid })
        }
        perPlatform.push(shuffle(list))
      }
      // interleave platforms so that every region is represented from the start
      const players: { platform: Platform; puuid: string }[] = []
      const known = new Set<string>()
      const addPlayer = (p: { platform: Platform; puuid: string }): void => {
        if (!p.puuid || known.has(p.puuid) || players.length >= MAX_PLAYERS) return
        known.add(p.puuid)
        players.push(p)
      }
      for (let i = 0; perPlatform.some((l) => i < l.length); i++) for (const l of perPlatform) if (l[i]) addPlayer(l[i])
      // ARAM: apex players rarely queue up, so every crawled game adds its players to the pool
      const snowball = mode === 'aram'

      this.update({ phase: 'crawling', players: players.length, message: `${players.length} Spieler gefunden` })

      // 2) crawl their recent ranked games
      let cursor = 0
      let sinceFlush = 0
      const startTime = Date.now() - LOOKBACK_MS
      const enough = (): boolean => this.status.matchesThisRun >= opts.maxMatches || signal.aborted

      const worker = async (): Promise<void> => {
        while (!enough() && cursor < players.length) {
          const { platform, puuid } = players[cursor++]
          const regional = regionalOf(platform)
          const ids = await this.client.matchIds(
            regional,
            puuid,
            { queue, count: opts.matchesPerPlayer, startTime },
            signal
          )
          for (const id of ids) {
            if (enough()) break
            if (stored.processed.has(id)) continue
            stored.processed.add(id)
            const match = await this.client.match(regional, id, signal)
            if (!match) continue
            const matchPatch = patchOf(match.info.gameVersion)
            if (matchPatch !== opts.patch) {
              this.update({ skippedOldPatch: this.status.skippedOldPatch + 1 })
              // match ids are newest-first: everything after an older patch is older too
              if (comparePatch(matchPatch, opts.patch) < 0) break
              continue
            }
            if (match.info.queueId !== queue) continue
            if (snowball) for (const p of match.info.participants) addPlayer({ platform, puuid: p.puuid })
            const timeline = await this.client.timeline(regional, id, signal)
            if (aggregateMatch(stored.stats, match, timeline, opts.classify)) {
              this.store.markDirty(opts.patch, mode)
              this.update({
                matchesThisRun: this.status.matchesThisRun + 1,
                matchesTotal: stored.stats.matches,
                players: players.length,
                message: `Analysiere ${GAME_MODES[mode].label}-Matches (${platform.toUpperCase()})`
              })
              if (++sinceFlush >= FLUSH_EVERY) {
                sinceFlush = 0
                await this.store.flush()
                this.onStatsUpdated(opts.patch, mode)
              }
            }
          }
          this.update({ playersDone: this.status.playersDone + 1 })
        }
      }
      await Promise.all(Array.from({ length: WORKERS }, worker))

      this.update({
        phase: 'done',
        message: signal.aborted ? 'Gestoppt' : `Fertig – ${this.status.matchesThisRun} neue Matches`
      })
    } catch (e) {
      if (signal.aborted) {
        this.update({ phase: 'done', message: 'Gestoppt' })
      } else {
        const msg = e instanceof Error ? e.message : String(e)
        this.update({ phase: 'error', message: msg, lastError: msg })
      }
    } finally {
      this.store.markDirty(opts.patch, mode)
      await this.store.flush().catch(() => undefined)
      this.onStatsUpdated(opts.patch, mode)
      this.abort = null
      this.update({ running: false })
    }
  }
}
