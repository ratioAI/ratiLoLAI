import { Link, useNavigate } from 'react-router-dom'
import { Activity, CheckCircle2, Database, MonitorSmartphone, Radio } from 'lucide-react'
import { ROLE_LABELS, ROLES } from '@shared/types'
import { api } from '@/lib/api'
import { num, pct, timeAgo, wrColor } from '@/lib/format'
import { useApp, useAsync } from '@/lib/store'
import { ChampIcon, GameImage, RoleIcon, TierBadge } from '@/components/icons'
import { img } from '@/lib/img'

const PHASES: Record<string, string> = {
  None: 'Im Hauptmenü',
  Lobby: 'In der Lobby',
  Matchmaking: 'In der Warteschlange',
  ReadyCheck: 'Match gefunden!',
  ChampSelect: 'Championauswahl',
  GameStart: 'Spiel startet',
  InProgress: 'Im Spiel',
  WaitingForStats: 'Warte auf Statistiken',
  PreEndOfGame: 'Spielende',
  EndOfGame: 'Spielende'
}

export function Home() {
  const { data, client, champSelect, patch, patches, crawler, statsVersion, lastImport, mode } = useApp()
  const navigate = useNavigate()
  const { value: tiers } = useAsync(() => (patch ? api.getTierList(patch, mode) : Promise.resolve([])), [patch, statsVersion, mode])
  const patchInfo = patches.find((p) => p.patch === patch)

  return (
    <div className="fade-in mx-auto max-w-6xl p-8">
      <div className="mb-7 flex items-center gap-4">
        {client.summoner && data ? (
          <GameImage src={img.profileIcon(data, client.summoner.profileIconId)} size={56} alt="icon" rounded="rounded-2xl" />
        ) : null}
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">
            {client.summoner ? `Willkommen zurück, ${client.summoner.gameName}` : 'Willkommen bei Rift Companion'}
          </h1>
          <p className="text-sm text-muted">Werbefrei. Deine Daten. Dein Crawler.</p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatusCard
          icon={<MonitorSmartphone size={18} />}
          title="League Client"
          value={client.connected ? PHASES[client.phase] ?? client.phase : 'Nicht gestartet'}
          ok={client.connected}
        >
          {client.connected ? 'Runen & Items werden beim Lock-in automatisch importiert.' : 'Starte den League Client – die Verbindung erfolgt automatisch.'}
        </StatusCard>
        <StatusCard
          icon={<Database size={18} />}
          title={`${mode === 'aram' ? 'ARAM' : 'Ranked'}-Daten Patch ${patch ?? '–'}`}
          value={patchInfo ? `${num(patchInfo.matches)} Matches` : 'Keine Daten'}
          ok={!!patchInfo?.matches}
        >
          {patchInfo?.matches ? `Aktualisiert ${timeAgo(patchInfo.updatedAt)}` : <Link to="/data" className="text-accent">Crawler starten →</Link>}
        </StatusCard>
        <StatusCard
          icon={<Activity size={18} />}
          title="Crawler"
          value={crawler?.running ? 'Läuft' : crawler?.phase === 'error' ? 'Fehler' : 'Bereit'}
          ok={crawler?.phase !== 'error'}
        >
          {crawler?.message ?? '–'}
        </StatusCard>
      </div>

      {champSelect?.active && champSelect.myChampionId > 0 && (
        <button
          onClick={() => navigate('/live')}
          className="panel mb-6 flex w-full items-center gap-4 border-accent/40 p-4 text-left hover:bg-panel-2"
        >
          <Radio className="text-accent" size={20} />
          <ChampIcon id={champSelect.myChampionId} size={44} tooltip={false} />
          <div className="flex-1">
            <div className="font-bold">Championauswahl läuft</div>
            <div className="text-sm text-muted">
              {data?.champions[champSelect.myChampionId]?.name}
              {champSelect.myRole ? ` · ${ROLE_LABELS[champSelect.myRole]}` : ''} – Build & Gegner ansehen
            </div>
          </div>
          {lastImport && lastImport.championId === champSelect.myChampionId && !lastImport.errors.length && (
            <span className="flex items-center gap-1.5 text-sm text-win">
              <CheckCircle2 size={16} /> importiert
            </span>
          )}
        </button>
      )}

      {mode === 'aram' ? (
        <>
          <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Stärkste ARAM-Champions</h2>
          <div className="panel grid grid-cols-2 gap-2 p-4 sm:grid-cols-3 lg:grid-cols-5">
            {(tiers ?? [])
              .slice()
              .sort((a, b) => a.rank - b.rank)
              .slice(0, 15)
              .map((t) => (
                <button
                  key={t.championId}
                  onClick={() => navigate(`/champion/${t.championId}/ARAM`)}
                  className="flex items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-panel-2"
                >
                  <ChampIcon id={t.championId} size={32} tooltip={false} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold">{data?.champions[t.championId]?.name}</div>
                    <div className="text-[11px]" style={{ color: wrColor(t.winRate) }}>
                      {pct(t.winRate)} WR
                    </div>
                  </div>
                  <TierBadge tier={t.tier} size="sm" />
                </button>
              ))}
            {!tiers?.length && <p className="text-xs text-muted">Noch keine ARAM-Daten – starte den ARAM-Crawler unter „Daten“.</p>}
          </div>
        </>
      ) : (
      <>
      <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Meta-Picks pro Rolle</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {ROLES.map((role) => {
          const top = (tiers ?? []).filter((t) => t.role === role).sort((a, b) => a.rank - b.rank).slice(0, 5)
          return (
            <div key={role} className="panel p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-bold">
                <RoleIcon role={role} size={16} className="text-accent" /> {ROLE_LABELS[role]}
              </div>
              {top.length ? (
                <div className="space-y-2">
                  {top.map((t) => (
                    <button
                      key={t.championId}
                      onClick={() => navigate(`/champion/${t.championId}/${role}`)}
                      className="flex w-full items-center gap-2.5 rounded-lg p-1 text-left hover:bg-panel-2"
                    >
                      <ChampIcon id={t.championId} size={32} tooltip={false} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold">{data?.champions[t.championId]?.name}</div>
                        <div className="text-[11px]" style={{ color: wrColor(t.winRate) }}>
                          {pct(t.winRate)} WR
                        </div>
                      </div>
                      <TierBadge tier={t.tier} size="sm" />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted">Noch keine Daten</p>
              )}
            </div>
          )
        })}
      </div>
      </>
      )}
    </div>
  )
}

function StatusCard({
  icon,
  title,
  value,
  ok,
  children
}: {
  icon: React.ReactNode
  title: string
  value: string
  ok: boolean
  children: React.ReactNode
}) {
  return (
    <div className="panel p-5">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-muted">
        <span className={ok ? 'text-accent' : 'text-loss'}>{icon}</span>
        {title}
      </div>
      <div className="text-lg font-bold">{value}</div>
      <div className="mt-1 text-xs text-muted">{children}</div>
    </div>
  )
}
