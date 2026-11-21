import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, extname } from 'node:path'
import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type {
  ChampionBuild,
  GameMode,
  LiveGameState,
  PatchStats,
  Platform,
  RcEvents,
  EditableSettings,
  StatRole,
  TierEntry,
  UpdateState,
  OverlayDiagnostics,
  MinimapState,
  AugmentOffer,
  MayhemData,
  PlayerHistory
} from '@shared/types'
import { toEncounter } from '@shared/encounters'
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
import { LearnedTimersFile, readMeasuredPads } from './minimap/store'
import { AugmentScanner, type ScanState } from './scanner/scanner'
import { DiagLog } from './diag'
import { GameStore } from './games'
import type { CurvePoint } from '@shared/summary'
import { CaptureService } from './capture/captureService'
import type { GameWindowSettings } from './lcu/gameSettings'
import { overlayNotice, type OverlayNotice } from '@shared/overlayNotice'
import { cardRects, WINDOWS, type NameCandidate } from './scanner/detect'
import { augmentTiersForChampion, makeTierLookup, type TierLookup } from '@shared/mayhem'
import {
  extraAugmentLevels,
  extraSelections,
  isHeadlinerAugment,
  newContext,
  NO_SELECTION,
  observeLevel,
  observeSelection,
  trackRerolls,
  withMapSkin,
  type MayhemContext,
  type SelectionTrack
} from '@shared/mayhemContext'
import { AchievementService } from './achievements'
import { DiscordPoster } from './discord'
import { isDiscordWebhook } from '@shared/discordPayload'
import { demoGame } from '@shared/demoGame'
import { ProfileService } from './profile'
import { sanitizeApiKey, isValidKeyFormat } from './riot/apiKey'
import { RiotClient, regionalOf } from './riot/client'
import type { GameResults, RecordMode } from './records'
import { SettingsStore } from './settings'
import { RecorderEnv } from './recorder/setup'
import { RecorderService } from './recorder/service'
import { ClipStore } from './recorder/clipStore'
import { clipProtocolHandler, mediaTypeOf } from './recorder/protocol'
import { Exporter } from './recorder/exporter'
import { run as runProgram } from './recorder/ffmpeg'
import { ClipSharer } from './recorder/share'
import { HighlightService } from './recorder/highlights'
import type { HighlightScope } from '@shared/highlights'
import { quips as gameQuips } from '@shared/quips'
import { newProject } from '@shared/editProject'
import { normalizeProject, type EditProject } from '@shared/editProject'
import type { ExportRequest } from '@shared/types'

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

// A second start ends at once. app.quit() would let the rest of this file run first – and a second
// instance that reaches recorder.recover() takes the first one's running recording for a leftover.
if (!app.requestSingleInstanceLock()) app.exit(0)
// rcclip:// plays clips in the window (read-only, ids instead of paths; see recorder/protocol.ts).
// Must be declared before the app is ready; "stream" lets the video player seek.
protocol.registerSchemesAsPrivileged([{ scheme: 'rcclip', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
// the "clip saved" sound plays when a hotkey was pressed in the game, not after a click in the window
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const userData = app.getPath('userData')
const settings = new SettingsStore(join(userData, 'settings.json'))
const ddragon = new DataDragon(join(userData, 'ddragon'), settings.get().language)
const store = new StatsStore(join(userData, 'stats'))
const riot = new RiotClient(() => settings.getApiKey())
const profiles = new ProfileService(riot)
const mayhem = new MayhemService(join(userData, 'mayhem.json'), settings.get().language, (message) => diag.log(message))

let mainWindow: BrowserWindow | null = null

/**
 * Events the overlay windows listen to. Everything else only goes to the main window.
 * 'loading' and 'framesOffer' are sent to their own window directly since the data is window specific.
 */
const OVERLAY_EVENTS = new Set<keyof RcEvents>(['live', 'augmentsOwned', 'minimap'])

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
// Small transparent windows instead of one full-screen one: the animated card frames (only over
// the cards), the minimap timers and the loading-screen panel. They are only shown when needed:
// the frames while the augment choice is open, the timers during ARAM games.

const diag = new DiagLog(join(userData, 'logs', 'overlay.log'))
const capture = new CaptureService(join(__dirname, '../preload/index.js'), join(__dirname, '../renderer'), (message) => diag.log(message))
let inGame = false
let inMayhem = false
let cards: ScanState = { visible: false, offer: null, displayId: null }
/** JSON of the offer the frames currently show, to skip redundant updates */
let shownOffer = ''
let minimapState: MinimapState | null = null
let lastTick = { level: 0, dead: false, gameMode: null as string | null }

const overlay = new OverlayManager(
  join(__dirname, '../preload/index.js'),
  loadRenderer,
  () => {
    // hotkey: look for the cards right away
    diag.log(`hotkey → scan now (inGame=${inGame}, mayhem=${inMayhem})`)
    if (scanner.running) scanner.lookNow(WINDOWS.manual)
    refreshOverlay()
  },
  (message) => diag.log(message)
)

/** One line per monitor for overlay.log and the diagnostics: id, position, size (DIP), scaling. */
function describeDisplays(): string[] {
  const primary = screen.getPrimaryDisplay().id
  return screen
    .getAllDisplays()
    .map(
      (display) =>
        `#${display.id}${display.id === primary ? ' (primary)' : ''}: ${display.bounds.width}×${display.bounds.height} DIP at ${display.bounds.x},${display.bounds.y}, ` +
        `${Math.round(display.scaleFactor * 100)} % → ${Math.round(display.size.width * display.scaleFactor)}×${Math.round(display.size.height * display.scaleFactor)} px` +
        (display.rotation ? `, rotated ${display.rotation}°` : '')
    )
}

// League's window mode (exclusive fullscreen can't be overlaid) and the notice shown in the app
let windowSettings: GameWindowSettings | null = null
let windowModeCheckedAt = 0
let notice: OverlayNotice | null = null

function refreshNotice(): void {
  const enabled = settings.get().overlay.enabled
  const next = enabled
    ? overlayNotice({ windowMode: windowSettings?.mode ?? null, blackCapture: inMayhem && scanner.running && scanner.blackCapture })
    : null
  if (JSON.stringify(next) === JSON.stringify(notice)) return
  notice = next
  diag.log(next ? `notice: ${next.title} – ${next.detail}` : 'notice cleared')
  emit('overlayNotice', next)
}

async function checkWindowMode(): Promise<void> {
  const next = await lcu.gameWindowSettings().catch(() => null)
  if (JSON.stringify(next) !== JSON.stringify(windowSettings))
    diag.log(next ? `League video: ${next.mode ?? 'unknown mode'}, ${next.width}×${next.height} (from ${next.source})` : 'League video settings: unknown')
  windowSettings = next
  refreshNotice()
}

/** Monitors were added, removed, rearranged or rescaled: everything placed for the old setup is stale. */
let displayTimer: NodeJS.Timeout | null = null
function onDisplaysChanged(_event: unknown, _display: unknown, changed?: string[]): void {
  // a work area change (taskbar shown or hidden) moves nothing we draw
  if (changed && !changed.some((metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation')) return
  if (displayTimer) clearTimeout(displayTimer)
  displayTimer = setTimeout(() => {
    displayTimer = null
    diag.log(`monitors changed: ${describeDisplays().join(' | ')}`)
    overlay.displaysChanged()
    capture.reset()
    if (scanner.running) scanner.displaysChanged()
    cards = { visible: false, offer: null, displayId: null }
    shownOffer = ''
    refreshOverlay()
  }, 600)
}

function refreshOverlay(): void {
  const current = settings.get()
  // the frames show the champion's static tier per card (see CardFrames); nothing here rates the cards
  const offer = current.overlay.enabled && current.overlay.cardFrames && inMayhem ? cards.offer : null
  const key = offer ? JSON.stringify(offer) : ''
  if (key !== shownOffer) {
    shownOffer = key
    diag.log(offer ? 'frames shown' : 'frames hidden')
    if (process.env.RC_SELFTEST_NO_FRAMES) return // xvfb has no compositor, so our own window would cover the cards
    if (offer) {
      if (overlay.showFrames(offer)) diag.log(`frames at ${offer.cards.map((card) => `${Math.round(card.rect.x)},${Math.round(card.rect.y)} ${Math.round(card.rect.width)}×${Math.round(card.rect.height)}`).join(' / ')} on display ${offer.displayId} (layout ${offer.fit ?? 'height'})`)
    } else overlay.hideFrames()
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
let candidatesTriedAt = 0
const scanner = new AugmentScanner(
  join(userData, 'ocr'),
  () => {
    // the names come from the Mayhem data: when it could not be loaded at the scanner's start (a source
    // was down), every card stayed unreadable for the whole game. Try again, at most every 30 s
    if (!candidates.length && Date.now() - candidatesTriedAt > 30_000) void loadCandidates()
    return candidates
  },
  (state) => {
    trackSelection(state)
    cards = state
    if (state.displayId !== null) overlay.moveToDisplay(state.displayId)
    refreshOverlay()
  },
  (message) => diag.log(message),
  capture,
  gameDisplay
)

scanner.snapshotDir = join(userData, 'logs')
scanner.overlayInCapture = () => settings.get().overlay.showInCapture

// augments picked in the running Mayhem game. Four from the levels, plus what Headliners add since
// patch 26.21: Superfans' level 21, K/DA's photocards, Pentakill's own selections
const MAX_OWNED = 8
let owned: number[] = []
let ownedGameTime = 0
function setOwned(ids: number[]): void {
  owned = [...new Set(ids)].slice(0, MAX_OWNED)
  emit('augmentsOwned', owned)
}
scanner.onPicked = (id) => {
  // never more augments than the level allows (a card that just got covered up is not a pick).
  // Pentakill's HEAVY … DOOM come from a selection of their own, on top of the normal ones
  if (owned.includes(id)) return
  const headliner = (augmentId: number): boolean => isHeadlinerAugment(mayhemData?.augments[augmentId])
  const regular = owned.filter((ownedId) => !headliner(ownedId)).length
  const allowed = Math.max(1, scanner.schedule.earnedRegular + extraSelections(mayhemContext))
  if (!headliner(id) && regular >= allowed) {
    diag.log(`ignoring pick ${id}: already ${regular} augments at this level`)
    return
  }
  setOwned([...owned, id])
}
scanner.onUnpicked = (id) => setOwned(owned.filter((ownedId) => ownedId !== id))

// --- What is known about the Mayhem game: the map's augment pool and the Headliner. The scanner
// needs it to know which augments can show up and at which levels (see @shared/mayhemContext) ---
let mayhemData: MayhemData | null = null
let mayhemContext: MayhemContext = newContext()
/** the selection that is open: what each card showed and which cards were rerolled (for the log) */
let selection: SelectionTrack = NO_SELECTION

function setContext(next: MayhemContext): void {
  if (next === mayhemContext) return
  for (const line of next.evidence.slice(mayhemContext.evidence.length)) diag.log(`game context: ${line}`)
  mayhemContext = next
  scanner.schedule.extraLevels = extraAugmentLevels(next)
}

function resetContext(): void {
  mayhemContext = newContext()
  scanner.schedule.extraLevels = []
  selection = NO_SELECTION
}

/** Rerolls (one card changes while the rest stay) and what the cards tell about the game. */
function trackSelection(state: ScanState): void {
  if (!state.visible) {
    selection = NO_SELECTION
    return
  }
  if (!state.offer) return
  const ids = state.offer.cards.map((card) => card.augmentId)
  const { track, changed } = trackRerolls(selection, ids)
  for (const i of changed) diag.log(`card ${i + 1} rerolled: ${selection.cards[i]} → ${ids[i]}`)
  selection = track
  if (mayhemData) setContext(observeSelection(mayhemContext, { augmentIds: ids, cardCount: ids.length }, mayhemData))
}

// health relic and inhibitor respawn timers on the minimap (ARAM, ARAM: Mayhem)
const minimapPadsFile = join(userData, 'minimap-pads.json')
const minimap = new MinimapWatcher(
  () => settings.get().minimap,
  () => gameDisplay.get(),
  (state) => {
    minimapState = state
    emit('mapTimers', state)
    refreshOverlay()
  },
  capture,
  (message) => diag.log(message),
  new LearnedTimersFile(join(userData, 'learned-timers.json'))
)
minimap.measuredPads = readMeasuredPads(minimapPadsFile)

// --- Loading screen panel (Mayhem/ARAM win rates of all players, Space toggles it) ---
let loadingHidden = false
/** Galaxy seed of the current game, so the loading screen shows the one the app jumped to. */
let cosmosSeed = Date.now()

function refreshLoading(): void {
  const state = lcu.getLoading()
  const live = lcu.getLive()
  const started = !!live?.active && live.started
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
  candidatesTriedAt = Date.now()
  const data = await mayhem.get().catch(() => null)
  if (data) {
    mayhemData = data
    candidates = Object.values(data.augments).map((augment) => ({ id: augment.id, names: [augment.name, augment.nameEn] }))
  }
}

function updateOverlay(live: LiveGameState | null): void {
  const overlaySettings = settings.get().overlay
  const wasInGame = inGame
  inGame = !!live?.active
  const queueId = lcu.getGameQueueId()
  // KIWI is the game mode name of ARAM: Mayhem
  const nowMayhem = inGame && (live!.gameMode === 'KIWI' || (queueId !== null && (QUEUE_IDS.mayhem as readonly number[]).includes(queueId)))
  const aram = inGame && (nowMayhem || live!.gameMode === 'ARAM' || queueId === 450)
  // Riot's event feed says where the game is: before GameStart it's still the loading screen, after
  // GameEnd a Nexus has fallen. Augment frames and map timers only run in between
  const playing = inGame && live!.started && !live!.result
  if (inGame && (!wasInGame || live!.gameMode !== lastTick.gameMode)) {
    resetContext()
    diag.log(`game detected: gameMode=${live!.gameMode} queue=${queueId ?? '?'} → mayhem=${nowMayhem}`)
    diag.log(`monitors: ${describeDisplays().join(' | ')}; game screen remembered: ${gameDisplay.get() ?? 'none yet'}`)
    lastTick.gameMode = live!.gameMode
    void checkWindowMode()
  }
  minimap.update(playing ? live : null, aram, nowMayhem)
  // the game clock went backwards, so this is a new game: forget the last game's augments
  if (inGame) {
    // the game clock went backwards, so this is a new game
    if (live!.gameTime + 5 < ownedGameTime) {
      if (owned.length) setOwned([])
      resetContext()
    }
    ownedGameTime = live!.gameTime
  }
  if (nowMayhem && playing && overlaySettings.enabled) {
    if (!inMayhem) overlay.prepare(gameDisplay.get())
    inMayhem = true
    const me = live!.players.find((player) => player.riotId === live!.activePlayer)
    const level = me?.level ?? 0
    const dead = me?.isDead ?? false
    if (level !== lastTick.level || dead !== lastTick.dead) {
      diag.log(`level ${level}${dead ? ', dead' : ''}${me ? '' : ' (player not found: ' + live!.activePlayer + ')'}`)
      lastTick = { ...lastTick, level, dead }
    }
    // what Riot tells about the game: the client's map skin, levels above 18 (Superfans)
    const mapSkin = lcu.getGameMapSkin()
    if (mapSkin && mapSkin !== mayhemContext.mapSkin && mayhemData) setContext(withMapSkin(mayhemContext, mapSkin, mayhemData))
    setContext(observeLevel(mayhemContext, level))
    // again every tick: a scanner restart in the middle of the game resets the schedule
    scanner.schedule.extraLevels = extraAugmentLevels(mayhemContext)
    if (overlaySettings.cardFrames) {
      if (!scanner.running) {
        scanner.start()
        scanner.warmup()
        void loadCandidates()
      }
      scanner.update({ level, dead, gameTime: live!.gameTime, itemsKey: (me?.items ?? []).join(',') })
    }
  } else {
    if (inMayhem) diag.log(live?.result ? `left the Mayhem game (${live.result})` : 'left the Mayhem game')
    inMayhem = false
    cards = { visible: false, offer: null, displayId: null }
    if (scanner.running) scanner.stop()
  }
  if (!inGame) lastTick = { level: 0, dead: false, gameMode: null }
  refreshOverlay()
  refreshNotice()
}

/** Registers the augment hotkey and writes to the log when Windows refuses it (it used to fail without a word). */
function setOverlayHotkey(accelerator: string): void {
  if (!overlay.setHotkey(accelerator))
    diag.log(`hotkeys: ${accelerator} could not be registered – another program holds the key, or it is not a key combination`)
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
    windowMode: windowSettings?.mode ?? null,
    hotkeysFailed: overlay.failedHotkeys(),
    displays: describeDisplays(),
    notice,
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
const games = new GameStore(join(userData, 'games.db'))
// history from before 1.0 was one JSON file per game
void games
  .importLegacy(join(userData, 'games'))
  .then((imported) => imported && diag.log(`imported ${imported} games from the old history into games.db`))
  .catch((error) => diag.log(`importing the old game history failed: ${String(error)}`))
// --- Achievements (constellations on the star map) ---
/** Augment tiers for the achievements, kept as long as the augment and static data stay the same. */
let tierLookup: { data: unknown; statics: unknown; lookup: TierLookup } | null = null
async function augmentTiers(): Promise<TierLookup | null> {
  const [data, statics] = await Promise.all([mayhem.get(), ddragon.get()]).catch(() => [null, null] as const)
  if (!data || !statics) return null
  if (tierLookup?.data !== data || tierLookup.statics !== statics) tierLookup = { data, statics, lookup: makeTierLookup(data, statics) }
  return tierLookup.lookup
}
const achievements = new AchievementService({
  db: games.database,
  history: () => games.all(),
  tiers: augmentTiers,
  unlocked: (ids) => emit('achievementsUnlocked', ids),
  log: (message) => diag.log(message)
})
// --- Discord: a summary of each game in your friends' channel (your own webhook) ---
const discord = new DiscordPoster({
  db: games.database,
  settings: () => settings.get().discord,
  webhook: () => settings.getDiscordWebhook(),
  staticData: () => ddragon.get().catch(() => null),
  tiers: augmentTiers,
  achievementsOf: (gameId) => achievements.list().filter((achievement) => achievement.gameId === gameId),
  log: (message) => diag.log(message)
})

// --- Clips: the gameplay recorder (FFmpeg as its own program, Windows capture interfaces only) ---
const recorderEnv = new RecorderEnv({
  userData,
  // resources/ is unpacked next to the asar archive in the installed app
  helperExe: join(__dirname, '../../resources/bin/ratio-audio.exe').replace('app.asar', 'app.asar.unpacked'),
  videosDir: app.getPath('videos'),
  settings: () => settings.get().recorder,
  onFfmpeg: (state) => emit('ffmpeg', state),
  inGame: () => inGame,
  log: (message) => diag.log(message),
  ffmpegOverride: app.isPackaged ? null : (process.env.RATIO_FFMPEG ?? null)
})

const clips = new ClipStore(games.database)
const recorder = new RecorderService({
  env: recorderEnv,
  store: clips,
  settings: () => settings.get().recorder,
  takenHotkeys: () => ({ augment: settings.get().overlay.hotkey }),
  emit: (status) => emit('recorder', status),
  clipSaved: (clip) => emit('clipSaved', clip),
  hotkeys: (bindings) => {
    const failed = overlay.setExtraHotkeys(bindings)
    if (failed.length) diag.log(`hotkeys: ${failed.join(', ')} could not be registered – another program holds the key, or it is not a key combination`)
  },
  displaySize: () => {
    const display = gameScreen()
    return { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
  },
  // asked fresh at each start: the app may have been opened during the game, without a champion select
  gameVideo: () => lcu.gameWindowSettings().catch(() => null),
  log: (message) => diag.log(message)
})

/** Files the user picked for the editor (music, stickers), by the token the window gets instead of the path. */
const pickedMedia = new Map<string, string>()
/** A playable rcclip:// URL for a music or picture file; null for anything else or a file that is gone. */
function registerMedia(path: string): string | null {
  const type = mediaTypeOf(path)
  if (!type || type.startsWith('video/') || !existsSync(path)) return null
  const known = [...pickedMedia].find(([, file]) => file === path)?.[0]
  const token = known ?? randomBytes(12).toString('hex')
  pickedMedia.set(token, path)
  return `rcclip://media/${token}`
}

const exporter = new Exporter({
  env: recorderEnv,
  store: clips,
  inGame: () => inGame || recorder.recording,
  emit: (job) => emit('exportProgress', job),
  clipSaved: (clip) => emit('clipSaved', clip),
  font: join(__dirname, '../../resources/fonts/Anton-Regular.ttf').replace('app.asar', 'app.asar.unpacked'),
  // the built-in loops are part of the window's files (inside the app archive, which FFmpeg cannot read)
  builtinMusic: (file) => readFile(join(__dirname, '../renderer', file)),
  log: (message) => diag.log(message)
})

// --- Highlight videos: the best clips of a game or a month as one montage ---
const highlights = new HighlightService({
  env: recorderEnv,
  store: clips,
  summary: (gameId) => games.get(gameId),
  results: (from, to) =>
    games
      .list()
      .filter((game) => game.createdAt >= from && game.createdAt < to)
      .map((game) => game.win),
  exporter,
  busy: () => inGame || recorder.recording,
  championName: async (id) => (await ddragon.get().catch(() => null))?.champions[id]?.name ?? null,
  scored: (ids) => emit('highlightsScored', ids),
  log: (message) => diag.log(message)
})
// clips from before the highlight scores (or saved while the app was busy) are looked at once, after the start settled
setTimeout(() => void highlights.backfill().catch((error) => diag.log(`highlights: backfill failed – ${String(error)}`)), 90_000)

/** A highlight scope from the window: a game id or a month ("2026-11"). */
function toScope(raw: unknown): HighlightScope {
  const scope = raw as { gameId?: unknown; month?: unknown } | null
  if (scope && Number.isInteger(scope.gameId)) return { gameId: Number(scope.gameId) }
  if (scope && typeof scope.month === 'string' && /^\d{4}-\d{2}$/.test(scope.month)) return { month: scope.month }
  throw new Error('Unknown highlight scope.')
}

// --- Sharing clips through the Discord webhook ---
const sharer = new ClipSharer({
  db: games.database,
  store: clips,
  settings: () => settings.get().discord,
  webhook: () => settings.getDiscordWebhook(),
  staticData: () => ddragon.get().catch(() => null),
  quipOf: async (gameId) => {
    const summary = games.get(gameId)
    const me = summary?.players.find((player) => player.me)
    return summary && me ? (gameQuips(summary)[me.puuid] ?? null) : null
  },
  // a clip that is too large is exported again with the Discord preset
  shrink: async (clipId, targetMb) => {
    const clip = clips.clip(clipId)
    if (!clip) return null
    try {
      const project = newProject(clipId, clip.durationMs / 1000)
      project.output = { ...project.output, preset: 'discord', targetMb }
      const job = await exporter.runToEnd({ clipId, project, title: clip.title, images: {} })
      if (job.state === 'paused') exporter.cancel()
      return job.state === 'done' ? (job.clip?.id ?? null) : null
    } catch {
      // another export is running
      return null
    }
  },
  discard: async (clipId) => {
    await recorder.deleteClips([clipId])
  },
  log: (message) => diag.log(message)
})

function registerClipProtocol(): void {
  protocol.handle(
    'rcclip',
    clipProtocolHandler((kind, id) => {
      if (kind === 'media') return pickedMedia.get(id) ?? null
      const numericId = Number(id)
      if (!Number.isInteger(numericId)) return null
      if (kind === 'recording') return recorder.sessionFile(numericId)
      const files = clips.files(numericId)
      return kind === 'clip' ? (files?.file ?? null) : (files?.thumb ?? null)
    })
  )
}

/** The first full evaluation reads every saved game, so it waits until no game is running. */
function startAchievements(): void {
  if (inGame) {
    setTimeout(startAchievements, 30_000)
    return
  }
  void achievements.rebuild().catch((error) => diag.log(`achievements failed: ${String(error)}`))
}

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

/** A match was accepted in the client: every window flies to the next galaxy. */
function onMatchAccepted(): void {
  cosmosSeed = Date.now()
  emit('journey', { seed: cosmosSeed })
}

const lcu = new LcuManager({
  liveCurve: () => liveCurve,
  records: {
    local: async (puuids, mode) => games.results(puuids, mode),
    riot: riotResults
  },
  encounters: async (me, puuids, excludeGameId) => games.encounters(me, puuids, excludeGameId),
  liveEvents: (events, state) => {
    // automatic clips hang on this poll too: the recorder has no loop of its own
    recorder.onLive(events, state)
  },
  phase: (phase) => {
    recorder.onPhase(phase)
    // exports never run next to a game
    if (phase === 'InProgress' || phase === 'GameStart') exporter.onGameStart()
    else if (!['Reconnect'].includes(phase)) setTimeout(() => exporter.onGameEnd(), 5000)
  },
  log: (message) => diag.log(message),
  // logs/live-loading.json, live-running.json, live-end.json: the last game's full answers
  dump: (name, data) =>
    void writeFile(join(userData, 'logs', `live-${name}.json`), JSON.stringify(data, null, 1)).catch((error) =>
      diag.log(`saving live-${name}.json failed: ${String(error)}`)
    ),
  settings: () => settings.get(),
  staticData: () => ddragon.get(),
  build: async (championId, role, mode) => championBuild(await currentPatch(mode), championId, role, mode),
  emit: {
    client: (status) => emit('client', status),
    champSelect: (champSelect) => {
      emit('champSelect', champSelect)
      // load the OCR engine during champion select, not when the first augment choice opens
      if (champSelect?.mode === 'mayhem' && settings.get().overlay.cardFrames) scanner.warmup()
      // tell about fullscreen before the game, while it can still be changed calmly
      if (champSelect && Date.now() - windowModeCheckedAt > 30_000) {
        windowModeCheckedAt = Date.now()
        void checkWindowMode()
      }
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
    matchAccepted: onMatchAccepted,
    summary: (summary) => {
      diag.log(`game summary ready: ${summary.gameId} (${summary.win ? 'win' : 'loss'}, curve from ${summary.curveSource})`)
      // remember where in the universe this game was played (the galaxy we flew to when it was accepted)
      const saved = { ...summary, cosmos: cosmosSeed }
      try {
        games.save(saved)
      } catch (error) {
        diag.log(`saving game ${summary.gameId} failed: ${String(error)}`)
      }
      emit('gameSummary', saved)
      // The clips recorded during this game now belong to it – once the recorder has cut the last
      // ones and joined the whole game. A summary that arrived before that found no recording to
      // attach to, and the clips never got their game. Then their highlight scores (sound).
      void recorder
        .settled()
        .then(() => {
          recorder.onSummary(saved.gameId)
          return highlights.afterGame(saved.gameId)
        })
        .catch((error) => diag.log(`highlights after game ${saved.gameId} failed: ${String(error)}`))
      // after the summary is on screen; the game is over, so reading the database is fine now
      void achievements
        .onGame(saved)
        .catch((error) => diag.log(`achievements after game ${saved.gameId} failed: ${String(error)}`))
        // posted after the achievements, so the message can name the ones this game unlocked
        .then(() => discord.maybePost(saved))
        .catch((error) => diag.log(`discord after game ${saved.gameId} failed: ${String(error)}`))
        // the best automatic clip goes under the summary (option, off by default); wait for the recorder's last clips
        .then(() => recorder.settled())
        .then(() => (discord.posted(saved.gameId) ? sharer.attachBest(saved.gameId) : undefined))
        .catch((error) => diag.log(`discord clip after game ${saved.gameId} failed: ${String(error)}`))
    }
  }
})

function assertPlatform(platform: string): Platform {
  if (!(platform in PLATFORMS)) throw new Error(`Unknown region: ${platform}`)
  return platform as Platform
}

// --- IPC ---

/** The screen the game runs on (or the main screen before the first game). */
function gameScreen(): Electron.Display {
  return screen.getAllDisplays().find((candidate) => candidate.id === (gameDisplay.get() ?? -1)) ?? screen.getPrimaryDisplay()
}

/** A made-up augment choice for a champion (best, roughly 30th percentile and worst augment), null without augment data. */
async function previewOffer(championId: number): Promise<AugmentOffer | null> {
  const display = gameScreen()
  overlay.moveToDisplay(display.id)
  try {
    const [data, statics] = await Promise.all([mayhem.get(), ddragon.get()])
    const tiers = augmentTiersForChampion(data, statics, championId)
    const picks = [tiers[0], tiers[Math.floor(tiers.length * 0.3)], tiers[tiers.length - 1]].filter(Boolean)
    const rects = cardRects(display.size.width, display.size.height)
    return {
      displayId: display.id,
      championId,
      cards: picks.map((tier, i) => ({ augmentId: tier.augment.id, text: tier.augment.nameEn, score: 1, rect: rects[i] }))
    }
  } catch {
    return null
  }
}

function registerIpc(): void {
  // lines for overlay.log from the windows (e.g. how the flight went on this GPU)
  ipcMain.on('rc:log', (_event, message: unknown) => diag.log(`window: ${String(message).slice(0, 400)}`))
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
  handle('saveSettings', (patch: Partial<EditableSettings>) => {
    const next = settings.update(patch)
    ddragon.setLanguage(next.language)
    mayhem.setLanguage(next.language)
    setOverlayHotkey(next.overlay.hotkey)
    overlay.setVisibleInCapture(next.overlay.showInCapture)
    updateOverlay(lcu.getLive())
    tierCache.clear()
    recorder.settingsChanged()
    if (patch.recorder) void recorder.refresh()
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
  handle('setDiscordWebhook', (url: string) => {
    const clean = String(url ?? '').trim()
    if (!clean) {
      settings.setDiscordWebhook('')
      return { ok: true, message: 'Webhook removed.' }
    }
    if (!isDiscordWebhook(clean))
      return { ok: false, message: 'This is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>).' }
    settings.setDiscordWebhook(clean)
    diag.log('discord: webhook saved')
    return { ok: true, message: 'Webhook saved.' }
  })
  handle('testDiscordWebhook', () => discord.post(demoGame(), true))
  handle('postGameToDiscord', async (gameId: number) => {
    const summary = games.get(Number(gameId))
    if (!summary) return { ok: false, message: 'Game not found.' }
    return discord.post(summary)
  })
  handle('postWillToDiscord', async (gameId: number) => {
    const summary = games.get(Number(gameId))
    if (!summary) return { ok: false, message: 'Game not found.' }
    return discord.postWill(summary)
  })
  handle('recorderSetup', () => recorderEnv.setup())
  handle('installFfmpeg', () => recorderEnv.install())
  handle('testEncoders', () => recorderEnv.testEncoders(true))
  handle('recorderStatus', () => recorder.status())
  handle('clipNow', () => recorder.clipNow())
  handle('listClips', () => clips.list())
  handle('updateClip', (id: number, patch: { title?: string; favorite?: boolean }) =>
    clips.update(Number(id), { title: typeof patch?.title === 'string' ? patch.title : undefined, favorite: typeof patch?.favorite === 'boolean' ? patch.favorite : undefined })
  )
  handle('deleteClips', (ids: number[]) => recorder.deleteClips(Array.isArray(ids) ? ids.map(Number) : []))
  handle('showClipInFolder', (id: number) => {
    const file = clips.files(Number(id))?.file
    if (file) shell.showItemInFolder(file)
  })
  handle('clipStorage', () => recorder.storageInfo())
  handle('cleanupPreview', () => recorder.cleanupPreviewInfo())
  handle('cleanupRun', () => recorder.cleanupNow())
  handle('listRecordings', () => recorder.sessions())
  handle('gameRecording', (gameId: number) => recorder.sessionOfGame(Number(gameId)))
  handle('keepRecording', (id: number, keep: boolean) => recorder.keepSession(Number(id), !!keep))
  handle('deleteRecording', (id: number) => recorder.deleteSession(Number(id)))
  handle('clipFromRecording', (id: number, startMs: number, endMs: number) => recorder.clipFromSession(Number(id), Number(startMs), Number(endMs)))
  handle('getEdit', (clipId: number) => {
    const edit = clips.edit(Number(clipId))
    if (!edit) return null
    try {
      return normalizeProject(JSON.parse(edit.projectJson))
    } catch {
      return null
    }
  })
  handle('saveEdit', (clipId: number, project: EditProject) => {
    const clean = normalizeProject(project)
    if (clean && clips.clip(Number(clipId))) clips.saveEdit(Number(clipId), JSON.stringify(clean), Date.now())
  })
  handle('pickMedia', async (kind: 'music' | 'image') => {
    const options = {
      title: kind === 'music' ? 'Choose a music file' : 'Choose a picture',
      properties: ['openFile'] as 'openFile'[],
      filters: [
        kind === 'music'
          ? { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac'] }
          : { name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }
      ]
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : result.filePaths[0]
    const url = path ? registerMedia(path) : null
    return path && url ? { url, path, name: basename(path, extname(path)) } : null
  })
  handle('mediaUrl', (path: string) => registerMedia(String(path)))
  handle('exportStart', (request: ExportRequest) => exporter.start(request))
  handle('highlightPlan', async (scope: unknown) => (await highlights.plan(toScope(scope))).plan)
  handle('createHighlightVideo', (scope: unknown) => highlights.create(toScope(scope)))
  handle('exportCancel', () => exporter.cancel())
  handle('exportStatus', () => exporter.status())
  handle('shareClipToDiscord', (id: number, options?: { quip?: boolean; again?: boolean }) =>
    sharer.share(Number(id), { quip: options?.quip ?? settings.get().discord.includeQuips, again: !!options?.again })
  )
  handle('copyClipFile', async (id: number) => {
    const file = clips.files(Number(id))?.file
    if (!file || !existsSync(file)) return false
    if (process.platform === 'win32') {
      // a real file drop list on the clipboard, so Ctrl+V in Discord or Explorer pastes the file itself
      const copied = await runProgram('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath '${file.replace(/'/g, "''")}'`], {
        timeoutMs: 15_000
      })
      if (copied.code === 0) return true
    }
    clipboard.writeText(file)
    return process.platform !== 'win32'
  })
  handle('saveClipAs', async (id: number) => {
    const file = clips.files(Number(id))?.file
    if (!file || !existsSync(file)) return false
    const options = { title: 'Save as', defaultPath: join(app.getPath('downloads'), basename(file)) }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await copyFile(file, result.filePath)
    return true
  })
  handle('openClipFolder', async () => {
    mkdirSync(recorderEnv.folder(), { recursive: true })
    await shell.openPath(recorderEnv.folder())
  })
  handle('chooseClipFolder', async () => {
    const options = { title: 'Folder for clips and recordings', defaultPath: recorderEnv.folder(), properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle('getPatches', (mode: GameMode) => store.patches(assertMode(mode)))
  handle('getTierList', (patch: string, mode: GameMode) => tierList(patch, assertMode(mode)))
  handle('getChampionBuild', (patch: string, championId: number, role: StatRole | undefined, mode: GameMode) =>
    championBuild(patch, championId, role, assertMode(mode))
  )
  handle('crawlerStart', (mode: GameMode) => {
    startCrawl(assertMode(mode)).catch((error) => diag.log(`crawler: could not start – ${String(error)}`))
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
    const display = gameScreen()
    const offer = await previewOffer(championId)
    if (offer) overlay.preview(offer)
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
  handle('fillGameEffort', async (id: number) => {
    const summary = games.get(Number(id))
    if (!summary || summary.effort) return summary
    const effort = await lcu.effortOf(summary)
    if (!effort) return summary
    const filled = { ...summary, effort }
    games.save(filled)
    diag.log(`will to win: signals of game ${filled.gameId} filled in from the client`)
    return filled
  })
  handle('getLeaderboard', () => games.leaderboard())
  handle('getAchievements', () => achievements.list())
  handle('markAchievementsSeen', (ids: string[]) => achievements.store.markSeen(Array.isArray(ids) ? ids.map(String) : []))
  handle('recordFlight', async (variant: string, seed: number) => {
    if ((variant === 'wormhole' || variant === 'slingshot') && Number.isFinite(seed)) await achievements.onFlight(variant, Number(seed))
  })
  handle('getPlayerHistory', (puuid: string, riotId?: string): PlayerHistory | null => {
    const id = String(puuid)
    const stats = games.encounters(lcu.getStatus().summoner?.puuid ?? null, [id]).get(id)
    if (!stats) return null
    return { encounter: toEncounter(stats, typeof riotId === 'string' ? riotId : ''), gameIds: games.gamesWith(id) }
  })
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

  // The admin tool only exists in `npm run dev`: in a build this branch and the module are left out.
  if (import.meta.env.DEV && !app.isPackaged) {
    void import('./admin').then(({ registerAdmin }) =>
      registerAdmin({
        handle,
        emit,
        acceptMatch: onMatchAccepted,
        feedLive: (live, events = []) => {
          emit('live', live)
          updateOverlay(live)
          recorder.onLive(events, live)
        },
        realLive: () => lcu.getLive(),
        restore: () => {
          shownOffer = ''
          refreshOverlay()
          refreshLoading()
        },
        previewOffer,
        gameDisplay: gameScreen,
        minimapScale: () => settings.get().minimap.scale,
        cosmosSeed: () => cosmosSeed,
        overlay,
        minimap,
        capture,
        games,
        achievements,
        discord,
        recorderEnv,
        recorder,
        diag,
        padsFile: minimapPadsFile
      })
    )
  }
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
  // The window only ever shows the app itself. A file or link dropped on it must not load there:
  // any page in this window gets the app's whole API (delete clips, change settings).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url.split('#')[0] !== current.split('#')[0]) event.preventDefault()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) =>
    diag.log(`main window crashed: ${details.reason} (exit code ${details.exitCode})`)
  )
  mainWindow.webContents.on('unresponsive', () => diag.log('main window not responding'))
  mainWindow.webContents.on('responsive', () => diag.log('main window responding again'))
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

// A crashed or hung GPU process makes Chromium fall back to software rendering, after which the
// animated parts get very slow. Log it, so a report shows when and why that happened.
app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU') return
  diag.log(`GPU process gone: ${details.reason} (exit code ${details.exitCode}) – WebGL now ${app.getGPUFeatureStatus().webgl}`)
})

// the GPU status is only known once the GPU process has reported in (right at start it always reads "disabled")
app.once('gpu-info-update', () => {
  const status = app.getGPUFeatureStatus()
  diag.log(`GPU: WebGL ${status.webgl}, WebGL2 ${status.webgl2}, compositing ${status.gpu_compositing}`)
})

void app.whenReady().then(async () => {
  diag.log(`app ${app.getVersion()} started`)
  setTimeout(startAchievements, 8000)
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
      started: true,
      result: null,
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
  registerClipProtocol()
  createWindow()
  void recorderEnv
    .init()
    .then(() => recorder.recover())
    .then(() => recorder.refresh())
    .catch((error) => diag.log(`recorder: init failed – ${String(error)}`))
  lcu.start()
  setOverlayHotkey(settings.get().overlay.hotkey)
  overlay.setVisibleInCapture(settings.get().overlay.showInCapture)
  screen.on('display-added', onDisplaysChanged)
  screen.on('display-removed', onDisplaysChanged)
  screen.on('display-metrics-changed', onDisplaysChanged)
  diag.log(`ratioAI ${app.getVersion()} – monitors: ${describeDisplays().join(' | ')}`)
  initAutoUpdate()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// a running recording is closed properly before the app goes (FFmpeg finishes its last segment)
let recorderClosed = false
app.on('before-quit', (event) => {
  // an export still running would go on as an orphaned FFmpeg and leave a file nobody lists
  exporter.cancel()
  if (recorderClosed || !recorder.recording) return
  event.preventDefault()
  void recorder
    .shutdown()
    .catch(() => undefined)
    .finally(() => {
      recorderClosed = true
      app.quit()
    })
})

app.on('will-quit', () => {
  recorderEnv.helper.quit()
  games.close()
})

app.on('window-all-closed', () => {
  scanner.stop()
  overlay.destroy()
  capture.destroy()
  lcu.stop()
  crawler.stop()
  if (process.platform !== 'darwin') app.quit()
})
