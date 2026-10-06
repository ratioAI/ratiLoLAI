import type { ChampionBuild, ChampSelectPlayer, ChampSelectState, Platform, Role, StaticData } from '@shared/types'
import { ROLE_LABELS, selectModeOfQueue } from '@shared/types'

const POSITION_TO_ROLE: Record<string, Role> = {
  top: 'TOP',
  jungle: 'JUNGLE',
  middle: 'MIDDLE',
  mid: 'MIDDLE',
  bottom: 'BOTTOM',
  utility: 'UTILITY',
  support: 'UTILITY'
}

export function positionToRole(position: string | undefined | null): Role | null {
  return (position && POSITION_TO_ROLE[position.toLowerCase()]) || null
}

const REGION_TO_PLATFORM: Record<string, Platform> = {
  EUW: 'euw1',
  EUW1: 'euw1',
  EUNE: 'eun1',
  EUN1: 'eun1',
  NA: 'na1',
  NA1: 'na1',
  KR: 'kr',
  BR: 'br1',
  BR1: 'br1',
  LA1: 'la1',
  LAN: 'la1',
  LA2: 'la2',
  LAS: 'la2',
  OC1: 'oc1',
  OCE: 'oc1',
  TR: 'tr1',
  TR1: 'tr1',
  RU: 'ru',
  JP: 'jp1',
  JP1: 'jp1',
  SG2: 'sg2',
  PH2: 'sg2',
  SG: 'sg2',
  PH: 'sg2',
  TH: 'sg2',
  TW: 'tw2',
  TW2: 'tw2',
  VN: 'vn2',
  VN2: 'vn2',
  ME1: 'me1'
}

export function regionToPlatform(region: string | undefined): Platform | null {
  return (region && REGION_TO_PLATFORM[region.toUpperCase()]) || null
}

interface RawCell {
  cellId: number
  championId: number
  championPickIntent?: number
  assignedPosition?: string
  spell1Id?: number
  spell2Id?: number
}

interface RawAction {
  actorCellId: number
  championId: number
  completed: boolean
  type: string
}

export interface RawSession {
  localPlayerCellId: number
  myTeam: RawCell[]
  theirTeam: RawCell[]
  actions: RawAction[][]
}

export function parseChampSelect(
  session: RawSession | null | undefined,
  queueId: number | null = null,
  gameMode: string | null = null
): ChampSelectState | null {
  if (!session || !Array.isArray(session.myTeam)) return null
  const actions = (session.actions ?? []).flat()
  // championPickIntent is the hovered champion before lock-in
  const toPlayer = (cell: RawCell, team: 'ally' | 'enemy'): ChampSelectPlayer => ({
    cellId: cell.cellId,
    championId: cell.championId || cell.championPickIntent || 0,
    role: positionToRole(cell.assignedPosition),
    isLocal: team === 'ally' && cell.cellId === session.localPlayerCellId,
    team,
    spell1Id: cell.spell1Id ?? 0,
    spell2Id: cell.spell2Id ?? 0
  })
  const allies = session.myTeam.map((cell) => toPlayer(cell, 'ally'))
  const enemies = (session.theirTeam ?? []).map((cell) => toPlayer(cell, 'enemy'))
  const localPlayer = allies.find((player) => player.isLocal)
  const locked = actions.some(
    (action) => action.type === 'pick' && action.actorCellId === session.localPlayerCellId && action.completed && action.championId > 0
  )
  const bans = actions
    .filter((action) => action.type === 'ban' && action.completed && action.championId > 0)
    .map((action) => action.championId)
  return {
    active: true,
    queueId,
    mode: selectModeOfQueue(queueId, gameMode),
    myChampionId: localPlayer?.championId ?? 0,
    myRole: localPlayer?.role ?? null,
    locked,
    allies,
    enemies,
    bans
  }
}

// Payloads for importing a build into the client

export const RUNE_PAGE_PREFIX = 'ratioAI: '
/** Prefixes used by versions before the rename, so we still recognise (and replace) those pages. */
export const LEGACY_RUNE_PAGE_PREFIXES = ['RC: ']
export const isOurRunePage = (name: string): boolean =>
  [RUNE_PAGE_PREFIX, ...LEGACY_RUNE_PAGE_PREFIXES].some((prefix) => name.startsWith(prefix))
export const ITEM_SET_UID_PREFIX = 'rift-companion-'
const FLASH = 4

export function buildRunePagePayload(build: ChampionBuild, championName: string) {
  const page = build.runes[0]?.value
  if (!page) return null
  return {
    name: `${RUNE_PAGE_PREFIX}${championName} ${ROLE_LABELS[build.role]}`.slice(0, 25),
    primaryStyleId: page.primaryStyle,
    subStyleId: page.subStyle,
    selectedPerkIds: [...page.primary, ...page.secondary, ...page.shards],
    current: true
  }
}

/** Returns [spell1Id (D), spell2Id (F)], putting Flash on the preferred key. */
export function orderSpells(spells: number[], flashOn: 'D' | 'F'): [number, number] | null {
  if (spells.length !== 2) return null
  const [first, second] = spells
  if (first !== FLASH && second !== FLASH) return [first, second]
  const other = first === FLASH ? second : first
  return flashOn === 'D' ? [FLASH, other] : [other, FLASH]
}

const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`

export function buildItemSet(build: ChampionBuild, data: StaticData) {
  const champion = data.champions[build.championId]
  const blocks: { type: string; items: { id: string; count: number }[] }[] = []
  // duplicate ids become one entry with a count (e.g. 2x Doran's Ring)
  const addBlock = (type: string, ids: number[]) => {
    const counted = new Map<number, number>()
    for (const id of ids) counted.set(id, (counted.get(id) ?? 0) + 1)
    const items = [...counted.entries()].map(([id, count]) => ({ id: String(id), count }))
    if (items.length) blocks.push({ type, items })
  }

  build.starters
    .slice(0, 2)
    .forEach((starter, i) => addBlock(`${i ? 'Alternative start' : 'Starting items'} (${pct(starter.winRate)} WR)`, starter.value))
  if (build.core[0]) addBlock(`Core build (${pct(build.core[0].winRate)} WR, ${build.core[0].g} games)`, build.core[0].value)
  addBlock(
    'Boots',
    build.boots.slice(0, 2).map((option) => option.value)
  )
  // skip anything already in the core build and keep the first occurrence of each item
  const seen = new Set(build.core[0]?.value ?? [])
  const late = build.late
    .flat()
    .map((option) => option.value)
    .filter((id) => !seen.has(id) && (seen.add(id), true))
  addBlock('Situational', late.slice(0, 8))
  if (build.core.length > 1) addBlock('Alternative core builds', [...new Set(build.core.slice(1, 4).flatMap((core) => core.value))])
  addBlock('Consumables & trinkets', build.mode === 'aram' ? [2003] : [2003, 2055, 3340, 3364])

  return {
    title: `ratioAI ${champion?.name ?? build.championId} ${ROLE_LABELS[build.role]} ${build.patch}`,
    uid: `${ITEM_SET_UID_PREFIX}${build.mode === 'aram' ? 'aram-' : ''}${build.championId}`,
    type: 'custom',
    map: build.mode === 'aram' ? 'HA' : 'SR',
    mode: 'any',
    associatedChampions: [build.championId],
    // map 11 is Summoner's Rift, 12 is Howling Abyss
    associatedMaps: build.mode === 'aram' ? [12] : [11],
    blocks,
    sortrank: 0,
    startedFrom: 'blank',
    preferredItemSlots: []
  }
}
