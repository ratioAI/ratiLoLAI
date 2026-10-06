import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  setSettings: (settings: Settings) => void
  mode: GameMode
  setMode: (mode: GameMode) => void
  patches: { patch: string; matches: number; updatedAt: number }[]
  patch: string | null
  setPatch: (patch: string) => void
  refreshPatches: () => Promise<void>
  statsVersion: number
  client: ClientStatus
  champSelect: ChampSelectState | null
  live: LiveGameState | null
  crawler: CrawlerStatus | null
  lastImport: (ImportResult & { championId: number; at: number }) | null
}

const AppCtx = createContext<AppState | null>(null)
// Static data gets its own context. Hundreds of icons read it and shouldn't re-render every
// second just because the live game state in the main context changed.
const DataCtx = createContext<StaticData | null>(null)

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
  const setMode = useCallback((nextMode: GameMode) => {
    setModeState(nextMode)
    try {
      localStorage.setItem('rc.mode', nextMode)
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
    // keep the selected patch if it still exists, otherwise pick the newest one that has matches
    setPatch((current) => {
      if (current && list.some((entry) => entry.patch === current)) return current
      return list.find((entry) => entry.matches > 0)?.patch ?? list[0]?.patch ?? current
    })
  }, [mode])

  useEffect(() => {
    void refreshPatches()
  }, [refreshPatches])

  useEffect(() => {
    api.getSettings().then(setSettings)
    api
      .getStatic()
      .then((staticData) => {
        setData(staticData)
        setPatch((current) => current ?? staticData.patch)
      })
      .catch((err: Error) => setDataError(err.message))
    api.clientStatus().then(setClient)
    api.champSelect().then(setChampSelect)
    api.liveGame().then(setLive)
    api.crawlerStatus().then(setCrawler)

    const unsubscribers = [
      api.on('client', setClient),
      api.on('champSelect', setChampSelect),
      api.on('live', setLive),
      api.on('crawler', setCrawler),
      api.on('imported', (result) => setLastImport({ ...result, at: Date.now() })),
      api.on('statsUpdated', () => setStatsVersion((version) => version + 1))
    ]
    return () => unsubscribers.forEach((off) => off())
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

  const value = useMemo<AppState>(
    () => ({
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
    }),
    [data, dataError, settings, mode, setMode, patches, patch, refreshPatches, statsVersion, client, champSelect, live, crawler, lastImport]
  )
  return (
    <DataCtx.Provider value={data}>
      <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
    </DataCtx.Provider>
  )
}

export function useApp(): AppState {
  const ctx = useContext(AppCtx)
  if (!ctx) throw new Error('useApp outside AppProvider')
  return ctx
}

/** Just the static game data (champions, items, ...), for components that need nothing else. */
export function useGameData(): StaticData | null {
  return useContext(DataCtx)
}

/** Runs an async loader and re-runs it whenever `deps` change. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): { value: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ value: T | null; error: string | null; loading: boolean }>({
    value: null,
    error: null,
    loading: true
  })
  useEffect(() => {
    let alive = true
    setState((prev) => ({ ...prev, loading: true }))
    loader().then(
      (value) => alive && setState({ value, error: null, loading: false }),
      (err: Error) => alive && setState({ value: null, error: err.message, loading: false })
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
