import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MayhemData, MayhemPersonal } from '@shared/types'
import { QUEUE_IDS } from '@shared/types'
import {
  buildMayhemData,
  type AmAugmentRow,
  type AmComboRow,
  type AmFile,
  type AugmentList,
  type CherryAugment,
  mayhemPool
} from '@shared/mayhem'

const CDRAGON = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global'
const ARAM_MAYHEM = 'https://arammayhem.com/data/v1/latest'
const MAX_AGE_MS = 12 * 3600 * 1000

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'User-Agent': 'ratioAI (github.com/ratioAI/ratiLoLAI)' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return (await res.json()) as T
}

/**
 * ARAM: Mayhem augment data. Riot blocks Mayhem matches in the public API and asks developers not to
 * publish augment win rates, so this only uses open data: the client augment list from CommunityDragon
 * and the CC BY 4.0 pick-rate / combo dataset of arammayhem.com.
 */
export class MayhemService {
  private data: MayhemData | null = null
  private loading: Promise<MayhemData> | null = null

  constructor(
    private readonly cacheFile: string,
    private language: string
  ) {}

  setLanguage(language: string): void {
    if (language !== this.language) {
      this.language = language
      this.data = null
    }
  }

  get(): Promise<MayhemData> {
    if (this.data && Date.now() - this.data.fetchedAt < MAX_AGE_MS) return Promise.resolve(this.data)
    // share one request between concurrent callers
    this.loading ??= this.load().finally(() => (this.loading = null))
    return this.loading
  }

  private async load(): Promise<MayhemData> {
    const locale = this.language.toLowerCase()
    try {
      // only the English list is required, everything else degrades gracefully
      const [english, localized, augments, combos, augmentLists] = await Promise.all([
        fetchJson<CherryAugment[]>(`${CDRAGON}/default/v1/cherry-augments.json`),
        locale === 'en_us'
          ? Promise.resolve(null)
          : fetchJson<CherryAugment[]>(`${CDRAGON}/${locale}/v1/cherry-augments.json`).catch(() => null),
        fetchJson<AmFile<AmAugmentRow>>(`${ARAM_MAYHEM}/augments.json`).catch(() => null),
        fetchJson<AmFile<AmComboRow>>(`${ARAM_MAYHEM}/combos.json`).catch(() => null),
        fetchJson<AugmentList[]>(`${CDRAGON}/default/v1/augment-lists.json`).catch(() => null)
      ])
      const data = buildMayhemData(english, localized ?? english, augments, combos, Date.now(), mayhemPool(augmentLists))
      this.data = data
      await mkdir(dirname(this.cacheFile), { recursive: true })
      await writeFile(this.cacheFile, JSON.stringify({ language: this.language, data }))
      return data
    } catch (err) {
      // offline: fall back to the last saved copy, however old it is
      try {
        const cached = JSON.parse(await readFile(this.cacheFile, 'utf8')) as { data: MayhemData }
        this.data = cached.data
        return cached.data
      } catch {
        throw new Error(`Mayhem data unavailable: ${(err as Error).message}`)
      }
    }
  }
}

// Personal Mayhem stats, read from the local League client's match history

interface LcuHistoryGame {
  gameId: number
  queueId: number
  gameMode: string
  gameCreation: number
  participants: { participantId: number; championId: number; stats: Record<string, unknown> }[]
  participantIdentities?: { participantId: number; player?: { puuid?: string } }[]
}

export interface LcuHistory {
  games?: { games?: LcuHistoryGame[] }
}

// KIWI is the internal game mode name of ARAM: Mayhem
export function isMayhemGame(game: { queueId: number; gameMode: string }): boolean {
  return (QUEUE_IDS.mayhem as readonly number[]).includes(game.queueId) || game.gameMode === 'KIWI'
}

/** Aggregates the player's own Mayhem games (augments are the playerAugmentN fields). */
export function personalMayhemStats(history: LcuHistory, puuid: string | null): MayhemPersonal {
  const result: MayhemPersonal = { games: 0, wins: 0, augments: [], champions: [], recent: [] }
  const augmentStats = new Map<number, { games: number; wins: number }>()
  const championStats = new Map<number, { games: number; wins: number }>()

  for (const game of history.games?.games ?? []) {
    if (!isMayhemGame(game)) continue
    const participantId = puuid
      ? game.participantIdentities?.find((identity) => identity.player?.puuid === puuid)?.participantId
      : undefined
    // the client's own history sometimes only contains the local player, so take the single entry then
    const me =
      game.participants.find((participant) => participant.participantId === participantId) ??
      (game.participants.length === 1 ? game.participants[0] : undefined)
    if (!me) continue
    const win = me.stats.win === true
    // playerAugment1..N, sorted numerically so playerAugment10 comes after playerAugment9
    const augments = Object.entries(me.stats)
      .filter(([key, value]) => /^playerAugment\d+$/.test(key) && typeof value === 'number' && value > 0)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([, value]) => value as number)

    result.games++
    if (win) result.wins++
    for (const id of augments) {
      const augmentRecord = augmentStats.get(id) ?? { games: 0, wins: 0 }
      augmentRecord.games++
      if (win) augmentRecord.wins++
      augmentStats.set(id, augmentRecord)
    }
    const championRecord = championStats.get(me.championId) ?? { games: 0, wins: 0 }
    championRecord.games++
    if (win) championRecord.wins++
    championStats.set(me.championId, championRecord)
    result.recent.push({ gameId: game.gameId, championId: me.championId, win, augments, createdAt: game.gameCreation })
  }

  result.augments = [...augmentStats.entries()].map(([id, record]) => ({ id, ...record })).sort((a, b) => b.games - a.games)
  result.champions = [...championStats.entries()]
    .map(([championId, record]) => ({ championId, ...record }))
    .sort((a, b) => b.games - a.games)
  result.recent.sort((a, b) => b.createdAt - a.createdAt)
  return result
}

/** One player's results in a mode from their client match history (gameId → won). */
export function modeResults(history: LcuHistory, puuid: string, mode: 'mayhem' | 'aram'): Map<number, boolean> {
  const results = new Map<number, boolean>()
  for (const game of history.games?.games ?? []) {
    const match =
      mode === 'mayhem' ? isMayhemGame(game) : (QUEUE_IDS.aram as readonly number[]).includes(game.queueId) || game.gameMode === 'ARAM'
    if (!match) continue
    const participantId = game.participantIdentities?.find((identity) => identity.player?.puuid === puuid)?.participantId
    const me =
      game.participants.find((participant) => participant.participantId === participantId) ??
      (game.participants.length === 1 ? game.participants[0] : undefined)
    if (!me) continue
    results.set(game.gameId, me.stats.win === true)
  }
  return results
}

/** Games and wins of one player in a mode, taken from that player's client match history. */
export function modeRecord(history: LcuHistory, puuid: string, mode: 'mayhem' | 'aram'): { games: number; wins: number } {
  const results = modeResults(history, puuid, mode)
  return { games: results.size, wins: [...results.values()].filter(Boolean).length }
}
