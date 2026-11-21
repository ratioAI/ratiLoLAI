import { useEffect, useState } from 'react'
import type { Tier } from '@shared/types'
import { ChevronDown, ExternalLink, Sparkles, TriangleAlert } from 'lucide-react'
import type { AugmentRarity, ComboType, MayhemAugment, MayhemData } from '@shared/types'
import { augmentTiersForChampion, COMBO_TYPE_LABELS, combosForChampion, inMainPool } from '@shared/mayhem'
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

// shared by every useMayhemData() caller so the data is fetched only once
let mayhemCache: Promise<MayhemData> | null = null

/** Ids of the augments picked so far in the current Mayhem game, detected from the in-game augment screen. */
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
    // drop a failed request from the cache so the next mount tries again
    mayhemCache ??= api.getMayhemData().catch((err) => {
      mayhemCache = null
      throw err
    })
    mayhemCache.then(
      (data) => alive && setState({ data, error: null }),
      (err: Error) => alive && setState({ data: null, error: err.message })
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
              {augment.pickRate != null && ` · ${augment.pickRate.toFixed(1)} % pick rate (#${augment.pickRateRank})`}
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

/**
 * Augment tips for one champion: curated tips, proven combinations and the champion's tier list.
 * Used in champ select, in game and on the champion page – always the same static data, nothing in
 * it changes with the running game.
 */
export function MayhemChampionPanel({ championId, compact = false }: { championId: number; compact?: boolean }) {
  const { data: staticData } = useApp()
  const { data, error } = useMayhemData()
  const [rarityFilter, setRarityFilter] = useState<AugmentRarity | null>(null)
  // in compact mode (Live page) the long tier grid starts collapsed
  const [tiersOpen, setTiersOpen] = useState(!compact)
  if (error) return <p className="text-sm text-loss">{error}</p>
  if (!data || !staticData) return <p className="text-sm text-muted">Loading augment data …</p>

  const combos = combosForChampion(data, staticData, championId)
  // single-augment "combos" are really tips about one augment
  const tips = combos.filter((combo) => combo.types.length && combo.augments.length === 1)
  const builds = combos.filter((combo) => combo.augments.length > 1).slice(0, compact ? 4 : 6)
  // augments only one map skin offers (Jade map) get their frame in the overlay when that map is played
  const tiers = augmentTiersForChampion(data, staticData, championId).filter((rating) => inMainPool(rating.augment))
  const shownTiers: Tier[] = compact ? ['S+', 'S', 'A'] : ['S+', 'S', 'A', 'B']

  return (
    <div className="space-y-5">
      {tips.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold text-muted">Augment tips for {staticData.champions[championId]?.name}</h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {tips.map((combo, i) => {
              const augment = data.augments[combo.augments[0]]
              const type = combo.types[0]
              return (
                <div key={i} className="flex items-center gap-3 rounded-xl bg-bg-2 p-2">
                  <AugmentIcon augment={augment} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{augment?.name}</div>
                    <div className="flex items-center gap-1 text-xs font-bold" style={{ color: COMBO_COLORS[type] }}>
                      {type === 'trap' && <TriangleAlert size={12} />}
                      {COMBO_TYPE_LABELS[type]}
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
          <h3 className="mb-2 text-xs font-semibold text-muted">Proven augment combinations</h3>
          <div className="space-y-2">
            {builds.map((combo, i) => (
              <button
                key={i}
                onClick={() => api.openExternal(combo.url)}
                className="flex w-full items-center gap-1.5 rounded-xl bg-bg-2 p-2 text-left hover:bg-panel-2"
                title="Details on arammayhem.com"
              >
                {combo.augments.map((id) => (
                  <span key={id} className="relative">
                    <AugmentIcon augment={data.augments[id]} size={34} />
                  </span>
                ))}
                <span className="ml-auto flex flex-col items-end gap-0.5">
                  {combo.types.map((type) => (
                    <span key={type} className="text-xs font-bold" style={{ color: COMBO_COLORS[type] }}>
                      {COMBO_TYPE_LABELS[type]}
                    </span>
                  ))}
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
          <button
            onClick={() => setTiersOpen((open) => !open)}
            className="flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-text"
            aria-expanded={tiersOpen}
          >
            <ChevronDown size={14} className={`transition-transform ${tiersOpen ? '' : '-rotate-90'}`} />
            Augment tiers for {staticData.champions[championId]?.name}
          </button>
          <div className={`flex gap-1 ${tiersOpen ? '' : 'hidden'}`}>
            {(['prismatic', 'gold', 'silver'] as AugmentRarity[]).map((rarity) => (
              <button
                key={rarity}
                onClick={() => setRarityFilter((current) => (current === rarity ? null : rarity))}
                className={`rounded-md border px-2 py-0.5 text-[10px] font-bold ${rarityFilter && rarityFilter !== rarity ? 'opacity-40' : ''}`}
                style={{ color: RARITY_COLORS[rarity], borderColor: `color-mix(in srgb, ${RARITY_COLORS[rarity]} 40%, transparent)` }}
              >
                {RARITY_LABELS[rarity]}
              </button>
            ))}
          </div>
        </div>
        <div className={`flex flex-wrap gap-x-3 gap-y-6 pt-3 pb-2 ${tiersOpen ? '' : 'hidden'}`}>
          {tiers
            .filter((rating) => shownTiers.includes(rating.tier) && (!rarityFilter || rating.augment.rarity === rarityFilter))
            .map((rating) => (
              <AugmentFrame
                key={rating.augment.id}
                augment={rating.augment}
                tier={rating.tier}
                size={compact ? 38 : 44}
                note={rating.note}
              />
            ))}
        </div>
      </div>
      <Attribution data={data} />
    </div>
  )
}
