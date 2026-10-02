import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom'
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
import { CosmosBackground, cosmicSeed } from './components/CosmosBackground'
import { api } from './lib/api'
import { OverlayFrames } from './pages/OverlayFrames'
import { OverlayMinimap } from './pages/OverlayMinimap'
import { OverlayLoading } from './pages/OverlayLoading'

/** Which galaxy we are in: the last game's id, a new one on every game start (→ wormhole jump). */
function useCosmicSeed(): number {
  const [seed, setSeed] = useState(() => {
    try {
      return Number(localStorage.getItem('rc.cosmos')) || cosmicSeed(Date.now() >> 20)
    } catch {
      return cosmicSeed(1)
    }
  })
  useEffect(
    () =>
      api.on('journey', ({ seed: s }) => {
        const v = cosmicSeed(s)
        setSeed(v)
        try {
          localStorage.setItem('rc.cosmos', String(v))
        } catch {
          /* private mode */
        }
      }),
    []
  )
  return seed
}

function Shell() {
  const { settings, live } = useApp()
  const location = useLocation()
  const seed = useCosmicSeed()
  const hash = window.location.hash
  if (hash.startsWith('#/overlay/panel')) return <Overlay part="panel" />
  if (hash.startsWith('#/overlay/frames')) return <OverlayFrames />
  if (hash.startsWith('#/overlay/minimap')) return <OverlayMinimap />
  if (hash.startsWith('#/overlay/loading')) return <OverlayLoading />
  if (hash.startsWith('#/overlay')) return <Overlay />
  return (
    <>
      {location.pathname.startsWith('/games') ? (
        <CosmosBackground seed={seed} mode={settings?.ui.background ?? 'animated'} inGame={!!live?.active} />
      ) : (
        <TripBackground mode={settings?.ui.background ?? 'animated'} inGame={!!live?.active} />
      )}
      <MainShell />
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
