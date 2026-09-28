import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameMode, PatchStats } from '@shared/types'
import { emptyPatchStats } from './aggregator'

interface Stored {
  stats: PatchStats
  processed: Set<string>
}

/** Persists aggregated statistics per patch as JSON files in the user data folder. */
export class StatsStore {
  private cache = new Map<string, Stored>()
  private dirty = new Set<string>()

  constructor(private readonly dir: string) {}

  /** Ranked keeps the v0.1 file names (stats-15.19.json); other modes are prefixed (stats-aram-15.19.json). */
  private prefix(mode: GameMode): string {
    return mode === 'ranked' ? '' : `${mode}-`
  }
  private statsFile(patch: string, mode: GameMode): string {
    return join(this.dir, `stats-${this.prefix(mode)}${patch}.json`)
  }
  private processedFile(patch: string, mode: GameMode): string {
    return join(this.dir, `processed-${this.prefix(mode)}${patch}.json`)
  }
  private key(patch: string, mode: GameMode): string {
    return `${mode}:${patch}`
  }

  async patches(mode: GameMode = 'ranked'): Promise<{ patch: string; matches: number; updatedAt: number }[]> {
    await mkdir(this.dir, { recursive: true })
    const files = await readdir(this.dir)
    const re = mode === 'ranked' ? /^stats-(\d+\.\d+)\.json$/ : new RegExp(`^stats-${mode}-(\\d+\\.\\d+)\\.json$`)
    const patches = files.map((f) => re.exec(f)?.[1]).filter((p): p is string => !!p)
    const result = await Promise.all(
      patches.map(async (p) => {
        const { stats } = await this.load(p, mode)
        return { patch: p, matches: stats.matches, updatedAt: stats.updatedAt }
      })
    )
    return result.sort((a, b) => b.patch.localeCompare(a.patch, undefined, { numeric: true }))
  }

  async load(patch: string, mode: GameMode = 'ranked'): Promise<Stored> {
    const k = this.key(patch, mode)
    const cached = this.cache.get(k)
    if (cached) return cached
    let stats: PatchStats
    let processed: Set<string>
    try {
      stats = JSON.parse(await readFile(this.statsFile(patch, mode), 'utf8')) as PatchStats
      stats.mode ??= mode
    } catch {
      stats = emptyPatchStats(patch, mode)
    }
    try {
      processed = new Set(JSON.parse(await readFile(this.processedFile(patch, mode), 'utf8')) as string[])
    } catch {
      processed = new Set()
    }
    const stored = { stats, processed }
    this.cache.set(k, stored)
    return stored
  }

  markDirty(patch: string, mode: GameMode = 'ranked'): void {
    this.dirty.add(this.key(patch, mode))
  }

  async flush(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const k of [...this.dirty]) {
      const s = this.cache.get(k)
      if (!s) continue
      const mode = (s.stats.mode ?? 'ranked') as GameMode
      await atomicWrite(this.statsFile(s.stats.patch, mode), JSON.stringify(s.stats))
      await atomicWrite(this.processedFile(s.stats.patch, mode), JSON.stringify([...s.processed]))
      this.dirty.delete(k)
    }
  }

  async reset(patch: string, mode: GameMode = 'ranked'): Promise<void> {
    const k = this.key(patch, mode)
    this.cache.delete(k)
    this.dirty.delete(k)
    await rm(this.statsFile(patch, mode), { force: true })
    await rm(this.processedFile(patch, mode), { force: true })
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, file)
}
