import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { ChampionBuild, PatchStats, Platform, RcEvents, Role, Settings, TierEntry } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { buildChampionView, buildTierList } from '@shared/analysis'
import { Crawler } from './crawler/crawler'
import { StatsStore } from './crawler/statsStore'
import { DataDragon, makeClassifier } from './ddragon'
import { LcuManager } from './lcu/manager'
import { ProfileService } from './profile'
import { RiotClient } from './riot/client'
import { SettingsStore } from './settings'

if (!app.requestSingleInstanceLock()) app.quit()

const userData = app.getPath('userData')
const settings = new SettingsStore(join(userData, 'settings.json'))
const ddragon = new DataDragon(join(userData, 'ddragon'), settings.get().language)
const store = new StatsStore(join(userData, 'stats'))
const riot = new RiotClient(() => settings.getApiKey())
const profiles = new ProfileService(riot)

let win: BrowserWindow | null = null

function emit<K extends keyof RcEvents>(event: K, payload: RcEvents[K]): void {
  win?.webContents.send('rc:event', event, payload)
}

// --- statistics helpers ------------------------------------------------------

const tierCache = new Map<string, { at: number; list: TierEntry[] }>()

async function statsFor(patch: string): Promise<PatchStats> {
  return (await store.load(patch)).stats
}

async function tierList(patch: string): Promise<TierEntry[]> {
  const stats = await statsFor(patch)
  const cached = tierCache.get(patch)
  if (cached && cached.at === stats.updatedAt) return cached.list
  const list = buildTierList(stats, settings.get().crawler.minGamesForTierList)
  tierCache.set(patch, { at: stats.updatedAt, list })
  return list
}

async function currentPatch(): Promise<string> {
  const known = await store.patches()
  const ddPatch = (await ddragon.get().catch(() => null))?.patch
  // prefer the newest patch with data, fall back to the live patch
  return known.find((p) => p.matches > 0)?.patch ?? ddPatch ?? known[0]?.patch ?? '0.0'
}

async function championBuild(patch: string, championId: number, role?: Role | null): Promise<ChampionBuild | null> {
  return buildChampionView(await statsFor(patch), championId, role ?? undefined, await tierList(patch))
}

// --- services ----------------------------------------------------------------

const crawler = new Crawler(
  riot,
  store,
  (s) => emit('crawler', s),
  (patch) => {
    tierCache.delete(patch)
    emit('statsUpdated', { patch })
  }
)

const lcu = new LcuManager({
  settings: () => settings.get(),
  staticData: () => ddragon.get(),
  build: async (championId, role) => championBuild(await currentPatch(), championId, role),
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
    tierCache.clear()
    return next
  })
  handle('setApiKey', async (key: string) => {
    const trimmed = key.trim()
    settings.setApiKey(trimmed)
    if (!trimmed) return { ok: true, message: 'API Key entfernt.' }
    try {
      const platform = settings.get().platform
      await riot.request(platform, '/lol/status/v4/platform-data')
      return { ok: true, message: 'API Key gespeichert und gültig ✔' }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })
  handle('getPatches', () => store.patches())
  handle('getTierList', (patch: string) => tierList(patch))
  handle('getChampionBuild', (patch: string, championId: number, role?: Role) => championBuild(patch, championId, role))
  handle('crawlerStart', async () => {
    const s = settings.get()
    const data = await ddragon.get()
    void crawler.start({
      patch: data.patch,
      platforms: [...new Set([s.platform, ...s.crawler.extraPlatforms])],
      seedTiers: s.crawler.seedTiers,
      maxMatches: s.crawler.maxMatchesPerRun,
      matchesPerPlayer: s.crawler.matchesPerPlayer,
      classify: makeClassifier(data)
    })
  })
  handle('crawlerStop', () => crawler.stop())
  handle('crawlerStatus', () => crawler.getStatus())
  handle('resetStats', async (patch: string) => {
    await store.reset(patch)
    tierCache.delete(patch)
    emit('statsUpdated', { patch })
  })
  handle('clientStatus', () => lcu.getStatus())
  handle('champSelect', () => lcu.getChampSelect())
  handle('liveGame', () => lcu.getLive())
  handle('importBuild', (championId: number, role: Role | null, what?: ('runes' | 'items' | 'spells')[]) =>
    lcu.importBuild(championId, role, what)
  )
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
