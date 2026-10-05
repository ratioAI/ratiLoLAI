import { StrictMode, Suspense, lazy, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/syne/700.css'
import '@fontsource/syne/800.css'
import './styles.css'
import { AppProvider, useApp } from './lib/store'
import { Layout, Spinner } from './components/Layout'

// Pages are separate chunks: the overlay windows (which load the same bundle) never parse them, and
// the main window prefetches them right after its first paint so switching tabs stays instant.
const pages = {
  Home: () => import('./pages/Home').then((m) => ({ default: m.Home })),
  TierList: () => import('./pages/TierList').then((m) => ({ default: m.TierList })),
  Champions: () => import('./pages/Champions').then((m) => ({ default: m.Champions })),
  ChampionPage: () => import('./pages/Champion').then((m) => ({ default: m.ChampionPage })),
  Live: () => import('./pages/Live').then((m) => ({ default: m.Live })),
  Games: () => import('./pages/Games').then((m) => ({ default: m.Games })),
  GameDetail: () => import('./pages/Games').then((m) => ({ default: m.GameDetail })),
  Profile: () => import('./pages/Profile').then((m) => ({ default: m.Profile })),
  Data: () => import('./pages/Data').then((m) => ({ default: m.Data })),
  Settings: () => import('./pages/Settings').then((m) => ({ default: m.Settings })),
  Mayhem: () => import('./pages/Mayhem').then((m) => ({ default: m.Mayhem }))
}
const Home = lazy(pages.Home)
const TierList = lazy(pages.TierList)
const Champions = lazy(pages.Champions)
const ChampionPage = lazy(pages.ChampionPage)
const Live = lazy(pages.Live)
const Games = lazy(pages.Games)
const GameDetail = lazy(pages.GameDetail)
const Profile = lazy(pages.Profile)
const Data = lazy(pages.Data)
const Settings = lazy(pages.Settings)
const Mayhem = lazy(pages.Mayhem)
import { Overlay } from './pages/Overlay'
import { TripBackground } from './components/TripBackground'
import { CosmosBackground, JUMP_MS, cosmicSeed } from './components/CosmosBackground'
import { JourneyCanvas } from './components/JourneyCanvas'
import { api } from './lib/api'
import { OverlayFrames } from './pages/OverlayFrames'
import { OverlayMinimap } from './pages/OverlayMinimap'
import { OverlayLoading } from './pages/OverlayLoading'

/**
 * Which galaxy we are in. A new one every time a match is accepted – then the whole window
 * travels through a wormhole to it (`journey` holds the jump while it runs).
 */
function useCosmos(onArrive: () => void): { seed: number; journey: { from: number; to: number; key: number } | null } {
  const [seed, setSeed] = useState(() => {
    try {
      return Number(localStorage.getItem('rc.cosmos')) || cosmicSeed(Date.now() >> 20)
    } catch {
      return cosmicSeed(1)
    }
  })
  const [journey, setJourney] = useState<{ from: number; to: number; key: number } | null>(null)
  const current = useRef(seed)
  const arriveRef = useRef(onArrive)
  arriveRef.current = onArrive
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let arrive: ReturnType<typeof setTimeout> | undefined
    const off = api.on('journey', ({ seed: s }) => {
      const v = cosmicSeed(s)
      setJourney({ from: current.current, to: v, key: Date.now() })
      current.current = v
      setSeed(v)
      clearTimeout(timer)
      clearTimeout(arrive)
      // at the far end of the wormhole: the new game – switch to the Live tab under the overlay
      arrive = setTimeout(() => arriveRef.current(), JUMP_MS * 0.6)
      timer = setTimeout(() => setJourney(null), JUMP_MS + 900)
      try {
        localStorage.setItem('rc.cosmos', String(v))
      } catch {
        /* private mode */
      }
    })
    return () => {
      off()
      clearTimeout(timer)
      clearTimeout(arrive)
    }
  }, [])
  return { seed, journey }
}

/** The flight to the next planet over the whole window; fades out once we have landed. */
function JourneyOverlay({ journey }: { journey: { from: number; to: number; key: number } }) {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLeaving(true), JUMP_MS - 200)
    return () => clearTimeout(t)
  }, [])
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[200] transition-opacity duration-700"
      style={{ opacity: leaving ? 0 : 1, animation: 'fade 0.6s ease-out' }}
      aria-hidden
    >
      <JourneyCanvas key={journey.key} from={journey.from} to={journey.to} />
    </div>
  )
}

function Shell() {
  const { settings, live } = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  // overlay windows get the event too – only the main window changes tabs
  const { seed, journey } = useCosmos(() => {
    if (!window.location.hash.startsWith('#/overlay')) navigate('/live')
  })
  const bg = settings?.ui.background ?? 'animated'
  const hash = window.location.hash
  if (hash.startsWith('#/overlay/panel')) return <Overlay part="panel" />
  if (hash.startsWith('#/overlay/frames')) return <OverlayFrames />
  if (hash.startsWith('#/overlay/minimap')) return <OverlayMinimap />
  if (hash.startsWith('#/overlay/loading')) return <OverlayLoading />
  if (hash.startsWith('#/overlay')) return <Overlay />
  return (
    <>
      {location.pathname.startsWith('/games') ? (
        <CosmosBackground seed={seed} mode={bg} inGame={!!live?.active} />
      ) : (
        <TripBackground mode={settings?.ui.background ?? 'animated'} inGame={!!live?.active} />
      )}
      <MainShell />
      {journey && bg !== 'static' && <JourneyOverlay key={journey.key} journey={journey} />}
    </>
  )
}

function MainShell() {
  const { data, dataError } = useApp()
  if (!data) {
    return (
      <div className="drag flex h-full flex-col items-center justify-center gap-4 text-sm text-muted">
        {dataError ? (
          <>
            <b className="text-loss">Could not load game data</b>
            <span>{dataError}</span>
          </>
        ) : (
          <>
            <Spinner />
            Loading game data (Data Dragon) …
          </>
        )}
      </div>
    )
  }
  return (
    <Layout>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/tierlist" element={<TierList />} />
          <Route path="/champions" element={<Champions />} />
          <Route path="/champion/:id/:role?" element={<ChampionPage />} />
          <Route path="/live" element={<Live />} />
          <Route path="/games" element={<Games />} />
          <Route path="/games/:id" element={<GameDetail />} />
          <Route path="/mayhem" element={<Mayhem />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/data" element={<Data />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}

if (!window.location.hash.startsWith('#/overlay')) {
  const prefetch = () => Object.values(pages).forEach((load) => void load())
  if ('requestIdleCallback' in window) requestIdleCallback(prefetch, { timeout: 3000 })
  else setTimeout(prefetch, 1500)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <Shell />
      </AppProvider>
    </HashRouter>
  </StrictMode>
)
