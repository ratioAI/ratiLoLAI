import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Role, TierEntry } from '@shared/types'
import { api } from '@/lib/api'
import { useApp, useAsync } from '@/lib/store'
import { ChampIcon, TierBadge } from '@/components/icons'
import { PageHeader } from '@/components/Layout'
import { RoleTabs } from './TierList'

export function Champions() {
  const { data, patch, statsVersion, mode } = useApp()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<Role | 'ALL'>('ALL')
  const { value: tiers } = useAsync(() => (patch ? api.getTierList(patch, mode) : Promise.resolve([])), [patch, statsVersion, mode])

  const best = useMemo(() => {
    const m = new Map<number, TierEntry>()
    for (const t of tiers ?? []) {
      if (mode === 'ranked' && role !== 'ALL' && t.role !== role) continue
      const cur = m.get(t.championId)
      if (!cur || t.games > cur.games) m.set(t.championId, t)
    }
    return m
  }, [tiers, role, mode])

  const champs = useMemo(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    return Object.values(data.champions)
      .filter((c) => (!q || c.name.toLowerCase().includes(q)) && (mode === 'aram' || role === 'ALL' || best.has(c.key)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [data, query, role, best, mode])

  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader title="Champions" subtitle={`${champs.length} champions · click for builds, runes & matchups`}>
        <input autoFocus className="input w-64" placeholder="Search champion …" value={query} onChange={(e) => setQuery(e.target.value)} />
      </PageHeader>
      {mode === 'ranked' && (
        <div className="mb-5">
          <RoleTabs value={role} onChange={setRole} />
        </div>
      )}
      <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3">
        {champs.map((c) => {
          const t = best.get(c.key)
          return (
            <button
              key={c.key}
              onClick={() => navigate(`/champion/${c.key}${t && role !== 'ALL' ? `/${t.role}` : ''}`)}
              className="group relative flex flex-col items-center gap-1.5 rounded-xl p-2 transition hover:bg-panel"
            >
              <ChampIcon id={c.key} size={64} className="transition group-hover:scale-105" tooltip={false} />
              <span className="w-full truncate text-center text-xs font-medium">{c.name}</span>
              {t && (
                <span className="absolute top-1 right-2">
                  <TierBadge tier={t.tier} size="sm" />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
