import type { DatabaseSync } from 'node:sqlite'
import type { Settings, StaticData } from '@shared/types'
import type { GameSummary } from '@shared/summary'
import { quips } from '@shared/quips'
import { summaryAugmentTiers, type TierLookup } from '@shared/mayhem'
import { buildDiscordPayload, discordModeOf, isDiscordWebhook, type DiscordPayload } from '@shared/discordPayload'

/** Only games that ended at most this long ago are posted on their own (no imports, no old games). */
export const DISCORD_MAX_AGE_MS = 30 * 60_000

export interface DiscordDeps {
  db: DatabaseSync
  settings(): Settings['discord']
  /** the saved webhook URL (decrypted), null when there is none */
  webhook(): string | null
  staticData(): Promise<StaticData | null>
  tiers(): Promise<TierLookup | null>
  /** names and descriptions of the achievements a game unlocked */
  achievementsOf(gameId: number): { name: string; description: string }[]
  log(message: string): void
  fetch?: typeof fetch
  now?(): number
  sleep?(ms: number): Promise<void>
}

export interface PostResult {
  ok: boolean
  message: string
}

/**
 * Posts game summaries to the user's own Discord webhook. Runs after a game was saved, never
 * blocks anything and never throws: failures end up in the log.
 */
export class DiscordPoster {
  private readonly inFlight = new Set<number>()

  constructor(private readonly deps: DiscordDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  posted(gameId: number): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM discord_posts WHERE game_id = ?').get(gameId)
  }

  /** Why a game would not be posted on its own, null when it would. */
  skipReason(summary: GameSummary): string | null {
    const settings = this.deps.settings()
    if (!settings.enabled) return 'Discord posts are off'
    if (!this.deps.webhook()) return 'no webhook saved'
    if (!(summary.gameId > 0)) return 'test game'
    if (!settings.modes.includes(discordModeOf(summary))) return `mode ${discordModeOf(summary)} is not selected`
    if (settings.onlyWithPremades && !summary.players.some((player) => player.premade && player.ally && !player.me))
      return 'no premade in this game'
    if (this.now() - (summary.createdAt + Math.max(0, summary.duration) * 1000) > DISCORD_MAX_AGE_MS)
      return 'the game ended more than 30 minutes ago'
    if (this.posted(summary.gameId) || this.inFlight.has(summary.gameId)) return 'already posted'
    return null
  }

  /** The message for a game with the current settings. */
  async payload(summary: GameSummary, test = false): Promise<DiscordPayload> {
    const settings = this.deps.settings()
    const [statics, tierOf] = await Promise.all([this.deps.staticData().catch(() => null), this.deps.tiers().catch(() => null)])
    return buildDiscordPayload(summary, {
      quips: settings.includeQuips ? quips(summary, tierOf ? summaryAugmentTiers(summary, tierOf) : {}) : undefined,
      champion: (id) => statics?.champions[id],
      ddragonVersion: statics?.version,
      achievements: settings.includeAchievements && summary.gameId > 0 ? this.deps.achievementsOf(summary.gameId) : undefined,
      anonymizeRandoms: settings.anonymizeRandoms,
      test
    })
  }

  /** Called after every saved game: posts it if the settings say so. */
  async maybePost(summary: GameSummary): Promise<void> {
    const reason = this.skipReason(summary)
    if (reason) {
      if (this.deps.settings().enabled) this.deps.log(`discord: game ${summary.gameId} not posted (${reason})`)
      return
    }
    await this.post(summary)
  }

  /** Posts a game now (manually, or from maybePost). Remembers it, so it isn't posted again on its own. */
  async post(summary: GameSummary, test = false): Promise<PostResult> {
    const url = this.deps.webhook()
    if (!url) return { ok: false, message: 'No Discord webhook saved.' }
    if (!test) this.inFlight.add(summary.gameId)
    try {
      const result = await this.send(url, await this.payload(summary, test))
      if (result.ok && !test)
        this.deps.db
          .prepare(
            'INSERT INTO discord_posts (game_id, posted_at) VALUES (?, ?) ON CONFLICT (game_id) DO UPDATE SET posted_at = excluded.posted_at'
          )
          .run(summary.gameId, this.now())
      this.deps.log(`discord: ${test ? 'test message' : `game ${summary.gameId}`} ${result.ok ? 'posted' : `failed – ${result.message}`}`)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log(`discord: posting failed – ${message}`)
      return { ok: false, message }
    } finally {
      this.inFlight.delete(summary.gameId)
    }
  }

  /** POSTs the payload; on 429 waits retry_after once and tries again. Never throws. */
  async send(url: string, payload: DiscordPayload): Promise<PostResult> {
    if (!isDiscordWebhook(url)) return { ok: false, message: 'The saved URL is not a Discord webhook.' }
    const doFetch = this.deps.fetch ?? fetch
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000)
        })
      } catch (error) {
        return { ok: false, message: `Discord not reachable: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (response.ok) return { ok: true, message: 'Posted to Discord ✔' }
      const body = (await response.json().catch(() => null)) as { retry_after?: number; message?: string } | null
      if (response.status === 429 && attempt === 0) {
        // retry_after is in seconds (may be fractional); never wait longer than a minute
        const wait = Math.min(60, Math.max(0.5, Number(body?.retry_after) || Number(response.headers.get('retry-after')) || 1))
        this.deps.log(`discord: rate limited, retrying in ${wait} s`)
        await sleep(wait * 1000)
        continue
      }
      const reason =
        response.status === 404 || response.status === 401
          ? 'the webhook doesn’t exist any more (deleted in Discord?)'
          : `${response.status}${body?.message ? ` ${body.message}` : ''}`
      return { ok: false, message: `Discord answered ${reason}` }
    }
    return { ok: false, message: 'Discord kept rate limiting – try again in a minute.' }
  }
}
