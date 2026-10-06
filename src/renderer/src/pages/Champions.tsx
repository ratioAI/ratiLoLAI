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

  // Per champion, the tier entry with the most games (within the selected role, if any)
  const bestEntry = useMemo(() => {
    const byChampion = new Map<number, TierEntry>()
    for (const entry of tiers ?? []) {
      if (mode === 'ranked' && role !== 'ALL' && entry.role !== role) continue
      const current = byChampion.get(entry.championId)
      if (!current || entry.games > current.games) byChampion.set(entry.championId, entry)
    }
    return byChampion
  }, [tiers, role, mode])

  const champions = useMemo(() => {
    if (!data) return []
    const search = query.trim().toLowerCase()
    return Object.values(data.champions)
      .filter(
        (champion) =>
          (!search || champion.name.toLowerCase().includes(search)) && (mode === 'aram' || role === 'ALL' || bestEntry.has(champion.key))
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [data, query, role, bestEntry, mode])

  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader title="Champions" subtitle={`${champions.length} champions · click for builds, runes & matchups`}>
        <input
          autoFocus
          className="input w-64"
          placeholder="Search champion …"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </PageHeader>
      {mode === 'ranked' && (
        <div className="mb-5">
          <RoleTabs value={role} onChange={setRole} />
        </div>
      )}
      <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3">
        {champions.map((champion) => {
          const entry = bestEntry.get(champion.key)
          return (
            <button
              key={champion.key}
              onClick={() => navigate(`/champion/${champion.key}${entry && role !== 'ALL' ? `/${entry.role}` : ''}`)}
              className="group relative flex flex-col items-center gap-1.5 rounded-xl p-2 transition hover:bg-panel"
            >
              <ChampIcon id={champion.key} size={64} className="transition group-hover:scale-105" tooltip={false} />
              <span className="w-full truncate text-center text-xs font-medium">{champion.name}</span>
              {entry && (
                <span className="absolute top-1 right-2">
                  <TierBadge tier={entry.tier} size="sm" />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
