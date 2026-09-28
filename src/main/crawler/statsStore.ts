import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PatchStats } from '@shared/types'
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

  private statsFile(patch: string): string {
    return join(this.dir, `stats-${patch}.json`)
  }
  private processedFile(patch: string): string {
    return join(this.dir, `processed-${patch}.json`)
  }

  async patches(): Promise<{ patch: string; matches: number; updatedAt: number }[]> {
    await mkdir(this.dir, { recursive: true })
    const files = await readdir(this.dir)
    const patches = files
      .map((f) => /^stats-(.+)\.json$/.exec(f)?.[1])
      .filter((p): p is string => !!p)
    const result = await Promise.all(
      patches.map(async (p) => {
        const { stats } = await this.load(p)
        return { patch: p, matches: stats.matches, updatedAt: stats.updatedAt }
      })
    )
    return result.sort((a, b) => b.patch.localeCompare(a.patch, undefined, { numeric: true }))
  }

  async load(patch: string): Promise<Stored> {
    const cached = this.cache.get(patch)
    if (cached) return cached
    let stats: PatchStats
    let processed: Set<string>
    try {
      stats = JSON.parse(await readFile(this.statsFile(patch), 'utf8')) as PatchStats
    } catch {
      stats = emptyPatchStats(patch)
    }
    try {
      processed = new Set(JSON.parse(await readFile(this.processedFile(patch), 'utf8')) as string[])
    } catch {
      processed = new Set()
    }
    const stored = { stats, processed }
    this.cache.set(patch, stored)
    return stored
  }

  markDirty(patch: string): void {
    this.dirty.add(patch)
  }

  async flush(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const patch of [...this.dirty]) {
      const s = this.cache.get(patch)
      if (!s) continue
      await atomicWrite(this.statsFile(patch), JSON.stringify(s.stats))
      await atomicWrite(this.processedFile(patch), JSON.stringify([...s.processed]))
      this.dirty.delete(patch)
    }
  }

  async reset(patch: string): Promise<void> {
    this.cache.delete(patch)
    this.dirty.delete(patch)
    await rm(this.statsFile(patch), { force: true })
    await rm(this.processedFile(patch), { force: true })
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, content)
  await rename(tmp, file)
}
