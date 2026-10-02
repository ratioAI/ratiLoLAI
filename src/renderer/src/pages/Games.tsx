import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Crown, History, Skull } from 'lucide-react'
import type { GameListEntry } from '@shared/types'
import type { GameSummary, SummaryPlayer } from '@shared/summary'
import { augmentTiersForChampion } from '@shared/mayhem'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { duration } from '@/lib/format'
import { ChampIcon, ItemIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/Layout'
import { AugmentFrame } from '@/components/AugmentFrame'
import { useMayhemData } from '@/components/mayhem'
import { WinCurve } from '@/components/WinCurve'

const MODE: Record<string, string> = { KIWI: 'ARAM: Mayhem', ARAM: 'ARAM', CLASSIC: "Summoner's Rift" }
const ago = (t: number): string => {
  const m = Math.round((Date.now() - t) / 60_000)
  return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

/** List of finished games with a summary. */
export function Games() {
  const [list, setList] = useState<GameListEntry[] | null>(null)
  useEffect(() => {
    const load = () => void api.listGames().then(setList)
    load()
    return api.on('gameSummary', load)
  }, [])
  return (
    <div className="fade-in mx-auto max-w-6xl p-8">
      <PageHeader title="Games" subtitle="Summary, gold curve and impact of every player – saved after each game" />
      {!list?.length ? (
        <EmptyState icon={<History size={28} />} title="No games yet">
          Play a game with ratioAI running – its summary appears here as soon as the client has the results.
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {list.map((g) => (
            <Link
              key={g.gameId}
              to={`/games/${g.gameId}`}
              className="panel flex items-center gap-4 p-3 hover:brightness-125"
              style={{ borderLeft: `3px solid ${g.win ? '#2f95dc' : '#e2553f'}` }}
            >
              <ChampIcon id={g.championId} size={40} tooltip={false} />
              <span className={`w-20 font-display font-extrabold ${g.win ? 'text-[#5fb4ff]' : 'text-[#ff7a62]'}`}>{g.win ? 'Victory' : 'Defeat'}</span>
              <span className="w-28 text-sm text-muted">{MODE[g.mode] ?? g.mode}</span>
              <span className="w-24 font-semibold tabular-nums">
                {g.kda[0]}/<span className="text-loss">{g.kda[1]}</span>/{g.kda[2]}
              </span>
              <span className="w-16 text-sm text-muted tabular-nums">{duration(g.duration)}</span>
              {g.blamedPremade && (
                <span className="flex items-center gap-1 text-xs text-loss">
                  <Skull size={12} /> {g.blamedPremade.split('#')[0]}
                </span>
              )}
              <span className="ml-auto text-xs text-muted">{ago(g.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function PlayerRow({ p, s, tierOf }: { p: SummaryPlayer; s: GameSummary; tierOf: (champ: number, aug: number) => ReturnType<typeof augmentTiersForChampion>[number] | undefined }) {
  const { data: mayhem } = useMayhemData()
  const team = s.players.filter((x) => x.ally === p.ally)
  const maxDmg = Math.max(...team.map((x) => x.damage), 1)
  const name = p.riotId.split('#')[0]
  return (
    <div className={`flex items-center gap-3 rounded-lg p-1.5 text-sm ${p.me ? 'bg-gold/8 ring-1 ring-gold/30' : ''}`}>
      <ChampIcon id={p.championId} size={34} tooltip={false} />
      <span className={`w-36 truncate font-semibold ${p.me ? 'text-gold' : p.premade ? 'text-[#7cc4ff]' : 'text-text'}`}>
        {name}
        {s.mvp === p.puuid && <Crown size={13} className="ml-1 inline text-gold" />}
        {s.blame === p.puuid && <Skull size={13} className="ml-1 inline text-loss" />}
      </span>
      <span className="w-20 font-semibold tabular-nums">
        {p.kills}/<span className="text-loss">{p.deaths}</span>/{p.assists}
      </span>
      <span className="flex w-28 items-center gap-1.5" title="Damage to champions">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <span className="block h-full rounded-full bg-[#b58bff]" style={{ width: `${(p.damage / maxDmg) * 100}%` }} />
        </span>
        <span className="w-10 text-right text-xs tabular-nums text-muted">{(p.damage / 1000).toFixed(1)}k</span>
      </span>
      <span className="w-12 text-right text-xs tabular-nums" title="Impact score (0–100, 50 = average teammate)">
        <b className={p.score >= 60 ? 'text-win' : p.score <= 40 ? 'text-loss' : 'text-text'}>{p.score}</b>
      </span>
      <span className="flex gap-0.5">
        {p.items.slice(0, 6).map((it, i) => (
          <ItemIcon key={i} id={it} size={22} />
        ))}
      </span>
      {/* every player's augments with the tier they have for that champion */}
      <span className="ml-1 flex items-center gap-1.5 pt-1.5 pb-1">
        {p.augments.map((id) => {
          const a = mayhem?.augments[id]
          if (!a) return null
          const t = tierOf(p.championId, id)
          return <AugmentFrame key={id} augment={a} tier={t?.tier ?? 'C'} size={24} note={t?.note ?? null} />
        })}
      </span>
    </div>
  )
}

/** One game: result, gold curve, highlights, MVP / blame, both teams with augments. */
export function GameDetail() {
  const { id } = useParams()
  const { data: statics } = useApp()
  const { data: mayhem } = useMayhemData()
  const [s, setS] = useState<GameSummary | null | undefined>(undefined)
  useEffect(() => {
    void api.getGame(Number(id)).then(setS)
  }, [id])
  const tiers = useMemo(() => new Map<number, ReturnType<typeof augmentTiersForChampion>>(), [mayhem, statics])
  const tierOf = (champ: number, aug: number) => {
    if (!mayhem || !statics) return undefined
    if (!tiers.has(champ)) tiers.set(champ, augmentTiersForChampion(mayhem, statics, champ))
    return tiers.get(champ)!.find((t) => t.augment.id === aug)
  }
  if (s === undefined) return null
  if (!s) return <EmptyState title="Game not found" />
  const blame = s.players.find((p) => p.puuid === s.blame)
  const mvp = s.players.find((p) => p.puuid === s.mvp)
  const groupSize = s.players.filter((p) => p.ally && (p.me || p.premade)).length
  return (
    <div className="fade-in mx-auto max-w-6xl p-8">
      <PageHeader
        title={s.win ? 'Victory' : 'Defeat'}
        subtitle={`${MODE[s.mode] ?? s.mode} · ${duration(s.duration)} · ${new Date(s.createdAt).toLocaleString()}`}
      >
        <Link to="/games" className="btn btn-ghost">
          All games
        </Link>
      </PageHeader>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="panel self-start p-5">
          <h2 className="mb-3 text-sm font-bold text-muted uppercase">Win / loss curve – gold lead of your team</h2>
          <WinCurve curve={s.curve} kills={s.kills} duration={s.duration} />
          {s.curveSource === 'live' && <p className="mt-2 text-[11px] text-muted">Estimated from item values during the game (the client had no timeline).</p>}
        </div>
        <div className="space-y-4">
          {!s.win && blame && (
            <div className="rounded-2xl border border-[#e2553f]/60 bg-[#e2553f]/10 p-4">
              <div className="mb-1 flex items-center gap-2 text-xs font-bold tracking-wider text-[#ff7a62] uppercase">
                <Skull size={14} /> {groupSize > 1 ? 'Most to blame in your group' : 'Weakest link of your team'}
              </div>
              <div className="flex items-center gap-3">
                <ChampIcon id={blame.championId} size={40} tooltip={false} />
                <div>
                  <div className={`font-display text-lg font-extrabold ${blame.me ? 'text-gold' : 'text-[#7cc4ff]'}`}>{blame.riotId.split('#')[0]}</div>
                  <div className="text-xs text-muted">
                    impact {blame.score}/100 · {blame.kills}/{blame.deaths}/{blame.assists} · {(blame.damage / 1000).toFixed(1)}k dmg
                  </div>
                </div>
              </div>
            </div>
          )}
          {mvp && (
            <div className="rounded-2xl border border-gold/50 bg-gold/8 p-4">
              <div className="mb-1 flex items-center gap-2 text-xs font-bold tracking-wider text-gold uppercase">
                <Crown size={14} /> MVP of your team
              </div>
              <div className="flex items-center gap-3">
                <ChampIcon id={mvp.championId} size={40} tooltip={false} />
                <div>
                  <div className="font-display text-lg font-extrabold">{mvp.riotId.split('#')[0]}</div>
                  <div className="text-xs text-muted">
                    impact {mvp.score}/100 · {mvp.kills}/{mvp.deaths}/{mvp.assists}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="panel p-4">
            <h2 className="mb-2 text-sm font-bold text-muted uppercase">Summary</h2>
            <ul className="space-y-1.5 text-sm">
              {s.highlights.map((h, i) => (
                <li key={i}>• {h}</li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] leading-snug text-muted">
              Impact score: share of the team's damage, tanking and healing, kill participation, minus share of deaths – 50 is
              an average teammate. A heuristic for fun, not a verdict.
            </p>
          </div>
        </div>
      </div>

      {[true, false].map((ally) => (
        <div
          key={String(ally)}
          className="mt-5 rounded-2xl p-4"
          style={{
            background: `linear-gradient(135deg, ${ally ? 'rgb(47 149 220 / 0.14)' : 'rgb(226 85 63 / 0.12)'}, rgb(20 13 40 / 0.78) 70%)`,
            border: `1px solid ${ally ? 'rgb(47 149 220 / 0.55)' : 'rgb(226 85 63 / 0.55)'}`
          }}
        >
          <h2 className="mb-2 text-sm font-bold uppercase" style={{ color: ally ? '#5fb4ff' : '#ff7a62' }}>
            {ally ? 'Your team' : 'Enemy team'}
          </h2>
          <div className="space-y-1">
            {s.players
              .filter((p) => p.ally === ally)
              .map((p) => (
                <PlayerRow key={p.puuid} p={p} s={s} tierOf={tierOf} />
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}
