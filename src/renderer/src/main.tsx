import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Route, Routes } from 'react-router-dom'
import './styles.css'
import { AppProvider, useApp } from './lib/store'
import { Layout, Spinner } from './components/Layout'
import { Home } from './pages/Home'
import { TierList } from './pages/TierList'
import { Champions } from './pages/Champions'
import { ChampionPage } from './pages/Champion'
import { Live } from './pages/Live'
import { Profile } from './pages/Profile'
import { Data } from './pages/Data'
import { Settings } from './pages/Settings'
import { Mayhem } from './pages/Mayhem'
import { Overlay } from './pages/Overlay'
import { OverlayFrames } from './pages/OverlayFrames'
import { OverlayMinimap } from './pages/OverlayMinimap'

function Shell() {
  const { data, dataError } = useApp()
  const hash = window.location.hash
  if (hash.startsWith('#/overlay/panel')) return <Overlay part="panel" />
  if (hash.startsWith('#/overlay/frames')) return <OverlayFrames />
  if (hash.startsWith('#/overlay/minimap')) return <OverlayMinimap />
  if (hash.startsWith('#/overlay')) return <Overlay />
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
