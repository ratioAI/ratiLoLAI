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

/** augment-lists.json. The "KIWI" list is the ARAM: Mayhem augment pool. */
export interface AugmentList {
  modeName: string
  augmentList: string[]
}

export function mayhemPool(lists: AugmentList[] | null | undefined): Set<string> {
  const kiwi = lists?.find((list) => list.modeName === 'KIWI')
  return new Set((kiwi?.augmentList ?? []).map((path) => path.split('/').pop()!.toLowerCase()))
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

export const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')

export function cdragonIcon(path: string): string {
  return CDRAGON_GAME_DATA + path.replace(/^\/lol-game-data\/assets\//i, '').toLowerCase()
}

function rarityOf(raw: string): AugmentRarity {
  const lower = raw.toLowerCase()
  if (lower.includes('prism')) return 'prismatic'
  if (lower.includes('gold')) return 'gold'
  return 'silver'
}

/**
 * Arena and Mayhem share a lot of augment names. The Mayhem versions have an "ARAM_" name id (or a
 * Kiwi icon, or an id >= 1000), and those are the ids the game writes into Mayhem match data.
 */
function mayhemPreference(augment: CherryAugment, pool?: Set<string>): number {
  if (pool?.has(augment.augmentNameId.toLowerCase())) return 5
  if (augment.augmentNameId.startsWith('ARAM_')) return 3
  if (/\/kiwi\//i.test(augment.augmentSmallIconPath)) return 2
  if (augment.id >= 1000) return 1
  return 0
}

/** Quest augments are called "Quest: X" in some lists and just "X" in others. */
const nameKeys = (name: string): string[] => [...new Set([norm(name), norm(name.replace(/^quest:\s*/i, ''))])]

export function indexCherry(list: CherryAugment[], pool?: Set<string>): Map<string, CherryAugment> {
  const byName = new Map<string, CherryAugment>()
  for (const augment of list) {
    for (const key of nameKeys(augment.nameTRA)) {
      if (!key) continue
      const current = byName.get(key)
      if (!current || mayhemPreference(augment, pool) > mayhemPreference(current, pool)) byName.set(key, augment)
    }
  }
  return byName
}

/**
 * Joins the English client augment list (for matching), the localised list (for display) and the
 * arammayhem.com pick rates into one lookup table.
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
  const localName = new Map(cherryLocal.map((augment) => [augment.id, augment.nameTRA]))
  const result: Record<number, MayhemAugment> = {}
  const bySlug = new Map<string, number>()

  const add = (cherry: CherryAugment, slug: string, row?: AmAugmentRow): number => {
    const existing = result[cherry.id]
    if (!existing || row) {
      result[cherry.id] = {
        id: cherry.id,
        slug,
        name: localName.get(cherry.id) || cherry.nameTRA,
        nameEn: cherry.nameTRA,
        rarity: row ? rarityOf(row.rarity) : rarityOf(cherry.rarity),
        icon: cdragonIcon(cherry.augmentSmallIconPath),
        pickRate: row?.pickRate ?? existing?.pickRate ?? null,
        pickRateRank: row?.pickRateRank ?? existing?.pickRateRank ?? null,
        pickRateChange: row?.pickRateChange ?? existing?.pickRateChange ?? null,
        url: row?.url ?? existing?.url ?? null
      }
    }
    bySlug.set(slug, cherry.id)
    return cherry.id
  }

  for (const row of augments?.rows ?? []) {
    const cherry =
      nameKeys(row.name.en ?? '')
        .map((key) => byName.get(key))
        .find(Boolean) ?? byName.get(norm(row.augmentId))
    if (cherry) add(cherry, row.augmentId, row)
  }
  // add the rest of the Mayhem pool too, even without pick rate data
  if (pool?.size) {
    for (const cherry of cherryEn) {
      if (pool.has(cherry.augmentNameId.toLowerCase()) && !result[cherry.id]) add(cherry, norm(cherry.nameTRA), undefined)
    }
  }

  const resolveSlug = (slug: string): number | null => {
    if (bySlug.has(slug)) return bySlug.get(slug)!
    const cherry = nameKeys(slug.replace(/_/g, ' '))
      .map((key) => byName.get(key))
      .find(Boolean)
    return cherry ? add(cherry, slug) : null
  }

  const comboList: MayhemCombo[] = []
  for (const row of combos?.rows ?? []) {
    const ids = row.augmentIds.map(resolveSlug).filter((id): id is number => id !== null)
    if (!ids.length) continue
    comboList.push({
      championAlias: row.championId,
      augments: ids,
      types: row.types.filter((type): type is ComboType => type in COMBO_TYPE_LABELS),
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
  const rank = (combo: MayhemCombo): number => (combo.types.length ? Math.min(...combo.types.map((type) => TYPE_ORDER.indexOf(type))) : 50)
  return data.combos
    .filter((combo) => keys.has(norm(combo.championAlias)))
    .sort((a, b) => rank(a) - rank(b) || a.augments.length - b.augments.length)
}

/** Most picked augments per rarity, across all champions. */
export function popularByRarity(data: MayhemData, limit = 8): Record<AugmentRarity, MayhemAugment[]> {
  const all = Object.values(data.augments).filter((augment) => augment.pickRate != null)
  const topOf = (rarity: AugmentRarity) =>
    all
      .filter((augment) => augment.rarity === rarity)
      .sort((a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0))
      .slice(0, limit)
  return { prismatic: topOf('prismatic'), gold: topOf('gold'), silver: topOf('silver') }
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
  /** set when this augment forms a combo with augments the player already has */
  synergy?: Synergy
}

export interface Synergy {
  type: ComboType
  /** owned augments that are part of the combo */
  with: number[]
  /** augments still missing after taking this one (empty means the combo is complete) */
  missing: number[]
}

export function championProfile(tags: string[]): Set<AugmentFit> {
  const profile = new Set<AugmentFit>()
  const has = (tag: string) => tags.includes(tag)
  if (has('Mage')) profile.add('ap')
  if (has('Marksman')) ['crit', 'onhit', 'ad'].forEach((fit) => profile.add(fit as AugmentFit))
  if (has('Assassin') && !has('Mage')) profile.add('ad')
  if (has('Fighter')) ['ad', 'onhit', 'tank'].forEach((fit) => profile.add(fit as AugmentFit))
  if (has('Tank')) profile.add('tank')
  if (has('Support')) profile.add('sup')
  if (!profile.size) profile.add('ad')
  return profile
}

// never shifts into S+, that one is kept for curated top combos
const shift = (tier: Tier, by: number): Tier => TIERS[Math.min(TIERS.length - 1, Math.max(1, TIERS.indexOf(tier) + by))]

/**
 * Tier of every Mayhem augment for one champion. Riot asks not to publish Mayhem win rates, so this
 * combines curated champion combos, pick rate within the rarity and whether the augment fits the
 * champion's archetype. S+ is only given to curated top combos.
 */
export function augmentTiersForChampion(data: MayhemData, statics: StaticData, championId: number): AugmentTier[] {
  const champ = statics.champions[championId]
  const profile = championProfile(champ?.tags ?? [])
  const combos = combosForChampion(data, statics, championId).filter((combo) => combo.augments.length === 1 && combo.types.length)
  const comboOf = new Map(combos.map((combo) => [combo.augments[0], combo.types[0]]))

  const ranked: Record<AugmentRarity, MayhemAugment[]> = { silver: [], gold: [], prismatic: [] }
  for (const augment of Object.values(data.augments)) if (augment.pickRate != null) ranked[augment.rarity].push(augment)
  const percentile = new Map<number, number>()
  for (const list of Object.values(ranked)) {
    list.sort((a, b) => (b.pickRate ?? 0) - (a.pickRate ?? 0))
    list.forEach((augment, i) => percentile.set(augment.id, (i + 1) / list.length))
  }

  return Object.values(data.augments)
    .map((augment) => {
      const [note, fitTags] = AUGMENT_NOTES[augment.id] ?? [null, ['any'] as AugmentFit[]]
      const fits = fitTags.includes('any') || fitTags.some((fit) => profile.has(fit))
      const combo = comboOf.get(augment.id)
      if (combo) return { augment, tier: COMBO_TIER[combo], note, source: 'combo' as const, combo, fits }
      const pct = percentile.get(augment.id)
      let tier: Tier = pct == null ? 'C' : pct <= 0.1 ? 'S' : pct <= 0.3 ? 'A' : pct <= 0.6 ? 'B' : pct <= 0.85 ? 'C' : 'D'
      // wrong archetype drops two tiers, a specific fit lifts A and below by one
      if (!fits) tier = shift(tier, 2)
      else if (!fitTags.includes('any') && TIERS.indexOf(tier) >= 2) tier = shift(tier, -1)
      return { augment, tier, note, source: 'rating' as const, fits }
    })
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || (b.augment.pickRate ?? 0) - (a.augment.pickRate ?? 0))
}

// ---------------------------------------------------------------------------
// Combos with augments the player already owns
// ---------------------------------------------------------------------------

/** Best multi-augment combo that `augmentId` forms together with the owned augments. */
export function synergyFor(combos: MayhemCombo[], owned: number[], augmentId: number): Synergy | null {
  if (owned.includes(augmentId)) return null
  let best: Synergy | null = null
  // lower is better: fewer missing pieces first, then combo type, then more owned pieces
  const score = (synergy: Synergy): number => synergy.missing.length * 10 + TYPE_ORDER.indexOf(synergy.type) - synergy.with.length * 0.1
  for (const combo of combos) {
    if (combo.augments.length < 2 || !combo.augments.includes(augmentId)) continue
    const have = combo.augments.filter((id) => owned.includes(id))
    if (!have.length) continue
    const missing = combo.augments.filter((id) => id !== augmentId && !owned.includes(id))
    // multi-augment builds often have no rating, count them as strong
    const type = [...combo.types].sort((a, b) => TYPE_ORDER.indexOf(a) - TYPE_ORDER.indexOf(b))[0] ?? 'strong'
    const candidate: Synergy = { type, with: have, missing }
    // a trap only wins if there is nothing else
    const better =
      !best || (best.type === 'trap' && type !== 'trap') || ((best.type === 'trap') === (type === 'trap') && score(candidate) < score(best))
    if (better) best = candidate
  }
  return best
}

/**
 * Augment tiers for a champion, adjusted for what the player already owns. Completing a combo
 * lifts the augment to at least the combo's tier, being one piece away lifts it one tier, and
 * completing a known trap drops it to D.
 */
export function augmentTiersWithOwned(data: MayhemData, statics: StaticData, championId: number, owned: number[]): AugmentTier[] {
  const base = augmentTiersForChampion(data, statics, championId)
  if (!owned.length) return base
  const combos = combosForChampion(data, statics, championId)
  return base
    .map((entry) => {
      const synergy = synergyFor(combos, owned, entry.augment.id)
      if (!synergy) return entry
      let tier = entry.tier
      if (synergy.type === 'trap') tier = synergy.missing.length ? tier : 'D'
      else if (!synergy.missing.length)
        tier = TIERS.indexOf(COMBO_TIER[synergy.type]) < TIERS.indexOf(tier) ? COMBO_TIER[synergy.type] : tier
      else if (synergy.missing.length === 1) tier = TIERS[Math.max(0, TIERS.indexOf(tier) - 1)]
      return { ...entry, tier, synergy }
    })
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || (b.augment.pickRate ?? 0) - (a.augment.pickRate ?? 0))
}
