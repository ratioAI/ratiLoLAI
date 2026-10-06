import { liveChampionKey } from '@shared/staticData'
import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Info, RefreshCw } from 'lucide-react'
import type { AugmentRarity, MayhemPersonal } from '@shared/types'
import { api } from '@/lib/api'
import { pct, timeAgo, wrColor } from '@/lib/format'
import { useApp } from '@/lib/store'
import { ChampIcon } from '@/components/icons'
import { PageHeader, Spinner } from '@/components/Layout'
import { Attribution, AugmentIcon, MayhemChampionPanel, RARITY_COLORS, RARITY_LABELS, useMayhemData } from '@/components/mayhem'

export function Mayhem() {
  const { data: statics, champSelect, live, client } = useApp()
  const { data, error } = useMayhemData()
  const currentChampionId = useMemo(() => {
    if (champSelect?.myChampionId) return champSelect.myChampionId
    return liveChampionKey(statics, live)
  }, [champSelect, live, statics])
  const [pickedChampionId, setPickedChampionId] = useState<number>(0)
  // Falls back to Ahri (103) as an example when nothing is picked or being played
  const championId = pickedChampionId || currentChampionId || 103
  const [champQuery, setChampQuery] = useState('')

  const champMatches = useMemo(() => {
    const search = champQuery.trim().toLowerCase()
    if (!search || !statics) return []
    return Object.values(statics.champions)
      .filter((champion) => champion.name.toLowerCase().includes(search))
      .slice(0, 8)
  }, [champQuery, statics])

  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader title="ARAM: Mayhem" subtitle="Augment tiers per champion, most picked augments and your own Mayhem stats" />

      <div className="panel mb-5 flex gap-3 border-gold/30 p-4 text-sm text-muted">
        <Info size={18} className="mt-0.5 shrink-0 text-gold" />
        <p>
          Riot does not expose Mayhem matches in the official API and asks developers not to publish augment win rates. ratioAI therefore
          rates augments by <b className="text-text">curated combos, pick rates and champion fit</b> (open dataset of arammayhem.com, China
          servers) and shows your <b className="text-text">own</b> Mayhem results from the League client. Items & runes for Mayhem come from
          your crawled ARAM games.
        </p>
      </div>

      <div className="stagger grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="panel p-5">
          <div className="mb-4 flex items-center gap-3">
            <ChampIcon id={championId} size={48} tooltip={false} />
            <div className="flex-1">
              <div className="text-lg font-extrabold">{statics?.champions[championId]?.name}</div>
              <div className="text-xs text-muted">
                {pickedChampionId ? 'selected' : currentChampionId ? 'your current champion' : 'example – pick a champion'}
              </div>
            </div>
            <div className="relative">
              <input
                className="input w-52"
                placeholder="Pick champion …"
                value={champQuery}
                onChange={(event) => setChampQuery(event.target.value)}
              />
              {champMatches.length > 0 && (
                <div className="absolute right-0 z-20 mt-1 w-52 rounded-xl border border-line bg-panel p-1 shadow-xl">
                  {champMatches.map((champion) => (
                    <button
                      key={champion.key}
                      onClick={() => {
                        setPickedChampionId(champion.key)
                        setChampQuery('')
                      }}
                      className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left text-sm hover:bg-panel-2"
                    >
                      <ChampIcon id={champion.key} size={24} tooltip={false} /> {champion.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <MayhemChampionPanel championId={championId} />
        </section>

        <div className="space-y-5">
          <PersonalStats connected={client.connected} />
          {error ? (
            <p className="text-sm text-loss">{error}</p>
          ) : data ? (
            <AugmentBrowser />
          ) : (
            <div className="flex justify-center p-10">
              <Spinner />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AugmentBrowser() {
  const { data } = useMayhemData()
  const [query, setQuery] = useState('')
  const [rarity, setRarity] = useState<AugmentRarity | null>(null)
  const augments = useMemo(() => {
    if (!data) return []
    const search = query.trim().toLowerCase()
    return Object.values(data.augments)
      .filter(
        (augment) =>
          augment.pickRate != null && (!rarity || augment.rarity === rarity) && (!search || augment.name.toLowerCase().includes(search))
      )
      .sort((a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0))
  }, [data, query, rarity])
  if (!data) return null
  return (
    <section className="panel p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold tracking-wide text-muted uppercase">All augments by popularity</h2>
        <input className="input w-44" placeholder="Search …" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="mb-3 flex gap-1.5">
        {(['prismatic', 'gold', 'silver'] as AugmentRarity[]).map((option) => (
          <button
            key={option}
            onClick={() => setRarity((current) => (current === option ? null : option))}
            className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${rarity && rarity !== option ? 'opacity-40' : ''}`}
            style={{ color: RARITY_COLORS[option], borderColor: `color-mix(in srgb, ${RARITY_COLORS[option]} 40%, transparent)` }}
          >
            {RARITY_LABELS[option]}
          </button>
        ))}
      </div>
      <div className="max-h-[460px] space-y-1 overflow-y-auto pr-1">
        {augments.map((augment) => (
          <div key={augment.id} className="flex items-center gap-3 rounded-lg px-1.5 py-1 hover:bg-panel-2">
            <span className="w-7 text-right text-xs text-muted tabular-nums">{augment.pickRateRank}</span>
            <AugmentIcon augment={augment} size={32} />
            <span className="min-w-0 flex-1 truncate text-sm">{augment.name}</span>
            <span className="w-14 text-right text-sm font-semibold tabular-nums">{augment.pickRate?.toFixed(1)} %</span>
            <span className="flex w-14 items-center justify-end text-xs tabular-nums">
              {augment.pickRateChange ? (
                <span className={`flex items-center ${augment.pickRateChange > 0 ? 'text-win' : 'text-loss'}`}>
                  {augment.pickRateChange > 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                  {Math.abs(augment.pickRateChange).toFixed(1)}
                </span>
              ) : (
                <span className="text-muted">–</span>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Attribution data={data} />
      </div>
    </section>
  )
}

function PersonalStats({ connected }: { connected: boolean }) {
  const { data } = useMayhemData()
  const [stats, setStats] = useState<MayhemPersonal | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // load as soon as the client is there – the numbers come straight from the client's match history
  useEffect(() => {
    if (connected && !stats && !busy) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])
  const load = async () => {
    setBusy(true)
    setErrorMessage(null)
    try {
      setStats(await api.getMayhemPersonal())
    } catch (err) {
      setErrorMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-wide text-muted uppercase">Your Mayhem games</h2>
        <button className="btn btn-ghost" disabled={!connected || busy} onClick={load}>
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> {stats ? 'Refresh' : 'Load'}
        </button>
      </div>
      {!connected && <p className="text-sm text-muted">Start the League client to analyse your recent Mayhem games.</p>}
      {errorMessage && <p className="text-sm text-loss">{errorMessage}</p>}
      {stats && stats.games === 0 && <p className="text-sm text-muted">No Mayhem game in your last 100 games.</p>}
      {stats && stats.games > 0 && (
        <>
          <div className="mb-4 flex items-baseline gap-3">
            <span className="text-2xl font-extrabold" style={{ color: wrColor(stats.wins / stats.games) }}>
              {pct(stats.wins / stats.games, 0)}
            </span>
            <span className="text-sm text-muted">
              {stats.wins}W {stats.games - stats.wins}L in {stats.games} games
            </span>
          </div>
          <h3 className="mb-2 text-xs font-semibold text-muted">Your most picked augments</h3>
          <div className="mb-4 space-y-1.5">
            {stats.augments.slice(0, 8).map((augmentStats) => (
              <div key={augmentStats.id} className="flex items-center gap-3 text-sm">
                <AugmentIcon augment={data?.augments[augmentStats.id]} size={30} />
                <span className="flex-1 truncate">{data?.augments[augmentStats.id]?.name ?? `Augment #${augmentStats.id}`}</span>
                <span style={{ color: wrColor(augmentStats.wins / augmentStats.games) }} className="font-semibold">
                  {pct(augmentStats.wins / augmentStats.games, 0)}
                </span>
                <span className="w-16 text-right text-xs text-muted">{augmentStats.games} games</span>
              </div>
            ))}
          </div>
          <h3 className="mb-2 text-xs font-semibold text-muted">Recent games</h3>
          <div className="space-y-1.5">
            {stats.recent.slice(0, 6).map((game) => (
              <div key={game.gameId} className="flex items-center gap-2 rounded-lg bg-bg-2 p-1.5">
                <span className={`h-8 w-1 rounded-full ${game.win ? 'bg-win' : 'bg-loss'}`} />
                <ChampIcon id={game.championId} size={30} />
                <div className="flex gap-1">
                  {game.augments.map((id) => (
                    <AugmentIcon key={id} augment={data?.augments[id]} size={26} />
                  ))}
                </div>
                <span className="ml-auto text-xs text-muted">{timeAgo(game.createdAt)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
