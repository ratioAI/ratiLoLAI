import type {
  ChampionBuild,
  ChampSelectState,
  ClientStatus,
  ClientSummoner,
  GameMode,
  ImportResult,
  LiveGameState,
  MayhemPersonal,
  Settings,
  StatRole,
  StaticData
} from '@shared/types'
import { statsModeOf } from '@shared/types'
import { personalMayhemStats, type LcuHistory } from '../mayhem'
import { fetchAllGameData, parseLiveData } from '../live/liveClient'
import {
  buildItemSet,
  buildRunePagePayload,
  ITEM_SET_UID_PREFIX,
  orderSpells,
  parseChampSelect,
  regionToPlatform,
  RUNE_PAGE_PREFIX,
  type RawSession
} from './champSelect'
import { findCredentials } from './credentials'
import { LcuClient, type LcuEvent } from './lcuClient'

export interface LcuManagerDeps {
  settings(): Settings
  staticData(): Promise<StaticData>
  build(championId: number, role: StatRole | null, mode: GameMode): Promise<ChampionBuild | null>
  emit: {
    client(s: ClientStatus): void
    champSelect(s: ChampSelectState | null): void
    live(s: LiveGameState | null): void
    imported(r: ImportResult & { championId: number }): void
  }
}

const POLL_MS = 3000
const LIVE_POLL_MS = 2000

interface PerkPage {
  id: number
  name: string
  isDeletable: boolean
  isEditable: boolean
  current: boolean
}

/**
 * Keeps a connection to the local League client (LCU): detects the client, follows the
 * gameflow, parses champion select, auto-imports builds and polls live game data.
 */
export class LcuManager {
  private client: LcuClient | null = null
  private status: ClientStatus = { connected: false, phase: 'None', summoner: null }
  private champSelectState: ChampSelectState | null = null
  private liveState: LiveGameState | null = null
  private lastAutoImport = ''
  private queue: { id: number | null; gameMode: string | null } = { id: null, gameMode: null }
  private importTimer: NodeJS.Timeout | null = null
  /** ARAM/Mayhem have no lock-in: import once the champion has been stable for this long */
  private static readonly ARAM_IMPORT_DELAY_MS = 1500
  private pollTimer: NodeJS.Timeout | null = null
  private liveTimer: NodeJS.Timeout | null = null
  private connecting = false

  constructor(private readonly deps: LcuManagerDeps) {}

  start(): void {
    const tick = async (): Promise<void> => {
      if (!this.client && !this.connecting) await this.tryConnect()
      this.pollTimer = setTimeout(tick, POLL_MS)
    }
    void tick()
  }

  stop(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.stopLivePolling()
    this.client?.close()
  }

  getStatus(): ClientStatus {
    return this.status
  }
  getChampSelect(): ChampSelectState | null {
    return this.champSelectState
  }
  getLive(): LiveGameState | null {
    return this.liveState
  }

  private setStatus(p: Partial<ClientStatus>): void {
    this.status = { ...this.status, ...p }
    this.deps.emit.client(this.status)
  }

  private async tryConnect(): Promise<void> {
    this.connecting = true
    try {
      const creds = await findCredentials(this.deps.settings().leaguePath || undefined)
      if (!creds) return
      const client = new LcuClient(creds)
      await client.connect([
        'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
        'OnJsonApiEvent_lol-champ-select_v1_session',
        'OnJsonApiEvent_lol-matchmaking_v1_ready-check',
        'OnJsonApiEvent_lol-summoner_v1_current-summoner'
      ])
      this.client = client
      client.on('event', (e: LcuEvent) => void this.onEvent(e))
      client.on('close', () => this.onDisconnect())

      const [summoner, phase, session] = await Promise.all([
        this.fetchSummoner(),
        client.get<string>('/lol-gameflow/v1/gameflow-phase').catch(() => 'None'),
        client.get<RawSession>('/lol-champ-select/v1/session').catch(() => null)
      ])
      this.setStatus({ connected: true, summoner, phase })
      this.onPhase(phase)
      if (session) {
        await this.fetchQueue()
        this.onChampSelect(session)
      }
    } catch {
      this.client?.close()
      this.client = null
    } finally {
      this.connecting = false
    }
  }

  private onDisconnect(): void {
    if (!this.client) return
    this.client = null
    this.champSelectState = null
    this.deps.emit.champSelect(null)
    this.setStatus({ connected: false, phase: 'None', summoner: null })
  }

  private async fetchSummoner(): Promise<ClientSummoner | null> {
    if (!this.client) return null
    try {
      const [s, region] = await Promise.all([
        this.client.get<{ gameName: string; tagLine: string; puuid: string; summonerLevel: number; profileIconId: number }>(
          '/lol-summoner/v1/current-summoner'
        ),
        this.client.get<{ region: string }>('/riotclient/region-locale').catch(() => ({ region: '' }))
      ])
      return {
        gameName: s.gameName,
        tagLine: s.tagLine,
        puuid: s.puuid,
        summonerLevel: s.summonerLevel,
        profileIconId: s.profileIconId,
        platform: regionToPlatform(region.region)
      }
    } catch {
      return null
    }
  }

  private async fetchQueue(): Promise<void> {
    try {
      const session = await this.client?.get<{ gameData?: { queue?: { id?: number; gameMode?: string } } }>(
        '/lol-gameflow/v1/session'
      )
      this.queue = { id: session?.gameData?.queue?.id ?? null, gameMode: session?.gameData?.queue?.gameMode ?? null }
    } catch {
      this.queue = { id: null, gameMode: null }
    }
  }

  private async onEvent(e: LcuEvent): Promise<void> {
    switch (e.uri) {
      case '/lol-gameflow/v1/gameflow-phase':
        this.setStatus({ phase: String(e.data) })
        if (e.data === 'ChampSelect') await this.fetchQueue()
        this.onPhase(String(e.data))
        break
      case '/lol-champ-select/v1/session':
        if (e.eventType === 'Delete') {
          this.champSelectState = null
          this.lastAutoImport = ''
          this.queue = { id: null, gameMode: null }
          this.deps.emit.champSelect(null)
        } else {
          if (this.queue.id === null) await this.fetchQueue()
          this.onChampSelect(e.data as RawSession)
        }
        break
      case '/lol-matchmaking/v1/ready-check': {
        const rc = e.data as { state?: string; playerResponse?: string } | null
        if (this.deps.settings().client.autoAccept && rc?.state === 'InProgress' && rc.playerResponse === 'None') {
          await this.client?.request('POST', '/lol-matchmaking/v1/ready-check/accept').catch(() => undefined)
        }
        break
      }
      case '/lol-summoner/v1/current-summoner':
        this.setStatus({ summoner: await this.fetchSummoner() })
        break
    }
  }

  private onPhase(phase: string): void {
    if (phase === 'InProgress') this.startLivePolling()
    else this.stopLivePolling()
  }

  private onChampSelect(session: RawSession): void {
    const state = parseChampSelect(session, this.queue.id, this.queue.gameMode)
    this.champSelectState = state
    this.deps.emit.champSelect(state)
    if (!state?.myChampionId) return
    const aramLike = state.mode === 'aram' || state.mode === 'mayhem'
    if (!aramLike && !state.locked) return

    const key = `${state.mode}:${state.myChampionId}:${state.myRole}`
    if (key === this.lastAutoImport) return
    if (aramLike) {
      // champions can still be swapped via the bench – wait until the choice settles
      if (this.importTimer) clearTimeout(this.importTimer)
      this.importTimer = setTimeout(() => {
        this.importTimer = null
        if (this.champSelectState?.myChampionId === state.myChampionId) this.autoImport(state, key)
      }, LcuManager.ARAM_IMPORT_DELAY_MS)
      return
    }
    this.autoImport(state, key)
  }

  private autoImport(state: ChampSelectState, key: string): void {
    const c = this.deps.settings().client
    const what = [
      ...(c.autoImportRunes ? (['runes'] as const) : []),
      ...(c.autoImportItems ? (['items'] as const) : []),
      ...(c.autoImportSpells ? (['spells'] as const) : [])
    ]
    if (!what.length) return
    this.lastAutoImport = key
    const mode = statsModeOf(state.mode)
    const role = mode === 'aram' ? 'ARAM' : state.myRole
    void this.importBuild(state.myChampionId, role, [...what], mode).then((r) =>
      this.deps.emit.imported({ ...r, championId: state.myChampionId })
    )
  }

  // --- live game ------------------------------------------------------------

  private startLivePolling(): void {
    if (this.liveTimer) return
    const poll = async (): Promise<void> => {
      const state = parseLiveData(await fetchAllGameData())
      this.liveState = state
      this.deps.emit.live(state)
      this.liveTimer = setTimeout(poll, LIVE_POLL_MS)
    }
    this.liveTimer = setTimeout(poll, 0)
  }

  private stopLivePolling(): void {
    if (this.liveTimer) clearTimeout(this.liveTimer)
    this.liveTimer = null
    if (this.liveState) {
      this.liveState = null
      this.deps.emit.live(null)
    }
  }

  // --- import ---------------------------------------------------------------

  async importBuild(
    championId: number,
    role: StatRole | null,
    what: ('runes' | 'items' | 'spells')[] = ['runes', 'items', 'spells'],
    mode: GameMode = 'ranked'
  ): Promise<ImportResult> {
    const result: ImportResult = { errors: [] }
    const client = this.client
    if (!client) return { errors: ['League Client ist nicht verbunden.'] }
    const build = await this.deps.build(championId, role, mode)
    if (!build) return { errors: ['Noch keine Daten für diesen Champion – starte den Crawler.'] }
    const data = await this.deps.staticData()
    const champName = data.champions[championId]?.name ?? String(championId)

    if (what.includes('runes')) {
      try {
        result.runes = await this.importRunes(client, build, champName)
      } catch (e) {
        result.errors.push(`Runen: ${(e as Error).message}`)
      }
    }
    if (what.includes('items')) {
      try {
        result.items = await this.importItems(client, build, data)
      } catch (e) {
        result.errors.push(`Items: ${(e as Error).message}`)
      }
    }
    if (what.includes('spells')) {
      try {
        const order = orderSpells(build.spells[0]?.value ?? [], this.deps.settings().client.flashOn)
        if (order && this.champSelectState?.active) {
          await client.request('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: order[0], spell2Id: order[1] })
          result.spells = order.map((id) => data.spells[id]?.name ?? id).join(' + ')
        }
      } catch (e) {
        result.errors.push(`Beschwörerzauber: ${(e as Error).message}`)
      }
    }
    return result
  }

  /** The player's own ARAM: Mayhem games from the client's match history. */
  async personalMayhem(): Promise<MayhemPersonal | null> {
    if (!this.client) return null
    const history = await this.client.get<LcuHistory>(
      '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=100'
    )
    return personalMayhemStats(history, this.status.summoner?.puuid ?? null)
  }

  private async importRunes(client: LcuClient, build: ChampionBuild, champName: string): Promise<string> {
    const payload = buildRunePagePayload(build, champName)
    if (!payload) throw new Error('keine Runendaten')
    const pages = await client.get<PerkPage[]>('/lol-perks/v1/pages')
    for (const p of pages.filter((p) => p.name.startsWith(RUNE_PAGE_PREFIX) && p.isDeletable)) {
      await client.request('DELETE', `/lol-perks/v1/pages/${p.id}`)
    }
    try {
      await client.request('POST', '/lol-perks/v1/pages', payload)
    } catch {
      // page limit reached – replace the currently selected editable page (same as other companion apps)
      const current = pages.find((p) => p.current && p.isDeletable && !p.name.startsWith(RUNE_PAGE_PREFIX))
      if (!current) throw new Error('Keine freie Runenseite verfügbar.')
      await client.request('DELETE', `/lol-perks/v1/pages/${current.id}`)
      await client.request('POST', '/lol-perks/v1/pages', payload)
    }
    return payload.name
  }

  private async importItems(client: LcuClient, build: ChampionBuild, data: StaticData): Promise<string> {
    const summoner = await client.get<{ summonerId: number }>('/lol-summoner/v1/current-summoner')
    const path = `/lol-item-sets/v1/item-sets/${summoner.summonerId}/sets`
    const current = await client.get<{ accountId: number; itemSets: { uid: string }[]; timestamp: number }>(path)
    const set = buildItemSet(build, data)
    const itemSets = current.itemSets.filter(
      (s) => s.uid !== set.uid && !(s.uid ?? '').startsWith(`${ITEM_SET_UID_PREFIX}${build.championId}`)
    )
    itemSets.unshift(set)
    await client.request('PUT', path, { ...current, itemSets, timestamp: Date.now() })
    return set.title
  }
}
