import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Settings, StaticData } from '@shared/types'
import { bestAutoClip, buildClipPayload, clipFileName, clipUploadForm, isDiscordWebhook, type DiscordPayload } from '@shared/discordPayload'
import { clipTitle } from '@shared/clipLibrary'
import type { ClipStore } from './clipStore'
import { mediaTypeOf } from './protocol'

export interface ShareDeps {
  db: DatabaseSync
  store: ClipStore
  settings(): Settings['discord']
  /** the saved webhook URL (decrypted), null when there is none */
  webhook(): string | null
  staticData(): Promise<StaticData | null>
  /** your quip of a saved game, null when there is none */
  quipOf(gameId: number): Promise<string | null>
  /**
   * Makes a smaller version of a clip with the Discord preset that stays below `targetMb`.
   * Resolves with the new clip's id, null when that is not possible right now.
   */
  shrink(clipId: number, targetMb: number): Promise<number | null>
  /** removes a clip that was only made for the upload */
  discard(clipId: number): Promise<void>
  log(message: string): void
  fetch?: typeof fetch
  now?(): number
  sleep?(ms: number): Promise<void>
}

export interface ShareResult {
  ok: boolean
  message: string
  /** the clip was posted before; ask before posting it again */
  alreadyPosted?: boolean
}

/**
 * Shares clips through the user's own Discord webhook: the video as an attachment, an embed with
 * champion, K/D/A, result and the title. A file that is too large for Discord is exported smaller
 * with the Discord preset and sent again. Never throws; failures go to the log.
 */
export class ClipSharer {
  private readonly inFlight = new Set<number>()

  constructor(private readonly deps: ShareDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  posted(clipId: number): boolean {
    return !!this.deps.db.prepare('SELECT 1 FROM clip_posts WHERE clip_id = ?').get(clipId)
  }

  /** Uploads one file with its message. `status` is the HTTP status (0 = not reachable). */
  async upload(url: string, payload: DiscordPayload, file: { name: string; type: string; data: Uint8Array }): Promise<{ ok: boolean; status: number; message: string }> {
    const doFetch = this.deps.fetch ?? fetch
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response
      try {
        // a fresh form per attempt: a body can only be sent once
        response = await doFetch(url, { method: 'POST', body: clipUploadForm(payload, file), signal: AbortSignal.timeout(180_000) })
      } catch (error) {
        return { ok: false, status: 0, message: `Discord not reachable: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (response.ok) return { ok: true, status: response.status, message: 'Posted to Discord ✔' }
      const body = (await response.json().catch(() => null)) as { retry_after?: number; message?: string } | null
      if (response.status === 429 && attempt === 0) {
        const wait = Math.min(60, Math.max(0.5, Number(body?.retry_after) || Number(response.headers.get('retry-after')) || 1))
        this.deps.log(`discord: rate limited, retrying the clip in ${wait} s`)
        await sleep(wait * 1000)
        continue
      }
      const reason =
        response.status === 413
          ? 'the file is too large'
          : response.status === 404 || response.status === 401
            ? 'the webhook doesn’t exist any more (deleted in Discord?)'
            : `${response.status}${body?.message ? ` ${body.message}` : ''}`
      return { ok: false, status: response.status, message: `Discord answered ${reason}` }
    }
    return { ok: false, status: 429, message: 'Discord kept rate limiting – try again in a minute.' }
  }

  /** Posts a clip. A clip that was posted before is only posted again with `again`. */
  async share(clipId: number, options: { quip?: boolean; again?: boolean } = {}): Promise<ShareResult> {
    const url = this.deps.webhook()
    if (!url) return { ok: false, message: 'No Discord webhook saved (Settings › Discord).' }
    if (!isDiscordWebhook(url)) return { ok: false, message: 'The saved URL is not a Discord webhook.' }
    const clip = this.deps.store.clip(clipId)
    if (!clip) return { ok: false, message: 'Clip not found.' }
    if (this.inFlight.has(clipId)) return { ok: false, message: 'This clip is being posted right now.' }
    if (this.posted(clipId) && !options.again) return { ok: false, alreadyPosted: true, message: 'This clip was already posted.' }
    this.inFlight.add(clipId)
    const temporary: number[] = []
    try {
      const statics = await this.deps.staticData().catch(() => null)
      const champion = clip.game ? statics?.champions[clip.game.championId] : undefined
      const quip = options.quip && clip.gameId ? await this.deps.quipOf(clip.gameId).catch(() => null) : null
      const payload = buildClipPayload({
        title: clipTitle(clip),
        durationS: clip.durationMs / 1000,
        createdAt: clip.createdAt,
        champion: champion ? { name: champion.name, id: champion.id } : undefined,
        kda: clip.game?.kda,
        win: clip.game?.win,
        mode: clip.game?.mode,
        quip: quip ?? undefined,
        ddragonVersion: statics?.version
      })
      const limitMb = this.deps.settings().uploadLimitMb
      let sendId = clipId
      // tries: the file as it is, then smaller, then smaller again
      for (let attempt = 0; attempt < 3; attempt++) {
        const path = this.deps.store.files(sendId)?.file
        const info = path ? await stat(path).catch(() => null) : null
        if (!path || !info) return { ok: false, message: 'The clip’s file no longer exists.' }
        let tooLarge = info.size > limitMb * 1024 * 1024
        if (!tooLarge) {
          const result = await this.upload(url, payload, {
            name: clipFileName(clipTitle(clip), extname(path)),
            type: mediaTypeOf(path) ?? 'application/octet-stream',
            data: new Uint8Array(await readFile(path))
          })
          if (result.ok) {
            this.deps.db
              .prepare('INSERT INTO clip_posts (clip_id, posted_at) VALUES (?, ?) ON CONFLICT (clip_id) DO UPDATE SET posted_at = excluded.posted_at')
              .run(clipId, this.now())
            this.deps.log(`discord: clip ${clipId} posted (${(info.size / 1048576).toFixed(1)} MB)`)
            return { ok: true, message: sendId === clipId ? result.message : 'Posted to Discord ✔ (as a smaller version)' }
          }
          if (result.status !== 413) {
            this.deps.log(`discord: clip ${clipId} failed – ${result.message}`)
            return { ok: false, message: result.message }
          }
          tooLarge = true
        }
        if (attempt === 2) break
        // too large (or Discord said 413): export it smaller with the Discord preset and send that
        const targetMb = attempt === 0 ? limitMb : limitMb / 2
        this.deps.log(`discord: clip ${clipId} is too large for ${limitMb} MB, exporting it smaller (${targetMb} MB)`)
        const smaller = await this.deps.shrink(clipId, targetMb)
        if (smaller === null) return { ok: false, message: 'The clip is too large for Discord and could not be made smaller right now (is a game or an export running?).' }
        temporary.push(smaller)
        sendId = smaller
      }
      this.deps.log(`discord: clip ${clipId} is still too large after two smaller exports`)
      return { ok: false, message: 'Discord says the file is too large, even as a smaller version. Lower the upload limit in Settings › Discord.' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.log(`discord: posting clip ${clipId} failed – ${message}`)
      return { ok: false, message }
    } finally {
      this.inFlight.delete(clipId)
      for (const id of temporary) await this.deps.discard(id).catch(() => undefined)
    }
  }

  /**
   * After a game was posted: adds its best automatic clip when the option is on. Once per clip;
   * does nothing when the game has no automatic clip.
   */
  async attachBest(gameId: number): Promise<void> {
    const settings = this.deps.settings()
    if (!settings.enabled || !settings.attachBestClip || !(gameId > 0)) return
    const best = bestAutoClip(this.deps.store.ofGame(gameId))
    if (!best || this.posted(best.id)) return
    const result = await this.share(best.id, { quip: settings.includeQuips })
    if (!result.ok) this.deps.log(`discord: best clip of game ${gameId} not posted (${result.message})`)
  }
}

