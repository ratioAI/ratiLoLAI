import type { AugmentRarity, ComboType, MayhemAugment, MayhemCombo, MayhemData, StaticData, Tier } from './types'
import { AUGMENT_NOTES, type AugmentFit } from './augmentNotes'

/** Client augment list (cherry-augments.json) as served by CommunityDragon. */
export interface CherryAugment {
  id: number
  augmentNameId: string
  nameTRA: string
  augmentSmallIconPath: string
  rarity: string // kSilver | kGold | kPrismatic
}

/** arammayhem.com open data (CC BY 4.0) */
export interface AmAugmentRow {
  augmentId: string
  name: Record<string, string>
  rarity: string
  pickRate: number | null
  pickRateRank: number | null
  pickRateChange: number | null
  url: string | null
}

export interface AmComboRow {
  championId: string
  augmentIds: string[]
  types: string[]
  url: string
}

/** augment-lists.json – the "KIWI" list is the ARAM: Mayhem augment pool */
export interface AugmentList {
  modeName: string
  augmentList: string[]
}

export function mayhemPool(lists: AugmentList[] | null | undefined): Set<string> {
  const kiwi = lists?.find((l) => l.modeName === 'KIWI')
  return new Set((kiwi?.augmentList ?? []).map((p) => p.split('/').pop()!.toLowerCase()))
}

export interface AmFile<T> {
  meta?: { patch?: string; statsDate?: string }
  rows: T[]
}

export const CDRAGON_GAME_DATA = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/'
export const MAYHEM_ATTRIBUTION = { text: 'Augment data: arammayhem.com (CC BY 4.0)', url: 'https://arammayhem.com/data/' }

export const COMBO_TYPE_LABELS: Record<ComboType, string> = {
  god: 'Top combo',
  strong: 'Strong',
  blackTech: 'Hidden gem',
  entertainment: 'Fun',
  trap: 'Trap',
  bug: 'Bug combo'
}

export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function cdragonIcon(path: string): string {
  return CDRAGON_GAME_DATA + path.replace(/^\/lol-game-data\/assets\//i, '').toLowerCase()
}

function rarityOf(r: string): AugmentRarity {
  const x = r.toLowerCase()
  if (x.includes('prism')) return 'prismatic'
  if (x.includes('gold')) return 'gold'
  return 'silver'
}

/**
 * Arena and Mayhem share many augment names. The Mayhem variants carry an "ARAM_" name id
 * (or a Kiwi icon / id >= 1000) – those are the ids the game writes into Mayhem match data.
 */
function mayhemPreference(a: CherryAugment, pool?: Set<string>): number {
  if (pool?.has(a.augmentNameId.toLowerCase())) return 5
  if (a.augmentNameId.startsWith('ARAM_')) return 3
  if (/\/kiwi\//i.test(a.augmentSmallIconPath)) return 2
  if (a.id >= 1000) return 1
  return 0
}

/** Quest augments are called "Quest: X" on some lists and "X" on others. */
const nameKeys = (name: string): string[] => [...new Set([norm(name), norm(name.replace(/^quest:\s*/i, ''))])]

export function indexCherry(list: CherryAugment[], pool?: Set<string>): Map<string, CherryAugment> {
  const byName = new Map<string, CherryAugment>()
  for (const a of list) {
    for (const k of nameKeys(a.nameTRA)) {
      if (!k) continue
      const cur = byName.get(k)
      if (!cur || mayhemPreference(a, pool) > mayhemPreference(cur, pool)) byName.set(k, a)
    }
  }
  return byName
}

/**
 * Joins the English client augment list (for matching), the localised list (for display)
 * and the arammayhem.com pick-rate data into one lookup table.
 */
export function buildMayhemData(
  cherryEn: CherryAugment[],
  cherryLocal: CherryAugment[],
  augments: AmFile<AmAugmentRow> | null,
  combos: AmFile<AmComboRow> | null,
  fetchedAt = Date.now(),
  pool?: Set<string>
): MayhemData {
  const byName = indexCherry(cherryEn, pool)
  const localName = new Map(cherryLocal.map((a) => [a.id, a.nameTRA]))
  const result: Record<number, MayhemAugment> = {}
  const bySlug = new Map<string, number>()

  const add = (c: CherryAugment, slug: string, row?: AmAugmentRow): number => {
    const existing = result[c.id]
    if (!existing || row) {
      result[c.id] = {
        id: c.id,
        slug,
        name: localName.get(c.id) || c.nameTRA,
        nameEn: c.nameTRA,
        rarity: row ? rarityOf(row.rarity) : rarityOf(c.rarity),
        icon: cdragonIcon(c.augmentSmallIconPath),
        pickRate: row?.pickRate ?? existing?.pickRate ?? null,
        pickRateRank: row?.pickRateRank ?? existing?.pickRateRank ?? null,
        pickRateChange: row?.pickRateChange ?? existing?.pickRateChange ?? null,
        url: row?.url ?? existing?.url ?? null
      }
    }
    bySlug.set(slug, c.id)
    return c.id
  }

  for (const row of augments?.rows ?? []) {
    const c = nameKeys(row.name.en ?? '').map((k) => byName.get(k)).find(Boolean) ?? byName.get(norm(row.augmentId))
    if (c) add(c, row.augmentId, row)
  }
  // every augment of the Mayhem pool, even without pick-rate data
  if (pool?.size) {
    for (const c of cherryEn) if (pool.has(c.augmentNameId.toLowerCase()) && !result[c.id]) add(c, norm(c.nameTRA), undefined)
  }

  const resolveSlug = (slug: string): number | null => {
    if (bySlug.has(slug)) return bySlug.get(slug)!
    const c = nameKeys(slug.replace(/_/g, ' ')).map((k) => byName.get(k)).find(Boolean)
    return c ? add(c, slug) : null
  }

  const comboList: MayhemCombo[] = []
  for (const row of combos?.rows ?? []) {
    const ids = row.augmentIds.map(resolveSlug).filter((id): id is number => id !== null)
    if (!ids.length) continue
    comboList.push({
      championAlias: row.championId,
      augments: ids,
      types: row.types.filter((t): t is ComboType => t in COMBO_TYPE_LABELS),
      url: row.url
    })
  }

  return {
    patch: augments?.meta?.patch ?? null,
    statsDate: augments?.meta?.statsDate ?? null,
    fetchedAt,
    augments: result,
    combos: comboList,
    attribution: MAYHEM_ATTRIBUTION
  }
}

const TYPE_ORDER: ComboType[] = ['god', 'strong', 'blackTech', 'entertainment', 'bug', 'trap']

/** Combos for one champion: single-augment tips first (by rating), then multi-augment builds. */
export function combosForChampion(data: MayhemData, statics: StaticData, championId: number): MayhemCombo[] {
  const champ = statics.champions[championId]
  if (!champ) return []
  const keys = new Set([norm(champ.id), norm(champ.name)])
  const rank = (c: MayhemCombo): number => (c.types.length ? Math.min(...c.types.map((t) => TYPE_ORDER.indexOf(t))) : 50)
  return data.combos.filter((c) => keys.has(norm(c.championAlias))).sort((a, b) => rank(a) - rank(b) || a.augments.length - b.augments.length)
}

/** Most picked augments per rarity (global, all champions). */
export function popularByRarity(data: MayhemData, limit = 8): Record<AugmentRarity, MayhemAugment[]> {
  const all = Object.values(data.augments).filter((a) => a.pickRate != null)
  const pick = (r: AugmentRarity) =>
    all
      .filter((a) => a.rarity === r)
      .sort((a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0))
      .slice(0, limit)
  return { prismatic: pick('prismatic'), gold: pick('gold'), silver: pick('silver') }
}

// ---------------------------------------------------------------------------
// Per-champion augment tiers
// ---------------------------------------------------------------------------

const TIERS: Tier[] = ['S+', 'S', 'A', 'B', 'C', 'D']
const COMBO_TIER: Record<ComboType, Tier> = { god: 'S+', strong: 'S', blackTech: 'A', entertainment: 'B', bug: 'B', trap: 'D' }

export interface AugmentTier {
  augment: MayhemAugment
  tier: Tier
  note: string | null
  source: 'combo' | 'rating'
  combo?: ComboType
  fits: boolean
}

export function championProfile(tags: string[]): Set<AugmentFit> {
  const p = new Set<AugmentFit>()
  const has = (t: string) => tags.includes(t)
  if (has('Mage')) p.add('ap')
  if (has('Marksman')) ['crit', 'onhit', 'ad'].forEach((x) => p.add(x as AugmentFit))
  if (has('Assassin') && !has('Mage')) p.add('ad')
  if (has('Fighter')) ['ad', 'onhit', 'tank'].forEach((x) => p.add(x as AugmentFit))
  if (has('Tank')) p.add('tank')
  if (has('Support')) p.add('sup')
  if (!p.size) p.add('ad')
  return p
}

const shift = (t: Tier, by: number): Tier => TIERS[Math.min(TIERS.length - 1, Math.max(1, TIERS.indexOf(t) + by))]

/**
 * Tier of every Mayhem augment for one champion. Riot asks not to publish Mayhem win rates, so the
 * rating combines (1) curated champion combos, (2) how often players pick the augment within its
 * rarity and (3) whether it fits the champion's archetype. S+ is reserved for curated top combos.
 */
export function augmentTiersForChampion(data: MayhemData, statics: StaticData, championId: number): AugmentTier[] {
  const champ = statics.champions[championId]
  const profile = championProfile(champ?.tags ?? [])
  const combos = combosForChampion(data, statics, championId).filter((c) => c.augments.length === 1 && c.types.length)
  const comboOf = new Map(combos.map((c) => [c.augments[0], c.types[0]]))

  const ranked: Record<AugmentRarity, MayhemAugment[]> = { silver: [], gold: [], prismatic: [] }
  for (const a of Object.values(data.augments)) if (a.pickRate != null) ranked[a.rarity].push(a)
  const percentile = new Map<number, number>()
  for (const list of Object.values(ranked)) {
    list.sort((x, y) => (y.pickRate ?? 0) - (x.pickRate ?? 0))
    list.forEach((a, i) => percentile.set(a.id, (i + 1) / list.length))
  }

  return Object.values(data.augments)
    .map((augment) => {
      const [note, fitTags] = AUGMENT_NOTES[augment.id] ?? [null, ['any'] as AugmentFit[]]
      const fits = fitTags.includes('any') || fitTags.some((f) => profile.has(f))
      const combo = comboOf.get(augment.id)
      if (combo) return { augment, tier: COMBO_TIER[combo], note, source: 'combo' as const, combo, fits }
      const p = percentile.get(augment.id)
      let tier: Tier = p == null ? 'C' : p <= 0.1 ? 'S' : p <= 0.3 ? 'A' : p <= 0.6 ? 'B' : p <= 0.85 ? 'C' : 'D'
      if (!fits) tier = shift(tier, 2)
      else if (!fitTags.includes('any') && TIERS.indexOf(tier) >= 2) tier = shift(tier, -1)
      return { augment, tier, note, source: 'rating' as const, fits }
    })
    .sort(
      (a, b) =>
        TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || (b.augment.pickRate ?? 0) - (a.augment.pickRate ?? 0)
    )
}
