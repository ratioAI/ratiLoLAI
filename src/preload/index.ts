import { contextBridge, ipcRenderer } from 'electron'
import type { AdminApi, RcApi, RcEvents } from '@shared/types'
import type { CaptureBridge } from '@shared/capture'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; value?: T; error?: string }
  if (!res.ok) throw new Error(res.error ?? 'Unknown error')
  return res.value as T
}

// developer tools, only in `npm run dev` (see main/admin.ts)
const admin: AdminApi | undefined = import.meta.env.DEV
  ? {
      acceptMatch: () => call('admin:acceptMatch'),
      emit: (event, payload) => call('admin:emit', event, payload),
      simStart: (options) => call('admin:simStart', options),
      simAction: (action) => call('admin:simAction', action),
      simState: () => call('admin:simState'),
      simStop: () => call('admin:simStop'),
      showMinimapDemo: (scenario, map) => call('admin:showMinimapDemo', scenario, map),
      showFrames: (championId) => call('admin:showFrames', championId),
      showLoading: (state) => call('admin:showLoading', state),
      showHistoryLobby: () => call('admin:showHistoryLobby'),
      hideOverlays: () => call('admin:hideOverlays'),
      saveTestGame: (summary) => call('admin:saveTestGame', summary),
      deleteTestGames: () => call('admin:deleteTestGames'),
      unlockAchievement: (id) => call('admin:unlockAchievement', id),
      resetAchievements: () => call('admin:resetAchievements'),
      discordPreview: () => call('admin:discordPreview'),
      announce: (trigger) => call('admin:announce', trigger),
      log: (lines) => call('admin:log', lines),
      minimapSnapshot: () => call('admin:minimapSnapshot'),
      classifyPads: (pads) => call('admin:classifyPads', pads),
      measuredPads: () => call('admin:measuredPads'),
      savePads: (map, pads) => call('admin:savePads', map, pads)
    }
  : undefined

const api: RcApi = {
  admin,
  getStatic: () => call('getStatic'),
  getSettings: () => call('getSettings'),
  saveSettings: (patch) => call('saveSettings', patch),
  setApiKey: (key) => call('setApiKey', key),
  setDiscordWebhook: (url) => call('setDiscordWebhook', url),
  testDiscordWebhook: () => call('testDiscordWebhook'),
  postGameToDiscord: (gameId) => call('postGameToDiscord', gameId),
  getPatches: (mode) => call('getPatches', mode),
  getTierList: (patch, mode) => call('getTierList', patch, mode),
  getChampionBuild: (patch, championId, role, mode) => call('getChampionBuild', patch, championId, role, mode),
  crawlerStart: (mode) => call('crawlerStart', mode),
  crawlerStop: () => call('crawlerStop'),
  crawlerStatus: () => call('crawlerStatus'),
  resetStats: (patch, mode) => call('resetStats', patch, mode),
  clientStatus: () => call('clientStatus'),
  champSelect: () => call('champSelect'),
  importBuild: (championId, role, what, mode) => call('importBuild', championId, role, what, mode),
  getMayhemData: () => call('getMayhemData'),
  getMayhemPersonal: () => call('getMayhemPersonal'),
  overlayPreview: (championId) => call('overlayPreview', championId),
  setOverlayInteractive: (interactive) => ipcRenderer.send('overlay:interactive', interactive),
  appInfo: () => call('appInfo'),
  installUpdate: () => call('installUpdate'),
  overlayDiagnostics: () => call('overlayDiagnostics'),
  overlayScanNow: () => call('overlayScanNow'),
  getOwnedAugments: () => call('getOwnedAugments'),
  getMapTimers: () => call('getMapTimers'),
  listGames: () => call('listGames'),
  getGame: (id) => call('getGame', id),
  getLeaderboard: () => call('getLeaderboard'),
  getPlayerHistory: (puuid, riotId) => call('getPlayerHistory', puuid, riotId),
  getAchievements: () => call('getAchievements'),
  getAnnouncerSound: (trigger) => call('getAnnouncerSound', trigger),
  openSoundFolder: () => call('openSoundFolder'),
  markAchievementsSeen: (ids) => call('markAchievementsSeen', ids),
  recordFlight: (variant, seed) => call('recordFlight', variant, seed),
  setOwnedAugments: (ids) => call('setOwnedAugments', ids),
  overlayTestScan: () => call('overlayTestScan'),
  openDiagnosticsFolder: () => call('openDiagnosticsFolder'),
  liveGame: () => call('liveGame'),
  lookupProfile: (riotId, platform) => call('lookupProfile', riotId, platform),
  scoutActiveGame: (riotId, platform) => call('scoutActiveGame', riotId, platform),
  openExternal: (url) => call('openExternal', url),
  logDiag: (message) => ipcRenderer.send('rc:log', String(message).slice(0, 400)),
  // all main -> renderer events share one channel, filtered by name here
  on<K extends keyof RcEvents>(event: K, callback: (payload: RcEvents[K]) => void) {
    const listener = (_event: unknown, name: string, payload: RcEvents[K]): void => {
      if (name === event) callback(payload)
    }
    ipcRenderer.on('rc:event', listener)
    return () => ipcRenderer.removeListener('rc:event', listener)
  }
}

contextBridge.exposeInMainWorld('rc', api)

// only used by the hidden capture page (see renderer/src/capture.ts)
const capture: CaptureBridge = {
  onCommand: (callback) => ipcRenderer.on('capture:cmd', (_event, id: number, command) => callback(id, command)),
  reply: (id, reply) => ipcRenderer.send('capture:reply', id, reply)
}
contextBridge.exposeInMainWorld('rcCapture', capture)
