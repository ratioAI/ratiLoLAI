import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameListEntry } from '@shared/types'
import { teamBlame, type GameSummary } from '@shared/summary'

/** Post-game summaries on disk (userData/games/<gameId>.json). Only the newest 60 are kept. */
export class GameStore {
  // read from disk once, then kept up to date so the history page doesn't re-parse 60 files every visit
  private index: Map<number, GameListEntry> | null = null

  constructor(private readonly dir: string) {}

  async save(summary: GameSummary): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    this.index?.set(summary.gameId, entry(summary))
    await writeFile(join(this.dir, `${summary.gameId}.json`), JSON.stringify(summary))
    const files = (await readdir(this.dir)).filter((file) => file.endsWith('.json')).sort()
    // gameIds increase over time, so the smallest ids are the oldest games
    for (const file of files.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5))).slice(0, Math.max(0, files.length - 60))) {
      await unlink(join(this.dir, file)).catch(() => undefined)
      this.index?.delete(Number(file.slice(0, -5)))
    }
  }

  async get(gameId: number): Promise<GameSummary | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${gameId}.json`), 'utf8')) as GameSummary
    } catch {
      return null
    }
  }

  /** Every saved summary (at most 60, so reading them all is fine). */
  async all(): Promise<GameSummary[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((file) => file.endsWith('.json'))
    const summaries = await Promise.all(files.map((file) => this.get(Number(file.slice(0, -5)))))
    return summaries.filter((summary): summary is GameSummary => !!summary)
  }

  async list(): Promise<GameListEntry[]> {
    if (!this.index) {
      const files = (await readdir(this.dir).catch(() => [] as string[])).filter((file) => file.endsWith('.json'))
      const summaries = await Promise.all(files.map((file) => this.get(Number(file.slice(0, -5)))))
      this.index = new Map(
        summaries.filter((summary): summary is GameSummary => !!summary).map((summary) => [summary.gameId, entry(summary)])
      )
    }
    return [...this.index.values()].sort((a, b) => b.createdAt - a.createdAt)
  }
}

function entry(summary: GameSummary): GameListEntry {
  const me = summary.players.find((player) => player.me)
  return {
    gameId: summary.gameId,
    createdAt: summary.createdAt,
    duration: summary.duration,
    queueId: summary.queueId,
    mode: summary.mode,
    win: summary.win,
    championId: me?.championId ?? 0,
    kda: me ? [me.kills, me.deaths, me.assists] : [0, 0, 0],
    blamedPremade: teamBlame(summary)?.riotId ?? null
  }
}
