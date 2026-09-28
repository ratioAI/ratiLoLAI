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

export function RoleTabs({ value, onChange, withAll = true }: { value: Role | 'ALL'; onChange: (r: Role | 'ALL') => void; withAll?: boolean }) {
  const options: (Role | 'ALL')[] = withAll ? ['ALL', ...ROLES] : [...ROLES]
  return (
    <div className="flex rounded-xl border border-line bg-bg-2 p-1">
      {options.map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
            value === r ? 'bg-panel-2 text-accent' : 'text-muted hover:text-text'
          }`}
        >
          <RoleIcon role={r} size={15} />
          {r === 'ALL' ? 'All' : ROLE_LABELS[r]}
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
    const q = query.trim().toLowerCase()
    let r = list.filter(
      (e) =>
        (aram || role === 'ALL' || e.role === role) &&
        (!tierFilter || e.tier === tierFilter) &&
        (!q || data.champions[e.championId]?.name.toLowerCase().includes(q))
    )
    const val = (e: TierEntry): number | string => {
      switch (sort.key) {
        case 'name':
          return data.champions[e.championId]?.name ?? ''
        case 'tier':
          return TIER_ORDER.indexOf(e.tier) * 1000 - e.score
        case 'rank':
          return role === 'ALL' && !aram ? TIER_ORDER.indexOf(e.tier) * 1000 - e.score : e.rank
        default:
          return -e[sort.key]
      }
    }
    r = [...r].sort((a, b) => {
      const va = val(a)
      const vb = val(b)
      return (typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number)) * sort.dir
    })
    return r
  }, [list, data, role, query, tierFilter, sort, aram])

  const Th = ({ k, children, className = '' }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th
      className={`cursor-pointer px-3 py-3 font-semibold select-none hover:text-text ${className}`}
      onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? ((-s.dir) as 1 | -1) : 1 }))}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sort.key === k && (sort.dir === 1 ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
      </span>
    </th>
  )

  return (
    <div className="fade-in mx-auto max-w-6xl p-8">
      <PageHeader
        title="Tier list"
        subtitle={
          aram
            ? `ARAM (Howling Abyss) · patch ${patch ?? '–'} · also the build source for ARAM: Mayhem`
            : `Ranked Solo/Duo · Master+ · patch ${patch ?? '–'} · based on your crawled matches`
        }
      >
        <input className="input w-56" placeholder="Search champion …" value={query} onChange={(e) => setQuery(e.target.value)} />
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {aram ? <span /> : <RoleTabs value={role} onChange={setRole} />}
        <div className="flex gap-1">
          {TIER_ORDER.map((t) => (
            <button key={t} onClick={() => setTierFilter((cur) => (cur === t ? null : t))} className={tierFilter && tierFilter !== t ? 'opacity-35' : ''}>
              <TierBadge tier={t} size="sm" />
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
              {rows.map((e, i) => {
                const c = data?.champions[e.championId]
                return (
                  <tr
                    key={`${e.championId}:${e.role}`}
                    className="cursor-pointer border-b border-line/50 transition last:border-0 hover:bg-panel-2"
                    onClick={() => navigate(`/champion/${e.championId}/${e.role}`)}
                  >
                    <td className="px-3 py-2 text-center font-semibold text-muted">{sort.key === 'rank' && (role !== 'ALL' || aram) ? e.rank : i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-3">
                        <ChampIcon id={e.championId} size={38} tooltip={false} />
                        <div>
                          <div className="font-semibold">{c?.name}</div>
                          <div className="flex items-center gap-1 text-xs text-muted">
                            <RoleIcon role={e.role} size={12} /> {ROLE_LABELS[e.role]}
                            {e.roleShare < 0.9 && <span className="text-muted/70">· {pct(e.roleShare, 0)} of games</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <TierBadge tier={e.tier} />
                    </td>
                    <td className="px-3 py-2 font-semibold" style={{ color: wrColor(e.winRate) }}>
                      {pct(e.winRate, 2)}
                    </td>
                    <td className="px-3 py-2">
                      <Bar value={e.pickRate} max={0.25} />
                    </td>
                    {!aram && (
                      <td className="px-3 py-2">
                        <Bar value={e.banRate} max={0.4} color="var(--color-loss)" />
                      </td>
                    )}
                    <td className="px-3 py-2 text-right text-muted">{num(e.games)}</td>
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
