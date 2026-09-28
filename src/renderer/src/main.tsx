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

function Shell() {
  const { data, dataError } = useApp()
  if (!data) {
    return (
      <div className="drag flex h-full flex-col items-center justify-center gap-4 text-sm text-muted">
        {dataError ? (
          <>
            <b className="text-loss">Spieldaten konnten nicht geladen werden</b>
            <span>{dataError}</span>
          </>
        ) : (
          <>
            <Spinner />
            Lade Spieldaten (Data Dragon) …
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
