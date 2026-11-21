import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Crown, History, Info, Loader2, Orbit, Send, Skull, Sparkles, Trophy, X } from 'lucide-react'
import type { AchievementState, GameListEntry } from '@shared/types'
import { explainImpact, teamBlame, type GameSummary, type SummaryPlayer } from '@shared/summary'
import { makeTierLookup, summaryAugmentTiers, type TierLookup } from '@shared/mayhem'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { duration, formatDateTime, timeAgo } from '@/lib/format'
import { ChampIcon, ItemIcon } from '@/components/icons'
import { EmptyState, LoadFailed, PageHeader, PageLoading, errorText } from '@/components/Layout'
import { AugmentFrame } from '@/components/AugmentFrame'
import { useMayhemData } from '@/components/mayhem'
import { WinCurve } from '@/components/WinCurve'
import { WillScale } from '@/components/WillScale'
import { quips, ratioApproved } from '@shared/quips'
import { cosmicSeed, galaxyOf } from '@shared/universe'
import { DiscoveryCard } from '@/components/AchievementToast'
import { GameClips } from './Clips'

const MODE: Record<string, string> = { KIWI: 'ARAM: Mayhem', ARAM: 'ARAM', CLASSIC: "Summoner's Rift" }

type ResultFilter = 'all' | 'wins' | 'losses'
const FILTERS: { key: ResultFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'wins', label: 'Wins' },
  { key: 'losses', label: 'Losses' }
]
/** Rows rendered at first and added per click on "Show more"; the history itself has no limit. */
const PAGE = 60

/** The game history: every finished game, newest first, read from the game database. */
export function Games() {
  const [list, setList] = useState<GameListEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [filter, setFilter] = useState<ResultFilter>('all')
  const [shown, setShown] = useState(PAGE)
  // '/games?with=<puuid>' (from a profile): only the games you shared with that player
  const [params, setParams] = useSearchParams()
  const withPuuid = params.get('with')
  const [withGames, setWithGames] = useState<{ ids: Set<number>; name: string } | null>(null)
  useEffect(() => {
    const load = () =>
      void api
        .listGames()
        .then((games) => {
          setList(games)
          setLoadError(null)
        })
        .catch((reason) => setLoadError(errorText(reason)))
    load()
    return api.on('gameSummary', load)
  }, [reload])
  useEffect(() => {
    setWithGames(null)
    if (!withPuuid) return
    let current = true
    // the player's name comes from the newest shared game
    void api
      .getPlayerHistory(withPuuid)
      .then(async (history) => {
        const newest = history?.gameIds[0]
        const summary = newest !== undefined ? await api.getGame(newest) : null
        const name = summary?.players.find((player) => player.puuid === withPuuid)?.riotId.split('#')[0] ?? ''
        if (current) setWithGames({ ids: new Set(history?.gameIds ?? []), name })
      })
      .catch(() => current && setWithGames({ ids: new Set(), name: '' }))
    return () => {
      current = false
    }
  }, [withPuuid])
  const filtered = (list ?? []).filter(
    (game) => (filter === 'all' || game.win === (filter === 'wins')) && (!withPuuid || !!withGames?.ids.has(game.gameId))
  )
  const wins = (list ?? []).filter((game) => game.win).length
  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader title="Games">
        {!!list?.length && (
          <span className="mr-1 text-sm text-muted tabular-nums">
            {list.length} games · <span className="text-[#5fb4ff]">{wins}W</span>{' '}
            <span className="text-[#ff7a62]">{list.length - wins}L</span>
          </span>
        )}
        <div className="flex rounded-xl border border-line bg-bg-2 p-1">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                setFilter(key)
                setShown(PAGE)
              }}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${filter === key ? 'bg-panel-2 text-accent' : 'text-muted'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {withPuuid && (
          <button className="btn btn-ghost" onClick={() => setParams({})} title="Show all games">
            with {withGames?.name || 'this player'} <X size={14} />
          </button>
        )}
        <Link to="/games/achievements" className="btn btn-ghost">
          <Sparkles size={15} /> Achievements
        </Link>
        <Link to="/games/leaderboard" className="btn btn-ghost">
          <Trophy size={15} /> Leaderboard
        </Link>
        <Link to="/games/map" className="btn btn-ghost">
          <Orbit size={15} /> Star map
        </Link>
      </PageHeader>
      {!list ? (
        loadError ? (
          <LoadFailed what="Your games" error={loadError} onRetry={() => setReload((n) => n + 1)} />
        ) : (
          <PageLoading />
        )
      ) : !list.length ? (
        <EmptyState icon={<History size={28} />} title="No games yet">
          Play a game with ratioAI running – its summary appears here as soon as the client has the results.
        </EmptyState>
      ) : withPuuid && !withGames ? (
        <PageLoading />
      ) : !filtered.length ? (
        <EmptyState icon={<History size={28} />} title="No game matches">
          <button
            className="btn btn-ghost"
            onClick={() => {
              setFilter('all')
              if (withPuuid) setParams({})
            }}
          >
            Show all games
          </button>
        </EmptyState>
      ) : (
        <div className="stagger space-y-2">
          {filtered.slice(0, shown).map((game) => (
            <Link
              key={game.gameId}
              to={`/games/${game.gameId}`}
              className="panel flex items-center gap-4 p-3 hover:brightness-125"
              style={{ borderLeft: `3px solid ${game.win ? '#2f95dc' : '#e2553f'}` }}
            >
              <ChampIcon id={game.championId} size={40} tooltip={false} />
              <span className={`w-24 font-display font-extrabold ${game.win ? 'text-[#5fb4ff]' : 'text-[#ff7a62]'}`}>
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
              <span className="ml-auto text-right text-xs text-muted">
                {timeAgo(game.createdAt)}
                <span className="block text-[10px] opacity-70">{galaxyOf(cosmicSeed(game.cosmos)).name}</span>
              </span>
            </Link>
          ))}
          {filtered.length > shown && (
            <button className="btn btn-ghost mx-auto mt-2 flex" onClick={() => setShown(shown + PAGE)}>
              Show more ({filtered.length - shown})
            </button>
          )}
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

type TierOf = TierLookup

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
      className="tinted group relative flex-1 cursor-help rounded-2xl p-3 outline-none"
      style={{ '--tint': accent } as CSSProperties}
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
      <div className="pointer-events-none absolute top-full right-0 z-30 mt-2 w-[390px] translate-y-1 rounded-xl border border-white/20 bg-[#120b24] p-3 text-xs opacity-0 shadow-[0_18px_50px_-10px_rgb(0_0_0/0.85)] transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus:translate-y-0 group-focus:opacity-100">
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

/** Posts this game to the saved Discord webhook, whatever the automatic rules say. */
function PostToDiscord({ gameId }: { gameId: number }) {
  const { settings } = useApp()
  const [state, setState] = useState<{ busy: boolean; result: { ok: boolean; message: string } | null }>({ busy: false, result: null })
  const ready = !!settings?.hasDiscordWebhook
  return (
    <span className="flex items-center gap-2">
      {state.result && (
        <span className={`max-w-64 truncate text-xs ${state.result.ok ? 'text-win' : 'text-loss'}`} title={state.result.message}>
          {state.result.message}
        </span>
      )}
      <button
        className="btn btn-ghost"
        disabled={!ready || state.busy}
        title={ready ? 'Post this game to your Discord channel' : 'Save a Discord webhook in Settings first'}
        onClick={async () => {
          setState({ busy: true, result: null })
          const result = await api.postGameToDiscord(gameId).catch((error: Error) => ({ ok: false, message: error.message }))
          setState({ busy: false, result })
        }}
      >
        {state.busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Post to Discord
      </button>
    </span>
  )
}

/** The achievements this game unlocked; new ones draw their constellation once, then count as seen. */
function GameDiscoveries({ gameId }: { gameId: number }) {
  const [found, setFound] = useState<AchievementState[]>([])
  // which ones animate is decided when they first show up, so marking them seen doesn't stop the animation
  const [animated] = useState(() => new Set<string>())
  useEffect(() => {
    const load = () =>
      void api.getAchievements().then((all) => {
        const mine = all.filter((achievement) => achievement.unlocked && achievement.gameId === gameId)
        for (const achievement of mine) if (!achievement.seen) animated.add(achievement.id)
        setFound(mine)
        const unseen = mine.filter((achievement) => !achievement.seen).map((achievement) => achievement.id)
        if (unseen.length) void api.markAchievementsSeen(unseen)
      })
    load()
    return api.on('achievementsUnlocked', load)
  }, [gameId, animated])
  if (!found.length) return null
  return (
    <div className="panel mb-3 flex flex-wrap gap-x-8 gap-y-3 px-4 py-3">
      {found.map((achievement) => (
        <DiscoveryCard key={achievement.id} achievement={achievement} animate={animated.has(achievement.id)} compact />
      ))}
    </div>
  )
}

/** One game on a single screen: result, gold curve, MVP and blame, both teams with their augments. */
export function GameDetail() {
  const { id } = useParams()
  const { data: statics } = useApp()
  const { data: mayhem } = useMayhemData()
  const [summary, setSummary] = useState<GameSummary | null | undefined>(undefined)
  // games saved before 1.3.3 lack the will-to-win signals: read them from the client once (false = not possible)
  const [effortMissing, setEffortMissing] = useState(false)
  useEffect(() => {
    let current = true
    setEffortMissing(false)
    setSummary(undefined)
    void api
      .getGame(Number(id))
      .catch(() => null)
      .then(async (game) => {
      if (!current) return
      setSummary(game)
      if (!game || game.effort) return
      const filled = await api.fillGameEffort(game.gameId).catch(() => null)
      if (!current) return
      if (filled?.effort) setSummary(filled)
      else setEffortMissing(true)
    })
    return () => {
      current = false
    }
  }, [id])
  // tiers are worked out per champion on first use, again whenever the augment or static data changes
  const lookup = useMemo(() => (mayhem && statics ? makeTierLookup(mayhem, statics) : null), [mayhem, statics])
  const tierOf: TierOf = (championId, augmentId) => lookup?.(championId, augmentId)
  if (summary === undefined)
    return (
      <div className="p-8">
        <PageLoading />
      </div>
    )
  if (!summary)
    return (
      <div className="page-enter mx-auto max-w-3xl p-8">
        <EmptyState icon={<History size={28} />} title="Game not found">
          <p className="mb-3">This game is not in your history (any more).</p>
          <Link to="/games" className="btn btn-ghost">
            All games
          </Link>
        </EmptyState>
      </div>
    )
  const blame = teamBlame(summary)
  const augmentTiers = summaryAugmentTiers(summary, tierOf)
  const quipsByPlayer = quips(summary, augmentTiers)
  const mvp = summary.players.find((player) => player.puuid === summary.mvp)
  return (
    <div className="page-enter mx-auto max-w-7xl px-8 py-5">
      <div className="mb-3 flex items-end gap-4">
        <h1 className={`font-display text-3xl font-extrabold ${summary.win ? 'text-[#5fb4ff]' : 'text-[#ff7a62]'}`}>
          {summary.win ? 'Victory' : 'Defeat'}
        </h1>
        <span className="on-bg pb-1 text-sm text-muted">
          {MODE[summary.mode] ?? summary.mode} · {duration(summary.duration)} · {formatDateTime(summary.createdAt)} ·{' '}
          {galaxyOf(cosmicSeed(summary.cosmos ?? summary.gameId)).name}
        </span>
        <span className="ml-auto" />
        <PostToDiscord gameId={summary.gameId} />
        <Link to="/games" className="btn btn-ghost">
          All games
        </Link>
      </div>

      <GameDiscoveries gameId={summary.gameId} />
      <GameClips gameId={summary.gameId} />

      <div className="stagger grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="panel px-4 pt-3 pb-2">
          <h2 className="mb-1 text-xs font-bold text-muted uppercase">Win / loss curve – gold lead of your team</h2>
          <WinCurve curve={summary.curve} kills={summary.kills} duration={summary.duration} height={150} />
          {summary.curveSource === 'live' && <p className="mt-1 text-[11px] text-muted">Estimated from item values during the game.</p>}
        </div>
        {/* z-index: the staggered player rows below are their own layers, the popovers must open above them */}
        <div className="relative z-20 flex flex-col gap-3">
          {mvp && <VerdictCard kind="mvp" p={mvp} s={summary} />}
          {blame && <VerdictCard kind="blame" p={blame} s={summary} />}
        </div>
      </div>

      <WillScale summary={summary} />
      {effortMissing && (
        <p className="mt-2 text-xs text-muted">
          Will to win: not available for this game – it was saved by an older version and the League client no longer has its details (or
          isn&apos;t running).
        </p>
      )}

      {[true, false].map((ally) => (
        <div
          key={String(ally)}
          className="tinted mt-3 rounded-2xl px-3 py-2"
          style={{ '--tint': ally ? '#2f95dc' : '#e2553f' } as CSSProperties}
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
