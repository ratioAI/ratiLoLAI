import type {
  ChampionBuild,
  ChampSelectState,
  ClientStatus,
  ClientSummoner,
  GameMode,
  ImportResult,
  LiveGameState,
  LoadingPlayer,
  LoadingState,
  MayhemPersonal,
  Settings,
  StatRole,
  StaticData
} from '@shared/types'
import { QUEUE_IDS, statsModeOf } from '@shared/types'
import { acceptDelayMs } from './acceptDelay'
import { buildSummary, type CurvePoint, type GameSummary, type RawGame, type RawTimeline } from '@shared/summary'
import { modeRecord, personalMayhemStats, type LcuHistory } from '../mayhem'
import { fetchAllGameData, parseLiveData } from '../live/liveClient'
import {
  buildItemSet,
  buildRunePagePayload,
  ITEM_SET_UID_PREFIX,
  orderSpells,
  parseChampSelect,
  regionToPlatform,
  isOurRunePage,
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
    loading(s: LoadingState | null): void
    summary(s: GameSummary): void
    /** everyone accepted the match (ready check → champ select): time to travel to a new galaxy */
    matchAccepted(): void
  }
  /** gold/kill lead recorded from the live data (fallback when the client has no timeline) */
  liveCurve(): CurvePoint[]
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
interface ReadyCheck {
  state?: string
  playerResponse?: string
  /** seconds since the ready check started */
  timer?: number
}

export class LcuManager {
  private client: LcuClient | null = null
  private status: ClientStatus = { connected: false, phase: 'None', summoner: null }
  private champSelectState: ChampSelectState | null = null
  private liveState: LiveGameState | null = null
  private lastAutoImport = ''
  private queue: { id: number | null; gameMode: string | null } = { id: null, gameMode: null }
  private importTimer: NodeJS.Timeout | null = null
  private gameQueueId: number | null = null
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
    this.cancelAccept()
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
      const session = await this.client?.get<{ gameData?: { queue?: { id?: number; gameMode?: string } } }>('/lol-gameflow/v1/session')
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
      case '/lol-matchmaking/v1/ready-check':
        this.onReadyCheck(e.data as ReadyCheck | null)
        break
      case '/lol-summoner/v1/current-summoner':
        this.setStatus({ summoner: await this.fetchSummoner() })
        break
    }
  }

  // --- auto accept ----------------------------------------------------------

  private acceptTimer: NodeJS.Timeout | null = null

  private cancelAccept(): void {
    if (this.acceptTimer) clearTimeout(this.acceptTimer)
    this.acceptTimer = null
  }

  /**
   * Accepts the ready check after a random, human-like delay (not the instant the popup appears).
   * Uses the same documented client API as the Accept button. If you accept or decline yourself,
   * or the check ends, the pending accept is dropped.
   */
  private onReadyCheck(rc: ReadyCheck | null): void {
    const s = this.deps.settings().client
    const open = rc?.state === 'InProgress' && rc.playerResponse === 'None'
    if (!s.autoAccept || !open) return this.cancelAccept()
    if (this.acceptTimer) return
    const delay = acceptDelayMs(s.acceptDelay, rc?.timer)
    this.acceptTimer = setTimeout(async () => {
      this.acceptTimer = null
      const now = await this.client?.get<ReadyCheck>('/lol-matchmaking/v1/ready-check').catch(() => null)
      if (!this.deps.settings().client.autoAccept || now?.state !== 'InProgress' || now.playerResponse !== 'None') return
      await this.client?.request('POST', '/lol-matchmaking/v1/ready-check/accept').catch(() => undefined)
    }, delay)
  }

  // --- party & loading screen ------------------------------------------------

  private currentGameId: number | null = null

  /**
   * After the game: the client's match history entry has all ten players (stats, augments) and a
   * timeline (gold per minute, kills). It can take a little while to appear – retry for ~2 min.
   */
  private async fetchSummary(gameId: number): Promise<void> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const client = this.client
      if (!client) return
      const game = await client.get<RawGame>(`/lol-match-history/v1/games/${gameId}`).catch(() => null)
      if (game?.participants?.length) {
        const timeline = await client.get<RawTimeline>(`/lol-match-history/v1/game-timelines/${gameId}`).catch(() => null)
        const summary = buildSummary(game, timeline, this.status.summoner?.puuid ?? null, this.premadePuuids, this.deps.liveCurve())
        this.deps.emit.summary(summary)
        return
      }
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  private premades: string[] = []
  private premadePuuids = new Set<string>()
  private loadingState: LoadingState | null = null
  private loadingGame: number | null = null

  getLoading(): LoadingState | null {
    return this.loadingState
  }

  private async riotIdOf(puuid: string): Promise<string> {
    const s = await this.client?.get<{ gameName?: string; tagLine?: string }>(`/lol-summoner/v2/summoners/puuid/${puuid}`).catch(() => null)
    return s?.gameName ? `${s.gameName}#${s.tagLine ?? ''}` : ''
  }

  /** Remembers who is in your party (lobby) – shown as premades during the game. */
  private async fetchParty(): Promise<void> {
    const lobby = await this.client?.get<{ members?: { puuid?: string }[] }>('/lol-lobby/v2/lobby').catch(() => null)
    const me = this.status.summoner?.puuid
    const puuids = (lobby?.members ?? []).map((m) => m.puuid).filter((p): p is string => !!p && p !== me)
    if (!puuids.length && !lobby) return // no lobby right now – keep what we knew
    this.premadePuuids = new Set(puuids)
    this.premades = (await Promise.all(puuids.map((p) => this.riotIdOf(p)))).filter(Boolean)
  }

  /**
   * Loading screen: read the players from the game session and look up each player's recent
   * games of this mode in the client's match history (the same data the client's profile shows).
   */
  private async fetchLoading(): Promise<void> {
    const client = this.client
    if (!client) return
    type SessionPlayer = { puuid?: string; championId?: number; gameName?: string; tagLine?: string; summonerName?: string }
    const session = await client
      .get<{
        gameData?: { gameId?: number; queue?: { id?: number; gameMode?: string }; teamOne?: SessionPlayer[]; teamTwo?: SessionPlayer[] }
      }>('/lol-gameflow/v1/session')
      .catch(() => null)
    const g = session?.gameData
    const queue = g?.queue?.id ?? null
    const mode: LoadingState['mode'] | null =
      g?.queue?.gameMode === 'KIWI' || (queue !== null && (QUEUE_IDS.mayhem as readonly number[]).includes(queue))
        ? 'mayhem'
        : g?.queue?.gameMode === 'ARAM' || (queue !== null && (QUEUE_IDS.aram as readonly number[]).includes(queue))
          ? 'aram'
          : null
    if (!g || !mode || g.gameId === this.loadingGame) return
    this.loadingGame = g.gameId ?? null
    const me = this.status.summoner?.puuid
    const mine = (g.teamOne ?? []).some((p) => p.puuid === me) ? (g.teamOne ?? []) : (g.teamTwo ?? [])
    const all = [...(g.teamOne ?? []), ...(g.teamTwo ?? [])].filter((p) => p.puuid)
    const players: LoadingPlayer[] = all.map((p) => ({
      puuid: p.puuid!,
      riotId: p.gameName ? `${p.gameName}#${p.tagLine ?? ''}` : (p.summonerName ?? ''),
      championId: p.championId ?? 0,
      ally: mine.includes(p),
      me: p.puuid === me,
      premade: this.premadePuuids.has(p.puuid!),
      record: null,
      loading: true
    }))
    this.loadingState = { mode, players }
    this.deps.emit.loading(this.loadingState)

    // names + records, three at a time so the client isn't hammered during loading
    const queue_ = [...players]
    const worker = async (): Promise<void> => {
      for (let p = queue_.shift(); p; p = queue_.shift()) {
        if (!p.riotId) p.riotId = await this.riotIdOf(p.puuid)
        const history = await client
          .get<LcuHistory>(`/lol-match-history/v1/products/lol/${p.puuid}/matches?begIndex=0&endIndex=99`)
          .catch(() => null)
        p.record = history ? modeRecord(history, p.puuid, mode) : null
        p.loading = false
        if (this.loadingState?.players === players) this.deps.emit.loading({ mode, players: [...players] })
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }

  private lastPhase = 'None'

  private onPhase(phase: string): void {
    if (phase === 'ChampSelect' && this.lastPhase === 'ReadyCheck') this.deps.emit.matchAccepted()
    this.lastPhase = phase
    if (['Lobby', 'Matchmaking', 'ReadyCheck', 'ChampSelect'].includes(phase)) void this.fetchParty()
    if (phase === 'InProgress') void this.fetchLoading()
    else if (this.loadingState) {
      this.loadingState = null
      this.loadingGame = null
      this.deps.emit.loading(null)
    }
    if (['PreEndOfGame', 'WaitingForStats', 'EndOfGame'].includes(phase) && this.currentGameId) {
      const id = this.currentGameId
      this.currentGameId = null
      void this.fetchSummary(id)
    }
    if (phase === 'InProgress') {
      // remember the queue (and id) of the running game (the champ-select queue is cleared when it ends)
      void this.client
        ?.get<{ gameData?: { gameId?: number; queue?: { id?: number } } }>('/lol-gameflow/v1/session')
        .then((s) => {
          this.gameQueueId = s?.gameData?.queue?.id ?? null
          this.currentGameId = s?.gameData?.gameId ?? null
        })
        .catch(() => undefined)
      this.startLivePolling()
    } else {
      this.gameQueueId = null
      this.stopLivePolling()
    }
  }

  /** Queue id of the game in progress (2400 = ARAM: Mayhem), null when unknown. */
  getGameQueueId(): number | null {
    return this.gameQueueId
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

  /** bumped on every stop – a request still in flight then must not schedule the next poll */
  private liveGen = 0

  private startLivePolling(): void {
    if (this.liveTimer) return
    const gen = this.liveGen
    const poll = async (): Promise<void> => {
      const state = parseLiveData(await fetchAllGameData())
      if (gen !== this.liveGen) return // the game ended while the request was running
      if (state) state.premades = this.premades
      this.liveState = state
      this.deps.emit.live(state)
      this.liveTimer = setTimeout(poll, LIVE_POLL_MS)
    }
    this.liveTimer = setTimeout(poll, 0)
  }

  private stopLivePolling(): void {
    this.liveGen++
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
    if (!client) return { errors: ['League client is not connected.'] }
    const build = await this.deps.build(championId, role, mode)
    if (!build) return { errors: ['No data for this champion yet – start the crawler.'] }
    const data = await this.deps.staticData()
    const champName = data.champions[championId]?.name ?? String(championId)

    if (what.includes('runes')) {
      try {
        result.runes = await this.importRunes(client, build, champName)
      } catch (e) {
        result.errors.push(`Runes: ${(e as Error).message}`)
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
        result.errors.push(`Summoner spells: ${(e as Error).message}`)
      }
    }
    return result
  }

  /** The player's own ARAM: Mayhem games from the client's match history. */
  async personalMayhem(): Promise<MayhemPersonal | null> {
    if (!this.client) return null
    const history = await this.client.get<LcuHistory>('/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=100')
    return personalMayhemStats(history, this.status.summoner?.puuid ?? null)
  }

  private async importRunes(client: LcuClient, build: ChampionBuild, champName: string): Promise<string> {
    const payload = buildRunePagePayload(build, champName)
    if (!payload) throw new Error('no rune data')
    const pages = await client.get<PerkPage[]>('/lol-perks/v1/pages')
    for (const p of pages.filter((p) => isOurRunePage(p.name) && p.isDeletable)) {
      await client.request('DELETE', `/lol-perks/v1/pages/${p.id}`)
    }
    try {
      await client.request('POST', '/lol-perks/v1/pages', payload)
    } catch {
      // page limit reached – replace the currently selected editable page (same as other companion apps)
      const current = pages.find((p) => p.current && p.isDeletable && !isOurRunePage(p.name))
      if (!current) throw new Error('No free rune page available.')
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
