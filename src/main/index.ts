import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type {
  ChampionBuild,
  GameMode,
  LiveGameState,
  PatchStats,
  Platform,
  RcEvents,
  Settings,
  StatRole,
  TierEntry,
  UpdateState,
  OverlayDiagnostics,
  MinimapState,
  AugmentOffer
} from '@shared/types'
import { GAME_MODES, PLATFORMS, QUEUE_IDS } from '@shared/types'
import { buildChampionView, buildTierList } from '@shared/analysis'
import { Crawler } from './crawler/crawler'
import { StatsStore } from './crawler/statsStore'
import { DataDragon, makeClassifier } from './ddragon'
import { LcuManager } from './lcu/manager'
import { MayhemService } from './mayhem'
import { OverlayManager } from './overlay'
import { MinimapWatcher } from './minimap/watcher'
import { INHIBITOR_POS, minimapRect, RELICS } from './minimap/timers'
import { AugmentScanner, type ScanState } from './scanner/scanner'
import { DiagLog } from './diag'
import { GameStore } from './games'
import type { CurvePoint } from '@shared/summary'
import { CaptureService } from './capture/captureService'
import { cardRects, WINDOWS, type NameCandidate } from './scanner/detect'
import { augmentTiersForChampion } from '@shared/mayhem'
import { ProfileService } from './profile'
import { sanitizeApiKey, isValidKeyFormat } from './riot/apiKey'
import { RiotClient, regionalOf } from './riot/client'
import { resultsFromSummaries, type GameResults, type RecordMode } from './records'
import { SettingsStore } from './settings'

// The app used to be called "Rift Companion". Move its data (settings, encrypted API key, crawled
// stats, caches) to the new folder once, or keep using the old folder if the move fails.
{
  const legacy = join(app.getPath('appData'), 'Rift Companion')
  const current = app.getPath('userData')
  if (legacy !== current && existsSync(legacy) && !existsSync(join(current, 'settings.json'))) {
    try {
      if (existsSync(current)) rmSync(current, { recursive: true, force: true })
      renameSync(legacy, current)
    } catch {
      app.setPath('userData', legacy)
    }
  }
}

if (!app.requestSingleInstanceLock()) app.quit()

const userData = app.getPath('userData')
const settings = new SettingsStore(join(userData, 'settings.json'))
const ddragon = new DataDragon(join(userData, 'ddragon'), settings.get().language)
const store = new StatsStore(join(userData, 'stats'))
const riot = new RiotClient(() => settings.getApiKey())
const profiles = new ProfileService(riot)
const mayhem = new MayhemService(join(userData, 'mayhem.json'), settings.get().language)

let mainWindow: BrowserWindow | null = null

/**
 * Events the overlay windows listen to. Everything else only goes to the main window.
 * 'loading' and 'framesOffer' are sent to their own window directly since the data is window specific.
 */
const OVERLAY_EVENTS = new Set<keyof RcEvents>(['live', 'overlayToggle', 'augmentCards', 'overlayPreview', 'augmentsOwned', 'minimap'])

/**
 * Sends an event to the windows that use it: the main window gets everything, the overlay windows
 * only their few events, the hidden capture page none. Each send is a structured clone plus an IPC
 * hop per window, and the live state goes out every second during a game.
 */
function emit<K extends keyof RcEvents>(event: K, payload: RcEvents[K]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('rc:event', event, payload)
  if (OVERLAY_EVENTS.has(event)) overlay.broadcast(event, payload)
}

/**
 * Checks the saved key against the Challenger league endpoint, which works with every key type. A
 * freshly generated development key is sometimes rejected for a moment until Riot has activated it
 * everywhere, so 401/403 are retried for about 20 s before the key counts as bad.
 */
async function testApiKey(): Promise<{ ok: boolean; message: string }> {
  const delays = [0, 2000, 4000, 6000, 8000]
  let lastError: unknown = null
  for (const delayMs of delays) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      await riot.request(settings.get().platform, '/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5')
      return {
        ok: true,
        message: lastError ? 'API key saved and valid ✔ (Riot needed a moment to activate it)' : 'API key saved and valid ✔'
      }
    } catch (err) {
      lastError = err
      const status = (err as { status?: number }).status
      if (status !== 401 && status !== 403) break // only "key not known yet" is worth waiting for
    }
  }
  return { ok: false, message: `Key saved, but the test failed: ${(lastError as Error).message}` }
}

function loadRenderer(browserWindow: BrowserWindow, hash = ''): void {
  if (process.env.ELECTRON_RENDERER_URL) void browserWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  else void browserWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

// --- In-game overlay ---
//
// Small transparent windows instead of one full-screen one: the tier panel (right edge), the
// animated card frames (only over the cards) and the minimap timers. They are only shown when
// needed: panel and frames while the augment choice can be open, the timers during ARAM games.

const diag = new DiagLog(join(userData, 'logs', 'overlay.log'))
const capture = new CaptureService(join(__dirname, '../preload/index.js'), join(__dirname, '../renderer'), (message) => diag.log(message))
let inGame = false
let inMayhem = false
let manualOpen = false
let hintOpen = false
let cards: ScanState = { visible: false, offer: null, displayId: null }
/** JSON of the offer the frames currently show, to skip redundant updates */
let shownOffer = ''
let minimapState: MinimapState | null = null
let lastTick = { level: 0, dead: false, gameMode: null as string | null }

const overlay = new OverlayManager(join(__dirname, '../preload/index.js'), loadRenderer, () => {
  // hotkey: scan for the cards right away, and toggle the tier list panel if it is enabled
  if (settings.get().overlay.autoExpand) manualOpen = !manualOpen
  diag.log(`hotkey → scan now${manualOpen ? ', panel open' : ''} (inGame=${inGame}, mayhem=${inMayhem})`)
  if (scanner.running) scanner.lookNow(WINDOWS.manual)
  refreshOverlay()
  void overlay.panel.send('overlayToggle', null)
})

function refreshOverlay(): void {
  const current = settings.get()
  // the tier list panel is opt-in ("Also show the tier list panel" in the settings)
  const panel =
    current.overlay.enabled && current.overlay.autoExpand && ((inGame && manualOpen) || (inMayhem && (cards.visible || hintOpen)))
  if (panel) overlay.showPanel()
  else overlay.hidePanel()

  const offer = current.overlay.enabled && current.overlay.cardFrames && inMayhem ? cards.offer : null
  const key = offer ? JSON.stringify(offer) : ''
  if (key !== shownOffer) {
    shownOffer = key
    diag.log(offer ? 'frames shown' : 'frames hidden')
    if (process.env.RC_SELFTEST_NO_FRAMES) return // xvfb has no compositor, so our own window would cover the cards
    if (offer) overlay.showFrames(offer)
    else overlay.hideFrames()
  }

  const mapState = minimapState
  const hasTimers = !!mapState && (mapState.inhibitors.length > 0 || mapState.relics.some((relic) => relic.state !== 'unknown'))
  if (mapState && current.minimap.enabled && hasTimers) {
    const local = overlay.showMinimap(minimap.displayId, mapState.rect)
    void overlay.minimap.send('minimap', { ...mapState, local })
  } else if (overlay.minimap.visible) {
    overlay.hideMinimap()
    void overlay.minimap.send('minimap', null)
  }
}

const gameDisplay = {
  get: (): number | null => settings.get().overlay.gameDisplayId,
  set: (id: number): void => {
    if (settings.get().overlay.gameDisplayId !== id) settings.update({ overlay: { ...settings.get().overlay, gameDisplayId: id } })
  }
}

// screen recognition of the offered augment cards, only runs while an augment is pending
let candidates: NameCandidate[] = []
const scanner = new AugmentScanner(
  join(userData, 'ocr'),
  () => candidates,
  (state) => {
    const wasVisible = cards.visible
    cards = state
    if (state.displayId !== null) overlay.moveToDisplay(state.displayId)
    if (wasVisible && !state.visible) manualOpen = false // augment picked, close the overlay
    void overlay.panel.send('augmentCards', { visible: state.visible })
    refreshOverlay()
  },
  (message) => diag.log(message),
  capture,
  gameDisplay
)

scanner.snapshotDir = join(userData, 'logs')
scanner.overlayInCapture = () => settings.get().overlay.showInCapture

// augments picked in the running Mayhem game
let owned: number[] = []
let ownedGameTime = 0
function setOwned(ids: number[]): void {
  owned = [...new Set(ids)].slice(0, 4)
  emit('augmentsOwned', owned)
}
scanner.onPicked = (id) => {
  // never more augments than the level allows (a card that just got covered up is not a pick)
  if (owned.includes(id)) return
  if (owned.length >= Math.max(1, scanner.schedule.earned)) {
    diag.log(`ignoring pick ${id}: already ${owned.length} augments at this level`)
    return
  }
  setOwned([...owned, id])
}
scanner.onUnpicked = (id) => setOwned(owned.filter((ownedId) => ownedId !== id))

// inhibitor timers on the minimap (ARAM); the game shows health relic timers itself
const minimap = new MinimapWatcher(
  () => settings.get().minimap,
  () => gameDisplay.get(),
  (state) => {
    minimapState = state
    emit('mapTimers', state)
    refreshOverlay()
  },
  capture,
  (message) => diag.log(message)
)

// --- Loading screen panel (Mayhem/ARAM win rates of all players, Space toggles it) ---
let loadingHidden = false
/** Galaxy seed of the current game, so the loading screen shows the one the app jumped to. */
let cosmosSeed = Date.now()

function refreshLoading(): void {
  const state = lcu.getLoading()
  const live = lcu.getLive()
  const started = !!live?.active && live.gameTime > 1
  const shouldShow = !!state && !started && settings.get().overlay.loadingScreen
  if (shouldShow) {
    overlay.holdKey('Space', () => {
      loadingHidden = !loadingHidden
      refreshLoading()
    })
    if (loadingHidden) overlay.hideLoading()
    else {
      overlay.showLoading(gameDisplay.get())
      void overlay.loading.send('loading', { ...state, seed: cosmosSeed })
    }
  } else {
    overlay.holdKey(null)
    overlay.hideLoading()
    if (!state) loadingHidden = false
  }
}

async function loadCandidates(): Promise<void> {
  const data = await mayhem.get().catch(() => null)
  if (data) candidates = Object.values(data.augments).map((augment) => ({ id: augment.id, names: [augment.name, augment.nameEn] }))
}

function updateOverlay(live: LiveGameState | null): void {
  const overlaySettings = settings.get().overlay
  const wasInGame = inGame
  inGame = !!live?.active
  const queueId = lcu.getGameQueueId()
  // KIWI is the game mode name of ARAM: Mayhem
  const nowMayhem = inGame && (live!.gameMode === 'KIWI' || (queueId !== null && (QUEUE_IDS.mayhem as readonly number[]).includes(queueId)))
  const aram = inGame && (nowMayhem || live!.gameMode === 'ARAM' || queueId === 450)
  if (inGame && (!wasInGame || live!.gameMode !== lastTick.gameMode)) {
    diag.log(`game detected: gameMode=${live!.gameMode} queue=${queueId ?? '?'} → mayhem=${nowMayhem}`)
    lastTick.gameMode = live!.gameMode
  }
  minimap.update(live, aram)
  // the game clock went backwards, so this is a new game: forget the last game's augments
  if (inGame) {
    if (live!.gameTime + 5 < ownedGameTime && owned.length) setOwned([])
    ownedGameTime = live!.gameTime
  }
  if (nowMayhem && overlaySettings.enabled) {
    if (!inMayhem) overlay.prepare()
    inMayhem = true
    const me = live!.players.find((player) => player.riotId === live!.activePlayer)
    const level = me?.level ?? 0
    const dead = me?.isDead ?? false
    if (level !== lastTick.level || dead !== lastTick.dead) {
      diag.log(`level ${level}${dead ? ', dead' : ''}${me ? '' : ' (player not found: ' + live!.activePlayer + ')'}`)
      lastTick = { ...lastTick, level, dead }
    }
    if (overlaySettings.cardFrames) {
      if (!scanner.running) {
        scanner.start()
        scanner.warmup()
        void loadCandidates()
      }
      scanner.update({ level, dead, gameTime: live!.gameTime, itemsKey: (me?.items ?? []).join(',') })
    }
    // small "augment ready" pill while the choice can be open (dead or at the start of the game)
    const schedule = scanner.schedule
    hintOpen = overlaySettings.cardFrames && schedule.pending && (dead || live!.gameTime < WINDOWS.gameStart)
  } else {
    if (inMayhem) diag.log('left the Mayhem game')
    inMayhem = false
    hintOpen = false
    cards = { visible: false, offer: null, displayId: null }
    if (scanner.running) scanner.stop()
  }
  if (!inGame) {
    manualOpen = false
    lastTick = { level: 0, dead: false, gameMode: null }
  }
  refreshOverlay()
}

function overlayDiagnostics(): OverlayDiagnostics {
  const live = lcu.getLive()
  return {
    gameMode: live?.gameMode ?? null,
    queueId: lcu.getGameQueueId(),
    mayhem: inMayhem,
    level: lastTick.level,
    dead: lastTick.dead,
    augmentPending: scanner.schedule.pending,
    canOpen: scanner.schedule.canOpen(),
    scanning: scanner.scanning,
    cardsVisible: cards.visible,
    overlayVisible: overlay.anyVisible,
    captureStream: capture.failed ? `failed: ${capture.failed}` : capture.active ? 'running' : 'off',
    log: diag.recent(40)
  }
}

// --- Auto update ---

let updateState: UpdateState = { status: app.isPackaged ? 'idle' : 'dev' }
function setUpdate(state: UpdateState): void {
  updateState = state
  emit('update', state)
}

function initAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }))
  autoUpdater.on('update-available', (info) => setUpdate({ status: 'downloading', version: info.version, progress: 0 }))
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none' }))
  autoUpdater.on('download-progress', (progress) => setUpdate({ ...updateState, status: 'downloading', progress: progress.percent }))
  autoUpdater.on('update-downloaded', (info) => setUpdate({ status: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => setUpdate({ status: 'error', message: err?.message ?? String(err) }))
  const check = (): void => void autoUpdater.checkForUpdates().catch(() => undefined)
  check()
  setInterval(check, 4 * 3600 * 1000) // every 4 hours
}

// --- Statistics helpers ---

/** Tier lists per "mode:patch", valid as long as the stats' updatedAt matches. */
const tierCache = new Map<string, { at: number; list: TierEntry[] }>()

function assertMode(mode: unknown): GameMode {
  return mode === 'aram' ? 'aram' : 'ranked'
}

async function statsFor(patch: string, mode: GameMode): Promise<PatchStats> {
  return (await store.load(patch, mode)).stats
}

async function tierList(patch: string, mode: GameMode): Promise<TierEntry[]> {
  const stats = await statsFor(patch, mode)
  const key = `${mode}:${patch}`
  const cached = tierCache.get(key)
  if (cached && cached.at === stats.updatedAt) return cached.list
  const list = buildTierList(stats, settings.get().crawler.minGamesForTierList)
  tierCache.set(key, { at: stats.updatedAt, list })
  return list
}

async function currentPatch(mode: GameMode): Promise<string> {
  const known = await store.patches(mode)
  const livePatch = (await ddragon.get().catch(() => null))?.patch
  // prefer the newest patch with data, fall back to the live patch
  return known.find((entry) => entry.matches > 0)?.patch ?? livePatch ?? known[0]?.patch ?? '0.0'
}

async function championBuild(
  patch: string,
  championId: number,
  role: StatRole | null | undefined,
  mode: GameMode
): Promise<ChampionBuild | null> {
  return buildChampionView(await statsFor(patch, mode), championId, role ?? undefined, await tierList(patch, mode))
}

// --- Services ---

const crawler = new Crawler(
  riot,
  store,
  (status) => emit('crawler', status),
  (patch, mode) => {
    tierCache.delete(`${mode}:${patch}`)
    emit('statsUpdated', { patch, mode })
  }
)

// --- Post-game summaries ---
const games = new GameStore(join(userData, 'games'))
/** Gold and kill lead sampled every 15 s from the live data, used as a fallback curve for the summary. */
let liveCurve: CurvePoint[] = []
let liveCurveAt = -1
async function recordCurve(live: LiveGameState | null): Promise<void> {
  if (!live?.active) return
  if (live.gameTime < liveCurveAt) liveCurve = [] // new game
  if (live.gameTime - liveCurveAt < 15 && liveCurve.length) return
  liveCurveAt = live.gameTime
  const statics = await ddragon.get().catch(() => null)
  const me = live.players.find((player) => player.riotId === live.activePlayer)
  if (!me || !statics) return
  // the live client API has no gold for other players, so use the value of their items instead
  let gold = 0
  let kills = 0
  for (const player of live.players) {
    const sign = player.team === me.team ? 1 : -1
    gold += sign * player.items.reduce((sum, id) => sum + (statics.items[id]?.gold ?? 0), 0)
    kills += sign * player.kills
  }
  liveCurve.push({ t: live.gameTime, gold, kills })
}

/** Riot API matches already looked up (premades share most of their games, so this saves a lot of requests). */
const riotMatchCache = new Map<string, { gameId: number; winners: Set<string>; players: Set<string> } | null>()

/**
 * A player's last few games in a mode from the Riot API, as gameId → won. Used on the loading screen
 * for players whose client match history is empty. null without an API key.
 */
async function riotResults(puuid: string, mode: RecordMode): Promise<GameResults | null> {
  if (!settings.getApiKey()) return null
  const regional = regionalOf(settings.get().platform)
  const queues = mode === 'mayhem' ? QUEUE_IDS.mayhem : [GAME_MODES.aram.queue]
  let matchIds: string[] = []
  for (const queue of queues) {
    matchIds = await riot.matchIds(regional, puuid, { queue, count: RIOT_GAMES_PER_PLAYER })
    if (matchIds.length) break
  }
  const results: GameResults = new Map()
  for (const matchId of matchIds) {
    if (!riotMatchCache.has(matchId)) {
      const match = await riot.match(regional, matchId).catch(() => null)
      riotMatchCache.set(
        matchId,
        match
          ? {
              gameId: match.info.gameId,
              winners: new Set(match.info.participants.filter((participant) => participant.win).map((participant) => participant.puuid)),
              players: new Set(match.info.participants.map((participant) => participant.puuid))
            }
          : null
      )
    }
    const cached = riotMatchCache.get(matchId)
    if (cached?.players.has(puuid)) results.set(cached.gameId, cached.winners.has(puuid))
  }
  return results
}
/** a dev key allows 100 requests per 2 minutes – 9 players × (1 + 8) stays below that */
const RIOT_GAMES_PER_PLAYER = 8

/** One crawler run for a mode with the current settings; resolves when the run is over. */
async function startCrawl(mode: GameMode): Promise<void> {
  const current = settings.get()
  const data = await ddragon.get()
  await crawler.start({
    patch: data.patch,
    mode,
    platforms: [...new Set([current.platform, ...current.crawler.extraPlatforms])],
    seedTiers: current.crawler.seedTiers,
    maxMatches: current.crawler.maxMatchesPerRun,
    matchesPerPlayer: current.crawler.matchesPerPlayer,
    classify: makeClassifier(data)
  })
}

/**
 * Background crawling so nobody has to press "Start" after every update: ARAM first (what we mostly
 * play), then ranked. Already counted matches are skipped, so a run only adds what is new. Never
 * starts during a game or while a manual run is going.
 */
async function autoCrawl(): Promise<void> {
  const ready = () => settings.get().crawler.autoCrawl && !!settings.getApiKey() && !inGame && !crawler.getStatus().running
  if (!ready()) return
  for (const mode of ['aram', 'ranked'] as const) {
    if (!ready()) break
    diag.log(`auto crawl: ${mode}`)
    await startCrawl(mode).catch((err) => diag.log(`auto crawl ${mode} failed: ${(err as Error).message}`))
  }
}
const AUTO_CRAWL_FIRST_MS = 2 * 60_000
const AUTO_CRAWL_EVERY_MS = 6 * 3600_000

const lcu = new LcuManager({
  liveCurve: () => liveCurve,
  records: {
    local: async (puuids, mode) => resultsFromSummaries(await games.all(), puuids, mode),
    riot: riotResults
  },
  log: (message) => diag.log(message),
  settings: () => settings.get(),
  staticData: () => ddragon.get(),
  build: async (championId, role, mode) => championBuild(await currentPatch(mode), championId, role, mode),
  emit: {
    client: (status) => emit('client', status),
    champSelect: (champSelect) => {
      emit('champSelect', champSelect)
      // load the OCR engine during champion select, not when the first augment choice opens
      if (champSelect?.mode === 'mayhem' && settings.get().overlay.cardFrames) scanner.warmup()
    },
    loading: (loading) => {
      emit('loading', loading)
      refreshLoading()
    },
    live: (live) => {
      emit('live', live)
      void recordCurve(live)
      refreshLoading()
      updateOverlay(live)
    },
    imported: (result) => emit('imported', result),
    matchAccepted: () => {
      cosmosSeed = Date.now()
      emit('journey', { seed: cosmosSeed })
    },
    summary: (summary) => {
      diag.log(`game summary ready: ${summary.gameId} (${summary.win ? 'win' : 'loss'}, curve from ${summary.curveSource})`)
      void games.save(summary).then(() => emit('gameSummary', summary))
    }
  }
})

function assertPlatform(platform: string): Platform {
  if (!(platform in PLATFORMS)) throw new Error(`Unknown region: ${platform}`)
  return platform as Platform
}

// --- IPC ---

function registerIpc(): void {
  // errors are returned as values, the preload turns them back into exceptions
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, value: await fn(...(args as A)) }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  }

  handle('getStatic', () => ddragon.get())
  handle('getSettings', () => settings.get())
  handle('saveSettings', (patch: Partial<Omit<Settings, 'hasApiKey'>>) => {
    const next = settings.update(patch)
    ddragon.setLanguage(next.language)
    mayhem.setLanguage(next.language)
    overlay.setHotkey(next.overlay.hotkey)
    overlay.setVisibleInCapture(next.overlay.showInCapture)
    updateOverlay(lcu.getLive())
    tierCache.clear()
    return next
  })
  handle('setApiKey', async (key: string) => {
    const clean = sanitizeApiKey(key)
    if (!clean) {
      settings.setApiKey('')
      return { ok: true, message: 'API key removed.' }
    }
    if (!isValidKeyFormat(clean)) {
      return { ok: false, message: 'This does not look like a Riot API key (format: RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).' }
    }
    settings.setApiKey(clean)
    riot.resetForNewKey()
    const result = await testApiKey()
    diag.log(`API key saved, test: ${result.ok ? 'ok' : result.message}`)
    if (result.ok) crawler.clearKeyError()
    return result
  })
  handle('getPatches', (mode: GameMode) => store.patches(assertMode(mode)))
  handle('getTierList', (patch: string, mode: GameMode) => tierList(patch, assertMode(mode)))
  handle('getChampionBuild', (patch: string, championId: number, role: StatRole | undefined, mode: GameMode) =>
    championBuild(patch, championId, role, assertMode(mode))
  )
  handle('crawlerStart', (mode: GameMode) => {
    void startCrawl(assertMode(mode))
  })
  handle('crawlerStop', () => crawler.stop())
  handle('crawlerStatus', () => crawler.getStatus())
  handle('resetStats', async (patch: string, mode: GameMode) => {
    const checkedMode = assertMode(mode)
    await store.reset(patch, checkedMode)
    tierCache.delete(`${checkedMode}:${patch}`)
    emit('statsUpdated', { patch, mode: checkedMode })
  })
  handle('clientStatus', () => lcu.getStatus())
  handle('champSelect', () => lcu.getChampSelect())
  handle('liveGame', () => lcu.getLive())
  handle('importBuild', (championId: number, role: StatRole | null, what: ('runes' | 'items' | 'spells')[] | undefined, mode: GameMode) =>
    lcu.importBuild(championId, role, what, assertMode(mode))
  )
  handle('getMayhemData', () => mayhem.get())
  handle('getMayhemPersonal', () => lcu.personalMayhem())
  handle('overlayPreview', async (championId: number) => {
    // simulate an augment choice so the card frames can be checked without a game
    const display = screen.getAllDisplays().find((candidate) => candidate.id === (gameDisplay.get() ?? -1)) ?? screen.getPrimaryDisplay()
    overlay.moveToDisplay(display.id)
    let offer: AugmentOffer | null = null
    try {
      const [data, statics] = await Promise.all([mayhem.get(), ddragon.get()])
      const tiers = augmentTiersForChampion(data, statics, championId)
      // best, roughly 30th percentile and worst augment as examples
      const picks = [tiers[0], tiers[Math.floor(tiers.length * 0.3)], tiers[tiers.length - 1]].filter(Boolean)
      const rects = cardRects(display.size.width, display.size.height)
      offer = {
        displayId: display.id,
        championId,
        cards: picks.map((tier, i) => ({ augmentId: tier.augment.id, text: tier.augment.nameEn, score: 1, rect: rects[i] }))
      }
    } catch {
      // no data, so only the side panel is shown
    }
    overlay.preview(offer, () => void overlay.panel.send('overlayPreview', { championId }))
    // example inhibitor timers at the configured minimap position
    if (!inGame) {
      const rect = minimapRect(display.size.width, display.size.height, settings.get().minimap.scale)
      const demo: MinimapState = {
        gameTime: 200,
        measuredAt: Date.now(),
        rect,
        inhibitors: [
          { team: 'ORDER', respawnAt: 200 + 58, pos: INHIBITOR_POS.ORDER },
          { team: 'CHAOS', respawnAt: 200 + 134, pos: INHIBITOR_POS.CHAOS }
        ],
        relics: RELICS.map((relic, i) => ({
          ...relic,
          pos: { ...relic.pos },
          state: i % 2 ? 'up' : 'spawn',
          at: i % 2 ? null : 200 + 31 + i * 17
        }))
      }
      const local = overlay.showMinimap(display.id, rect)
      void overlay.minimap.send('minimap', { ...demo, local })
      setTimeout(() => {
        if (!inGame) {
          overlay.hideMinimap()
          void overlay.minimap.send('minimap', null)
        }
      }, 20_000)
    }
  })
  handle('overlayDiagnostics', () => overlayDiagnostics())
  handle('getOwnedAugments', () => owned)
  handle('getMapTimers', () => minimapState)
  handle('listGames', () => games.list())
  handle('getGame', (id: number) => games.get(Number(id)))
  handle('setOwnedAugments', (ids: number[]) => setOwned(Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id)) : []))
  handle('overlayScanNow', () => {
    diag.log('scan requested from the overlay')
    if (scanner.running) scanner.lookNow(WINDOWS.manual)
  })
  handle('overlayTestScan', async () => {
    if (!candidates.length) await loadCandidates()
    return scanner.testScan(join(userData, 'logs'))
  })
  handle('openDiagnosticsFolder', () => shell.openPath(join(userData, 'logs')).then(() => undefined))
  handle('appInfo', () => ({ version: app.getVersion(), update: updateState }))
  handle('installUpdate', () => {
    if (updateState.status === 'ready') autoUpdater.quitAndInstall()
  })
  handle('lookupProfile', (riotId: string, platform: string) => profiles.lookup(riotId, assertPlatform(platform)))
  handle('scoutActiveGame', (riotId: string, platform: string) => profiles.scout(riotId, assertPlatform(platform)))
  handle('openExternal', (url: string) => {
    if (/^https:\/\//.test(url)) return shell.openExternal(url)
    return undefined
  })
}

// --- Main window ---

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#07050f',
    title: 'ratioAI',
    icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#0c0818', symbolColor: '#c9b8f0', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  // the hidden overlay windows would otherwise keep the app alive
  mainWindow.on('closed', () => {
    mainWindow = null
    overlay.destroy()
    capture.destroy()
    if (process.platform !== 'darwin') app.quit()
  })
  // links open in the default browser, never inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow)
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

void app.whenReady().then(async () => {
  setTimeout(() => void autoCrawl(), AUTO_CRAWL_FIRST_MS)
  setInterval(() => void autoCrawl(), AUTO_CRAWL_EVERY_MS)
  // Developer self-tests, run headless under xvfb and controlled through environment variables.
  if (process.env.RC_OCR_SELFTEST) {
    const { nativeImage } = await import('electron')
    const result = await scanner.selfTest(nativeImage.createFromPath(process.env.RC_OCR_SELFTEST))
    console.log('RC_OCR_SELFTEST ' + JSON.stringify(result))
    app.exit(0)
    return
  }
  if (process.env.RC_BLINK_SELFTEST) {
    // samples the center pixel of a blinking test page to check that the capture stream delivers fresh frames
    const display = screen.getPrimaryDisplay()
    const testWindow = new BrowserWindow({ ...display.bounds, frame: false, show: true })
    await testWindow.loadFile(process.env.RC_BLINK_SELFTEST)
    capture.demand('t', { displays: [display.id], fps: 2 })
    const samples: string[] = []
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      const frames = await capture.grab(display, [{ x: 0.5, y: 0.5, w: 0.01, h: 0.01, outW: 1, outH: 1 }])
      samples.push(frames ? Array.from(frames[0].data.slice(0, 3)).join('/') : 'null')
    }
    console.log('RC_BLINK ' + samples.join('  '))
    app.exit(0)
    return
  }
  if (process.env.RC_GAME_SELFTEST) {
    // End-to-end check: RC_GAME_SELFTEST=<html showing an augment screenshot>. Fakes a Mayhem live
    // game (dead, level 1) on top of a real augment screenshot.
    const display = screen.getPrimaryDisplay()
    const background = new BrowserWindow({ ...display.bounds, frame: false, show: true })
    await background.loadFile(process.env.RC_GAME_SELFTEST)
    registerIpc()
    const fakeLive = (gameTime: number): LiveGameState => ({
      active: true,
      gameMode: 'KIWI',
      gameTime,
      activePlayer: 'me#1',
      activeChampion: 'Thresh',
      activeChampionKey: 'Thresh',
      players: [
        {
          riotId: 'me#1',
          championName: 'Thresh',
          team: 'ORDER',
          level: 1,
          kills: 0,
          deaths: 0,
          assists: 0,
          creepScore: 0,
          items: [],
          spells: [],
          position: '',
          isDead: true,
          respawnTimer: 5
        }
      ],
      events: [],
      inhibitorEvents: [{ type: 'killed', inhibitor: 'Barracks_T2_L1', time: gameTime - 60 }]
    })
    const startedAt = Date.now()
    const tickFake = (): void => {
      const live = fakeLive(20 + (Date.now() - startedAt) / 1000)
      emit('live', live)
      updateOverlay(live)
    }
    const timer = setInterval(tickFake, 2000)
    tickFake()
    const { writeFileSync } = await import('node:fs')
    // wait up to 5 s for the frames, then a bit longer for the animation to settle
    for (let i = 0; i < 100 && !overlay.frames.visible; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    await new Promise((resolve) => setTimeout(resolve, 700))
    for (const [name, part] of [
      ['frames', overlay.frames],
      ['panel', overlay.panel],
      ['minimap', overlay.minimap]
    ] as const) {
      if (part.win?.isVisible())
        writeFileSync(join(userData, 'logs', `part-${name}.png`), (await part.win.webContents.capturePage()).toPNG())
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.RC_GAME_SELFTEST_MS ?? 6000)))
    clearInterval(timer)
    const wins = BrowserWindow.getAllWindows().map((browserWindow) => ({
      title: browserWindow.getTitle(),
      visible: browserWindow.isVisible(),
      bounds: browserWindow.getBounds()
    }))
    console.log('RC_GAME_SELFTEST ' + JSON.stringify({ wins, diag: overlayDiagnostics() }, null, 1))
    const shot = await capture.grab(display, [{ x: 0, y: 0, w: 1, h: 1 }])
    if (shot?.[0]) {
      const { nativeImage } = await import('electron')
      const frame = shot[0]
      // capture frames are RGBA, createFromBitmap expects BGRA
      const bgra = Buffer.from(frame.data)
      for (let i = 0; i < bgra.length; i += 4) {
        const red = bgra[i]
        bgra[i] = bgra[i + 2]
        bgra[i + 2] = red
      }
      writeFileSync(
        join(userData, 'logs', 'game-selftest.png'),
        nativeImage.createFromBitmap(bgra, { width: frame.width, height: frame.height }).toPNG()
      )
    }
    app.exit(0)
    return
  }
  app.setAppUserModelId('dev.riftcompanion.app')
  registerIpc()
  createWindow()
  lcu.start()
  overlay.setHotkey(settings.get().overlay.hotkey)
  overlay.setVisibleInCapture(settings.get().overlay.showInCapture)
  initAutoUpdate()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  scanner.stop()
  overlay.destroy()
  capture.destroy()
  lcu.stop()
  crawler.stop()
  if (process.platform !== 'darwin') app.quit()
})
