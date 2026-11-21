import type { AugmentRarity, ComboType, MayhemAugment, MayhemCombo, MayhemData, StaticData, Tier } from './types'
import { AUGMENT_NOTES, type AugmentFit } from './augmentNotes'

/** Client augment list (cherry-augments.json) as served by CommunityDragon. */
export interface CherryAugment {
  id: number
  augmentNameId: string
  nameTRA: string
  augmentSmallIconPath: string
  rarity: string // kSilver | kGold | kPrismatic
  /** kDamage, kResilience, kSpeed, kAlly, kUtility, kGeneral, kClassicish, … */
  augmentDisplayTags?: string[]
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

/**
 * augment-lists.json. The "KIWI" list is the ARAM: Mayhem augment pool. Since November 2026 there are
 * more "KIWI_…" lists: map skins with their own pool. "KIWI_JADE" belongs to MapSkin_Map12_Jade
 * (game-mode-mutators.json) and holds 44 augments the normal pool doesn't have, among them the
 * "classic" upgrades like Upgrade: Deathfire Grasp or Doran's Biggest Fan.
 */
export interface AugmentList {
  modeName: string
  augmentList: string[]
}

/** The normal Mayhem pool. */
export const MAIN_POOL = 'KIWI'

const nameIdOf = (path: string): string => path.split('/').pop()!.toLowerCase()

/** Every Mayhem pool (KIWI and the map pools), as augment name ids in lower case. */
export function mayhemPools(lists: AugmentList[] | null | undefined): Record<string, Set<string>> {
  const pools: Record<string, Set<string>> = {}
  for (const list of lists ?? []) {
    if (list.modeName === MAIN_POOL || list.modeName.startsWith(MAIN_POOL + '_'))
      pools[list.modeName] = new Set(list.augmentList.map(nameIdOf))
  }
  return pools
}

/**
 * The augment can show up on every map. False for augments only a map skin's pool has (KIWI_JADE);
 * true when the pools aren't known (older data, augment-lists.json missing).
 */
export function inMainPool(augment: Pick<MayhemAugment, 'pools'>): boolean {
  return !augment.pools?.length || augment.pools.includes(MAIN_POOL)
}

/** All augments that can show up in some Mayhem game, whatever the map. */
export function mayhemPool(lists: AugmentList[] | null | undefined): Set<string> {
  return new Set(Object.values(mayhemPools(lists)).flatMap((pool) => [...pool]))
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
  pool?: Set<string>,
  /** the single pools (see mayhemPools), so every augment knows on which maps it can show up */
  pools?: Record<string, Set<string>>
): MayhemData {
  const byName = indexCherry(cherryEn, pool)
  const localName = new Map(cherryLocal.map((augment) => [augment.id, augment.nameTRA]))
  const result: Record<number, MayhemAugment> = {}
  const bySlug = new Map<string, number>()
  const poolsOf = (cherry: CherryAugment): string[] | undefined => {
    if (!pools) return undefined
    const nameId = cherry.augmentNameId.toLowerCase()
    return Object.keys(pools).filter((name) => pools[name].has(nameId))
  }

  const add = (cherry: CherryAugment, slug: string, row?: AmAugmentRow): number => {
    const existing = result[cherry.id]
    if (!existing || row) {
      const inPools = poolsOf(cherry)
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
        url: row?.url ?? existing?.url ?? null,
        tags: (cherry.augmentDisplayTags ?? []).map((tag) => tag.replace(/^k/, '').toLowerCase()),
        ...(inPools?.length ? { pools: inPools } : {})
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
 * Tier of every Mayhem augment for one champion. Riot's policy forbids showing augment win rates, so this
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
// Augment tiers of a finished game
// ---------------------------------------------------------------------------

/** Looks up an augment's tier for a champion; tiers are worked out once per champion and kept. */
export type TierLookup = (championId: number, augmentId: number) => AugmentTier | undefined

export function makeTierLookup(data: MayhemData, statics: StaticData): TierLookup {
  const cache = new Map<number, Map<number, AugmentTier>>()
  return (championId, augmentId) => {
    let tiers = cache.get(championId)
    if (!tiers) {
      tiers = new Map(augmentTiersForChampion(data, statics, championId).map((entry) => [entry.augment.id, entry]))
      cache.set(championId, tiers)
    }
    return tiers.get(augmentId)
  }
}

/**
 * The tier of every augment each player of a game took, for their champion, by puuid. What quips()
 * and the achievements expect; the game page, the main process and the Discord post all use it.
 */
export function summaryAugmentTiers(
  summary: { players: readonly { puuid: string; championId: number; augments: readonly number[] }[] },
  tierOf: TierLookup
): Record<string, (Tier | undefined)[]> {
  return Object.fromEntries(
    summary.players.map((player) => [player.puuid, player.augments.map((id) => tierOf(player.championId, id)?.tier)])
  )
}
