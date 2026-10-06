import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp, Trophy } from 'lucide-react'
import type { Role, Tier, TierEntry } from '@shared/types'
import { ROLE_LABELS, ROLES } from '@shared/types'
import { api } from '@/lib/api'
import { num, pct, wrColor } from '@/lib/format'
import { useApp, useAsync } from '@/lib/store'
import { ChampIcon, RoleIcon, TierBadge } from '@/components/icons'
import { EmptyState, PageHeader, Spinner } from '@/components/Layout'
import { NoDataHint } from './NoDataHint'

type SortKey = 'rank' | 'tier' | 'winRate' | 'pickRate' | 'banRate' | 'games' | 'name'
const TIER_ORDER: Tier[] = ['S+', 'S', 'A', 'B', 'C', 'D']

export function RoleTabs({
  value,
  onChange,
  withAll = true
}: {
  value: Role | 'ALL'
  onChange: (role: Role | 'ALL') => void
  withAll?: boolean
}) {
  const options: (Role | 'ALL')[] = withAll ? ['ALL', ...ROLES] : [...ROLES]
  return (
    <div className="flex rounded-xl border border-line bg-bg-2 p-1">
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
            value === option ? 'bg-panel-2 text-accent' : 'text-muted hover:text-text'
          }`}
        >
          <RoleIcon role={option} size={15} />
          {option === 'ALL' ? 'All' : ROLE_LABELS[option]}
        </button>
      ))}
    </div>
  )
}

export function TierList() {
  const { data, patch, statsVersion, mode } = useApp()
  const aram = mode === 'aram'
  const navigate = useNavigate()
  const [role, setRole] = useState<Role | 'ALL'>('ALL')
  const [query, setQuery] = useState('')
  const [tierFilter, setTierFilter] = useState<Tier | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'rank', dir: 1 })

  const { value: list, loading } = useAsync(() => (patch ? api.getTierList(patch, mode) : Promise.resolve([])), [patch, statsVersion, mode])

  const rows = useMemo(() => {
    if (!list || !data) return []
    const search = query.trim().toLowerCase()
    let filtered = list.filter(
      (entry) =>
        (aram || role === 'ALL' || entry.role === role) &&
        (!tierFilter || entry.tier === tierFilter) &&
        (!search || data.champions[entry.championId]?.name.toLowerCase().includes(search))
    )
    // Tier first, then score within the tier. Per-role ranks don't compare across roles, so "All" falls back to this too.
    const sortValue = (entry: TierEntry): number | string => {
      switch (sort.key) {
        case 'name':
          return data.champions[entry.championId]?.name ?? ''
        case 'tier':
          return TIER_ORDER.indexOf(entry.tier) * 1000 - entry.score
        case 'rank':
          return role === 'ALL' && !aram ? TIER_ORDER.indexOf(entry.tier) * 1000 - entry.score : entry.rank
        default:
          return -entry[sort.key]
      }
    }
    filtered = [...filtered].sort((a, b) => {
      const valueA = sortValue(a)
      const valueB = sortValue(b)
      return (typeof valueA === 'string' ? valueA.localeCompare(valueB as string) : valueA - (valueB as number)) * sort.dir
    })
    return filtered
  }, [list, data, role, query, tierFilter, sort, aram])

  const Th = ({ k, children, className = '' }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th
      className={`cursor-pointer px-3 py-3 font-semibold select-none hover:text-text ${className}`}
      onClick={() => setSort((current) => ({ key: k, dir: current.key === k ? (-current.dir as 1 | -1) : 1 }))}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sort.key === k && (sort.dir === 1 ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </span>
    </th>
  )

  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader
        title="Tier list"
        subtitle={
          aram
            ? `ARAM (Howling Abyss) · patch ${patch ?? '–'} · also the build source for ARAM: Mayhem`
            : `Ranked Solo/Duo · Master+ · patch ${patch ?? '–'} · based on your crawled matches`
        }
      >
        <input className="input w-56" placeholder="Search champion …" value={query} onChange={(event) => setQuery(event.target.value)} />
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {aram ? <span /> : <RoleTabs value={role} onChange={setRole} />}
        <div className="flex gap-1">
          {TIER_ORDER.map((tier) => (
            <button
              key={tier}
              onClick={() => setTierFilter((current) => (current === tier ? null : tier))}
              className={tierFilter && tierFilter !== tier ? 'opacity-35' : ''}
            >
              <TierBadge tier={tier} size="sm" />
            </button>
          ))}
        </div>
      </div>

      {loading && !list ? (
        <div className="flex justify-center p-16">
          <Spinner />
        </div>
      ) : !list?.length ? (
        <NoDataHint />
      ) : !rows.length ? (
        <EmptyState icon={<Trophy size={32} />} title="No results" />
      ) : (
        <div className="panel overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <Th k="rank" className="w-16 text-center">
                  #
                </Th>
                <Th k="name">Champion</Th>
                <Th k="tier">Tier</Th>
                <Th k="winRate">Win rate</Th>
                <Th k="pickRate">Pick rate</Th>
                {!aram && <Th k="banRate">Ban rate</Th>}
                <Th k="games" className="text-right">
                  Games
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry, i) => {
                const champion = data?.champions[entry.championId]
                return (
                  <tr
                    key={`${entry.championId}:${entry.role}`}
                    className="cursor-pointer border-b border-line/50 transition last:border-0 hover:bg-panel-2"
                    onClick={() => navigate(`/champion/${entry.championId}/${entry.role}`)}
                  >
                    <td className="px-3 py-2 text-center font-semibold text-muted">
                      {sort.key === 'rank' && (role !== 'ALL' || aram) ? entry.rank : i + 1}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        <ChampIcon id={entry.championId} size={38} tooltip={false} />
                        <div>
                          <div className="font-semibold">{champion?.name}</div>
                          <div className="flex items-center gap-1 text-xs text-muted">
                            <RoleIcon role={entry.role} size={12} /> {ROLE_LABELS[entry.role]}
                            {entry.roleShare < 0.9 && <span className="text-muted/70">· {pct(entry.roleShare, 0)} of games</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <TierBadge tier={entry.tier} />
                    </td>
                    <td className="px-3 py-2 font-semibold" style={{ color: wrColor(entry.winRate) }}>
                      {pct(entry.winRate, 2)}
                    </td>
                    <td className="px-3 py-2">
                      <Bar value={entry.pickRate} max={0.25} />
                    </td>
                    {!aram && (
                      <td className="px-3 py-2">
                        <Bar value={entry.banRate} max={0.4} color="var(--color-loss)" />
                      </td>
                    )}
                    <td className="px-3 py-2 text-right text-muted">{num(entry.games)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Bar({ value, max, color = 'var(--color-accent)' }: { value: number; max: number; color?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 tabular-nums">{pct(value)}</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-bg-2">
        <span className="block h-full rounded-full" style={{ width: `${Math.min(100, (value / max) * 100)}%`, background: color }} />
      </span>
    </div>
  )
}
