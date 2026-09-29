import { useEffect, useState } from 'react'
import type { Tier } from '@shared/types'
import { Check, ExternalLink, Sparkles, TriangleAlert } from 'lucide-react'
import type { AugmentRarity, ComboType, MayhemAugment, MayhemData } from '@shared/types'
import { augmentTiersWithOwned, COMBO_TYPE_LABELS, combosForChampion } from '@shared/mayhem'
import { AugmentFrame } from './AugmentFrame'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { GameImage } from './icons'

export const RARITY_COLORS: Record<AugmentRarity, string> = {
  silver: '#b8c4d6',
  gold: '#f5c451',
  prismatic: '#c07bff'
}
export const RARITY_LABELS: Record<AugmentRarity, string> = { silver: 'Silver', gold: 'Gold', prismatic: 'Prismatic' }

export const COMBO_COLORS: Record<ComboType, string> = {
  god: 'var(--color-tier-splus)',
  strong: 'var(--color-tier-s)',
  blackTech: 'var(--color-accent)',
  entertainment: 'var(--color-tier-c)',
  bug: 'var(--color-tier-a)',
  trap: 'var(--color-loss)'
}

let cache: Promise<MayhemData> | null = null

/** Augments picked in the running Mayhem game (recognised from the in-game augment choice). */
export function useOwnedAugments(): number[] {
  const [owned, setOwned] = useState<number[]>([])
  useEffect(() => {
    let alive = true
    void api
      .getOwnedAugments()
      .then((ids) => alive && setOwned(ids))
      .catch(() => undefined)
    const off = api.on('augmentsOwned', setOwned)
    return () => {
      alive = false
      off()
    }
  }, [])
  return owned
}

export function useMayhemData(): { data: MayhemData | null; error: string | null } {
  const [state, setState] = useState<{ data: MayhemData | null; error: string | null }>({ data: null, error: null })
  useEffect(() => {
    let alive = true
    cache ??= api.getMayhemData().catch((e) => {
      cache = null
      throw e
    })
    cache.then(
      (data) => alive && setState({ data, error: null }),
      (e: Error) => alive && setState({ data: null, error: e.message })
    )
    return () => {
      alive = false
    }
  }, [])
  return state
}

export function AugmentIcon({ augment, size = 40 }: { augment: MayhemAugment | undefined; size?: number }) {
  if (!augment) return <span className="inline-block rounded-lg bg-panel-2" style={{ width: size, height: size }} />
  const color = RARITY_COLORS[augment.rarity]
  return (
    <span className="inline-flex rounded-lg p-[2px]" style={{ background: `color-mix(in srgb, ${color} 55%, transparent)` }}>
      <GameImage
        src={augment.icon}
        size={size - 4}
        alt={augment.name}
        rounded="rounded-md"
        className="bg-bg"
        tooltip={
          <span className="block">
            <b style={{ color }}>{augment.name}</b>
            <span className="block text-muted">
              {RARITY_LABELS[augment.rarity]}
              {augment.pickRate != null && ` · ${augment.pickRate.toFixed(1)}% pick rate (#${augment.pickRateRank})`}
            </span>
          </span>
        }
      />
    </span>
  )
}

export function Attribution({ data }: { data: MayhemData }) {
  return (
    <button
      onClick={() => api.openExternal(data.attribution.url)}
      className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-accent"
    >
      {data.attribution.text}
      {data.patch && ` · Patch ${data.patch}`} <ExternalLink size={11} />
    </button>
  )
}

/** Augment recommendations for one champion – shown in champion select, in game and on the champion page. */
export function MayhemChampionPanel({
  championId,
  compact = false,
  owned = []
}: {
  championId: number
  compact?: boolean
  /** augments already picked this game: combos with them are shown first, tiers adjusted */
  owned?: number[]
}) {
  const { data: statics } = useApp()
  const { data, error } = useMayhemData()
  const [rarityFilter, setRarityFilter] = useState<AugmentRarity | null>(null)
  if (error) return <p className="text-sm text-loss">{error}</p>
  if (!data || !statics) return <p className="text-sm text-muted">Loading augment data …</p>

  const combos = combosForChampion(data, statics, championId)
  const tips = combos.filter((c) => c.types.length && c.augments.length === 1)
  const has = (c: { augments: number[] }) => c.augments.filter((a) => owned.includes(a)).length
  const builds = combos
    .filter((c) => c.augments.length > 1)
    .map((c, i) => ({ c, i, have: has(c), missing: c.augments.length - has(c) }))
    // with owned augments: combos you are already building first, the closest ones on top
    .sort((a, b) => (owned.length ? Number(b.have > 0) - Number(a.have > 0) || a.missing - b.missing : 0) || a.i - b.i)
    .slice(0, compact ? 4 : 6)
  const tiers = augmentTiersWithOwned(data, statics, championId, owned).filter((t) => !owned.includes(t.augment.id))
  const shownTiers: Tier[] = compact ? ['S+', 'S', 'A'] : ['S+', 'S', 'A', 'B']

  return (
    <div className="space-y-5">
      {tips.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold text-muted">Augment tips for {statics.champions[championId]?.name}</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {tips.map((c, i) => {
              const a = data.augments[c.augments[0]]
              const t = c.types[0]
              return (
                <div key={i} className="flex items-center gap-3 rounded-xl bg-bg-2 p-2">
                  <AugmentIcon augment={a} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{a?.name}</div>
                    <div className="flex items-center gap-1 text-xs font-bold" style={{ color: COMBO_COLORS[t] }}>
                      {t === 'trap' && <TriangleAlert size={12} />}
                      {COMBO_TYPE_LABELS[t]}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {builds.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold text-muted">
            {owned.length ? 'Combos with your augments' : 'Proven augment combinations'}
          </h3>
          <div className="space-y-2">
            {builds.map(({ c, have, missing }, i) => (
              <button
                key={i}
                onClick={() => api.openExternal(c.url)}
                className={`flex w-full items-center gap-1.5 rounded-xl p-2 text-left hover:bg-panel-2 ${
                  have ? 'bg-accent/10 ring-1 ring-accent/40' : 'bg-bg-2'
                }`}
                title="Details on arammayhem.com"
              >
                {c.augments.map((id) => {
                  const mine = owned.includes(id)
                  return (
                    <span key={id} className={`relative ${owned.length > 0 && !mine ? 'opacity-60' : ''}`}>
                      <AugmentIcon augment={data.augments[id]} size={34} />
                      {mine && (
                        <span className="absolute -right-1 -bottom-1 rounded-full bg-win p-0.5 text-black">
                          <Check size={9} strokeWidth={4} />
                        </span>
                      )}
                    </span>
                  )
                })}
                <span className="ml-auto flex flex-col items-end gap-0.5">
                  {c.types.map((t) => (
                    <span key={t} className="text-xs font-bold" style={{ color: COMBO_COLORS[t] }}>
                      {COMBO_TYPE_LABELS[t]}
                    </span>
                  ))}
                  {have > 0 && (
                    <span className="text-[10px] font-semibold whitespace-nowrap text-accent">
                      {missing === 0 ? 'Complete!' : `${missing} to go`}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!tips.length && !builds.length && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Sparkles size={15} /> No curated combos for this champion yet – tiers below use pick rate and champion fit.
        </p>
      )}

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-muted">Augment tiers for {statics.champions[championId]?.name}</h3>
          <div className="flex gap-1">
            {(['prismatic', 'gold', 'silver'] as AugmentRarity[]).map((r) => (
              <button
                key={r}
                onClick={() => setRarityFilter((cur) => (cur === r ? null : r))}
                className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${rarityFilter && rarityFilter !== r ? 'opacity-40' : ''}`}
                style={{ color: RARITY_COLORS[r], borderColor: `color-mix(in srgb, ${RARITY_COLORS[r]} 40%, transparent)` }}
              >
                {RARITY_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-6 pt-3 pb-2">
          {tiers
            .filter((t) => shownTiers.includes(t.tier) && (!rarityFilter || t.augment.rarity === rarityFilter))
            .map((t) => (
              <AugmentFrame
                key={t.augment.id}
                augment={t.augment}
                tier={t.tier}
                size={compact ? 38 : 44}
                note={
                  t.synergy
                    ? `${t.synergy.type === 'trap' ? 'Trap' : t.synergy.missing.length ? 'Builds a combo' : 'Completes a combo'} with ${t.synergy.with.map((id) => data.augments[id]?.name).join(' + ')}`
                    : t.note
                }
              />
            ))}
        </div>
      </div>
      <Attribution data={data} />
    </div>
  )
}
