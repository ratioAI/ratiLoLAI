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
import { modeResults, personalMayhemStats, type LcuHistory } from '../mayhem'
import { mergeResults, type GameResults } from '../records'
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
    client(status: ClientStatus): void
    champSelect(state: ChampSelectState | null): void
    live(state: LiveGameState | null): void
    imported(result: ImportResult & { championId: number }): void
    loading(state: LoadingState | null): void
    summary(summary: GameSummary): void
    /** Everyone accepted (ready check went straight to champ select). The app jumps to a new galaxy. */
    matchAccepted(): void
  }
  /** Gold/kill lead recorded from the live data, used when the client has no timeline. */
  liveCurve(): CurvePoint[]
  /** Extra sources for the loading-screen win rates (our saved games, the Riot API). */
  records?: {
    local(puuids: string[], mode: 'mayhem' | 'aram'): Promise<Map<string, GameResults>>
    riot(puuid: string, mode: 'mayhem' | 'aram'): Promise<GameResults | null>
  }
  log?(message: string): void
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

interface ReadyCheck {
  state?: string
  playerResponse?: string
  /** seconds since the ready check started */
  timer?: number
}

/**
 * Keeps a connection to the local League client (LCU). Follows the gameflow, parses champ select,
 * auto-imports builds and polls live game data.
 */
export class LcuManager {
  private client: LcuClient | null = null
  private status: ClientStatus = { connected: false, phase: 'None', summoner: null }
  private champSelectState: ChampSelectState | null = null
  private liveState: LiveGameState | null = null
  private lastAutoImport = ''
  private queue: { id: number | null; gameMode: string | null } = { id: null, gameMode: null }
  private importTimer: NodeJS.Timeout | null = null
  private gameQueueId: number | null = null
  /** ARAM/Mayhem have no lock-in, so we import once the champion has been stable for this long. */
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

  private setStatus(patch: Partial<ClientStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.emit.client(this.status)
  }

  private async tryConnect(): Promise<void> {
    this.connecting = true
    try {
      const credentials = await findCredentials(this.deps.settings().leaguePath || undefined)
      if (!credentials) return
      const client = new LcuClient(credentials)
      await client.connect([
        'OnJsonApiEvent_lol-gameflow_v1_gameflow-phase',
        'OnJsonApiEvent_lol-champ-select_v1_session',
        'OnJsonApiEvent_lol-matchmaking_v1_ready-check',
        'OnJsonApiEvent_lol-summoner_v1_current-summoner'
      ])
      this.client = client
      client.on('event', (event: LcuEvent) => void this.onEvent(event))
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
      const [summoner, region] = await Promise.all([
        this.client.get<{ gameName: string; tagLine: string; puuid: string; summonerLevel: number; profileIconId: number }>(
          '/lol-summoner/v1/current-summoner'
        ),
        this.client.get<{ region: string }>('/riotclient/region-locale').catch(() => ({ region: '' }))
      ])
      return {
        gameName: summoner.gameName,
        tagLine: summoner.tagLine,
        puuid: summoner.puuid,
        summonerLevel: summoner.summonerLevel,
        profileIconId: summoner.profileIconId,
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

  private async onEvent(event: LcuEvent): Promise<void> {
    switch (event.uri) {
      case '/lol-gameflow/v1/gameflow-phase':
        this.setStatus({ phase: String(event.data) })
        if (event.data === 'ChampSelect') await this.fetchQueue()
        this.onPhase(String(event.data))
        break
      case '/lol-champ-select/v1/session':
        if (event.eventType === 'Delete') {
          this.champSelectState = null
          this.lastAutoImport = ''
          this.queue = { id: null, gameMode: null }
          this.deps.emit.champSelect(null)
        } else {
          if (this.queue.id === null) await this.fetchQueue()
          this.onChampSelect(event.data as RawSession)
        }
        break
      case '/lol-matchmaking/v1/ready-check':
        this.onReadyCheck(event.data as ReadyCheck | null)
        break
      case '/lol-summoner/v1/current-summoner':
        this.setStatus({ summoner: await this.fetchSummoner() })
        break
    }
  }

  // --- auto accept ---

  private acceptTimer: NodeJS.Timeout | null = null

  private cancelAccept(): void {
    if (this.acceptTimer) clearTimeout(this.acceptTimer)
    this.acceptTimer = null
  }

  /**
   * Accepts the ready check after a random, human-like delay instead of the moment it pops.
   * Uses the same client endpoint as the Accept button. If the player answers themselves or the
   * check ends first, the pending accept is dropped.
   */
  private onReadyCheck(readyCheck: ReadyCheck | null): void {
    const clientSettings = this.deps.settings().client
    const open = readyCheck?.state === 'InProgress' && readyCheck.playerResponse === 'None'
    if (!clientSettings.autoAccept || !open) return this.cancelAccept()
    if (this.acceptTimer) return
    const delay = acceptDelayMs(clientSettings.acceptDelay, readyCheck?.timer)
    this.acceptTimer = setTimeout(async () => {
      this.acceptTimer = null
      // re-check right before accepting, the state may have changed during the delay
      const latest = await this.client?.get<ReadyCheck>('/lol-matchmaking/v1/ready-check').catch(() => null)
      if (!this.deps.settings().client.autoAccept || latest?.state !== 'InProgress' || latest.playerResponse !== 'None') return
      await this.client?.request('POST', '/lol-matchmaking/v1/ready-check/accept').catch(() => undefined)
    }, delay)
  }

  // --- party & loading screen ---

  private currentGameId: number | null = null

  /**
   * Post-game summary from the client's match history (all ten players, augments) plus its timeline
   * (gold per minute, kills). The entry can take a while to show up, so we retry for about 2 minutes.
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
      await new Promise((resolve) => setTimeout(resolve, 5000))
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
    const summoner = await this.client
      ?.get<{ gameName?: string; tagLine?: string }>(`/lol-summoner/v2/summoners/puuid/${puuid}`)
      .catch(() => null)
    return summoner?.gameName ? `${summoner.gameName}#${summoner.tagLine ?? ''}` : ''
  }

  /** Remembers who is in the lobby with us, shown as premades during the game. */
  private async fetchParty(): Promise<void> {
    const lobby = await this.client?.get<{ members?: { puuid?: string }[] }>('/lol-lobby/v2/lobby').catch(() => null)
    const myPuuid = this.status.summoner?.puuid
    const puuids = (lobby?.members ?? []).map((member) => member.puuid).filter((puuid): puuid is string => !!puuid && puuid !== myPuuid)
    if (!puuids.length && !lobby) return // no lobby right now, keep what we had
    this.premadePuuids = new Set(puuids)
    this.premades = (await Promise.all(puuids.map((puuid) => this.riotIdOf(puuid)))).filter(Boolean)
  }

  /**
   * Loading screen: takes the players from the game session and looks up each one's recent games in
   * this mode from the client's match history (same data the in-client profile shows).
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
    const gameData = session?.gameData
    const queueId = gameData?.queue?.id ?? null
    // KIWI is the internal gameMode of ARAM: Mayhem
    const mode: LoadingState['mode'] | null =
      gameData?.queue?.gameMode === 'KIWI' || (queueId !== null && (QUEUE_IDS.mayhem as readonly number[]).includes(queueId))
        ? 'mayhem'
        : gameData?.queue?.gameMode === 'ARAM' || (queueId !== null && (QUEUE_IDS.aram as readonly number[]).includes(queueId))
          ? 'aram'
          : null
    if (!gameData || !mode || gameData.gameId === this.loadingGame) return
    this.loadingGame = gameData.gameId ?? null
    const myPuuid = this.status.summoner?.puuid
    const myTeam = (gameData.teamOne ?? []).some((player) => player.puuid === myPuuid) ? (gameData.teamOne ?? []) : (gameData.teamTwo ?? [])
    const everyone = [...(gameData.teamOne ?? []), ...(gameData.teamTwo ?? [])].filter((player) => player.puuid)
    const players: LoadingPlayer[] = everyone.map((player) => ({
      puuid: player.puuid!,
      riotId: player.gameName ? `${player.gameName}#${player.tagLine ?? ''}` : (player.summonerName ?? ''),
      championId: player.championId ?? 0,
      ally: myTeam.includes(player),
      me: player.puuid === myPuuid,
      premade: this.premadePuuids.has(player.puuid!),
      record: null,
      loading: true
    }))
    this.loadingState = { mode, players }
    this.deps.emit.loading(this.loadingState)

    // Win rates come from three sources, merged by game id so nothing is counted twice:
    // 1. our own saved games (every game played with ratioAI, so premades add up over time)
    // 2. the player's client match history (the client often returns little or nothing for others)
    // 3. the Riot API for players that still have only a few games (needs an API key, rate limited)
    const local =
      (await this.deps.records
        ?.local(
          players.map((player) => player.puuid),
          mode
        )
        .catch(() => null)) ?? new Map()
    const fromClient = new Map<string, GameResults>()
    const update = (player: LoadingPlayer, ...extra: (GameResults | null)[]): void => {
      const record = mergeResults(local.get(player.puuid), fromClient.get(player.puuid), ...extra)
      player.record = record.games ? record : null
    }
    const publish = (): void => {
      if (this.loadingState?.players === players) this.deps.emit.loading({ mode, players: [...players] })
    }
    for (const player of players) update(player)
    publish()

    // names and client history, three at a time so we don't hammer the client while the game loads
    const pending = [...players]
    const worker = async (): Promise<void> => {
      for (let player = pending.shift(); player; player = pending.shift()) {
        if (!player.riotId) player.riotId = await this.riotIdOf(player.puuid)
        const history = await client
          .get<LcuHistory>(`/lol-match-history/v1/products/lol/${player.puuid}/matches?begIndex=0&endIndex=99`)
          .catch(() => null)
        if (history) fromClient.set(player.puuid, modeResults(history, player.puuid, mode))
        update(player)
        player.loading = !!this.deps.records && (player.record?.games ?? 0) < LcuManager.ENOUGH_GAMES
        publish()
      }
    }
    await Promise.all([worker(), worker(), worker()])

    // players with too few games: ask the Riot API, one after another (the rate limiter paces it)
    for (const player of players) {
      if (!player.loading) continue
      const fromRiot = await this.deps.records!.riot(player.puuid, mode).catch(() => null)
      update(player, fromRiot)
      player.loading = false
      publish()
    }
    this.deps.log?.(
      `loading screen records: ${players
        .map(
          (player) =>
            `${player.riotId.split('#')[0] || '?'} ${player.record ? `${player.record.wins}/${player.record.games}` : '–'} (saved ${local.get(player.puuid)?.size ?? 0}, client ${fromClient.get(player.puuid)?.size ?? '✗'})`
        )
        .join(', ')}`
    )
  }

  /** below this many games a player's record is filled up from the Riot API */
  private static readonly ENOUGH_GAMES = 5

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
      const gameId = this.currentGameId
      this.currentGameId = null
      void this.fetchSummary(gameId)
    }
    if (phase === 'InProgress') {
      // remember queue and game id of the running game, the champ select queue is cleared when it ends
      void this.client
        ?.get<{ gameData?: { gameId?: number; queue?: { id?: number } } }>('/lol-gameflow/v1/session')
        .then((session) => {
          this.gameQueueId = session?.gameData?.queue?.id ?? null
          this.currentGameId = session?.gameData?.gameId ?? null
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
      // champions can still be swapped via the bench, so wait until the pick settles
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
    const clientSettings = this.deps.settings().client
    const what = [
      ...(clientSettings.autoImportRunes ? (['runes'] as const) : []),
      ...(clientSettings.autoImportItems ? (['items'] as const) : []),
      ...(clientSettings.autoImportSpells ? (['spells'] as const) : [])
    ]
    if (!what.length) return
    this.lastAutoImport = key
    const mode = statsModeOf(state.mode)
    const role = mode === 'aram' ? 'ARAM' : state.myRole
    void this.importBuild(state.myChampionId, role, [...what], mode).then((result) =>
      this.deps.emit.imported({ ...result, championId: state.myChampionId })
    )
  }

  // --- live game ---

  /** Bumped on every stop, so a request still in flight doesn't schedule another poll. */
  private liveGeneration = 0

  private startLivePolling(): void {
    if (this.liveTimer) return
    const generation = this.liveGeneration
    const poll = async (): Promise<void> => {
      const state = parseLiveData(await fetchAllGameData())
      if (generation !== this.liveGeneration) return // game ended while the request was running
      if (state) state.premades = this.premades
      this.liveState = state
      this.deps.emit.live(state)
      this.liveTimer = setTimeout(poll, LIVE_POLL_MS)
    }
    this.liveTimer = setTimeout(poll, 0)
  }

  private stopLivePolling(): void {
    this.liveGeneration++
    if (this.liveTimer) clearTimeout(this.liveTimer)
    this.liveTimer = null
    if (this.liveState) {
      this.liveState = null
      this.deps.emit.live(null)
    }
  }

  // --- import ---

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
    const championName = data.champions[championId]?.name ?? String(championId)

    if (what.includes('runes')) {
      try {
        result.runes = await this.importRunes(client, build, championName)
      } catch (err) {
        result.errors.push(`Runes: ${(err as Error).message}`)
      }
    }
    if (what.includes('items')) {
      try {
        result.items = await this.importItems(client, build, data)
      } catch (err) {
        result.errors.push(`Items: ${(err as Error).message}`)
      }
    }
    if (what.includes('spells')) {
      try {
        const order = orderSpells(build.spells[0]?.value ?? [], this.deps.settings().client.flashOn)
        if (order && this.champSelectState?.active) {
          await client.request('PATCH', '/lol-champ-select/v1/session/my-selection', { spell1Id: order[0], spell2Id: order[1] })
          result.spells = order.map((id) => data.spells[id]?.name ?? id).join(' + ')
        }
      } catch (err) {
        result.errors.push(`Summoner spells: ${(err as Error).message}`)
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

  private async importRunes(client: LcuClient, build: ChampionBuild, championName: string): Promise<string> {
    const payload = buildRunePagePayload(build, championName)
    if (!payload) throw new Error('no rune data')
    const pages = await client.get<PerkPage[]>('/lol-perks/v1/pages')
    for (const page of pages.filter((page) => isOurRunePage(page.name) && page.isDeletable)) {
      await client.request('DELETE', `/lol-perks/v1/pages/${page.id}`)
    }
    try {
      await client.request('POST', '/lol-perks/v1/pages', payload)
    } catch {
      // page limit reached: replace the currently selected page, like other companion apps do
      const current = pages.find((page) => page.current && page.isDeletable && !isOurRunePage(page.name))
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
    const itemSet = buildItemSet(build, data)
    // replace our previous set for this champion instead of adding another one
    const itemSets = current.itemSets.filter(
      (existing) => existing.uid !== itemSet.uid && !(existing.uid ?? '').startsWith(`${ITEM_SET_UID_PREFIX}${build.championId}`)
    )
    itemSets.unshift(itemSet)
    await client.request('PUT', path, { ...current, itemSets, timestamp: Date.now() })
    return itemSet.title
  }
}
