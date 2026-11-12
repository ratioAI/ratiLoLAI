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

// Each page is its own chunk. The overlay windows load the same bundle but never need the pages, and
// the main window prefetches them once it's idle so switching tabs still feels instant.
const pages = {
  Home: () => import('./pages/Home').then((mod) => ({ default: mod.Home })),
  TierList: () => import('./pages/TierList').then((mod) => ({ default: mod.TierList })),
  Champions: () => import('./pages/Champions').then((mod) => ({ default: mod.Champions })),
  ChampionPage: () => import('./pages/Champion').then((mod) => ({ default: mod.ChampionPage })),
  Live: () => import('./pages/Live').then((mod) => ({ default: mod.Live })),
  Games: () => import('./pages/Games').then((mod) => ({ default: mod.Games })),
  GameDetail: () => import('./pages/Games').then((mod) => ({ default: mod.GameDetail })),
  Leaderboard: () => import('./pages/Leaderboard').then((mod) => ({ default: mod.Leaderboard })),
  StarMap: () => import('./pages/StarMap').then((mod) => ({ default: mod.StarMap })),
  Profile: () => import('./pages/Profile').then((mod) => ({ default: mod.Profile })),
  Data: () => import('./pages/Data').then((mod) => ({ default: mod.Data })),
  Settings: () => import('./pages/Settings').then((mod) => ({ default: mod.Settings })),
  Mayhem: () => import('./pages/Mayhem').then((mod) => ({ default: mod.Mayhem }))
}
const Home = lazy(pages.Home)
const TierList = lazy(pages.TierList)
const Champions = lazy(pages.Champions)
const ChampionPage = lazy(pages.ChampionPage)
const Live = lazy(pages.Live)
const Games = lazy(pages.Games)
const GameDetail = lazy(pages.GameDetail)
const Leaderboard = lazy(pages.Leaderboard)
const StarMap = lazy(pages.StarMap)
const Profile = lazy(pages.Profile)
const Data = lazy(pages.Data)
const Settings = lazy(pages.Settings)
const Mayhem = lazy(pages.Mayhem)
import { Overlay } from './pages/Overlay'
import { TripBackground } from './components/TripBackground'
import { CosmosBackground, JUMP_MS, cosmicSeed } from './components/CosmosBackground'
import { JourneyCanvas } from './components/JourneyCanvas'
import { galaxyOf } from '@shared/universe'
import { api } from './lib/api'
import { OverlayFrames } from './pages/OverlayFrames'
import { OverlayMinimap } from './pages/OverlayMinimap'
import { OverlayLoading } from './pages/OverlayLoading'

/**
 * The place in the universe we're currently at. Every accepted match picks a new one and the window
 * flies there; `journey` is set while that jump is running.
 */
function useCosmos(onArrive: () => void): { seed: number; journey: { from: number; to: number; key: number } | null } {
  const [seed, setSeed] = useState(() => {
    try {
      const stored = Number(localStorage.getItem('rc.cosmos'))
      if (stored) return stored
      // first start: pick a home and remember it, so the star map knows where we are
      const home = cosmicSeed(Date.now() >> 20)
      localStorage.setItem('rc.cosmos', String(home))
      return home
    } catch {
      return cosmicSeed(1)
    }
  })
  const [journey, setJourney] = useState<{ from: number; to: number; key: number } | null>(null)
  const currentSeed = useRef(seed)
  const arriveRef = useRef(onArrive)
  arriveRef.current = onArrive
  useEffect(() => {
    let endTimer: ReturnType<typeof setTimeout> | undefined
    let arriveTimer: ReturnType<typeof setTimeout> | undefined
    const off = api.on('journey', ({ seed: rawSeed }) => {
      const nextSeed = cosmicSeed(rawSeed)
      setJourney({ from: currentSeed.current, to: nextSeed, key: Date.now() })
      currentSeed.current = nextSeed
      setSeed(nextSeed)
      clearTimeout(endTimer)
      clearTimeout(arriveTimer)
      // switch to the Live tab while the overlay still covers the window, so we "land" in the new game
      arriveTimer = setTimeout(() => arriveRef.current(), JUMP_MS * 0.6)
      endTimer = setTimeout(() => setJourney(null), JUMP_MS + 900)
      try {
        localStorage.setItem('rc.cosmos', String(nextSeed))
      } catch {
        /* private mode */
      }
    })
    return () => {
      off()
      clearTimeout(endTimer)
      clearTimeout(arriveTimer)
    }
  }, [])
  return { seed, journey }
}

/** Full-window flight to the next galaxy. Fades out shortly before the jump ends. */
function JourneyOverlay({ journey }: { journey: { from: number; to: number; key: number } }) {
  const [leaving, setLeaving] = useState(false)
  useEffect(() => {
    const fadeTimer = setTimeout(() => setLeaving(true), JUMP_MS - 200)
    return () => clearTimeout(fadeTimer)
  }, [])
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[200] transition-opacity duration-700"
      style={{ opacity: leaving ? 0 : 1, animation: 'fade 0.6s ease-out' }}
      aria-hidden
    >
      <JourneyCanvas key={journey.key} from={journey.from} to={journey.to} />
      {/* where we're going, shown while crossing intergalactic space */}
      <div className="journey-caption absolute inset-x-0 bottom-[9%] text-center">
        <div className="text-[11px] font-semibold tracking-[0.35em] text-white/55 uppercase">Destination</div>
        <div className="font-display text-3xl font-extrabold tracking-tight text-white/90">{galaxyOf(journey.to).name}</div>
        <div className="text-xs tracking-widest text-white/45">{galaxyOf(journey.to).designation}</div>
      </div>
    </div>
  )
}

function Shell() {
  const { settings, live } = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  // overlay windows get the event too, but only the main window should change tabs
  const { seed, journey } = useCosmos(() => {
    if (!window.location.hash.startsWith('#/overlay')) navigate('/live')
  })
  const background = settings?.ui.background ?? 'animated'
  const hash = window.location.hash
  if (hash.startsWith('#/overlay/panel')) return <Overlay part="panel" />
  if (hash.startsWith('#/overlay/frames')) return <OverlayFrames />
  if (hash.startsWith('#/overlay/minimap')) return <OverlayMinimap />
  if (hash.startsWith('#/overlay/loading')) return <OverlayLoading />
  if (hash.startsWith('#/overlay')) return <Overlay />
  return (
    <>
      {location.pathname.startsWith('/games') ? (
        <CosmosBackground seed={seed} mode={background} inGame={!!live?.active} />
      ) : (
        <TripBackground mode={settings?.ui.background ?? 'animated'} inGame={!!live?.active} />
      )}
      <MainShell />
      {journey && background !== 'static' && <JourneyOverlay key={journey.key} journey={journey} />}
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
          <Route path="/games/leaderboard" element={<Leaderboard />} />
          <Route path="/games/map" element={<StarMap />} />
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
