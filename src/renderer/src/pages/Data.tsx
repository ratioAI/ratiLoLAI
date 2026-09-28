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
        title="Datenbasis & Crawler"
        subtitle="Sammelt Ranked- oder ARAM-Matches über die offizielle Riot API und berechnet daraus Tierliste, Builds und Matchups."
      >
        {running ? (
          <button className="btn btn-ghost" onClick={() => api.crawlerStop()}>
            <Square size={15} /> Stoppen
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
              <Play size={15} /> {crawlMode === 'aram' ? 'ARAM-Crawler starten' : 'Crawler starten'}
            </button>
          </>
        )}
      </PageHeader>

      {!settings?.hasApiKey && (
        <div className="panel mb-5 flex items-center gap-3 border-gold/40 p-4 text-sm">
          <Info size={18} className="text-gold" />
          <span className="flex-1">Für den Crawler brauchst du einen (kostenlosen) Riot API Key.</span>
          <Link to="/settings" className="btn btn-ghost">
            Zu den Einstellungen
          </Link>
        </div>
      )}

      <div className="panel mb-5 p-6">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-semibold">
            {crawler?.message ?? 'Bereit'}
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
          <Metric label="Neue Matches (Lauf)" value={num(crawler?.matchesThisRun ?? 0)} />
          <Metric label="Matches gesamt" value={num(crawler?.matchesTotal ?? 0)} />
          <Metric label="Spieler abgearbeitet" value={`${num(crawler?.playersDone ?? 0)} / ${num(crawler?.players ?? 0)}`} />
          <Metric label="Matches / Minute" value={perMin ? perMin.toFixed(1) : '–'} />
          <Metric label="API-Requests" value={num(crawler?.requests ?? 0)} />
          <Metric label="Alte Patches übersprungen" value={num(crawler?.skippedOldPatch ?? 0)} />
          <Metric label="Regionen" value={platforms.map((p) => PLATFORMS[p].label).join(', ') || '–'} />
          <Metric label="Seed" value={settings?.crawler.seedTiers.map((t) => ({ CHALLENGER: 'Chall', GRANDMASTER: 'GM', MASTER: 'Master' })[t]).join(' · ') || '–'} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="panel p-5">
          <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Gespeicherte Patches ({GAME_MODES[mode].label})</h2>
          {patches.length ? (
            <div className="space-y-2">
              {patches.map((p) => (
                <div key={p.patch} className="flex items-center gap-3 rounded-xl bg-bg-2 px-3 py-2 text-sm">
                  <span className="font-bold">{p.patch}</span>
                  <span className="flex-1 text-muted">
                    {num(p.matches)} Matches · {timeAgo(p.updatedAt)}
                  </span>
                  <button
                    className="text-muted hover:text-loss"
                    title="Daten dieses Patches löschen"
                    onClick={async () => {
                      if (confirm(`Alle Statistiken für Patch ${p.patch} löschen?`)) {
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
            <p className="text-sm text-muted">Noch nichts gesammelt.</p>
          )}
        </div>
        <div className="panel p-5 text-sm leading-relaxed text-muted">
          <h2 className="mb-3 text-sm font-bold tracking-wide uppercase">So funktioniert's</h2>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>Holt Challenger-, Grandmaster- und Master-Spieler deiner Region(en).</li>
            <li>Lädt deren letzte Solo/Duo-Matches inkl. Timeline (Kaufreihenfolge, Skills).</li>
            <li>Zählt nur Spiele des aktuellen Patches, Remakes werden ignoriert.</li>
            <li>Berechnet Winrate (Bayes-geglättet), Pick- & Banrate und daraus die Tiers.</li>
            <li>ARAM: Startet bei High-Elo-Spielern und nimmt die Mitspieler jedes ARAM-Spiels in den Pool auf. Die Builds nutzt die App auch für ARAM: Mayhem (Mayhem selbst sperrt Riot in der API).</li>
          </ol>
          <p className="mt-3">
            Ein Development- oder Personal-Key erlaubt 100 Requests / 2 Min – das sind ca. <b className="text-text">20–25 Matches pro Minute</b> (jedes Match braucht 2 Requests).
            Lass den Crawler ruhig im Hintergrund laufen; der Fortschritt wird laufend gespeichert und bei jedem Start fortgesetzt.
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
