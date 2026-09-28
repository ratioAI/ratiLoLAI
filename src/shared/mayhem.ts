import type { AugmentRarity, ComboType, MayhemAugment, MayhemCombo, MayhemData, StaticData } from './types'

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

export interface AmFile<T> {
  meta?: { patch?: string; statsDate?: string }
  rows: T[]
}

export const CDRAGON_GAME_DATA = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/'
export const MAYHEM_ATTRIBUTION = { text: 'Augment-Daten: arammayhem.com (CC BY 4.0)', url: 'https://arammayhem.com/data/' }

export const COMBO_TYPE_LABELS: Record<ComboType, string> = {
  god: 'Top-Kombo',
  strong: 'Stark',
  blackTech: 'Geheimtipp',
  entertainment: 'Fun',
  trap: 'Falle',
  bug: 'Bug-Kombo'
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
function mayhemPreference(a: CherryAugment): number {
  if (a.augmentNameId.startsWith('ARAM_')) return 3
  if (/\/kiwi\//i.test(a.augmentSmallIconPath)) return 2
  if (a.id >= 1000) return 1
  return 0
}

export function indexCherry(list: CherryAugment[]): Map<string, CherryAugment> {
  const byName = new Map<string, CherryAugment>()
  for (const a of list) {
    const k = norm(a.nameTRA)
    if (!k) continue
    const cur = byName.get(k)
    if (!cur || mayhemPreference(a) > mayhemPreference(cur)) byName.set(k, a)
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
  fetchedAt = Date.now()
): MayhemData {
  const byName = indexCherry(cherryEn)
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
    const c = byName.get(norm(row.name.en ?? '')) ?? byName.get(norm(row.augmentId))
    if (c) add(c, row.augmentId, row)
  }

  const resolveSlug = (slug: string): number | null => {
    if (bySlug.has(slug)) return bySlug.get(slug)!
    const c = byName.get(norm(slug))
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
