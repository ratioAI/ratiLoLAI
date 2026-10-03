import { StrictMode, useEffect, useRef, useState } from 'react'
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
import { Home } from './pages/Home'
import { TierList } from './pages/TierList'
import { Champions } from './pages/Champions'
import { ChampionPage } from './pages/Champion'
import { Live } from './pages/Live'
import { GameDetail, Games } from './pages/Games'
import { Profile } from './pages/Profile'
import { Data } from './pages/Data'
import { Settings } from './pages/Settings'
import { Mayhem } from './pages/Mayhem'
import { Overlay } from './pages/Overlay'
import { TripBackground } from './components/TripBackground'
import { CosmosBackground, JUMP_MS, cosmicSeed } from './components/CosmosBackground'
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

/** The jump through the wormhole over the whole window; fades out when the new galaxy is reached. */
function JourneyOverlay({ journey, mode }: { journey: { from: number; to: number; key: number }; mode: 'animated' | 'calm' | 'static' }) {
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
      <CosmosBackground
        key={journey.key}
        seed={journey.to}
        from={journey.from}
        jumpOnMount
        mode={mode === 'static' ? 'animated' : mode}
        inGame={false}
        className="h-full w-full"
      />
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
        <CosmosBackground seed={seed} mode={bg} inGame={!!live?.active} animateChanges={false} />
      ) : (
        <TripBackground mode={settings?.ui.background ?? 'animated'} inGame={!!live?.active} />
      )}
      <MainShell />
      {journey && bg !== 'static' && <JourneyOverlay key={journey.key} journey={journey} mode={bg} />}
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
    </Layout>
  )
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
