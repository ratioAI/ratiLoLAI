import { StrictMode, Suspense, lazy, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
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
// The admin tool only exists in `npm run dev`; builds leave the page out completely.
const Admin = import.meta.env.DEV ? lazy(() => import('./pages/Admin').then((mod) => ({ default: mod.Admin }))) : null
import { Overlay } from './pages/Overlay'
import { TripBackground } from './components/TripBackground'
import { CosmosBackground, cosmicSeed } from './components/CosmosBackground'
import { JourneyCanvas } from './components/JourneyCanvas'
import { prewarmFlightShaders } from './components/flightGl'
import { FLIGHT_S, FLIGHT_VARIANTS, captionAt, pickVariant, type FlightVariant } from '@shared/journey'
import { galaxyKind, galaxyOf } from '@shared/universe'
import { api } from './lib/api'
import { OverlayFrames } from './pages/OverlayFrames'
import { OverlayMinimap } from './pages/OverlayMinimap'
import { OverlayLoading } from './pages/OverlayLoading'
import { COSMOS_EVENT, type CosmosCommand } from './lib/cosmosControl'

interface Journey {
  from: number
  to: number
  key: number
  /** set by the admin tool, otherwise picked at random (nextVariant) */
  variant?: FlightVariant
  /** admin tool: don't switch to the Live tab at the end */
  stay?: boolean
}

/**
 * The place in the universe we're currently at. Every accepted match picks a new one and the window
 * flies there; `journey` is set from then until the flight has ended (see JourneyOverlay).
 */
function useCosmos(): { seed: number; journey: Journey | null; endJourney: () => void } {
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
  const [journey, setJourney] = useState<Journey | null>(null)
  const currentSeed = useRef(seed)
  const moveTo = useCallback((nextSeed: number) => {
    currentSeed.current = nextSeed
    try {
      localStorage.setItem('rc.cosmos', String(nextSeed))
    } catch {
      /* private mode */
    }
  }, [])
  const fly = useCallback(
    (nextSeed: number, variant?: FlightVariant, stay?: boolean) => {
      // a second accept while still flying (someone dodged) starts over from where we were heading.
      // The sky behind the flight switches to the new planet only when it ends (endJourney), so the
      // flight fades in over the very sky it starts from.
      setJourney({ from: currentSeed.current, to: nextSeed, key: Date.now(), variant, stay })
      moveTo(nextSeed)
    },
    [moveTo]
  )
  useEffect(() => api.on('journey', ({ seed: rawSeed }) => fly(cosmicSeed(rawSeed))), [fly])
  // the admin tool's flights and teleports (development builds only)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onCommand = (event: Event): void => {
      const command = (event as CustomEvent<CosmosCommand>).detail
      if (command.type === 'fly') fly(command.to, command.variant, command.stay)
      else {
        moveTo(command.to)
        setSeed(command.to)
      }
    }
    window.addEventListener(COSMOS_EVENT, onCommand)
    return () => window.removeEventListener(COSMOS_EVENT, onCommand)
  }, [fly, moveTo])
  const endJourney = useCallback(() => {
    setJourney(null)
    setSeed(currentSeed.current)
  }, [])
  return { seed, journey, endJourney }
}

/**
 * Kind of the next flight: wormhole or slingshot at random, never three times the same in a row.
 * '#...journey=wormhole' (or slingshot) in the URL forces one, for screenshots.
 */
function nextVariant(seed: number): FlightVariant {
  const forced = FLIGHT_VARIANTS.find((variant) => window.location.hash.includes(`journey=${variant}`))
  let recent: FlightVariant[] = []
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('rc.flights') ?? '[]')
    if (Array.isArray(stored)) recent = stored.filter((entry): entry is FlightVariant => FLIGHT_VARIANTS.includes(entry))
  } catch {
    /* nothing stored */
  }
  const variant = forced ?? pickVariant(seed, recent)
  try {
    localStorage.setItem('rc.flights', JSON.stringify([variant, ...recent].slice(0, 2)))
  } catch {
    /* private mode */
  }
  return variant
}

const noop = (): void => undefined

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Full-window flight to the next galaxy. It plays to the end even if the window is hidden for a
 * while (the film just waits), and ends early only when you skip it (click, Esc, Space, Enter) or
 * when the game itself starts. At the end the app switches to the Live tab under the last frame,
 * then the overlay fades out.
 */
function JourneyOverlay({ journey, onArrive, onClose }: { journey: Journey; onArrive: () => void; onClose: () => void }) {
  const { live } = useApp()
  const [variant] = useState(() => journey.variant ?? nextVariant(journey.to))
  const [leaving, setLeaving] = useState(false)
  // false while the shaders are being compiled (the film starts with its first frame)
  const [ready, setReady] = useState(false)
  const leavingRef = useRef(false)
  const captionRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const handlers = useRef({ onArrive, onClose })
  handlers.current = { onArrive, onClose }

  const finish = useCallback(() => {
    if (leavingRef.current) return
    leavingRef.current = true
    handlers.current.onArrive()
    setLeaving(true)
  }, [])
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => handlers.current.onClose(), 750)
    return () => clearTimeout(timer)
  }, [leaving])
  // the game started before the film got to play (window hidden all through champ select)
  useEffect(() => {
    if (live?.active) finish()
  }, [live?.active, finish])
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' && event.key !== ' ' && event.key !== 'Enter') return
      event.preventDefault()
      finish()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [finish])
  // captions follow the film's own clock, so they stay in step when it waits
  const onFrame = useCallback((seconds: number) => {
    const shown = captionAt(seconds)
    if (captionRef.current) {
      captionRef.current.style.opacity = String(shown)
      captionRef.current.style.transform = `translateY(${(1 - shown) * 8}px)`
    }
    if (hintRef.current)
      hintRef.current.style.opacity = String(
        0.55 * smoothstep(2.4, 3.4, seconds) * (1 - smoothstep(FLIGHT_S - 1.6, FLIGHT_S - 0.8, seconds))
      )
  }, [])

  const destination = galaxyOf(journey.to)
  return (
    <div
      className="fixed inset-0 z-[200] cursor-pointer transition-opacity duration-700"
      style={{ opacity: leaving ? 0 : 1, animation: 'fade 0.6s ease-out', WebkitAppRegion: 'no-drag' } as CSSProperties}
      onClick={finish}
      aria-hidden
    >
      <JourneyCanvas
        from={journey.from}
        to={journey.to}
        variant={variant}
        onDone={finish}
        onFrame={onFrame}
        onReady={() => setReady(true)}
      />
      {/* while the GPU prepares the film: dim the app a little and say what's going on */}
      <div
        className="journey-preparing pointer-events-none absolute inset-0 flex items-end justify-center pb-[6%] transition-opacity duration-500"
        style={{ opacity: ready ? 0 : 1 }}
      >
        <span className="text-[11px] font-semibold tracking-[0.35em] text-white/60 uppercase">Preparing the jump · click to skip</span>
      </div>
      {/* where we're going, on the lower letterbox bar once the target is in sight */}
      <div
        ref={captionRef}
        className="journey-caption pointer-events-none absolute inset-x-0 bottom-[2.5%] text-center"
        style={{ opacity: 0 }}
      >
        <div className="text-[11px] font-semibold tracking-[0.35em] text-white/55 uppercase">Destination</div>
        <div className="font-display text-3xl font-extrabold tracking-tight text-white/90">{destination.name}</div>
        <div className="text-xs tracking-widest text-white/45">
          {destination.designation} · {galaxyKind(destination)}
        </div>
      </div>
      <div
        ref={hintRef}
        className="pointer-events-none absolute right-6 bottom-[2.5%] text-[10px] font-semibold tracking-[0.3em] text-white uppercase"
        style={{ opacity: 0 }}
      >
        Click to skip
      </div>
    </div>
  )
}

function Shell() {
  const { settings, live } = useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const { seed, journey, endJourney } = useCosmos()
  // overlay windows get the event too, but only the main window should change tabs
  const arrive = useCallback(() => {
    if (!window.location.hash.startsWith('#/overlay')) navigate('/live')
  }, [navigate])
  const background = settings?.ui.background ?? 'animated'
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const showFlight = background !== 'static' && !reducedMotion && !window.location.hash.startsWith('#/overlay')
  // without the flight we just go straight to the new game
  useEffect(() => {
    if (journey && !showFlight) {
      if (!journey.stay) arrive()
      endJourney()
    }
  }, [journey, showFlight, arrive, endJourney])
  const hash = window.location.hash
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
      {journey && showFlight && (
        <JourneyOverlay key={journey.key} journey={journey} onArrive={journey.stay ? noop : arrive} onClose={endJourney} />
      )}
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
          {Admin && <Route path="/admin" element={<Admin />} />}
        </Routes>
      </Suspense>
    </Layout>
  )
}

if (!window.location.hash.startsWith('#/overlay')) {
  const prefetch = () => {
    Object.values(pages).forEach((load) => void load())
    // and compile the flight's shaders once, so the first flight starts without a pause
    setTimeout(() => prewarmFlightShaders((message) => api.logDiag(message)), 4000)
  }
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
