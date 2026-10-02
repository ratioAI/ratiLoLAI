import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameListEntry } from '@shared/types'
import { teamBlame, type GameSummary } from '@shared/summary'

/** Post-game summaries on disk (userData/games/<gameId>.json), newest 60 kept. */
export class GameStore {
  constructor(private readonly dir: string) {}

  async save(s: GameSummary): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, `${s.gameId}.json`), JSON.stringify(s))
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json')).sort()
    // gameIds grow over time – drop the oldest beyond 60
    for (const f of files.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5))).slice(0, Math.max(0, files.length - 60)))
      await unlink(join(this.dir, f)).catch(() => undefined)
  }

  async get(gameId: number): Promise<GameSummary | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, `${gameId}.json`), 'utf8')) as GameSummary
    } catch {
      return null
    }
  }

  async list(): Promise<GameListEntry[]> {
    const files = await readdir(this.dir).catch(() => [] as string[])
    const out: GameListEntry[] = []
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const s = await this.get(Number(f.slice(0, -5)))
      if (!s) continue
      const me = s.players.find((p) => p.me)
      out.push({
        gameId: s.gameId,
        createdAt: s.createdAt,
        duration: s.duration,
        queueId: s.queueId,
        mode: s.mode,
        win: s.win,
        championId: me?.championId ?? 0,
        kda: me ? [me.kills, me.deaths, me.assists] : [0, 0, 0],
        blamedPremade: teamBlame(s)?.riotId ?? null
      })
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }
}
