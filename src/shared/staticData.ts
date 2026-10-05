import type { StaticData, StaticItem, StaticRune, StaticRuneTree, StaticSpell } from './types'

/** Stat shards are not part of runesReforged.json – they are hard-coded here. */
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

export function classifyRawItem(id: number, it: RawItem): Omit<StaticItem, 'id' | 'name' | 'description' | 'plaintext'> {
  const tags = it.tags ?? []
  const boots = tags.includes('Boots') && (it.from ?? []).includes('1001')
  const completed =
    !boots &&
    it.gold.purchasable &&
    !it.requiredAlly &&
    !it.requiredChampion &&
    !(it.into && it.into.length) &&
    !tags.includes('Consumable') &&
    !tags.includes('Trinket') &&
    ((it.depth ?? 1) >= 3 || it.gold.total >= 2200)
  const starter = it.gold.purchasable && it.gold.total <= 500 && !tags.includes('Trinket') && id !== 1001
  return { gold: it.gold.total, tags, completed, boots, starter }
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

  for (const c of Object.values(champs)) {
    data.champions[Number(c.key)] = { id: c.id, key: Number(c.key), name: c.name, title: c.title, tags: c.tags }
  }

  for (const [idStr, it] of Object.entries(items)) {
    const id = Number(idStr)
    if (!it.maps?.['11']) continue
    data.items[id] = {
      id,
      name: it.name,
      description: it.description,
      plaintext: it.plaintext,
      ...classifyRawItem(id, it)
    }
  }

  for (const tree of runes) {
    const t: StaticRuneTree = {
      id: tree.id,
      key: tree.key,
      name: tree.name,
      icon: tree.icon,
      slots: tree.slots.map((s) =>
        s.runes.map((r) => ({ id: r.id, key: r.key, name: r.name, icon: r.icon, shortDesc: stripTags(r.shortDesc) }))
      )
    }
    data.runeTrees.push(t)
    for (const slot of t.slots) for (const r of slot) data.runes[r.id] = r
  }
  for (const shard of STAT_SHARDS) data.runes[shard.id] = shard

  for (const s of Object.values(spells)) {
    if (!s.modes.some((m) => m === 'CLASSIC' || m === 'ARAM')) continue
    const spell: StaticSpell = { id: Number(s.key), key: s.id, name: s.name, description: s.description }
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

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Numeric champion key of the local player in a live game. Prefers the language-independent
 * Data Dragon id (from rawChampionName), then the (localized) display name.
 */
export function liveChampionKey(
  statics: StaticData | null | undefined,
  live: { activeChampion: string | null; activeChampionKey?: string | null } | null | undefined
): number {
  if (!statics || !live) return 0
  const champs = Object.values(statics.champions)
  const byId = live.activeChampionKey && champs.find((c) => norm(c.id) === norm(live.activeChampionKey!))
  if (byId) return byId.key
  const name = live.activeChampion
  if (!name) return 0
  return champs.find((c) => c.name === name || c.id === name || norm(c.name) === norm(name) || norm(c.id) === norm(name))?.key ?? 0
}
