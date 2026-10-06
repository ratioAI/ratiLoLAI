import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameMode, PatchStats } from '@shared/types'
import { emptyPatchStats } from './aggregator'

/** Stats of one patch plus the match ids already counted, so a match is never added twice. */
interface Stored {
  stats: PatchStats
  processed: Set<string>
}

/** Persists aggregated statistics per patch as JSON files in the user data folder. */
export class StatsStore {
  private cache = new Map<string, Stored>()
  private dirty = new Set<string>()

  constructor(private readonly dir: string) {}

  /** Ranked keeps the old v0.1 file names (stats-15.19.json), other modes get a prefix (stats-aram-15.19.json). */
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
    const filePattern = mode === 'ranked' ? /^stats-(\d+\.\d+)\.json$/ : new RegExp(`^stats-${mode}-(\\d+\\.\\d+)\\.json$`)
    const patches = files.map((file) => filePattern.exec(file)?.[1]).filter((patch): patch is string => !!patch)
    const result = await Promise.all(
      patches.map(async (patch) => {
        const { stats } = await this.load(patch, mode)
        return { patch, matches: stats.matches, updatedAt: stats.updatedAt }
      })
    )
    return result.sort((a, b) => b.patch.localeCompare(a.patch, undefined, { numeric: true }))
  }

  async load(patch: string, mode: GameMode = 'ranked'): Promise<Stored> {
    const cacheKey = this.key(patch, mode)
    const cached = this.cache.get(cacheKey)
    if (cached) return cached
    let stats: PatchStats
    let processed: Set<string>
    try {
      stats = JSON.parse(await readFile(this.statsFile(patch, mode), 'utf8')) as PatchStats
      stats.mode ??= mode // files from before modes existed have no mode field
    } catch {
      stats = emptyPatchStats(patch, mode)
    }
    try {
      processed = new Set(JSON.parse(await readFile(this.processedFile(patch, mode), 'utf8')) as string[])
    } catch {
      processed = new Set()
    }
    const stored = { stats, processed }
    this.cache.set(cacheKey, stored)
    return stored
  }

  markDirty(patch: string, mode: GameMode = 'ranked'): void {
    this.dirty.add(this.key(patch, mode))
  }

  async flush(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const cacheKey of [...this.dirty]) {
      const stored = this.cache.get(cacheKey)
      if (!stored) continue
      const mode = (stored.stats.mode ?? 'ranked') as GameMode
      await atomicWrite(this.statsFile(stored.stats.patch, mode), JSON.stringify(stored.stats))
      await atomicWrite(this.processedFile(stored.stats.patch, mode), JSON.stringify([...stored.processed]))
      this.dirty.delete(cacheKey)
    }
  }

  async reset(patch: string, mode: GameMode = 'ranked'): Promise<void> {
    const cacheKey = this.key(patch, mode)
    this.cache.delete(cacheKey)
    this.dirty.delete(cacheKey)
    await rm(this.statsFile(patch, mode), { force: true })
    await rm(this.processedFile(patch, mode), { force: true })
  }
}

/** Write to a temp file and rename it, so a crash mid-write can't leave a truncated JSON file. */
async function atomicWrite(file: string, content: string): Promise<void> {
  const tempFile = `${file}.tmp`
  await writeFile(tempFile, content)
  await rename(tempFile, file)
}
