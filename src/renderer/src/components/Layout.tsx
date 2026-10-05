import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Database, Gauge, History, LayoutGrid, Radio, Search, Settings as SettingsIcon, Sparkles, Trophy } from 'lucide-react'
import type { GameMode, UpdateState } from '@shared/types'
import type { GameSummary } from '@shared/summary'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { isDemo } from '@/lib/api'
import { num } from '@/lib/format'

const NAV = [
  { to: '/', label: 'Home', icon: Gauge, end: true },
  { to: '/tierlist', label: 'Tier list', icon: Trophy },
  { to: '/champions', label: 'Champions', icon: LayoutGrid },
  { to: '/live', label: 'Live', icon: Radio },
  { to: '/games', label: 'Games', icon: History },
  { to: '/mayhem', label: 'Mayhem', icon: Sparkles },
  { to: '/profile', label: 'Profile', icon: Search },
  { to: '/data', label: 'Data', icon: Database }
]

/** ratioAI mark: an iridescent mushroom cap with glowing spores over a hexagon (static). */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="rai-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff7ad9" />
          <stop offset="0.5" stopColor="#b58bff" />
          <stop offset="1" stopColor="#6fe8ff" />
        </linearGradient>
        <radialGradient id="rai-cap" cx="0.5" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#ffd3f4" />
          <stop offset="0.55" stopColor="#e58bff" />
          <stop offset="1" stopColor="#7b5cff" />
        </radialGradient>
      </defs>
      <path d="M16 1.8 29 9.3v13.4L16 30.2 3 22.7V9.3z" fill="#120a24" stroke="url(#rai-g)" strokeWidth="1.8" />
      <path d="M7.5 16.2C7.5 10.9 11.3 7.6 16 7.6s8.5 3.3 8.5 8.6c0 .8-.6 1.3-1.4 1.3H8.9c-.8 0-1.4-.5-1.4-1.3z" fill="url(#rai-cap)" />
      <path d="M13.6 17.5h4.8l.7 6.6c.1.9-.6 1.6-1.5 1.6h-3.2c-.9 0-1.6-.7-1.5-1.6z" fill="#f1edfb" />
      <circle cx="12.2" cy="12.4" r="1.25" fill="#fff" opacity=".9" />
      <circle cx="17.6" cy="10.8" r="0.95" fill="#fff" opacity=".85" />
      <circle cx="20.6" cy="13.9" r="1.1" fill="#fff" opacity=".8" />
    </svg>
  )
}

/** "ratioAI" word mark */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-extrabold tracking-tight ${className}`}>
      ratio<span className="iridescent-text">AI</span>
    </span>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const { client, patches, patch, setPatch, crawler, mode, setMode } = useApp()
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const navigate = useNavigate()
  useEffect(() => {
    api.appInfo().then((i) => setUpdate(i.update))
    const offs = [api.on('update', setUpdate), api.on('gameSummary', (g: GameSummary) => navigate(`/games/${g.gameId}`))]
    return () => offs.forEach((o) => o())
  }, [navigate])
  return (
    <div className="flex h-full">
      <aside className="flex w-[76px] shrink-0 flex-col items-center border-r border-line bg-bg-2 pt-3 pb-4">
        <div className="drag mb-5 flex h-10 w-full items-center justify-center">
          <Logo />
        </div>
        <nav className="flex flex-1 flex-col gap-1.5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `group flex w-[60px] flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-semibold transition ${
                  isActive ? 'nav-active text-text' : 'text-muted hover:bg-panel hover:text-text'
                }`
              }
            >
              <Icon size={20} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </nav>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex w-[60px] flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-semibold ${
              isActive ? 'nav-active text-text' : 'text-muted hover:bg-panel hover:text-text'
            }`
          }
        >
          <SettingsIcon size={20} />
          Settings
        </NavLink>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="drag flex h-10 shrink-0 items-center gap-4 border-b border-line pr-40 pl-5 text-xs">
          <Wordmark className="text-[15px] text-text" />
          {isDemo && <span className="rounded-md bg-gold/15 px-2 py-0.5 font-semibold text-gold">Web demo · synthetic data</span>}
          <div className="flex-1" />
          {update?.status === 'ready' && (
            <button className="no-drag rounded-md bg-accent/15 px-2 py-0.5 font-semibold text-accent" onClick={() => api.installUpdate()}>
              Update {update.version} ready – restart
            </button>
          )}
          {crawler?.running && (
            <span className="flex items-center gap-2 text-muted">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              Crawler ({crawler.mode === 'aram' ? 'ARAM' : 'Ranked'}): {num(crawler.matchesThisRun)} Matches
            </span>
          )}
          <div className="no-drag flex rounded-lg border border-line bg-panel p-0.5">
            {(['ranked', 'aram'] as GameMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-2.5 py-0.5 font-semibold ${mode === m ? 'bg-panel-2 text-accent' : 'text-muted hover:text-text'}`}
              >
                {m === 'ranked' ? 'Ranked' : 'ARAM'}
              </button>
            ))}
          </div>
          <label className="no-drag flex items-center gap-2 text-muted">
            Patch
            <select
              className="rounded-md border border-line bg-panel px-2 py-1 text-text outline-none"
              value={patch ?? ''}
              onChange={(e) => setPatch(e.target.value)}
            >
              {patch && !patches.some((p) => p.patch === patch) && <option value={patch}>{patch}</option>}
              {patches.map((p) => (
                <option key={p.patch} value={p.patch}>
                  {p.patch} ({num(p.matches)})
                </option>
              ))}
            </select>
          </label>
          <span className="flex items-center gap-2 text-muted">
            <span className={`h-2 w-2 rounded-full ${client.connected ? 'bg-win' : 'bg-loss/70'}`} />
            {client.connected
              ? client.summoner
                ? `${client.summoner.gameName}#${client.summoner.tagLine}`
                : 'Client connected'
              : 'Client offline'}
          </span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}

export function PageHeader({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-[28px] leading-tight font-extrabold tracking-tight">
          <span className="iridescent-text">{title}</span>
        </h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="panel flex flex-col items-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-accent">{icon}</div>}
      <h3 className="text-lg font-bold">{title}</h3>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  )
}

export function Spinner() {
  return <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
}
