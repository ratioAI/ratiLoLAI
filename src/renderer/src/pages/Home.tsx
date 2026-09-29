import { Link, useNavigate } from 'react-router-dom'
import { Activity, CheckCircle2, Database, MonitorSmartphone, Radio } from 'lucide-react'
import { ROLE_LABELS, ROLES } from '@shared/types'
import { api } from '@/lib/api'
import { num, pct, timeAgo, wrColor } from '@/lib/format'
import { useApp, useAsync } from '@/lib/store'
import { ChampIcon, GameImage, RoleIcon, TierBadge } from '@/components/icons'
import { img } from '@/lib/img'

const PHASES: Record<string, string> = {
  None: 'In the main menu',
  Lobby: 'In lobby',
  Matchmaking: 'In queue',
  ReadyCheck: 'Match found!',
  ChampSelect: 'Champion select',
  GameStart: 'Game starting',
  InProgress: 'In game',
  WaitingForStats: 'Waiting for stats',
  PreEndOfGame: 'Game over',
  EndOfGame: 'Game over'
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
          <h1 className="font-display text-[28px] leading-tight font-extrabold tracking-tight">
            <span className="iridescent-text">
              {client.summoner ? `Welcome back, ${client.summoner.gameName}` : 'Welcome to ratioAI'}
            </span>
          </h1>
          <p className="text-sm text-muted">No ads. Your data. Your crawler.</p>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatusCard
          icon={<MonitorSmartphone size={18} />}
          title="League Client"
          value={client.connected ? PHASES[client.phase] ?? client.phase : 'Not running'}
          ok={client.connected}
        >
          {client.connected ? 'Runes & items are imported automatically when you lock in.' : 'Start the League client – ratioAI connects automatically.'}
        </StatusCard>
        <StatusCard
          icon={<Database size={18} />}
          title={`${mode === 'aram' ? 'ARAM' : 'Ranked'} data · patch ${patch ?? '–'}`}
          value={patchInfo ? `${num(patchInfo.matches)} matches` : 'No data'}
          ok={!!patchInfo?.matches}
        >
          {patchInfo?.matches ? `Updated ${timeAgo(patchInfo.updatedAt)}` : <Link to="/data" className="text-accent">Start crawler →</Link>}
        </StatusCard>
        <StatusCard
          icon={<Activity size={18} />}
          title="Crawler"
          value={crawler?.running ? 'Running' : crawler?.phase === 'error' ? 'Error' : 'Ready'}
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
            <div className="font-bold">Champion select in progress</div>
            <div className="text-sm text-muted">
              {data?.champions[champSelect.myChampionId]?.name}
              {champSelect.myRole ? ` · ${ROLE_LABELS[champSelect.myRole]}` : ''} – view build & enemies
            </div>
          </div>
          {lastImport && lastImport.championId === champSelect.myChampionId && !lastImport.errors.length && (
            <span className="flex items-center gap-1.5 text-sm text-win">
              <CheckCircle2 size={16} /> imported
            </span>
          )}
        </button>
      )}

      {mode === 'aram' ? (
        <>
          <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Strongest ARAM champions</h2>
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
            {!tiers?.length && <p className="text-xs text-muted">No ARAM data yet – start the ARAM crawler under "Data".</p>}
          </div>
        </>
      ) : (
      <>
      <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Meta picks per role</h2>
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
                <p className="text-xs text-muted">No data yet</p>
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
