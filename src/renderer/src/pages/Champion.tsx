import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronRight, Download, Loader2, Sparkles, Swords } from 'lucide-react'
import type { ChampionBuild, ImportResult, Matchup, Option, RunePage, StatRole } from '@shared/types'
import { ROLE_LABELS } from '@shared/types'
import { api } from '@/lib/api'
import { duration, num, pct, wrColor } from '@/lib/format'
import { useApp, useAsync } from '@/lib/store'
import { ChampIcon, ItemIcon, RoleIcon, RuneIcon, SpellIcon, TierBadge } from '@/components/icons'
import { Spinner } from '@/components/Layout'
import { NoDataHint } from './NoDataHint'
import { MayhemChampionPanel } from '@/components/mayhem'

// Stat shard rune ids, one row per shard slot (offense, flex, defense)
const SHARD_ROWS = [
  [5008, 5005, 5007],
  [5008, 5010, 5001],
  [5011, 5013, 5001]
]

export function ChampionPage() {
  const params = useParams()
  const championId = Number(params.id)
  const { data, patch, statsVersion, client, mode } = useApp()
  const aram = mode === 'aram'
  const role = aram ? 'ARAM' : (params.role as StatRole | undefined)
  const navigate = useNavigate()
  const { value: build, loading } = useAsync(
    () => (patch ? api.getChampionBuild(patch, championId, role === 'ARAM' && !aram ? undefined : role, mode) : Promise.resolve(null)),
    [patch, championId, role, statsVersion, mode]
  )
  const [selectedRunePage, setSelectedRunePage] = useState(0)
  useEffect(() => setSelectedRunePage(0), [championId, role])

  const champion = data?.champions[championId]
  if (!data) return null
  if (!champion) return <div className="p-8">Unbekannter Champion.</div>

  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      {/* Header with a faded splash art behind it */}
      <div className="panel relative mb-6 overflow-hidden p-6">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.13]"
          style={{
            backgroundImage: `url(https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${champion.id}_0.jpg)`,
            backgroundSize: 'cover',
            backgroundPosition: 'center 20%'
          }}
        />
        <div className="relative flex flex-wrap items-center gap-6">
          <ChampIcon id={championId} size={84} className="rounded-2xl ring-2 ring-line" tooltip={false} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-extrabold tracking-tight">{champion.name}</h1>
              {build && <TierBadge tier={build.tier} size="lg" />}
            </div>
            <p className="text-sm text-muted capitalize">{champion.title}</p>
            {build && !aram && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {build.availableRoles.map((roleOption) => (
                  <button
                    key={roleOption.role}
                    onClick={() => navigate(`/champion/${championId}/${roleOption.role}`, { replace: true })}
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-semibold ${
                      roleOption.role === build.role
                        ? 'border-accent/50 bg-accent/10 text-accent'
                        : 'border-line text-muted hover:text-text'
                    }`}
                  >
                    <RoleIcon role={roleOption.role} size={13} /> {ROLE_LABELS[roleOption.role]}
                    <span className="font-normal opacity-60">{num(roleOption.games)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {build && (
            <div className="flex gap-6">
              <Stat label="Win rate" value={pct(build.winRate, 2)} color={wrColor(build.winRate)} />
              <Stat label="Pick rate" value={pct(build.pickRate)} />
              {!aram && <Stat label="Ban rate" value={pct(build.banRate)} />}
              <Stat label="Games" value={num(build.games)} />
              <Stat label="Avg. length" value={duration(build.avgDuration)} />
            </div>
          )}
        </div>
        {build && <ImportBar build={build} connected={client.connected} />}
      </div>

      {loading && !build ? (
        <div className="flex justify-center p-16">
          <Spinner />
        </div>
      ) : !build ? (
        <NoDataHint />
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <Card title="Runes" className="lg:row-span-2">
            {build.runes[selectedRunePage] ? <RunePageView page={build.runes[selectedRunePage].value} /> : <Muted>No rune data</Muted>}
            <div className="mt-5 space-y-1.5">
              {build.runes.map((runeOption, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedRunePage(i)}
                  className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left text-xs ${
                    i === selectedRunePage ? 'border-accent/40 bg-accent/5' : 'border-transparent hover:bg-panel-2'
                  }`}
                >
                  <RuneIcon id={runeOption.value.primary[0]} size={28} />
                  <RuneIcon id={runeOption.value.subStyle} size={18} />
                  <span className="flex-1 truncate text-muted">
                    {runeOption.value.primary
                      .slice(1)
                      .concat(runeOption.value.secondary)
                      .map((id) => data.runes[id]?.name)
                      .join(' · ')}
                  </span>
                  <OptionStats o={runeOption} />
                </button>
              ))}
            </div>
          </Card>

          <Card title="Summoner spells & skills">
            <div className="flex flex-wrap gap-6">
              <div className="space-y-2">
                {build.spells.slice(0, 2).map((spellOption, i) => (
                  <div key={i} className={`flex items-center gap-3 ${i ? 'opacity-70' : ''}`}>
                    <div className="flex gap-1">
                      {spellOption.value.map((id) => (
                        <SpellIcon key={id} id={id} size={34} />
                      ))}
                    </div>
                    <OptionStats o={spellOption} />
                  </div>
                ))}
              </div>
              {build.skillMax[0] && (
                <div>
                  <div className="mb-2 text-xs text-muted">Skill priority</div>
                  <div className="flex items-center gap-1.5">
                    {[...build.skillMax[0].value].map((skill, i) => (
                      <span key={i} className="flex items-center gap-1.5">
                        <SkillKey k={skill} big />
                        {i < 2 && <ChevronRight size={14} className="text-muted" />}
                      </span>
                    ))}
                    <span className="ml-3">
                      <OptionStats o={build.skillMax[0]} />
                    </span>
                  </div>
                </div>
              )}
            </div>
            {build.skillPath[0] && <SkillPath path={build.skillPath[0].value} />}
          </Card>

          <Card title="Items">
            <Section label="Starting items">
              {build.starters.slice(0, 2).map((starter, i) => (
                <Row key={i} o={starter}>
                  <ItemList ids={starter.value} />
                </Row>
              ))}
            </Section>
            <Section label="Core build">
              {build.core.slice(0, 3).map((coreOption, i) => (
                <Row key={i} o={coreOption}>
                  <div className="flex items-center gap-1">
                    {coreOption.value.map((id, j) => (
                      <span key={j} className="flex items-center gap-1">
                        <ItemIcon id={id} size={i ? 32 : 40} />
                        {j < coreOption.value.length - 1 && <ChevronRight size={14} className="text-muted" />}
                      </span>
                    ))}
                  </div>
                </Row>
              ))}
            </Section>
            <Section label="Boots">
              <div className="flex flex-wrap gap-4">
                {build.boots.slice(0, 3).map((boots) => (
                  <div key={boots.value} className="flex items-center gap-2">
                    <ItemIcon id={boots.value} size={32} />
                    <OptionStats o={boots} vertical />
                  </div>
                ))}
              </div>
            </Section>
          </Card>

          <Card title="Situational items" className="lg:col-span-2">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {build.late.map((slot, i) => (
                <div key={i}>
                  <div className="mb-2 text-xs font-semibold text-muted">{['4th', '5th', '6th'][i]} item</div>
                  <div className="space-y-1.5">
                    {slot.length ? (
                      slot.map((itemOption) => (
                        <div key={itemOption.value} className="flex items-center gap-2.5">
                          <ItemIcon id={itemOption.value} size={30} />
                          <span className="flex-1 truncate text-xs">{data.items[itemOption.value]?.name}</span>
                          <OptionStats o={itemOption} />
                        </div>
                      ))
                    ) : (
                      <Muted>Not enough data</Muted>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {aram && (
            <Card title="ARAM: Mayhem – Augments" icon={<Sparkles size={15} className="text-gold" />} className="lg:col-span-2">
              <MayhemChampionPanel championId={championId} />
            </Card>
          )}

          <Card title={aram ? 'Toughest opponents' : 'Hardest matchups'} icon={<Swords size={15} className="text-loss" />}>
            <MatchupList list={build.counters} />
          </Card>
          <Card title={aram ? 'Easiest opponents' : 'Best matchups'} icon={<Swords size={15} className="text-win" />}>
            <MatchupList list={build.goodAgainst} />
          </Card>
        </div>
      )}
    </div>
  )
}

function ImportBar({ build, connected }: { build: ChampionBuild; connected: boolean }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const runImport = async (parts?: ('runes' | 'items' | 'spells')[]) => {
    setBusy(true)
    setResult(null)
    try {
      setResult(await api.importBuild(build.championId, build.role, parts, build.mode))
    } catch (err) {
      setResult({ errors: [(err as Error).message] })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="relative mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
      <button className="btn btn-primary" disabled={!connected || busy} onClick={() => runImport()}>
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Import everything into the client
      </button>
      <button className="btn btn-ghost" disabled={!connected || busy} onClick={() => runImport(['runes'])}>
        Runes
      </button>
      <button className="btn btn-ghost" disabled={!connected || busy} onClick={() => runImport(['items'])}>
        Item set
      </button>
      <button className="btn btn-ghost" disabled={!connected || busy} onClick={() => runImport(['spells'])}>
        Spells
      </button>
      <span className="text-xs text-muted">
        {!connected && 'League client not running'}
        {result && !result.errors.length && `✔ Imported: ${[result.runes, result.items, result.spells].filter(Boolean).join(' · ')}`}
        {result?.errors.length ? <span className="text-loss">{result.errors.join(' · ')}</span> : null}
      </span>
    </div>
  )
}

function RunePageView({ page }: { page: RunePage }) {
  const { data } = useApp()
  if (!data) return null
  const primaryTree = data.runeTrees.find((tree) => tree.id === page.primaryStyle)
  const secondaryTree = data.runeTrees.find((tree) => tree.id === page.subStyle)
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] gap-6">
      <div>
        <TreeHeader id={page.primaryStyle} name={primaryTree?.name} />
        {primaryTree?.slots.map((slot, i) => (
          <div key={i} className={`flex justify-center gap-3 ${i === 0 ? 'mb-4' : 'mb-3'}`}>
            {slot.map((rune) => (
              <RuneIcon key={rune.id} id={rune.id} size={i === 0 ? 46 : 34} dim={!page.primary.includes(rune.id)} />
            ))}
          </div>
        ))}
      </div>
      <div>
        <TreeHeader id={page.subStyle} name={secondaryTree?.name} />
        {secondaryTree?.slots.slice(1).map((slot, i) => (
          <div key={i} className="mb-3 flex justify-center gap-3">
            {slot.map((rune) => (
              <RuneIcon key={rune.id} id={rune.id} size={30} dim={!page.secondary.includes(rune.id)} />
            ))}
          </div>
        ))}
      </div>
      <div className="pt-9">
        {SHARD_ROWS.map((row, i) => (
          <div key={i} className="mb-3 flex gap-2">
            {row.map((id, j) => (
              <RuneIcon key={j} id={id} size={22} dim={page.shards[i] !== id} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function TreeHeader({ id, name }: { id: number; name?: string }) {
  return (
    <div className="mb-4 flex items-center justify-center gap-2 text-sm font-semibold">
      <RuneIcon id={id} size={22} />
      {name}
    </div>
  )
}

const SKILL_COLORS: Record<string, string> = { Q: '#4ea3ff', W: '#3dd68c', E: '#f5c451', R: '#ff5d6c' }

function SkillKey({ k, big = false }: { k: string; big?: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md font-extrabold ${big ? 'h-9 w-9 text-base' : 'h-6 w-6 text-[11px]'}`}
      style={{ color: SKILL_COLORS[k], background: `color-mix(in srgb, ${SKILL_COLORS[k]} 15%, transparent)` }}
    >
      {k}
    </span>
  )
}

function SkillPath({ path }: { path: string }) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="text-center text-[11px]">
        <tbody>
          {['Q', 'W', 'E', 'R'].map((skill) => (
            <tr key={skill}>
              <td className="pr-2">
                <SkillKey k={skill} />
              </td>
              {[...path].map((levelSkill, i) => (
                <td key={i} className="p-[2px]">
                  {levelSkill === skill ? (
                    <span
                      className="inline-flex h-[22px] w-[22px] items-center justify-center rounded font-bold text-bg"
                      style={{ background: SKILL_COLORS[skill] }}
                    >
                      {i + 1}
                    </span>
                  ) : (
                    <span className="inline-block h-[22px] w-[22px] rounded bg-bg-2" />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MatchupList({ list }: { list: Matchup[] }) {
  const navigate = useNavigate()
  const { data } = useApp()
  if (!list.length) return <Muted>Not enough data for matchups</Muted>
  return (
    <div className="grid grid-cols-2 gap-2">
      {list.map((matchup) => (
        <button
          key={matchup.championId}
          onClick={() => navigate(`/champion/${matchup.championId}`)}
          className="flex items-center gap-2.5 rounded-xl bg-bg-2 p-2 text-left hover:bg-panel-2"
        >
          <ChampIcon id={matchup.championId} size={34} tooltip={false} />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold">{data?.champions[matchup.championId]?.name}</div>
            <div className="text-xs">
              <span style={{ color: wrColor(matchup.winRate) }} className="font-bold">
                {pct(matchup.winRate)}
              </span>{' '}
              <span className="text-muted">· {num(matchup.games)}</span>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

function Card({ title, icon, children, className = '' }: { title: string; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-5 ${className}`}>
      <h2 className="mb-4 flex items-center gap-2 text-sm font-bold tracking-wide text-muted uppercase">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 text-xs font-semibold text-muted">{label}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Row({ o, children }: { o: Option<unknown>; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      {children}
      <OptionStats o={o} />
    </div>
  )
}

function ItemList({ ids }: { ids: number[] }) {
  const counts = new Map<number, number>()
  ids.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1))
  return (
    <div className="flex gap-1">
      {[...counts.entries()].map(([id, count]) => (
        <ItemIcon key={id} id={id} size={34} count={count} />
      ))}
    </div>
  )
}

function OptionStats({ o, vertical = false }: { o: Option<unknown>; vertical?: boolean }) {
  return (
    <span className={`flex shrink-0 text-xs tabular-nums ${vertical ? 'flex-col' : 'items-baseline gap-2 text-right'}`}>
      <b style={{ color: wrColor(o.winRate) }}>{pct(o.winRate)} WR</b>
      <span className="text-muted">
        {pct(o.pickRate, 0)} · {num(o.g)}
      </span>
    </span>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="text-center">
      <div className="text-lg font-extrabold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>
}
