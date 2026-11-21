/**
 * What is known about the running ARAM: Mayhem game, for the augment scanner: the map skin and its
 * augment pool, the game's Headliner (since patch 26.21, read off the cards and levels) and which
 * card of the open selection was rerolled. It decides which augments the scanner accepts and at
 * which levels a selection comes – it does not rate anything.
 *
 * Pure functions only; the main process feeds in what the client and the scanner see.
 */
import type { MayhemAugment, MayhemData } from './types'
import { MAIN_POOL, norm } from './mayhem'

/** Map skins of ARAM's map 12 (game-mode-mutators.json, November 2026). No mutator = Howling Abyss. */
export const MAP_SKINS: Record<string, string> = {
  MapSkin_Map12_Bloom: "Koeshin's Crossing",
  MapSkin_HA_Bilgewater: "Butcher's Bridge",
  MapSkin_HA_Crepe: 'Bridge of Progress',
  // the client itself only calls it "SR?" so far; it has its own augment pool (KIWI_JADE)
  MapSkin_Map12_Jade: 'Jade map'
}

export function mapSkinName(mutator: string | null): string {
  if (!mutator) return 'Howling Abyss'
  return MAP_SKINS[mutator] ?? mutator.replace(/^MapSkin_(Map12_|HA_)?/, '')
}

/** Every pool the Mayhem data knows (KIWI plus map pools such as KIWI_JADE). */
export function knownPools(data: MayhemData): Set<string> {
  const pools = new Set<string>()
  for (const augment of Object.values(data.augments)) for (const pool of augment.pools ?? []) pools.add(pool)
  return pools
}

/** The augment pool of a map skin: KIWI_<last part of the mutator> if the client has one, else KIWI. */
export function poolForMapSkin(mutator: string | null, data: MayhemData): string {
  if (!mutator) return MAIN_POOL
  const pool = `${MAIN_POOL}_${mutator.split('_').pop()!.toUpperCase()}`
  return knownPools(data).has(pool) ? pool : MAIN_POOL
}

/** Name of the map a pool belongs to ("KIWI_JADE" → "Jade map"). */
export function poolMapName(pool: string): string {
  if (pool === MAIN_POOL) return 'every map'
  const suffix = pool.slice(MAIN_POOL.length + 1).toLowerCase()
  const mutator = Object.keys(MAP_SKINS).find((key) => key.split('_').pop()!.toLowerCase() === suffix)
  return mutator ? MAP_SKINS[mutator] : `${suffix} map`
}

/** One "band" per game since patch 26.21 (26.23 added Bit Rush, Debonair, La Ilusión and Maestro). */
export type Headliner =
  | 'kda'
  | 'trueDamage'
  | 'heartsteel'
  | 'pentakill'
  | 'cafeCuties'
  | 'commandLine'
  | 'spaceGroove'
  | 'beeBand'
  | 'bitRush'
  | 'debonair'
  | 'laIlusion'
  | 'maestro'
  | 'superfans'

export const HEADLINERS: Record<Headliner, { name: string; effect: string }> = {
  kda: { name: 'K/DA', effect: 'four photocards give an extra augment' },
  trueDamage: { name: 'True Damage', effect: 'takedowns and turrets drop stat anvils' },
  heartsteel: { name: 'HEARTSTEEL', effect: 'stickers on some cards add a bonus' },
  pentakill: { name: 'Pentakill', effect: 'HEAVY / POWER / THRASH at the start, DOOM at level 18' },
  cafeCuties: { name: 'Cafe Cuties', effect: 'stronger health relics' },
  commandLine: { name: 'Command Line', effect: 'a hacked reroll raises the rarity' },
  spaceGroove: { name: 'Space Groove', effect: 'disco ball gold' },
  beeBand: { name: 'The Bee Band', effect: 'bees and honey' },
  bitRush: { name: 'Bit Rush', effect: 'four tokens revive you' },
  debonair: { name: 'Debonair', effect: 'every card also gives gold' },
  laIlusion: { name: 'La Ilusión', effect: 'fallen allies leave shielding candles' },
  maestro: { name: 'Maestro', effect: 'four cards instead of three' },
  superfans: { name: 'Superfans', effect: 'level cap 21, an extra augment at level 21' }
}

/** Pentakill's own selection (ability empowerments). They come on top of the normal augments. */
const PENTAKILL_AUGMENTS = new Set(['heavy', 'power', 'thrash', 'doom'])

/** Augments only a Headliner offers, in a selection of their own. */
export function isHeadlinerAugment(augment: Pick<MayhemAugment, 'nameEn'> | undefined): boolean {
  return !!augment && PENTAKILL_AUGMENTS.has(norm(augment.nameEn))
}

export interface MayhemContext {
  /** map skin mutator from the client ("MapSkin_Map12_Bloom"), null while not known */
  mapSkin: string | null
  /** augment pool of the game ("KIWI", "KIWI_JADE"), null while not known */
  pool: string | null
  headliner: Headliner | null
  /** how each of the above was found out (newest last), for the log */
  evidence: string[]
}

export function newContext(): MayhemContext {
  return { mapSkin: null, pool: null, headliner: null, evidence: [] }
}

/** The client told us the map skin (LCU game session). */
export function withMapSkin(context: MayhemContext, mutator: string | null, data: MayhemData | null): MayhemContext {
  if (context.mapSkin === mutator && context.pool) return context
  const pool = data ? poolForMapSkin(mutator, data) : context.pool
  return {
    ...context,
    mapSkin: mutator,
    pool,
    evidence: [...context.evidence, `map ${mapSkinName(mutator)}${mutator ? ` (${mutator})` : ''} from the client → pool ${pool ?? '?'}`]
  }
}

export function withHeadliner(context: MayhemContext, headliner: Headliner, why: string): MayhemContext {
  if (context.headliner === headliner) return context
  return { ...context, headliner, evidence: [...context.evidence, `${HEADLINERS[headliner].name}: ${why}`] }
}

/**
 * What one augment selection on screen tells about the game: four cards are Maestro, HEAVY / POWER /
 * THRASH / DOOM are Pentakill, and an augment that only one pool has decides the pool.
 */
export function observeSelection(
  context: MayhemContext,
  selection: { augmentIds: (number | null)[]; cardCount: number },
  data: MayhemData
): MayhemContext {
  let next = context
  if (selection.cardCount === 4 && !next.headliner) next = withHeadliner(next, 'maestro', 'four cards in the selection')
  const augments = selection.augmentIds
    .filter((id): id is number => id !== null)
    .map((id) => data.augments[id])
    .filter((augment): augment is MayhemAugment => !!augment)
  if (augments.some(isHeadlinerAugment) && next.headliner !== 'pentakill')
    next = withHeadliner(next, 'pentakill', `${augments.find(isHeadlinerAugment)!.nameEn} offered`)

  // the pool: the cards must all be in it. One candidate left decides it; a card outside the assumed
  // pool overrules what was assumed (the client's map skin can't be wrong, our reading of it can)
  const withPools = augments.filter((augment) => augment.pools?.length && !isHeadlinerAugment(augment))
  if (withPools.length) {
    const candidates = [...knownPools(data)].filter((pool) => withPools.every((augment) => augment.pools!.includes(pool)))
    const contradicts = next.pool !== null && !candidates.includes(next.pool)
    if (candidates.length === 1 && (next.pool === null || contradicts) && candidates[0] !== next.pool) {
      const telling = withPools.find((augment) => augment.pools!.length === 1) ?? withPools[0]
      next = {
        ...next,
        pool: candidates[0],
        evidence: [...next.evidence, `pool ${candidates[0]} (${poolMapName(candidates[0])}): ${telling.nameEn} offered`]
      }
    }
  }
  return next
}

/** Levels above 18 only exist with Superfans (K'Sante's HEARTSTEEL sticker raises the cap to 19 only). */
export function observeLevel(context: MayhemContext, level: number): MayhemContext {
  return level >= 20 && !context.headliner ? withHeadliner(context, 'superfans', `level ${level}`) : context
}

/** Augment levels a Headliner adds to the normal ones (see AUGMENT_LEVELS in the scanner). */
export function extraAugmentLevels(context: MayhemContext): number[] {
  return context.headliner === 'pentakill' ? [18] : []
}

/** Selections on top of the levels: K/DA's photocard augment. */
export function extraSelections(context: MayhemContext): number {
  return context.headliner === 'kda' ? 1 : 0
}

export function describeContext(context: MayhemContext): string {
  return [
    context.mapSkin !== null || context.pool ? `map ${mapSkinName(context.mapSkin)}` : 'map unknown',
    `pool ${context.pool ?? `${MAIN_POOL} (assumed)`}`,
    context.headliner ? `Headliner ${HEADLINERS[context.headliner].name}` : 'Headliner unknown'
  ].join(', ')
}

/** The selection that is open: the augment last read per card position, and the positions rerolled. */
export interface SelectionTrack {
  cards: (number | null)[]
  rerolled: number[]
}

export const NO_SELECTION: SelectionTrack = { cards: [], rerolled: [] }

/**
 * Follows the open selection from read to read. Each card can be rerolled once, and a reroll changes
 * that one card while the others stay. Another number of cards, or every card changing at once, is a
 * new selection. An unreadable card keeps what was read there before.
 */
export function trackRerolls(track: SelectionTrack, ids: (number | null)[]): { track: SelectionTrack; changed: number[] } {
  const changed = ids.flatMap((id, i) => (id !== null && track.cards[i] != null && track.cards[i] !== id ? [i] : []))
  const fresh = track.cards.length !== ids.length || (ids.length > 0 && changed.length === ids.length)
  const cards = ids.map((id, i) => id ?? (fresh ? null : (track.cards[i] ?? null)))
  if (fresh) return { track: { cards, rerolled: [] }, changed: [] }
  return { track: { cards, rerolled: [...new Set([...track.rerolled, ...changed])].sort((a, b) => a - b) }, changed }
}
