import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Crown, History, Info, Skull, Sparkles } from 'lucide-react'
import type { GameListEntry } from '@shared/types'
import { explainImpact, teamBlame, type GameSummary, type SummaryPlayer } from '@shared/summary'
import { augmentTiersForChampion } from '@shared/mayhem'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { duration } from '@/lib/format'
import { ChampIcon, ItemIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/Layout'
import { AugmentFrame } from '@/components/AugmentFrame'
import { useMayhemData } from '@/components/mayhem'
import { WinCurve } from '@/components/WinCurve'
import { quips, ratioApproved } from '@shared/quips'

const MODE: Record<string, string> = { KIWI: 'ARAM: Mayhem', ARAM: 'ARAM', CLASSIC: "Summoner's Rift" }
const ago = (timestamp: number): string => {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  return minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`
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
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader title="Games" subtitle="Summary, gold curve and impact of every player – saved after each game" />
      {!list?.length ? (
        <EmptyState icon={<History size={28} />} title="No games yet">
          Play a game with ratioAI running – its summary appears here as soon as the client has the results.
        </EmptyState>
      ) : (
        <div className="stagger space-y-2">
          {list.map((game) => (
            <Link
              key={game.gameId}
              to={`/games/${game.gameId}`}
              className="panel flex items-center gap-4 p-3 hover:brightness-125"
              style={{ borderLeft: `3px solid ${game.win ? '#2f95dc' : '#e2553f'}` }}
            >
              <ChampIcon id={game.championId} size={40} tooltip={false} />
              <span className={`w-20 font-display font-extrabold ${game.win ? 'text-[#5fb4ff]' : 'text-[#ff7a62]'}`}>
                {game.win ? 'Victory' : 'Defeat'}
              </span>
              <span className="w-28 text-sm text-muted">{MODE[game.mode] ?? game.mode}</span>
              <span className="w-24 font-semibold tabular-nums">
                {game.kda[0]}/<span className="text-loss">{game.kda[1]}</span>/{game.kda[2]}
              </span>
              <span className="w-16 text-sm text-muted tabular-nums">{duration(game.duration)}</span>
              {game.blamedPremade && (
                <span className="flex items-center gap-1 text-xs text-loss">
                  <Skull size={12} /> {game.blamedPremade.split('#')[0]}
                </span>
              )}
              <span className="ml-auto text-xs text-muted">{ago(game.createdAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function PlayerRow({
  p,
  s,
  blame,
  quip,
  approved,
  tierOf
}: {
  p: SummaryPlayer
  s: GameSummary
  blame: string | null
  quip?: string
  approved: boolean
  tierOf: TierOf
}) {
  const { data: mayhem } = useMayhemData()
  const team = s.players.filter((player) => player.ally === p.ally)
  const maxDamage = Math.max(...team.map((player) => player.damage), 1)
  const name = p.riotId.split('#')[0]
  return (
    <div className={`flex items-center gap-3 rounded-lg px-1.5 py-0.5 text-sm ${p.me ? 'bg-gold/8 ring-1 ring-gold/30' : ''}`}>
      <ChampIcon id={p.championId} size={28} tooltip={false} />
      <span className={`w-36 truncate font-semibold ${p.me ? 'text-gold' : p.premade ? 'text-[#7cc4ff]' : 'text-text'}`}>
        {name}
        {s.mvp === p.puuid && <Crown size={13} className="ml-1 inline text-gold" />}
        {blame === p.puuid && <Skull size={13} className="ml-1 inline text-loss" />}
      </span>
      <span className="w-20 font-semibold tabular-nums">
        {p.kills}/<span className="text-loss">{p.deaths}</span>/{p.assists}
      </span>
      <span className="flex w-28 items-center gap-1.5" title="Damage to champions">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <span className="bar-grow block h-full rounded-full bg-[#b58bff]" style={{ width: `${(p.damage / maxDamage) * 100}%` }} />
        </span>
        <span className="w-10 text-right text-xs tabular-nums text-muted">{(p.damage / 1000).toFixed(1)}k</span>
      </span>
      <span className="w-10 text-right text-xs tabular-nums" title="Impact score (0–100, 50 = average teammate)">
        <b className={p.score >= 60 ? 'text-win' : p.score <= 40 ? 'text-loss' : 'text-text'}>{p.score}</b>
      </span>
      <span className="flex gap-0.5">
        {p.items.slice(0, 6).map((itemId, i) => (
          <ItemIcon key={i} id={itemId} size={20} />
        ))}
      </span>
      {/* Each player's augments, framed by their tier for that champion */}
      <span className="ml-2 flex w-[164px] shrink-0 items-center gap-3 py-1.5">
        {p.augments.map((id, i) => {
          const augment = mayhem?.augments[id]
          if (!augment) return null
          const tierEntry = tierOf(p.championId, id)
          return (
            <span key={id} className="pop-in" style={{ animationDelay: `${300 + i * 90}ms` }}>
              <AugmentFrame augment={augment} tier={tierEntry?.tier ?? 'C'} size={24} note={tierEntry?.note ?? null} />
            </span>
          )
        })}
      </span>
      {approved && <ApprovedBadge />}
      {quip && (
        <span className="line-clamp-2 min-w-0 flex-1 pl-2 text-[12px] leading-snug text-[#cfc6ee] italic" title={quip}>
          {quip}
        </span>
      )}
    </div>
  )
}

/** Shown when a player took only S/S+ augments for their champion, as if they had used ratioAI. */
function ApprovedBadge() {
  return (
    <span
      className="pop-in shrink-0"
      style={{ animationDelay: '700ms' }}
      title="Took only S-tier augments for this champion – as if they used ratioAI"
    >
      <span className="ratio-approved flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-extrabold tracking-wide whitespace-nowrap uppercase">
        <Sparkles size={11} /> ratioAI approved
      </span>
    </span>
  )
}

type TierOf = (championId: number, augmentId: number) => ReturnType<typeof augmentTiersForChampion>[number] | undefined

const PHRASE: Record<string, [string, string]> = {
  'Damage to champions': ['dealt {v} of the team’s damage', 'dealt only {v} of the team’s damage'],
  'Deaths of the team': ['died rarely ({v} of the team’s deaths)', 'died the most ({v} of the team’s deaths)'],
  'Kill participation': ['was in {v} of the kills', 'was in only {v} of the kills'],
  'Damage soaked': ['soaked {v} of the damage taken', 'soaked only {v} of the damage taken'],
  'Heals & shields on allies': ['gave {v} of the team’s heals & shields', 'gave little healing or shielding ({v})']
}

/** One sentence from the two factors that moved the score most in the verdict's direction. */
function verdictText(factors: ReturnType<typeof explainImpact>, mvp: boolean): string {
  const topFactors = factors.filter((factor) => (mvp ? factor.points > 0.5 : factor.points < -0.5)).slice(0, 2)
  if (!topFactors.length) return mvp ? 'Solid all-round game.' : 'Nobody was clearly worse – lowest by a small margin.'
  const parts = topFactors.map((factor) => PHRASE[factor.label][mvp ? 0 : 1].replace('{v}', factor.value))
  const text = parts.join(' and ')
  return text[0].toUpperCase() + text.slice(1) + '.'
}

/** MVP / blame card; hovering shows which factors made the score, against the team average. */
function VerdictCard({ kind, p, s }: { kind: 'mvp' | 'blame'; p: SummaryPlayer; s: GameSummary }) {
  const mvp = kind === 'mvp'
  const factors = explainImpact(s.players, p.puuid)
  const accent = mvp ? '#f2c14e' : '#ff7a62'
  const nameClass = p.me ? 'text-gold' : p.premade ? 'text-[#7cc4ff]' : 'text-text'
  return (
    <div
      tabIndex={0}
      className="group relative flex-1 cursor-help rounded-2xl p-3 outline-none"
      style={{ border: `1px solid ${accent}80`, background: `${accent}14` }}
    >
      <div className="mb-1 flex items-center gap-2 text-[11px] font-bold tracking-wider uppercase" style={{ color: accent }}>
        {mvp ? <Crown size={13} /> : <Skull size={13} />} {mvp ? 'MVP' : s.win ? 'Biggest troll' : 'Most to blame'}
        <Info size={12} className="ml-auto opacity-60" />
      </div>
      <div className="flex items-center gap-3">
        <ChampIcon id={p.championId} size={36} tooltip={false} />
        <div className="min-w-0">
          <div className={`truncate font-display text-base font-extrabold ${nameClass}`}>{p.riotId.split('#')[0]}</div>
          <div className="text-xs text-muted">
            impact {p.score} · {p.kills}/{p.deaths}/{p.assists}
          </div>
        </div>
      </div>
      {/* Explanation popover, opens on hover or keyboard focus */}
      <div className="pointer-events-none absolute top-full right-0 z-30 mt-2 w-[390px] translate-y-1 rounded-xl border border-white/15 bg-[#120b24]/97 p-3 text-xs opacity-0 shadow-2xl backdrop-blur transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus:translate-y-0 group-focus:opacity-100">
        <div className="mb-2 font-semibold text-text">
          {mvp ? 'Why MVP' : s.win ? 'Why biggest troll' : 'Why most to blame'} – compared with an even share of your team of{' '}
          {s.players.filter((player) => player.ally).length}
        </div>
        <p className="mb-2.5 text-[13px] leading-snug text-text">{verdictText(factors, mvp)}</p>
        <div className="space-y-1.5">
          {factors.map((factor) => {
            const good = factor.points >= 0
            // 15 points fills the bar
            const barWidth = Math.min(100, (Math.abs(factor.points) / 15) * 100)
            return (
              <div key={factor.label} className="grid grid-cols-[1fr_auto_64px] items-center gap-2">
                <span className="text-text">
                  {factor.label}
                  <span className="ml-1 whitespace-nowrap text-muted">
                    {factor.value} <span className="opacity-70">(avg {factor.avg})</span>
                  </span>
                </span>
                <span className={`w-9 text-right font-bold tabular-nums ${good ? 'text-[#5fb4ff]' : 'text-[#ff7a62]'}`}>
                  {good ? '+' : '−'}
                  {Math.abs(factor.points).toFixed(0)}
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <span className="block h-full rounded-full" style={{ width: `${barWidth}%`, background: good ? '#2f95dc' : '#e2553f' }} />
                </span>
              </div>
            )
          })}
        </div>
        <p className="mt-2.5 border-t border-white/10 pt-2 leading-snug text-muted">
          Score = 50 + these points (clamped 0–100). {mvp ? 'Highest' : 'Lowest'} score of all{' '}
          {s.players.filter((player) => player.ally).length} players on your team – a heuristic for fun, not a verdict.
        </p>
      </div>
    </div>
  )
}

/** One game on a single screen: result, gold curve, MVP and blame, both teams with their augments. */
export function GameDetail() {
  const { id } = useParams()
  const { data: statics } = useApp()
  const { data: mayhem } = useMayhemData()
  const [summary, setSummary] = useState<GameSummary | null | undefined>(undefined)
  useEffect(() => {
    void api.getGame(Number(id)).then(setSummary)
  }, [id])
  // Lazily filled per champion, reset whenever the augment or static data changes
  const tierCache = useMemo(() => new Map<number, ReturnType<typeof augmentTiersForChampion>>(), [mayhem, statics])
  const tierOf: TierOf = (championId, augmentId) => {
    if (!mayhem || !statics) return undefined
    if (!tierCache.has(championId)) tierCache.set(championId, augmentTiersForChampion(mayhem, statics, championId))
    return tierCache.get(championId)!.find((entry) => entry.augment.id === augmentId)
  }
  if (summary === undefined) return null
  if (!summary) return <EmptyState title="Game not found" />
  const blame = teamBlame(summary)
  const augmentTiers = Object.fromEntries(
    summary.players.map((player) => [player.puuid, player.augments.map((id) => tierOf(player.championId, id)?.tier)])
  )
  const quipsByPlayer = quips(summary, augmentTiers)
  const mvp = summary.players.find((player) => player.puuid === summary.mvp)
  return (
    <div className="page-enter mx-auto max-w-7xl px-8 py-5">
      <div className="mb-3 flex items-end gap-4">
        <h1 className={`font-display text-3xl font-extrabold ${summary.win ? 'text-[#5fb4ff]' : 'text-[#ff7a62]'}`}>
          {summary.win ? 'Victory' : 'Defeat'}
        </h1>
        <span className="pb-1 text-sm text-muted">
          {MODE[summary.mode] ?? summary.mode} · {duration(summary.duration)} · {new Date(summary.createdAt).toLocaleString()}
        </span>
        <Link to="/games" className="btn btn-ghost ml-auto">
          All games
        </Link>
      </div>

      <div className="stagger grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="panel px-4 pt-3 pb-2">
          <h2 className="mb-1 text-xs font-bold text-muted uppercase">Win / loss curve – gold lead of your team</h2>
          <WinCurve curve={summary.curve} kills={summary.kills} duration={summary.duration} height={150} />
          {summary.curveSource === 'live' && <p className="mt-1 text-[11px] text-muted">Estimated from item values during the game.</p>}
        </div>
        <div className="flex flex-col gap-3">
          {mvp && <VerdictCard kind="mvp" p={mvp} s={summary} />}
          {blame && <VerdictCard kind="blame" p={blame} s={summary} />}
        </div>
      </div>

      {[true, false].map((ally) => (
        <div
          key={String(ally)}
          className="mt-3 rounded-2xl px-3 py-2"
          style={{
            background: `linear-gradient(135deg, ${ally ? 'rgb(47 149 220 / 0.14)' : 'rgb(226 85 63 / 0.12)'}, rgb(20 13 40 / 0.78) 70%)`,
            border: `1px solid ${ally ? 'rgb(47 149 220 / 0.55)' : 'rgb(226 85 63 / 0.55)'}`
          }}
        >
          <h2 className="mb-1 text-xs font-bold uppercase" style={{ color: ally ? '#5fb4ff' : '#ff7a62' }}>
            {ally ? 'Your team' : 'Enemy team'}
          </h2>
          <div className="stagger">
            {summary.players
              .filter((player) => player.ally === ally)
              .map((player) => (
                <PlayerRow
                  key={player.puuid}
                  p={player}
                  s={summary}
                  blame={blame?.puuid ?? null}
                  quip={quipsByPlayer[player.puuid]}
                  approved={ratioApproved(augmentTiers[player.puuid])}
                  tierOf={tierOf}
                />
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}
