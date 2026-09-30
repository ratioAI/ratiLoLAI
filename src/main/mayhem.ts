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
const AM = 'https://arammayhem.com/data/v1/latest'
const MAX_AGE_MS = 12 * 3600 * 1000

async function json<T>(url: string): Promise<T> {
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
    this.loading ??= this.load().finally(() => (this.loading = null))
    return this.loading
  }

  private async load(): Promise<MayhemData> {
    const locale = this.language.toLowerCase()
    try {
      const [en, local, augments, combos, lists] = await Promise.all([
        json<CherryAugment[]>(`${CDRAGON}/default/v1/cherry-augments.json`),
        locale === 'en_us' ? Promise.resolve(null) : json<CherryAugment[]>(`${CDRAGON}/${locale}/v1/cherry-augments.json`).catch(() => null),
        json<AmFile<AmAugmentRow>>(`${AM}/augments.json`).catch(() => null),
        json<AmFile<AmComboRow>>(`${AM}/combos.json`).catch(() => null),
        json<AugmentList[]>(`${CDRAGON}/default/v1/augment-lists.json`).catch(() => null)
      ])
      const data = buildMayhemData(en, local ?? en, augments, combos, Date.now(), mayhemPool(lists))
      this.data = data
      await mkdir(dirname(this.cacheFile), { recursive: true })
      await writeFile(this.cacheFile, JSON.stringify({ language: this.language, data }))
      return data
    } catch (e) {
      try {
        const cached = JSON.parse(await readFile(this.cacheFile, 'utf8')) as { data: MayhemData }
        this.data = cached.data
        return cached.data
      } catch {
        throw new Error(`Mayhem data unavailable: ${(e as Error).message}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Personal Mayhem statistics from the local League client's match history
// ---------------------------------------------------------------------------

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

export function isMayhemGame(g: { queueId: number; gameMode: string }): boolean {
  return (QUEUE_IDS.mayhem as readonly number[]).includes(g.queueId) || g.gameMode === 'KIWI'
}

/** Aggregates the player's own Mayhem games (augments are the playerAugmentN fields). */
export function personalMayhemStats(history: LcuHistory, puuid: string | null): MayhemPersonal {
  const result: MayhemPersonal = { games: 0, wins: 0, augments: [], champions: [], recent: [] }
  const augs = new Map<number, { games: number; wins: number }>()
  const champs = new Map<number, { games: number; wins: number }>()

  for (const g of history.games?.games ?? []) {
    if (!isMayhemGame(g)) continue
    const pid = puuid ? g.participantIdentities?.find((i) => i.player?.puuid === puuid)?.participantId : undefined
    const me = g.participants.find((p) => p.participantId === pid) ?? (g.participants.length === 1 ? g.participants[0] : undefined)
    if (!me) continue
    const win = me.stats.win === true
    const augments = Object.entries(me.stats)
      .filter(([k, v]) => /^playerAugment\d+$/.test(k) && typeof v === 'number' && v > 0)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([, v]) => v as number)

    result.games++
    if (win) result.wins++
    for (const id of augments) {
      const e = augs.get(id) ?? { games: 0, wins: 0 }
      e.games++
      if (win) e.wins++
      augs.set(id, e)
    }
    const c = champs.get(me.championId) ?? { games: 0, wins: 0 }
    c.games++
    if (win) c.wins++
    champs.set(me.championId, c)
    result.recent.push({ gameId: g.gameId, championId: me.championId, win, augments, createdAt: g.gameCreation })
  }

  result.augments = [...augs.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.games - a.games)
  result.champions = [...champs.entries()].map(([championId, v]) => ({ championId, ...v })).sort((a, b) => b.games - a.games)
  result.recent.sort((a, b) => b.createdAt - a.createdAt)
  return result
}

/** Wins / games of one player in a mode (from that player's client match history). */
export function modeRecord(history: LcuHistory, puuid: string, mode: 'mayhem' | 'aram'): { games: number; wins: number } {
  let games = 0
  let wins = 0
  for (const g of history.games?.games ?? []) {
    const match = mode === 'mayhem' ? isMayhemGame(g) : (QUEUE_IDS.aram as readonly number[]).includes(g.queueId) || g.gameMode === 'ARAM'
    if (!match) continue
    const pid = g.participantIdentities?.find((i) => i.player?.puuid === puuid)?.participantId
    const me = g.participants.find((p) => p.participantId === pid) ?? (g.participants.length === 1 ? g.participants[0] : undefined)
    if (!me) continue
    games++
    if (me.stats.win === true) wins++
  }
  return { games, wins }
}
