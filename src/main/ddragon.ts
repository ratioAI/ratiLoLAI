import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StaticData } from '@shared/types'
import { DDRAGON as CDN, loadStaticData } from '@shared/staticData'
import type { ItemClass, ItemClassifier } from './crawler/aggregator'

/** Item classifier for the crawler, memoized per item id (unknown ids are cached as undefined too). */
export function makeClassifier(data: StaticData): ItemClassifier {
  const cache = new Map<number, ItemClass | undefined>()
  return (id) => {
    if (cache.has(id)) return cache.get(id)
    const item = data.items[id]
    const itemClass = item ? { completed: item.completed, boots: item.boots, trinket: item.tags.includes('Trinket') } : undefined
    cache.set(id, itemClass)
    return itemClass
  }
}

/** Static game data from Data Dragon, cached on disk per patch version and language. */
export class DataDragon {
  private data: StaticData | null = null
  private loading: Promise<StaticData> | null = null

  constructor(
    private readonly cacheDir: string,
    private language: string
  ) {}

  setLanguage(language: string): void {
    if (language !== this.language) {
      this.language = language
      this.data = null
      this.loading = null
    }
  }

  get(): Promise<StaticData> {
    if (this.data) return Promise.resolve(this.data)
    if (!this.loading) {
      this.loading = this.load().then(
        (data) => (this.data = data),
        (err) => {
          // allow a retry on the next call
          this.loading = null
          throw err
        }
      )
    }
    return this.loading
  }

  private async json<T>(path: string): Promise<T> {
    const res = await fetch(`${CDN}${path}`)
    if (!res.ok) throw new Error(`Data Dragon ${res.status} (${path})`)
    return (await res.json()) as T
  }

  private async load(): Promise<StaticData> {
    await mkdir(this.cacheDir, { recursive: true })
    let version: string
    try {
      version = (await this.json<string[]>('/api/versions.json'))[0]
    } catch {
      // offline: use whatever patch we cached last for this language
      const cached = await this.latestCached()
      if (cached) return cached
      throw new Error('Data Dragon unreachable and no cache available.')
    }

    const file = join(this.cacheDir, `${version}-${this.language}.json`)
    try {
      return JSON.parse(await readFile(file, 'utf8')) as StaticData
    } catch {
      // not cached yet
    }

    const data = await loadStaticData((path) => this.json(path), version, this.language)
    await writeFile(file, JSON.stringify(data))
    return data
  }

  private async latestCached(): Promise<StaticData | null> {
    try {
      const files = (await readdir(this.cacheDir)).filter((file) => file.endsWith(`-${this.language}.json`))
      if (!files.length) return null
      // file names start with the version, numeric compare puts the newest patch last
      files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      return JSON.parse(await readFile(join(this.cacheDir, files[files.length - 1]), 'utf8')) as StaticData
    } catch {
      return null
    }
  }
}
