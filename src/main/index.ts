import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ChampionBuild, GameMode, LiveGameState, PatchStats, Platform, RcEvents, Settings, StatRole, TierEntry, UpdateState, OverlayDiagnostics } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { buildChampionView, buildTierList } from '@shared/analysis'
import { Crawler } from './crawler/crawler'
import { StatsStore } from './crawler/statsStore'
import { DataDragon, makeClassifier } from './ddragon'
import { LcuManager } from './lcu/manager'
import { MayhemService } from './mayhem'
import { OverlayManager } from './overlay'
import { AugmentScanner, type ScanState } from './scanner/scanner'
import { DiagLog } from './diag'
import { cardRects, WINDOWS, type NameCandidate } from './scanner/detect'
import { augmentTiersForChampion } from '@shared/mayhem'
import { ProfileService } from './profile'
import { sanitizeApiKey, isValidKeyFormat } from './riot/apiKey'
import { RiotClient } from './riot/client'
import { SettingsStore } from './settings'

if (!app.requestSingleInstanceLock()) app.quit()

const userData = app.getPath('userData')
const settings = new SettingsStore(join(userData, 'settings.json'))
const ddragon = new DataDragon(join(userData, 'ddragon'), settings.get().language)
const store = new StatsStore(join(userData, 'stats'))
const riot = new RiotClient(() => settings.getApiKey())
const profiles = new ProfileService(riot)
const mayhem = new MayhemService(join(userData, 'mayhem.json'), settings.get().language)

let win: BrowserWindow | null = null

function emit<K extends keyof RcEvents>(event: K, payload: RcEvents[K]): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('rc:event', event, payload)
}

function loadRenderer(w: BrowserWindow, hash = ''): void {
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash })
}

// --- in-game overlay -------------------------------------------------------------
//
// The overlay window is only visible while the augment choice can be open (dead / game start, an
// augment pending), while the cards are on screen, or when opened with the hotkey. A transparent
// always-on-top window costs frames, so it stays hidden the rest of the game.

const diag = new DiagLog(join(userData, 'logs', 'overlay.log'))
let inGame = false
let inMayhem = false
let manualOpen = false
let hintOpen = false
let cards: ScanState = { visible: false, offer: null, displayId: null }
let lastTick = { level: 0, dead: false, gameMode: null as string | null }

const overlay = new OverlayManager(join(__dirname, '../preload/index.js'), loadRenderer, () => {
  manualOpen = !manualOpen
  diag.log(`hotkey → overlay ${manualOpen ? 'open' : 'closed'} (inGame=${inGame}, mayhem=${inMayhem})`)
  if (manualOpen && scanner.running) scanner.lookNow(WINDOWS.manual)
  refreshOverlay()
  emit('overlayToggle', null)
})

function refreshOverlay(): void {
  const s = settings.get().overlay
  const want = s.enabled && ((inGame && manualOpen) || (inMayhem && (cards.visible || hintOpen)))
  if (want) overlay.show()
  else overlay.hide()
}

// screen recognition of the offered augment cards (only while an augment is pending)
let candidates: NameCandidate[] = []
const scanner = new AugmentScanner(
  join(userData, 'ocr'),
  () => candidates,
  (state) => {
    const wasVisible = cards.visible
    cards = state
    if (state.displayId !== null) overlay.moveToDisplay(state.displayId)
    if (wasVisible && !state.visible) manualOpen = false // augment picked → overlay goes away
    emit('augmentCards', { visible: state.visible })
    emit('augmentOffer', state.offer)
    refreshOverlay()
  },
  (msg) => diag.log(msg)
)

async function loadCandidates(): Promise<void> {
  const d = await mayhem.get().catch(() => null)
  if (d) candidates = Object.values(d.augments).map((a) => ({ id: a.id, names: [a.name, a.nameEn] }))
}

function updateOverlay(live: LiveGameState | null): void {
  const s = settings.get().overlay
  const wasInGame = inGame
  inGame = !!live?.active
  const queueId = lcu.getGameQueueId()
  const nowMayhem = inGame && (live!.gameMode === 'KIWI' || queueId === 2400)
  if (inGame && (!wasInGame || live!.gameMode !== lastTick.gameMode)) {
    diag.log(`game detected: gameMode=${live!.gameMode} queue=${queueId ?? '?'} → mayhem=${nowMayhem}`)
    lastTick.gameMode = live!.gameMode
  }
  if (nowMayhem && s.enabled) {
    if (!inMayhem) overlay.prepare() // create the (hidden) window early so it appears instantly
    inMayhem = true
    const me = live!.players.find((p) => p.riotId === live!.activePlayer)
    const level = me?.level ?? 0
    const dead = me?.isDead ?? false
    if (level !== lastTick.level || dead !== lastTick.dead) {
      diag.log(`level ${level}${dead ? ', dead' : ''}${me ? '' : ' (player not found: ' + live!.activePlayer + ')'}`)
      lastTick = { ...lastTick, level, dead }
    }
    if (s.cardFrames) {
      if (!scanner.running) {
        scanner.start()
        void loadCandidates()
      }
      scanner.update({ level, dead, gameTime: live!.gameTime, itemsKey: (me?.items ?? []).join(',') })
    }
    // small "augment ready" pill while the choice can be open (dead or at the start of the game)
    const sched = scanner.schedule
    hintOpen = s.cardFrames && sched.pending && (dead || live!.gameTime < WINDOWS.gameStart)
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
    overlayVisible: !!overlay.window?.isVisible(),
    log: diag.recent(40)
  }
}

// --- auto update ---------------------------------------------------------------------

let updateState: UpdateState = { status: app.isPackaged ? 'idle' : 'dev' }
function setUpdate(s: UpdateState): void {
  updateState = s
  emit('update', s)
}

function initAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }))
  autoUpdater.on('update-available', (i) => setUpdate({ status: 'downloading', version: i.version, progress: 0 }))
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => setUpdate({ ...updateState, status: 'downloading', progress: p.percent }))
  autoUpdater.on('update-downloaded', (i) => setUpdate({ status: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', message: e?.message ?? String(e) }))
  const check = (): void => void autoUpdater.checkForUpdates().catch(() => undefined)
  check()
  setInterval(check, 4 * 3600 * 1000)
}

// --- statistics helpers ------------------------------------------------------

const tierCache = new Map<string, { at: number; list: TierEntry[] }>()

function assertMode(m: unknown): GameMode {
  return m === 'aram' ? 'aram' : 'ranked'
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
  const ddPatch = (await ddragon.get().catch(() => null))?.patch
  // prefer the newest patch with data, fall back to the live patch
  return known.find((p) => p.matches > 0)?.patch ?? ddPatch ?? known[0]?.patch ?? '0.0'
}

async function championBuild(
  patch: string,
  championId: number,
  role: StatRole | null | undefined,
  mode: GameMode
): Promise<ChampionBuild | null> {
  return buildChampionView(await statsFor(patch, mode), championId, role ?? undefined, await tierList(patch, mode))
}

// --- services ----------------------------------------------------------------

const crawler = new Crawler(
  riot,
  store,
  (s) => emit('crawler', s),
  (patch, mode) => {
    tierCache.delete(`${mode}:${patch}`)
    emit('statsUpdated', { patch, mode })
  }
)

const lcu = new LcuManager({
  settings: () => settings.get(),
  staticData: () => ddragon.get(),
  build: async (championId, role, mode) => championBuild(await currentPatch(mode), championId, role, mode),
  emit: {
    client: (s) => emit('client', s),
    champSelect: (s) => emit('champSelect', s),
    live: (s) => {
      emit('live', s)
      updateOverlay(s)
    },
    imported: (r) => emit('imported', r)
  }
})

function assertPlatform(p: string): Platform {
  if (!(p in PLATFORMS)) throw new Error(`Unknown region: ${p}`)
  return p as Platform
}

// --- IPC -----------------------------------------------------------------------

function registerIpc(): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R): void => {
    ipcMain.handle(channel, async (_e, ...args) => {
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
    try {
      // the Challenger league endpoint is available for every key type (dev, personal, production)
      await riot.request(settings.get().platform, '/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5')
      return { ok: true, message: 'API key saved and valid ✔' }
    } catch (e) {
      return { ok: false, message: `Key saved, but the test failed: ${(e as Error).message}` }
    }
  })
  handle('getPatches', (mode: GameMode) => store.patches(assertMode(mode)))
  handle('getTierList', (patch: string, mode: GameMode) => tierList(patch, assertMode(mode)))
  handle('getChampionBuild', (patch: string, championId: number, role: StatRole | undefined, mode: GameMode) =>
    championBuild(patch, championId, role, assertMode(mode))
  )
  handle('crawlerStart', async (mode: GameMode) => {
    const s = settings.get()
    const data = await ddragon.get()
    void crawler.start({
      patch: data.patch,
      mode: assertMode(mode),
      platforms: [...new Set([s.platform, ...s.crawler.extraPlatforms])],
      seedTiers: s.crawler.seedTiers,
      maxMatches: s.crawler.maxMatchesPerRun,
      matchesPerPlayer: s.crawler.matchesPerPlayer,
      classify: makeClassifier(data)
    })
  })
  handle('crawlerStop', () => crawler.stop())
  handle('crawlerStatus', () => crawler.getStatus())
  handle('resetStats', async (patch: string, mode: GameMode) => {
    const m = assertMode(mode)
    await store.reset(patch, m)
    tierCache.delete(`${m}:${patch}`)
    emit('statsUpdated', { patch, mode: m })
  })
  handle('clientStatus', () => lcu.getStatus())
  handle('champSelect', () => lcu.getChampSelect())
  handle('liveGame', () => lcu.getLive())
  handle(
    'importBuild',
    (championId: number, role: StatRole | null, what: ('runes' | 'items' | 'spells')[] | undefined, mode: GameMode) =>
      lcu.importBuild(championId, role, what, assertMode(mode))
  )
  handle('getMayhemData', () => mayhem.get())
  handle('getMayhemPersonal', () => lcu.personalMayhem())
  handle('overlayPreview', (championId: number) => {
    overlay.preview(async () => {
      emit('overlayPreview', { championId })
      // simulate an augment choice so the card frames can be checked without a game
      try {
        const [data, statics] = await Promise.all([mayhem.get(), ddragon.get()])
        const tiers = augmentTiersForChampion(data, statics, championId)
        const pick = [tiers[0], tiers[Math.floor(tiers.length * 0.3)], tiers[tiers.length - 1]].filter(Boolean)
        const display = screen.getAllDisplays().find((d) => d.id === overlay.currentDisplayId) ?? screen.getPrimaryDisplay()
        const rects = cardRects(display.size.width, display.size.height)
        emit('augmentOffer', {
          displayId: display.id,
          cards: pick.map((t, i) => ({ augmentId: t.augment.id, text: t.augment.nameEn, score: 1, rect: rects[i] }))
        })
        setTimeout(() => emit('augmentOffer', null), 20_000)
      } catch {
        /* no data – side panel only */
      }
    })
  })
  handle('overlayDiagnostics', () => overlayDiagnostics())
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

// --- window --------------------------------------------------------------------

function createWindow(): void {
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'Rift Companion',
    icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? true : { color: '#0b0e14', symbolColor: '#9aa4b2', height: 40 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  // the (hidden) overlay window would otherwise keep the app alive
  win.on('closed', () => {
    win = null
    overlay.destroy()
    if (process.platform !== 'darwin') app.quit()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(win)
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

void app.whenReady().then(async () => {
  if (process.env.RC_OCR_SELFTEST) {
    const { nativeImage } = await import('electron')
    const res = await scanner.selfTest(nativeImage.createFromPath(process.env.RC_OCR_SELFTEST))
    console.log('RC_OCR_SELFTEST ' + JSON.stringify(res))
    app.exit(0)
    return
  }
  if (process.env.RC_SCAN_SELFTEST) {
    // end-to-end check of the capture path: show a screenshot full screen and scan the desktop
    const w = new BrowserWindow({ ...screen.getPrimaryDisplay().bounds, frame: false, show: true })
    await w.loadFile(process.env.RC_SCAN_SELFTEST)
    await new Promise((r) => setTimeout(r, 1500))
    const res = await scanner.testScan(join(userData, 'logs'))
    console.log('RC_SCAN_SELFTEST ' + JSON.stringify(res))
    app.exit(0)
    return
  }
  app.setAppUserModelId('dev.riftcompanion.app')
  registerIpc()
  createWindow()
  lcu.start()
  overlay.setHotkey(settings.get().overlay.hotkey)
  initAutoUpdate()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  scanner.stop()
  overlay.destroy()
  lcu.stop()
  crawler.stop()
  if (process.platform !== 'darwin') app.quit()
})
