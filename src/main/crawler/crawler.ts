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

/** Cap for the snowball player pool (only used for ARAM, apex players rarely play it). */
const MAX_PLAYERS = 50_000
/** only look at games from the last 3 weeks */
const LOOKBACK_MS = 21 * 24 * 3600 * 1000
const WORKERS = 3
const FLUSH_EVERY = 10

/** Fisher-Yates, in place. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

/** Compares "15.9" and "15.10" numerically. */
export function comparePatch(a: string, b: string): number {
  const [majorA, minorA] = a.split('.').map(Number)
  const [majorB, minorB] = b.split('.').map(Number)
  return majorA - majorB || minorA - minorB
}

/**
 * Crawls high-elo games through the official Riot API and adds them to the aggregated stats.
 * Runs a few workers in parallel, the rate limiter decides the actual throughput.
 */
export class Crawler {
  private abortController: AbortController | null = null
  private status: CrawlerStatus = Crawler.idleStatus()

  constructor(
    private readonly client: RiotClient,
    private readonly store: StatsStore,
    private readonly onStatus: (status: CrawlerStatus) => void,
    private readonly onStatsUpdated: (patch: string, mode: GameMode) => void
  ) {}

  static idleStatus(mode: GameMode = 'ranked'): CrawlerStatus {
    return {
      running: false,
      mode,
      phase: 'idle',
      message: 'Ready',
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

  private update(patch: Partial<CrawlerStatus>): void {
    this.status = { ...this.status, ...patch }
    this.onStatus(this.getStatus())
  }

  /** A new API key was saved, so an error from the old key no longer applies. */
  clearKeyError(): void {
    if (this.status.running || this.status.phase !== 'error') return
    this.update({ phase: 'idle', message: 'Ready – new API key saved', lastError: null })
  }

  stop(): void {
    if (this.abortController) {
      this.update({ phase: 'stopping', message: 'Stopping …' })
      this.abortController.abort()
    }
  }

  async start(opts: CrawlOptions): Promise<void> {
    if (this.status.running) return
    const mode = opts.mode ?? 'ranked'
    const queue = GAME_MODES[mode].queue
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    const stored = await this.store.load(opts.patch, mode)

    this.status = {
      ...Crawler.idleStatus(mode),
      running: true,
      phase: 'seeding',
      message: 'Loading high-elo players …',
      patch: opts.patch,
      matchesTotal: stored.stats.matches,
      startedAt: Date.now()
    }
    this.onStatus(this.getStatus())

    try {
      // 1. seed players from the apex leagues of every selected platform
      const perPlatform: { platform: Platform; puuid: string }[][] = []
      for (const platform of opts.platforms) {
        const platformPlayers: { platform: Platform; puuid: string }[] = []
        for (const tier of opts.seedTiers) {
          if (signal.aborted) break
          const league = await this.client.apexLeague(platform, tier, signal)
          for (const entry of league?.entries ?? []) if (entry.puuid) platformPlayers.push({ platform, puuid: entry.puuid })
        }
        perPlatform.push(shuffle(platformPlayers))
      }
      // interleave platforms so every region shows up from the start
      const players: { platform: Platform; puuid: string }[] = []
      const known = new Set<string>()
      const addPlayer = (player: { platform: Platform; puuid: string }): void => {
        if (!player.puuid || known.has(player.puuid) || players.length >= MAX_PLAYERS) return
        known.add(player.puuid)
        players.push(player)
      }
      for (let i = 0; perPlatform.some((list) => i < list.length); i++) for (const list of perPlatform) if (list[i]) addPlayer(list[i])
      // apex players rarely queue ARAM, so in ARAM every crawled game adds its players to the pool
      const snowball = mode === 'aram'

      this.update({ phase: 'crawling', players: players.length, message: `${players.length} players found` })

      // 2. crawl their recent games
      let cursor = 0
      let sinceFlush = 0
      const startTime = Date.now() - LOOKBACK_MS
      const enough = (): boolean => this.status.matchesThisRun >= opts.maxMatches || signal.aborted

      const worker = async (): Promise<void> => {
        while (!enough() && cursor < players.length) {
          const { platform, puuid } = players[cursor++]
          const regional = regionalOf(platform)
          const ids = await this.client.matchIds(regional, puuid, { queue, count: opts.matchesPerPlayer, startTime }, signal)
          for (const matchId of ids) {
            if (enough()) break
            if (stored.processed.has(matchId)) continue
            // mark as processed only after the fetch, so a failed request (expired key, network)
            // doesn't lose the match for the next run
            const match = await this.client.match(regional, matchId, signal)
            stored.processed.add(matchId)
            if (!match) continue
            const matchPatch = patchOf(match.info.gameVersion)
            if (matchPatch !== opts.patch) {
              this.update({ skippedOldPatch: this.status.skippedOldPatch + 1 })
              // match ids come newest first, so everything after an older patch is older too
              if (comparePatch(matchPatch, opts.patch) < 0) break
              continue
            }
            if (match.info.queueId !== queue) continue
            if (snowball) for (const participant of match.info.participants) addPlayer({ platform, puuid: participant.puuid })
            const timeline = await this.client.timeline(regional, matchId, signal)
            if (aggregateMatch(stored.stats, match, timeline, opts.classify)) {
              this.store.markDirty(opts.patch, mode)
              this.update({
                matchesThisRun: this.status.matchesThisRun + 1,
                matchesTotal: stored.stats.matches,
                players: players.length,
                message: `Analysing ${GAME_MODES[mode].label} matches (${platform.toUpperCase()})`
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
        message: signal.aborted ? 'Stopped' : `Done – ${this.status.matchesThisRun} new matches`
      })
    } catch (err) {
      if (signal.aborted) {
        this.update({ phase: 'done', message: 'Stopped' })
      } else {
        const errorMessage = err instanceof Error ? err.message : String(err)
        this.update({ phase: 'error', message: errorMessage, lastError: errorMessage })
      }
    } finally {
      this.store.markDirty(opts.patch, mode)
      await this.store.flush().catch(() => undefined)
      this.onStatsUpdated(opts.patch, mode)
      this.abortController = null
      this.update({ running: false })
    }
  }
}
