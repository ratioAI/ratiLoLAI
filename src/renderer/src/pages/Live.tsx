import { liveChampionKey } from '@shared/staticData'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Ban, Eye, Loader2, Radio, Skull, X } from 'lucide-react'
import type { ChampSelectPlayer, GameMode, LiveGameState, MinimapState, Platform, ScoutResult } from '@shared/types'
import { PLATFORMS, ROLE_LABELS, statsModeOf } from '@shared/types'
import { MayhemChampionPanel, useMayhemData, useOwnedAugments } from '@/components/mayhem'
import { AugmentFrame } from '@/components/AugmentFrame'
import { augmentTiersForChampion } from '@shared/mayhem'
import { api } from '@/lib/api'
import { duration, num, pct, RANK_COLORS, wrColor } from '@/lib/format'
import { useApp, useAsync } from '@/lib/store'
import { img } from '@/lib/img'
import { ChampIcon, GameImage, ItemIcon, RoleIcon, RuneIcon, SpellIcon, TierBadge } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/Layout'

export function Live() {
  const { champSelect, live, client, settings } = useApp()
  const [scout, setScout] = useState<ScoutResult | null>(null)
  const [scoutErr, setScoutErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [riotId, setRiotId] = useState('')
  const [platform, setPlatform] = useState<Platform>(settings?.platform ?? 'euw1')

  const runScout = async (id: string, p: Platform) => {
    setBusy(true)
    setScoutErr(null)
    try {
      const r = await api.scoutActiveGame(id, p)
      setScout(r)
      if (!r) setScoutErr('This player is not in a game right now.')
    } catch (e) {
      setScoutErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const me = client.summoner
  const scoutMe = () => me && runScout(`${me.gameName}#${me.tagLine}`, me.platform ?? settings?.platform ?? 'euw1')

  return (
    <div className="fade-in mx-auto max-w-6xl p-8">
      <PageHeader
        title="Live"
        subtitle={
          champSelect?.active ? 'Champion select in progress' : live?.active ? `In game · ${duration(live.gameTime)}` : 'No active game'
        }
      >
        {me && (
          <button className="btn btn-ghost" onClick={scoutMe} disabled={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />} Load ranks of current game
          </button>
        )}
      </PageHeader>

      {champSelect?.active && <ChampSelectView />}
      {live?.active && <LiveScoreboard live={live} />}

      {!champSelect?.active && !live?.active && !scout && (
        <EmptyState icon={<Radio size={34} />} title="Waiting for champion select …">
          As soon as you enter champion select in the League client, your build, your teammates and the enemy picks
          show up here. Runes and items are imported automatically.
        </EmptyState>
      )}

      <section className="panel mt-6 p-5">
        <h2 className="mb-3 text-sm font-bold tracking-wide text-muted uppercase">Scout a player's game</h2>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void runScout(riotId, platform)
          }}
        >
          <input className="input w-72" placeholder="Name#TAG" value={riotId} onChange={(e) => setRiotId(e.target.value)} />
          <select className="input" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
            {Object.entries(PLATFORMS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={busy || !riotId.includes('#')}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />} Scout
          </button>
        </form>
        {scoutErr && <p className="mt-3 text-sm text-loss">{scoutErr}</p>}
        {scout && <ScoutView result={scout} />}
      </section>
    </div>
  )
}

function ChampSelectView() {
  const { champSelect, data, patch, statsVersion, lastImport } = useApp()
  const cs = champSelect!
  const statsMode: GameMode = statsModeOf(cs.mode)
  const role = statsMode === 'aram' ? 'ARAM' : (cs.myRole ?? undefined)
  const { value: build } = useAsync(async () => {
    if (!cs.myChampionId) return null
    const p = (await api.getPatches(statsMode)).find((x) => x.matches > 0)?.patch ?? patch
    return p ? api.getChampionBuild(p, cs.myChampionId, role, statsMode) : null
  }, [patch, cs.myChampionId, role, statsMode, statsVersion])
  return (
    <>
    <div className="mb-3 text-xs font-semibold text-muted">
      Mode: <span className="text-accent">{MODE_LABELS[cs.mode]}</span>
      {cs.mode === 'mayhem' && ' · builds from ARAM data, augments below'}
    </div>
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1.3fr_1fr]">
      <TeamColumn title="Your team" players={cs.allies} />
      <div className="panel p-5">
        {cs.myChampionId ? (
          <>
            <div className="mb-4 flex items-center gap-4">
              <ChampIcon id={cs.myChampionId} size={64} className="rounded-2xl" tooltip={false} />
              <div className="flex-1">
                <div className="text-xl font-extrabold">{data?.champions[cs.myChampionId]?.name}</div>
                <div className="flex items-center gap-1.5 text-sm text-muted">
                  {cs.myRole && <RoleIcon role={cs.myRole} size={14} />}
                  {statsMode === 'aram'
                    ? `${MODE_LABELS[cs.mode]} · random champion`
                    : `${cs.myRole ? ROLE_LABELS[cs.myRole] : 'No role'} · ${cs.locked ? 'locked in' : 'hovering'}`}
                </div>
              </div>
              {build && <TierBadge tier={build.tier} size="lg" />}
            </div>
            {build ? (
              <>
                <div className="mb-4 grid grid-cols-3 gap-2 text-center">
                  <Mini label="Win rate" value={pct(build.winRate)} color={wrColor(build.winRate)} />
                  <Mini label="Pick rate" value={pct(build.pickRate)} />
                  <Mini label="Games" value={num(build.games)} />
                </div>
                {build.runes[0] && (
                  <div className="mb-3 flex items-center gap-2">
                    {build.runes[0].value.primary.map((id, i) => (
                      <RuneIcon key={id} id={id} size={i === 0 ? 40 : 28} />
                    ))}
                    <span className="mx-1 h-6 w-px bg-line" />
                    {build.runes[0].value.secondary.map((id) => (
                      <RuneIcon key={id} id={id} size={24} />
                    ))}
                  </div>
                )}
                <div className="mb-3 flex items-center gap-1.5">
                  {build.spells[0]?.value.map((id) => <SpellIcon key={id} id={id} size={30} />)}
                  <span className="mx-2 h-6 w-px bg-line" />
                  {build.core[0]?.value.map((id) => <ItemIcon key={id} id={id} size={34} />)}
                  {build.boots[0] && <ItemIcon id={build.boots[0].value} size={34} />}
                </div>
                <div className="flex items-center justify-between">
                  <Link to={`/champion/${cs.myChampionId}/${build.role}`} className="text-sm font-semibold text-accent">
                    Full build →
                  </Link>
                  <button className="btn btn-primary" onClick={() => api.importBuild(cs.myChampionId, role ?? null, undefined, statsMode)}>
                    Import
                  </button>
                </div>
                {lastImport && lastImport.championId === cs.myChampionId && (
                  <p className={`mt-3 text-xs ${lastImport.errors.length ? 'text-loss' : 'text-win'}`}>
                    {lastImport.errors.length ? lastImport.errors.join(' · ') : '✔ Runes & items imported automatically'}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">No data for this champion yet.</p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">Pick a champion …</p>
        )}
        {cs.bans.length > 0 && (
          <div className="mt-5 border-t border-line pt-4">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted">
              <Ban size={13} /> Bans
            </div>
            <div className="flex flex-wrap gap-1.5">
              {cs.bans.map((id, i) => (
                <ChampIcon key={i} id={id} size={28} className="opacity-60 grayscale" />
              ))}
            </div>
          </div>
        )}
      </div>
      <TeamColumn title="Enemies" players={cs.enemies} enemy />
    </div>
    {cs.mode === 'mayhem' && cs.myChampionId > 0 && (
      <section className="panel mt-5 p-5">
        <h2 className="mb-4 text-sm font-bold tracking-wide text-gold uppercase">ARAM: Mayhem – Augments</h2>
        <MayhemChampionPanel championId={cs.myChampionId} />
      </section>
    )}
    </>
  )
}

const MODE_LABELS = { ranked: "Summoner's Rift", aram: 'ARAM', mayhem: 'ARAM: Mayhem', other: 'Other mode' } as const

function TeamColumn({ title, players, enemy = false }: { title: string; players: ChampSelectPlayer[]; enemy?: boolean }) {
  const { data } = useApp()
  return (
    <div className="panel p-5">
      <h2 className={`mb-3 text-sm font-bold tracking-wide uppercase ${enemy ? 'text-loss' : 'text-accent'}`}>{title}</h2>
      <div className="space-y-2">
        {players.map((p) => (
          <div key={p.cellId} className={`flex items-center gap-3 rounded-xl p-2 ${p.isLocal ? 'bg-accent/8 ring-1 ring-accent/30' : 'bg-bg-2'}`}>
            {p.championId ? (
              <ChampIcon id={p.championId} size={40} tooltip={false} />
            ) : (
              <span className="h-10 w-10 rounded-lg bg-panel-2" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{p.championId ? data?.champions[p.championId]?.name : 'Picking …'}</div>
              <div className="flex items-center gap-1 text-xs text-muted">
                {p.role && <RoleIcon role={p.role} size={12} />}
                {p.role ? ROLE_LABELS[p.role] : enemy ? 'Enemy' : ''}
                {p.isLocal && ' · You'}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The augments you picked this game, in their tier frames (hover a frame to remove a wrong one). */
function OwnedAugments({ championId, owned }: { championId: number; owned: number[] }) {
  const { data: statics } = useApp()
  const { data } = useMayhemData()
  const tiers = useMemo(
    () => (data && statics && championId ? new Map(augmentTiersForChampion(data, statics, championId).map((t) => [t.augment.id, t])) : null),
    [data, statics, championId]
  )
  if (!data || !tiers) return null
  return (
    <span className="ml-2 flex items-center gap-2 pt-1.5 pb-1">
      {owned.map((id) => {
        const t = tiers.get(id)
        const a = data.augments[id]
        if (!a) return null
        return (
          <span key={id} className="group relative">
            <AugmentFrame augment={a} tier={t?.tier ?? 'C'} size={26} note={t?.note ?? null} />
            <button
              onClick={() => api.setOwnedAugments(owned.filter((x) => x !== id))}
              className="absolute -top-2 -right-2 hidden rounded-full bg-black/85 p-0.5 text-muted group-hover:block hover:text-loss"
              title="Not picked – remove"
            >
              <X size={10} />
            </button>
          </span>
        )
      })}
    </span>
  )
}

const TEAM_STYLE = {
  ORDER: { label: 'Blue team', color: '#4ea3ff', tint: 'rgb(78 163 255 / 0.13)', edge: 'rgb(78 163 255 / 0.55)' },
  CHAOS: { label: 'Red team', color: '#ff5a78', tint: 'rgb(255 90 120 / 0.12)', edge: 'rgb(255 90 120 / 0.55)' }
} as const

const fmtClock = (s: number): string => {
  const v = Math.max(0, Math.ceil(s))
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`
}

/** Relic and inhibitor timers of the running ARAM game (same data as the minimap overlay). */
function MapTimers({ gameMode }: { gameMode: string }) {
  const [t, setT] = useState<MinimapState | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    void api.getMapTimers().then(setT).catch(() => undefined)
    const off = api.on('mapTimers', setT)
    const i = setInterval(() => tick((x) => x + 1), 1000)
    return () => {
      off()
      clearInterval(i)
    }
  }, [])
  if (!t || (gameMode !== 'KIWI' && gameMode !== 'ARAM')) return null
  const now = t.gameTime + (Date.now() - t.measuredAt) / 1000
  const label = (id: string) => ({ 'order-inner': 'Blue inner', 'order-outer': 'Blue outer', 'chaos-outer': 'Red outer', 'chaos-inner': 'Red inner' })[id] ?? id
  return (
    <div className="panel p-4">
      <h2 className="mb-3 text-sm font-bold text-muted uppercase">Map timers</h2>
      <div className="grid grid-cols-2 gap-2 text-sm">
        {t.relics.map((r) => (
          <div key={r.id} className="flex items-center justify-between rounded-lg bg-bg-2 px-2.5 py-1.5">
            <span className="flex items-center gap-1.5">
              <span className="font-black text-win">+</span>
              {label(r.id)}
            </span>
            <span className="font-bold tabular-nums">
              {r.state === 'spawn' && r.at !== null && r.at > now ? fmtClock(r.at - now) : r.state === 'up' ? <span className="text-win">up</span> : <span className="text-muted">up?</span>}
            </span>
          </div>
        ))}
        {t.inhibitors
          .filter((i) => i.respawnAt > now)
          .map((i, k) => (
            <div key={k} className="col-span-2 flex items-center justify-between rounded-lg bg-bg-2 px-2.5 py-1.5">
              <span style={{ color: TEAM_STYLE[i.team].color }}>{i.team === 'ORDER' ? 'Blue' : 'Red'} inhibitor</span>
              <span className="font-bold tabular-nums">{fmtClock(i.respawnAt - now)}</span>
            </div>
          ))}
      </div>
    </div>
  )
}

function LiveScoreboard({ live }: { live: LiveGameState }) {
  const { data } = useApp()
  const owned = useOwnedAugments()
  if (!data) return null
  const me = live.players.find((p) => p.riotId === live.activePlayer)
  const premades = new Set((live.premades ?? []).map((r) => r.toLowerCase()))
  // your team first
  const order: ('ORDER' | 'CHAOS')[] = me?.team === 'CHAOS' ? ['CHAOS', 'ORDER'] : ['ORDER', 'CHAOS']
  const myChamp = liveChampionKey(data, live)
  // the Live Client API only updates other players' CS in steps of 10 – meaningless in ARAM
  const showCs = live.gameMode !== 'ARAM' && live.gameMode !== 'KIWI'
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-4">
        {order.map((team) => {
          const st = TEAM_STYLE[team]
          const players = live.players.filter((p) => p.team === team)
          const mine = me?.team === team
          return (
            <div
              key={team}
              className="rounded-2xl p-4"
              style={{
                background: `linear-gradient(135deg, ${st.tint}, rgb(20 13 40 / 0.78) 70%)`,
                border: `1px solid ${st.edge}`,
                boxShadow: mine ? `0 0 24px -10px ${st.color}` : undefined
              }}
            >
              <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase" style={{ color: st.color }}>
                {st.label}
                {mine && (
                  <span className="rounded-md px-1.5 py-0.5 text-[10px] tracking-wider" style={{ background: st.tint, color: st.color }}>
                    your team
                  </span>
                )}
              </h2>
              <div className="space-y-1.5">
                {players.map((p) => {
                  const isMe = p.riotId === live.activePlayer
                  const premade = premades.has(p.riotId.toLowerCase())
                  return (
                    <div
                      key={p.riotId}
                      className={`flex items-center gap-3 rounded-lg p-1.5 text-sm ${isMe ? 'bg-gold/8 ring-1 ring-gold/30' : ''} ${p.isDead ? 'opacity-55' : ''}`}
                    >
                      <span className="relative">
                        <GameImage src={img.championByName(data, p.championName)} size={34} alt={p.championName} />
                        <span className="absolute -right-1 -bottom-1 rounded bg-black/80 px-1 text-[10px] font-bold">{p.level}</span>
                      </span>
                      <span
                        className={`w-40 truncate font-semibold ${isMe ? 'text-gold' : premade ? 'text-[#7cc4ff]' : 'text-text'}`}
                        title={premade ? 'In your party' : undefined}
                      >
                        {p.riotId.split('#')[0]}
                      </span>
                      <span className="w-20 font-semibold tabular-nums">
                        {p.kills}/<span className="text-loss">{p.deaths}</span>/{p.assists}
                      </span>
                      {showCs && (
                        <span className="w-14 text-muted tabular-nums" title="The game reports other players' CS in steps of 10">
                          ~{p.creepScore} CS
                        </span>
                      )}
                      <span className="flex gap-0.5">
                        {Array.from({ length: 7 }, (_, i) => (
                          <ItemIcon key={i} id={p.items[i] ?? 0} size={24} />
                        ))}
                      </span>
                      {isMe && owned.length > 0 && <OwnedAugments championId={myChamp} owned={owned} />}
                      {p.isDead && (
                        <span className="ml-auto flex items-center gap-1 text-xs text-loss">
                          <Skull size={12} /> {Math.ceil(p.respawnTimer)}s
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        <p className="px-1 text-[11px] text-muted">
          <span className="font-semibold text-gold">Gold</span> = you · <span className="font-semibold text-[#7cc4ff]">blue</span> = your
          premades. Other players' augments are not shared by the game, so only yours are shown.
        </p>
      </div>
      <div className="space-y-4">
        <MapTimers gameMode={live.gameMode} />
        {live.gameMode === 'KIWI' && myChamp > 0 && (
          <div className="panel p-4">
            <h2 className="mb-3 text-sm font-bold text-gold uppercase">Augments for {live.activeChampion}</h2>
            <MayhemChampionPanel championId={myChamp} compact owned={owned} />
          </div>
        )}
        <div className="panel p-4">
          <h2 className="mb-3 text-sm font-bold text-muted uppercase">Events</h2>
          <div className="space-y-2 text-sm">
            {live.events.map((e, i) => (
              <div key={i} className="flex gap-3">
                <span className="w-10 text-muted tabular-nums">{duration(e.time)}</span>
                <span>{e.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ScoutView({ result }: { result: ScoutResult }) {
  const teams = [100, 200].map((t) => result.players.filter((p) => p.teamId === t))
  return (
    <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
      {teams.map((players, ti) => (
        <div key={ti}>
          <h3 className={`mb-2 text-xs font-bold uppercase ${ti ? 'text-loss' : 'text-accent'}`}>{ti ? 'Red team' : 'Blue team'}</h3>
          <div className="space-y-1.5">
            {players.map((p) => {
              const r = p.ranked
              const wr = r ? r.wins / Math.max(1, r.wins + r.losses) : 0
              return (
                <div key={p.puuid} className="flex items-center gap-3 rounded-xl bg-bg-2 p-2">
                  <ChampIcon id={p.championId} size={36} />
                  <div className="flex gap-0.5">
                    {p.spells.map((s) => (
                      <SpellIcon key={s} id={s} size={17} />
                    ))}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.riotId}</span>
                  {r ? (
                    <span className="text-right text-xs">
                      <b style={{ color: RANK_COLORS[r.tier] }}>
                        {r.tier.charAt(0) + r.tier.slice(1).toLowerCase()} {['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(r.tier) ? '' : r.rank}
                      </b>{' '}
                      {r.leaguePoints} LP
                      <span className="block" style={{ color: wrColor(wr) }}>
                        {pct(wr, 0)} · {r.wins + r.losses} games
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs text-muted">Unranked</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl bg-bg-2 py-2">
      <div className="text-base font-bold" style={{ color }}>
        {value}
      </div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  )
}
