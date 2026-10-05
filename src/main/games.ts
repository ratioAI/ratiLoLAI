import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameListEntry } from '@shared/types'
import { teamBlame, type GameSummary } from '@shared/summary'

/** Post-game summaries on disk (userData/games/<gameId>.json), newest 60 kept. */
export class GameStore {
  /** list entries, read from disk once and then kept up to date (no re-parsing 60 files per visit) */
  private index: Map<number, GameListEntry> | null = null

  constructor(private readonly dir: string) {}

  async save(s: GameSummary): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    this.index?.set(s.gameId, entry(s))
    await writeFile(join(this.dir, `${s.gameId}.json`), JSON.stringify(s))
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')).sort()
    // gameIds grow over time – drop the oldest beyond 60
    for (const f of files.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5))).slice(0, Math.max(0, files.length - 60))) {
      await unlink(join(this.dir, f)).catch(() => undefined)
      this.index?.delete(Number(f.slice(0, -5)))
    }
  }

  async get(gameId: number): Promise<GameSummary | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${gameId}.json`), 'utf8')) as GameSummary
    } catch {
      return null
    }
  }

  async list(): Promise<GameListEntry[]> {
    if (!this.index) {
      const files = (await readdir(this.dir).catch(() => [] as string[])).filter((x) => x.endsWith('.json'))
      const all = await Promise.all(files.map((f) => this.get(Number(f.slice(0, -5)))))
      this.index = new Map(all.filter((s): s is GameSummary => !!s).map((s) => [s.gameId, entry(s)]))
    }
    return [...this.index.values()].sort((a, b) => b.createdAt - a.createdAt)
  }
}

function entry(s: GameSummary): GameListEntry {
  const me = s.players.find((p) => p.me)
  return {
    gameId: s.gameId,
    createdAt: s.createdAt,
    duration: s.duration,
    queueId: s.queueId,
    mode: s.mode,
    win: s.win,
    championId: me?.championId ?? 0,
    kda: me ? [me.kills, me.deaths, me.assists] : [0, 0, 0],
    blamedPremade: teamBlame(s)?.riotId ?? null
  }
}
