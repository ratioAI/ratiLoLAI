import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type {
  ChampSelectState,
  ClientStatus,
  CrawlerStatus,
  GameMode,
  ImportResult,
  LiveGameState,
  Settings,
  StaticData
} from '@shared/types'
import { api } from './api'

interface AppState {
  data: StaticData | null
  dataError: string | null
  settings: Settings | null
  setSettings: (s: Settings) => void
  mode: GameMode
  setMode: (m: GameMode) => void
  patches: { patch: string; matches: number; updatedAt: number }[]
  patch: string | null
  setPatch: (p: string) => void
  refreshPatches: () => Promise<void>
  statsVersion: number
  client: ClientStatus
  champSelect: ChampSelectState | null
  live: LiveGameState | null
  crawler: CrawlerStatus | null
  lastImport: (ImportResult & { championId: number; at: number }) | null
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<StaticData | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [mode, setModeState] = useState<GameMode>(() => {
    try {
      return localStorage.getItem('rc.mode') === 'aram' ? 'aram' : 'ranked'
    } catch {
      return 'ranked'
    }
  })
  const setMode = useCallback((m: GameMode) => {
    setModeState(m)
    try {
      localStorage.setItem('rc.mode', m)
    } catch {
      /* ignore */
    }
  }, [])
  const [patches, setPatches] = useState<AppState['patches']>([])
  const [patch, setPatch] = useState<string | null>(null)
  const [statsVersion, setStatsVersion] = useState(0)
  const [client, setClient] = useState<ClientStatus>({ connected: false, phase: 'None', summoner: null })
  const [champSelect, setChampSelect] = useState<ChampSelectState | null>(null)
  const [live, setLive] = useState<LiveGameState | null>(null)
  const [crawler, setCrawler] = useState<CrawlerStatus | null>(null)
  const [lastImport, setLastImport] = useState<AppState['lastImport']>(null)

  const refreshPatches = useCallback(async () => {
    const list = await api.getPatches(mode)
    setPatches(list)
    setPatch((cur) => {
      if (cur && list.some((p) => p.patch === cur)) return cur
      return list.find((p) => p.matches > 0)?.patch ?? list[0]?.patch ?? cur
    })
  }, [mode])

  useEffect(() => {
    void refreshPatches()
  }, [refreshPatches])

  useEffect(() => {
    api.getSettings().then(setSettings)
    api
      .getStatic()
      .then((d) => {
        setData(d)
        setPatch((cur) => cur ?? d.patch)
      })
      .catch((e: Error) => setDataError(e.message))
    api.clientStatus().then(setClient)
    api.champSelect().then(setChampSelect)
    api.liveGame().then(setLive)
    api.crawlerStatus().then(setCrawler)

    const offs = [
      api.on('client', setClient),
      api.on('champSelect', setChampSelect),
      api.on('live', setLive),
      api.on('crawler', setCrawler),
      api.on('imported', (r) => setLastImport({ ...r, at: Date.now() })),
      api.on('statsUpdated', () => setStatsVersion((v) => v + 1))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    if (statsVersion) void refreshPatches()
  }, [statsVersion, refreshPatches])

  // reload static data when the language changes
  const language = settings?.language
  useEffect(() => {
    if (!language || !data || data.language === language) return
    api.getStatic().then(setData)
  }, [language, data])

  return (
    <Ctx.Provider
      value={{
        data,
        dataError,
        settings,
        setSettings,
        mode,
        setMode,
        patches,
        patch,
        setPatch,
        refreshPatches,
        statsVersion,
        client,
        champSelect,
        live,
        crawler,
        lastImport
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useApp(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp outside AppProvider')
  return ctx
}

/** Small async helper: re-runs the loader whenever deps change. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): { value: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ value: T | null; error: string | null; loading: boolean }>({
    value: null,
    error: null,
    loading: true
  })
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    loader().then(
      (value) => alive && setState({ value, error: null, loading: false }),
      (e: Error) => alive && setState({ value: null, error: e.message, loading: false })
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
