import { contextBridge, ipcRenderer } from 'electron'
import type { RcApi, RcEvents } from '@shared/types'
import type { CaptureBridge } from '@shared/capture'

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
  overlayTestScan: () => call('overlayTestScan'),
  openDiagnosticsFolder: () => call('openDiagnosticsFolder'),
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

// only used by the hidden capture page (see renderer/src/capture.ts)
const capture: CaptureBridge = {
  onCommand: (cb) => ipcRenderer.on('capture:cmd', (_e, id: number, cmd) => cb(id, cmd)),
  reply: (id, reply) => ipcRenderer.send('capture:reply', id, reply)
}
contextBridge.exposeInMainWorld('rcCapture', capture)
