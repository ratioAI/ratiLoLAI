import type { StaticData, StaticItem, StaticRune, StaticRuneTree, StaticSpell } from './types'

/** Stat shards aren't in runesReforged.json, so they are hard-coded here. */
export const STAT_SHARDS: StaticRune[] = [
  {
    id: 5008,
    key: 'AdaptiveForce',
    name: 'Adaptive Force',
    icon: 'perk-images/StatMods/StatModsAdaptiveForceIcon.png',
    shortDesc: '+9 Adaptive Force'
  },
  {
    id: 5005,
    key: 'AttackSpeed',
    name: 'Attack Speed',
    icon: 'perk-images/StatMods/StatModsAttackSpeedIcon.png',
    shortDesc: '+10% Attack Speed'
  },
  {
    id: 5007,
    key: 'AbilityHaste',
    name: 'Ability Haste',
    icon: 'perk-images/StatMods/StatModsCDRScalingIcon.png',
    shortDesc: '+8 Ability Haste'
  },
  {
    id: 5010,
    key: 'MoveSpeed',
    name: 'Move Speed',
    icon: 'perk-images/StatMods/StatModsMovementSpeedIcon.png',
    shortDesc: '+2% Move Speed'
  },
  {
    id: 5001,
    key: 'HealthScaling',
    name: 'Health Scaling',
    icon: 'perk-images/StatMods/StatModsHealthPlusIcon.png',
    shortDesc: '+10-180 Health (lvl)'
  },
  { id: 5011, key: 'Health', name: 'Health', icon: 'perk-images/StatMods/StatModsHealthScalingIcon.png', shortDesc: '+65 Health' },
  {
    id: 5013,
    key: 'Tenacity',
    name: 'Tenacity & Slow Resist',
    icon: 'perk-images/StatMods/StatModsTenacityIcon.png',
    shortDesc: '+10% Tenacity and Slow Resist'
  },
  { id: 5002, key: 'Armor', name: 'Armor', icon: 'perk-images/StatMods/StatModsArmorIcon.png', shortDesc: '+6 Armor' },
  { id: 5003, key: 'MagicRes', name: 'Magic Resist', icon: 'perk-images/StatMods/StatModsMagicResIcon.png', shortDesc: '+8 Magic Resist' }
]

export interface RawItem {
  name: string
  description: string
  plaintext: string
  into?: string[]
  from?: string[]
  tags: string[]
  maps: Record<string, boolean>
  gold: { total: number; purchasable: boolean }
  depth?: number
  requiredAlly?: string
  requiredChampion?: string
  consumed?: boolean
}

export function classifyRawItem(id: number, item: RawItem): Omit<StaticItem, 'id' | 'name' | 'description' | 'plaintext'> {
  const tags = item.tags ?? []
  // 1001 is the basic Boots, so anything built from it is a tier 2 boot
  const boots = tags.includes('Boots') && (item.from ?? []).includes('1001')
  const completed =
    !boots &&
    item.gold.purchasable &&
    !item.requiredAlly &&
    !item.requiredChampion &&
    !(item.into && item.into.length) &&
    !tags.includes('Consumable') &&
    !tags.includes('Trinket') &&
    ((item.depth ?? 1) >= 3 || item.gold.total >= 2200)
  const starter = item.gold.purchasable && item.gold.total <= 500 && !tags.includes('Trinket') && id !== 1001
  return { gold: item.gold.total, tags, completed, boots, starter }
}

export interface RawChampion {
  id: string
  key: string
  name: string
  title: string
  tags: string[]
}

export interface RawRuneTree {
  id: number
  key: string
  name: string
  icon: string
  slots: { runes: { id: number; key: string; name: string; icon: string; shortDesc: string }[] }[]
}

export interface RawSpell {
  id: string
  key: string
  name: string
  description: string
  modes: string[]
}

export function buildStaticData(
  version: string,
  language: string,
  champs: Record<string, RawChampion>,
  items: Record<string, RawItem>,
  runes: RawRuneTree[],
  spells: Record<string, RawSpell>
): StaticData {
  const [major, minor] = version.split('.')
  const data: StaticData = {
    version,
    patch: `${major}.${minor}`,
    language,
    champions: {},
    items: {},
    runeTrees: [],
    runes: {},
    spells: {}
  }

  for (const champ of Object.values(champs)) {
    data.champions[Number(champ.key)] = { id: champ.id, key: Number(champ.key), name: champ.name, title: champ.title, tags: champ.tags }
  }

  for (const [idStr, item] of Object.entries(items)) {
    const id = Number(idStr)
    // map 11 is Summoner's Rift
    if (!item.maps?.['11']) continue
    data.items[id] = {
      id,
      name: item.name,
      description: item.description,
      plaintext: item.plaintext,
      ...classifyRawItem(id, item)
    }
  }

  for (const tree of runes) {
    const runeTree: StaticRuneTree = {
      id: tree.id,
      key: tree.key,
      name: tree.name,
      icon: tree.icon,
      slots: tree.slots.map((slot) =>
        slot.runes.map((rune) => ({ id: rune.id, key: rune.key, name: rune.name, icon: rune.icon, shortDesc: stripTags(rune.shortDesc) }))
      )
    }
    data.runeTrees.push(runeTree)
    for (const slot of runeTree.slots) for (const rune of slot) data.runes[rune.id] = rune
  }
  for (const shard of STAT_SHARDS) data.runes[shard.id] = shard

  for (const rawSpell of Object.values(spells)) {
    if (!rawSpell.modes.some((mode) => mode === 'CLASSIC' || mode === 'ARAM')) continue
    const spell: StaticSpell = { id: Number(rawSpell.key), key: rawSpell.id, name: rawSpell.name, description: rawSpell.description }
    data.spells[spell.id] = spell
  }
  return data
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

export const DDRAGON = 'https://ddragon.leagueoflegends.com'

/** Downloads the four Data Dragon files needed by the app and converts them to StaticData. */
export async function loadStaticData(getJson: <T>(path: string) => Promise<T>, version: string, language: string): Promise<StaticData> {
  const base = `/cdn/${version}/data/${language}`
  const [champs, items, runes, spells] = await Promise.all([
    getJson<{ data: Record<string, RawChampion> }>(`${base}/champion.json`),
    getJson<{ data: Record<string, RawItem> }>(`${base}/item.json`),
    getJson<RawRuneTree[]>(`${base}/runesReforged.json`),
    getJson<{ data: Record<string, RawSpell> }>(`${base}/summoner.json`)
  ])
  return buildStaticData(version, language, champs.data, items.data, runes, spells.data)
}

const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Numeric champion key of the local player in a live game. Tries the Data Dragon id first (from
 * rawChampionName, same in every language), then the localized display name.
 */
export function liveChampionKey(
  statics: StaticData | null | undefined,
  live: { activeChampion: string | null; activeChampionKey?: string | null } | null | undefined
): number {
  if (!statics || !live) return 0
  const champs = Object.values(statics.champions)
  const byId = live.activeChampionKey && champs.find((champ) => norm(champ.id) === norm(live.activeChampionKey!))
  if (byId) return byId.key
  const name = live.activeChampion
  if (!name) return 0
  return (
    champs.find((champ) => champ.name === name || champ.id === name || norm(champ.name) === norm(name) || norm(champ.id) === norm(name))
      ?.key ?? 0
  )
}
