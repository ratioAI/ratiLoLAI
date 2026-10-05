import { useEffect, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import type { MatchSummary, Platform, ProfileData, RankedEntry } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { api } from '@/lib/api'
import { duration, num, pct, QUEUES, RANK_COLORS, timeAgo, wrColor } from '@/lib/format'
import { img } from '@/lib/img'
import { useApp } from '@/lib/store'
import { ChampIcon, GameImage, ItemIcon, RuneIcon, SpellIcon } from '@/components/icons'
import { EmptyState, PageHeader, Spinner } from '@/components/Layout'

export function Profile() {
  const { client, settings } = useApp()
  const [riotId, setRiotId] = useState('')
  const [platform, setPlatform] = useState<Platform>('euw1')
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (client.summoner && !riotId) {
      setRiotId(`${client.summoner.gameName}#${client.summoner.tagLine}`)
      if (client.summoner.platform) setPlatform(client.summoner.platform)
    } else if (settings && !riotId) setPlatform(settings.platform)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.summoner, settings])

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setProfile(await api.lookupProfile(riotId, platform))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader title="Player profile" subtitle="Rank, match history and champion stats – like op.gg, just without ads">
        <form onSubmit={search} className="flex gap-2">
          <input className="input w-64" placeholder="Name#TAG" value={riotId} onChange={(e) => setRiotId(e.target.value)} />
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            {Object.entries(PLATFORMS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={busy || !riotId.includes('#')}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} Search
          </button>
        </form>
      </PageHeader>

      {error && <div className="panel mb-5 border-loss/40 p-4 text-sm text-loss">{error}</div>}
      {busy && !profile && (
        <div className="flex justify-center p-16">
          <Spinner />
        </div>
      )}
      {!profile && !busy && (
        <EmptyState icon={<Search size={32} />} title="Search for a player">
          Enter a Riot ID like <b>Name#TAG</b>. Your own account is filled in automatically once the League client is running.
        </EmptyState>
      )}
      {profile && <ProfileView p={profile} />}
    </div>
  )
}

function ProfileView({ p }: { p: ProfileData }) {
  const { data } = useApp()
  if (!data) return null
  const games = p.matches.filter((m) => !m.remake)
  const wins = games.filter((m) => m.win).length
  const k = games.reduce((n, m) => n + m.kills, 0)
  const d = games.reduce((n, m) => n + m.deaths, 0)
  const a = games.reduce((n, m) => n + m.assists, 0)

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
      <div className="space-y-5">
        <div className="panel flex items-center gap-4 p-5">
          <span className="relative">
            <GameImage src={img.profileIcon(data, p.profileIconId)} size={72} alt="icon" rounded="rounded-2xl" />
            <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-md bg-bg px-1.5 text-[11px] font-bold ring-1 ring-line">
              {p.summonerLevel}
            </span>
          </span>
          <div className="min-w-0">
            <div className="truncate text-xl font-extrabold">{p.gameName}</div>
            <div className="text-sm text-muted">
              #{p.tagLine} · {PLATFORMS[p.platform].label}
            </div>
          </div>
        </div>

        {['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'].map((q) => (
          <RankCard key={q} queue={q} entry={p.ranked.find((r) => r.queueType === q)} />
        ))}

        <div className="panel p-5">
          <h3 className="mb-3 text-xs font-bold tracking-wide text-muted uppercase">Last {games.length} games</h3>
          <div className="mb-4 flex items-baseline gap-3">
            <span className="text-2xl font-extrabold" style={{ color: wrColor(wins / Math.max(1, games.length)) }}>
              {pct(wins / Math.max(1, games.length), 0)}
            </span>
            <span className="text-sm text-muted">
              {wins}W {games.length - wins}L · {((k + a) / Math.max(1, d)).toFixed(2)} KDA
            </span>
          </div>
          <div className="space-y-2">
            {p.championSummary.slice(0, 6).map((c) => (
              <div key={c.championId} className="flex items-center gap-3 text-sm">
                <ChampIcon id={c.championId} size={30} />
                <span className="flex-1 truncate">{data.champions[c.championId]?.name}</span>
                <span style={{ color: wrColor(c.wins / c.games) }} className="font-semibold">
                  {pct(c.wins / c.games, 0)}
                </span>
                <span className="w-16 text-right text-xs text-muted">
                  {c.games} · {c.kda.toFixed(1)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {p.mastery.length > 0 && (
          <div className="panel p-5">
            <h3 className="mb-3 text-xs font-bold tracking-wide text-muted uppercase">Mastery</h3>
            <div className="grid grid-cols-3 gap-3">
              {p.mastery.map((m) => (
                <div key={m.championId} className="flex flex-col items-center gap-1 text-center">
                  <ChampIcon id={m.championId} size={44} />
                  <span className="text-xs font-semibold">Lvl {m.level}</span>
                  <span className="text-[11px] text-muted">{num(m.points)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {p.matches.map((m) => (
          <MatchRow key={m.matchId} m={m} puuid={p.puuid} />
        ))}
      </div>
    </div>
  )
}

function RankCard({ queue, entry }: { queue: string; entry?: RankedEntry }) {
  const label = queue === 'RANKED_SOLO_5x5' ? 'Ranked Solo/Duo' : 'Ranked Flex'
  if (!entry)
    return (
      <div className="panel p-5">
        <div className="text-xs font-bold text-muted uppercase">{label}</div>
        <div className="mt-1 text-sm text-muted">Unranked</div>
      </div>
    )
  const wr = entry.wins / Math.max(1, entry.wins + entry.losses)
  const apex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(entry.tier)
  return (
    <div className="panel flex items-center gap-4 p-5">
      <div
        className="flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-black"
        style={{ color: RANK_COLORS[entry.tier], background: `color-mix(in srgb, ${RANK_COLORS[entry.tier]} 14%, transparent)` }}
      >
        {entry.tier.charAt(0)}
        {apex ? '' : ['I', 'II', 'III', 'IV'].indexOf(entry.rank) + 1}
      </div>
      <div className="flex-1">
        <div className="text-xs font-bold text-muted uppercase">{label}</div>
        <div className="font-bold" style={{ color: RANK_COLORS[entry.tier] }}>
          {entry.tier.charAt(0) + entry.tier.slice(1).toLowerCase()} {apex ? '' : entry.rank}{' '}
          <span className="text-text">{entry.leaguePoints} LP</span>
        </div>
        <div className="text-xs text-muted">
          {entry.wins}W {entry.losses}L ·{' '}
          <span style={{ color: wrColor(wr) }} className="font-semibold">
            {pct(wr, 0)}
          </span>
        </div>
      </div>
    </div>
  )
}

function MatchRow({ m, puuid }: { m: MatchSummary; puuid: string }) {
  const color = m.remake ? 'var(--color-muted)' : m.win ? 'var(--color-win)' : 'var(--color-loss)'
  const kda = (m.kills + m.assists) / Math.max(1, m.deaths)
  const minutes = m.gameDuration / 60
  return (
    <div
      className="panel flex items-center gap-4 overflow-hidden border-l-4 p-3"
      style={{
        borderLeftColor: color,
        background: `linear-gradient(90deg, color-mix(in srgb, ${color} 7%, var(--color-panel)), var(--color-panel) 45%)`
      }}
    >
      <div className="w-24 shrink-0 text-xs whitespace-nowrap">
        <div className="font-bold" style={{ color }}>
          {m.remake ? 'Remake' : m.win ? 'Victory' : 'Defeat'}
        </div>
        <div className="text-muted">{QUEUES[m.queueId] ?? `Queue ${m.queueId}`}</div>
        <div className="text-muted">{timeAgo(m.gameCreation)}</div>
        <div className="text-muted">{duration(m.gameDuration)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <ChampIcon id={m.championId} size={48} />
        <div className="grid shrink-0 grid-cols-[22px_22px] gap-0.5">
          {m.spells.map((s) => (
            <SpellIcon key={s} id={s} size={22} />
          ))}
          {m.keystone ? <RuneIcon id={m.keystone} size={22} /> : <span />}
          {m.subStyle ? <RuneIcon id={m.subStyle} size={22} /> : <span />}
        </div>
      </div>
      <div className="w-28 shrink-0 text-center whitespace-nowrap">
        <div className="font-bold">
          {m.kills} / <span className="text-loss">{m.deaths}</span> / {m.assists}
        </div>
        <div className="text-xs text-muted">{kda.toFixed(2)} KDA</div>
      </div>
      <div className="w-32 shrink-0 text-xs whitespace-nowrap text-muted">
        <div>
          {m.cs} CS ({(m.cs / minutes).toFixed(1)})
        </div>
        <div>KP {pct(m.killParticipation, 0)}</div>
        <div>{num(m.damage)} damage</div>
      </div>
      <div className="flex shrink-0 gap-0.5">
        {m.items.map((id, i) => (
          <ItemIcon key={i} id={id} size={28} />
        ))}
      </div>
      <div className="ml-auto hidden shrink-0 grid-cols-2 gap-x-3 gap-y-0.5 2xl:grid">
        {[100, 200].map((t) => (
          <div key={t} className="space-y-0.5">
            {m.teams
              .filter((x) => x.teamId === t)
              .map((x) => (
                <div key={x.puuid} className="flex w-28 items-center gap-1 text-[11px]">
                  <ChampIcon id={x.championId} size={15} tooltip={false} className="rounded" />
                  <span className={`truncate ${x.puuid === puuid ? 'font-bold text-text' : 'text-muted'}`}>{x.riotId.split('#')[0]}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}
