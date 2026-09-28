import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { ChampionBuild, GameMode, PatchStats, Platform, RcEvents, Settings, StatRole, TierEntry } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { buildChampionView, buildTierList } from '@shared/analysis'
import { Crawler } from './crawler/crawler'
import { StatsStore } from './crawler/statsStore'
import { DataDragon, makeClassifier } from './ddragon'
import { LcuManager } from './lcu/manager'
import { MayhemService } from './mayhem'
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
  win?.webContents.send('rc:event', event, payload)
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
    live: (s) => emit('live', s),
    imported: (r) => emit('imported', r)
  }
})

function assertPlatform(p: string): Platform {
  if (!(p in PLATFORMS)) throw new Error(`Unbekannte Region: ${p}`)
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
    tierCache.clear()
    return next
  })
  handle('setApiKey', async (key: string) => {
    const clean = sanitizeApiKey(key)
    if (!clean) {
      settings.setApiKey('')
      return { ok: true, message: 'API Key entfernt.' }
    }
    if (!isValidKeyFormat(clean)) {
      return { ok: false, message: 'Das sieht nicht wie ein Riot API Key aus (Format: RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).' }
    }
    settings.setApiKey(clean)
    try {
      // the Challenger league endpoint is available for every key type (dev, personal, production)
      await riot.request(settings.get().platform, '/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5')
      return { ok: true, message: 'API Key gespeichert und gültig ✔' }
    } catch (e) {
      return { ok: false, message: `Key gespeichert, aber der Test ist fehlgeschlagen: ${(e as Error).message}` }
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

void app.whenReady().then(() => {
  app.setAppUserModelId('dev.riftcompanion.app')
  registerIpc()
  createWindow()
  lcu.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  lcu.stop()
  crawler.stop()
  if (process.platform !== 'darwin') app.quit()
})
