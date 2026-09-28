import { contextBridge, ipcRenderer } from 'electron'
import type { RcApi, RcEvents } from '@shared/types'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; value?: T; error?: string }
  if (!res.ok) throw new Error(res.error ?? 'Unbekannter Fehler')
  return res.value as T
}

const api: RcApi = {
  getStatic: () => call('getStatic'),
  getSettings: () => call('getSettings'),
  saveSettings: (patch) => call('saveSettings', patch),
  setApiKey: (key) => call('setApiKey', key),
  getPatches: () => call('getPatches'),
  getTierList: (patch) => call('getTierList', patch),
  getChampionBuild: (patch, championId, role) => call('getChampionBuild', patch, championId, role),
  crawlerStart: () => call('crawlerStart'),
  crawlerStop: () => call('crawlerStop'),
  crawlerStatus: () => call('crawlerStatus'),
  resetStats: (patch) => call('resetStats', patch),
  clientStatus: () => call('clientStatus'),
  champSelect: () => call('champSelect'),
  importBuild: (championId, role, what) => call('importBuild', championId, role, what),
  liveGame: () => call('liveGame'),
  lookupProfile: (riotId, platform) => call('lookupProfile', riotId, platform),
  scoutActiveGame: (riotId, platform) => call('scoutActiveGame', riotId, platform),
  openExternal: (url) => call('openExternal', url),
  on<K extends keyof RcEvents>(event: K, cb: (payload: RcEvents[K]) => void) {
    const listener = (_e: unknown, name: string, payload: RcEvents[K]): void => {
      if (name === event) cb(payload)
    }
    ipcRenderer.on('rc:event', listener)
    return () => ipcRenderer.removeListener('rc:event', listener)
  }
}

contextBridge.exposeInMainWorld('rc', api)
