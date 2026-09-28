import { Link } from 'react-router-dom'
import { Info, Play, Square, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { GameMode } from '@shared/types'
import { GAME_MODES, PLATFORMS } from '@shared/types'
import { api } from '@/lib/api'
import { num, timeAgo } from '@/lib/format'
import { useApp } from '@/lib/store'
import { PageHeader } from '@/components/Layout'

export function Data() {
  const { crawler, settings, patches, data, refreshPatches, mode } = useApp()
  const [crawlMode, setCrawlMode] = useState<GameMode>(mode)
  const running = !!crawler?.running
  const elapsed = crawler?.startedAt ? (Date.now() - crawler.startedAt) / 1000 : 0
  const perMin = elapsed > 30 && crawler ? (crawler.matchesThisRun / elapsed) * 60 : 0
  const progress = crawler && settings ? Math.min(1, crawler.matchesThisRun / settings.crawler.maxMatchesPerRun) : 0
  const platforms = settings ? [settings.platform, ...settings.crawler.extraPlatforms.filter((p) => p !== settings.platform)] : []

  return (
    <div className="fade-in mx-auto max-w-5xl p-8">
      <PageHeader
        title="Data & crawler"
        subtitle="Collects ranked or ARAM matches through the official Riot API and computes tier lists, builds and matchups from them."
      >
        {running ? (
          <button className="btn btn-ghost" onClick={() => api.crawlerStop()}>
            <Square size={15} /> Stop
          </button>
        ) : (
          <>
            <div className="flex rounded-xl border border-line bg-bg-2 p-1">
              {(['ranked', 'aram'] as GameMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setCrawlMode(m)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${crawlMode === m ? 'bg-panel-2 text-accent' : 'text-muted'}`}
                >
                  {GAME_MODES[m].label}
                </button>
              ))}
            </div>
            <button className="btn btn-primary" disabled={!settings?.hasApiKey} onClick={() => api.crawlerStart(crawlMode)}>
              <Play size={15} /> {crawlMode === 'aram' ? 'Start ARAM crawler' : 'Start crawler'}
            </button>
          </>
        )}
      </PageHeader>

      {!settings?.hasApiKey && (
        <div className="panel mb-5 flex items-center gap-3 border-gold/40 p-4 text-sm">
          <Info size={18} className="text-gold" />
          <span className="flex-1">The crawler needs a (free) Riot API key.</span>
          <Link to="/settings" className="btn btn-ghost">
            Open settings
          </Link>
        </div>
      )}

      <div className="panel mb-5 p-6">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-semibold">
            {crawler?.message ?? 'Ready'}
            {crawler?.phase === 'error' && <span className="ml-2 text-loss">({crawler.lastError})</span>}
          </span>
          <span className="text-muted">Patch {crawler?.patch ?? data?.patch ?? '–'}</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-bg-2">
          <div
            className={`h-full rounded-full bg-gradient-to-r from-accent to-[#4ea3ff] transition-all ${running ? 'animate-pulse' : ''}`}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
          <Metric label="New matches (this run)" value={num(crawler?.matchesThisRun ?? 0)} />
          <Metric label="Matches total" value={num(crawler?.matchesTotal ?? 0)} />
          <Metric label="Players processed" value={`${num(crawler?.playersDone ?? 0)} / ${num(crawler?.players ?? 0)}`} />
          <Metric label="Matches / minute" value={perMin ? perMin.toFixed(1) : '–'} />
          <Metric label="API requests" value={num(crawler?.requests ?? 0)} />
          <Metric label="Old-patch games skipped" value={num(crawler?.skippedOldPatch ?? 0)} />
          <Metric label="Regions" value={platforms.map((p) => PLATFORMS[p].label).join(', ') || '–'} />
          <Metric label="Seed" value={settings?.crawler.seedTiers.map((t) => ({ CHALLENGER: 'Chall', GRANDMASTER: 'GM', MASTER: 'Master' })[t]).join(' · ') || '–'} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="panel p-5">
          <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Stored patches ({GAME_MODES[mode].label})</h2>
          {patches.length ? (
            <div className="space-y-2">
              {patches.map((p) => (
                <div key={p.patch} className="flex items-center gap-3 rounded-xl bg-bg-2 px-3 py-2 text-sm">
                  <span className="font-bold">{p.patch}</span>
                  <span className="flex-1 text-muted">
                    {num(p.matches)} matches · {timeAgo(p.updatedAt)}
                  </span>
                  <button
                    className="text-muted hover:text-loss"
                    title="Delete this patch's data"
                    onClick={async () => {
                      if (confirm(`Delete all statistics for patch ${p.patch}?`)) {
                        await api.resetStats(p.patch, mode)
                        await refreshPatches()
                      }
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Nothing collected yet.</p>
          )}
        </div>
        <div className="panel p-5 text-sm leading-relaxed text-muted">
          <h2 className="mb-3 text-sm font-bold tracking-wide uppercase">How it works</h2>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Fetches the Challenger, Grandmaster and Master players of your region(s).</li>
            <li>Downloads their recent matches incl. timeline (purchase order, skills).</li>
            <li>Only counts games of the current patch; remakes are ignored.</li>
            <li>Computes win rate (Bayesian-smoothed), pick & ban rate and the tiers from them.</li>
            <li>ARAM: starts with high-elo players and adds everyone from each ARAM game to the pool. These builds are also used for ARAM: Mayhem (Riot blocks Mayhem itself in the API).</li>
          </ol>
          <p className="mt-3">
            A development or personal key allows 100 requests / 2 min – about <b className="text-text">20–25 matches per minute</b> (each match needs 2 requests).
            Let it run in the background – progress is saved continuously and resumed on every start.
          </p>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  )
}
