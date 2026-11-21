import { describe, expect, it } from 'vitest'
import {
  extraAugmentLevels,
  extraSelections,
  mapSkinName,
  newContext,
  NO_SELECTION,
  observeLevel,
  observeSelection,
  poolForMapSkin,
  trackRerolls,
  withMapSkin
} from '../src/shared/mayhemContext'
import { buildMayhemData, mayhemPool, mayhemPools, type CherryAugment } from '../src/shared/mayhem'
import { findMapSkin } from '../src/main/lcu/manager'
import { AugmentSchedule } from '../src/main/scanner/detect'
import type { AugmentRarity, MayhemAugment, MayhemData } from '../src/shared/types'

const aug = (
  id: number,
  nameEn: string,
  rarity: AugmentRarity,
  pickRate: number | null,
  pools = ['KIWI', 'KIWI_JADE'],
  tags: string[] = []
): MayhemAugment => ({
  id,
  slug: nameEn.toLowerCase(),
  name: nameEn,
  nameEn,
  rarity,
  icon: '',
  pickRate,
  pickRateRank: null,
  pickRateChange: null,
  url: null,
  tags,
  pools
})

const augments = [
  // silver
  aug(1007, 'Blunt Force', 'silver', 50),
  aug(3264, 'Mystic Guard', 'silver', 40, ['KIWI']),
  aug(3265, 'Fortified', 'silver', 40, ['KIWI']),
  aug(1138, 'Goredrink', 'silver', 30),
  aug(9001, 'Silver Filler', 'silver', 20),
  aug(9002, 'Silver Dud', 'silver', 1),
  // gold
  aug(9101, 'Gold One', 'gold', 60),
  aug(9102, 'Gold Two', 'gold', 55),
  aug(9103, 'Gold Three', 'gold', 50),
  aug(7007, 'Upgrade: Deathfire Grasp', 'gold', null, ['KIWI_JADE'], ['classicish', 'damage']),
  aug(3170, 'HEAVY', 'gold', null, ['KIWI']),
  // prismatic
  aug(1195, 'Giant Slayer', 'prismatic', 40),
  aug(1001, "Titan's Resolve", 'prismatic', 30),
  aug(9201, 'Prismatic Filler', 'prismatic', 20, ['KIWI'], ['resilience'])
]

const data: MayhemData = {
  patch: '26.23',
  statsDate: null,
  fetchedAt: 0,
  augments: Object.fromEntries(augments.map((augment) => [augment.id, augment])),
  combos: [
    { championAlias: 'Garen', augments: [9101], types: ['god'], url: '' },
    { championAlias: 'Garen', augments: [1007, 7007], types: ['god'], url: '' },
    { championAlias: 'Garen', augments: [1007, 1001, 7007], types: ['strong'], url: '' }
  ],
  attribution: { text: '', url: '' }
}

describe('what the game is', () => {
  it('takes the pool from the map skin the client names', () => {
    expect(poolForMapSkin('MapSkin_Map12_Jade', data)).toBe('KIWI_JADE')
    expect(poolForMapSkin('MapSkin_Map12_Bloom', data)).toBe('KIWI')
    expect(poolForMapSkin(null, data)).toBe('KIWI')
    expect(mapSkinName('MapSkin_HA_Bilgewater')).toBe("Butcher's Bridge")
    expect(mapSkinName('MapSkin_Map12_Bloom')).toBe("Koeshin's Crossing")
    expect(mapSkinName('MapSkin_Map12_Newmap')).toBe('Newmap')
    const context = withMapSkin(newContext(), 'MapSkin_Map12_Jade', data)
    expect(context).toMatchObject({ mapSkin: 'MapSkin_Map12_Jade', pool: 'KIWI_JADE' })
    expect(context.evidence).toEqual(['map Jade map (MapSkin_Map12_Jade) from the client → pool KIWI_JADE'])
    expect(withMapSkin(context, 'MapSkin_Map12_Jade', data)).toBe(context)
  })

  it('reads Maestro, Pentakill and the pool off the cards', () => {
    let context = observeSelection(newContext(), { augmentIds: [1007, 9001, 9002, 1138], cardCount: 4 }, data)
    expect(context.headliner).toBe('maestro')
    expect(context.pool).toBeNull() // every card is in both pools

    context = observeSelection(context, { augmentIds: [7007, 9101, null], cardCount: 3 }, data)
    expect(context.pool).toBe('KIWI_JADE')
    expect(context.evidence.at(-1)).toBe('pool KIWI_JADE (Jade map): Upgrade: Deathfire Grasp offered')

    // a card only the normal pool has overrules it
    context = observeSelection(context, { augmentIds: [3264, 1007, 1138], cardCount: 3 }, data)
    expect(context.pool).toBe('KIWI')

    const pentakill = observeSelection(newContext(), { augmentIds: [3170, null, null], cardCount: 3 }, data)
    expect(pentakill.headliner).toBe('pentakill')
    expect(extraAugmentLevels(pentakill)).toEqual([18])
    // nothing new: same object back
    expect(observeSelection(pentakill, { augmentIds: [null, null, null], cardCount: 3 }, data)).toBe(pentakill)
  })

  it('knows Superfans from levels above 18 and K/DA gives an extra selection', () => {
    expect(observeLevel(newContext(), 18).headliner).toBeNull()
    expect(observeLevel(newContext(), 21).headliner).toBe('superfans')
    expect(extraSelections({ ...newContext(), headliner: 'kda' })).toBe(1)
    expect(extraSelections(newContext())).toBe(0)
  })

  it('finds the map skin anywhere in the game session', () => {
    expect(findMapSkin({ gameData: { queue: { gameMutator: 'MapSkin_Map12_Bloom' } } })).toBe('MapSkin_Map12_Bloom')
    expect(findMapSkin({ map: { properties: { suppressRunesMasteriesPerks: false } } })).toBeNull()
    expect(findMapSkin(null)).toBeNull()
  })
})

describe('rerolls in the open selection', () => {
  it('counts a card that changes while the others stay as rerolled', () => {
    let { track, changed } = trackRerolls(NO_SELECTION, [1, 2, 3])
    expect(track).toEqual({ cards: [1, 2, 3], rerolled: [] })
    expect(changed).toEqual([])
    ;({ track, changed } = trackRerolls(track, [1, 5, 3]))
    expect(changed).toEqual([1])
    expect(track).toEqual({ cards: [1, 5, 3], rerolled: [1] })
    // an unreadable read keeps what was there, and the reroll stays
    ;({ track } = trackRerolls(track, [null, 5, 7]))
    expect(track).toEqual({ cards: [1, 5, 7], rerolled: [1, 2] })
  })

  it('takes every card changing, or another number of cards, as a new selection', () => {
    const open = trackRerolls(trackRerolls(NO_SELECTION, [1, 2, 3]).track, [1, 5, 3]).track
    expect(trackRerolls(open, [7, 8, 9])).toEqual({ track: { cards: [7, 8, 9], rerolled: [] }, changed: [] })
    expect(trackRerolls(open, [1, 5, 3, 4]).track).toEqual({ cards: [1, 5, 3, 4], rerolled: [] })
  })
})

describe('augment levels', () => {
  const tick = (level: number) => ({ level, dead: false, gameTime: 600, itemsKey: '' })

  it('has the Superfans augment at 21 and the Headliner levels on top', () => {
    const schedule = new AugmentSchedule()
    schedule.update(tick(18))
    expect(schedule.earned).toBe(4)
    schedule.extraLevels = [18] // Pentakill's DOOM
    expect(schedule.earned).toBe(5)
    expect(schedule.earnedRegular).toBe(4)
    schedule.update(tick(21))
    expect(schedule.earned).toBe(6)
    expect(schedule.earnedRegular).toBe(5)
    schedule.reset()
    expect(schedule.extraLevels).toEqual([])
  })
})

describe('Mayhem pools in the data', () => {
  const cherry: CherryAugment[] = [
    {
      id: 1007,
      augmentNameId: 'ARAM_BluntForce',
      nameTRA: 'Blunt Force',
      augmentSmallIconPath: '/x.png',
      rarity: 'kSilver',
      augmentDisplayTags: ['kDamage']
    },
    {
      id: 7007,
      augmentNameId: 'Upgrade_DeathFireGrasp',
      nameTRA: 'Upgrade: Deathfire Grasp',
      augmentSmallIconPath: '/y.png',
      rarity: 'kGold',
      augmentDisplayTags: ['kClassicish', 'kDamage']
    },
    { id: 3264, augmentNameId: 'MysticGuard', nameTRA: 'Mystic Guard', augmentSmallIconPath: '/z.png', rarity: 'kSilver' }
  ]
  const lists = [
    { modeName: 'CHERRY', augmentList: ['Maps/ModeSpecificData/Augments/BluntForce'] },
    { modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_BluntForce', 'Maps/ModeSpecificData/Augments/MysticGuard'] },
    {
      modeName: 'KIWI_JADE',
      augmentList: ['Maps/ModeSpecificData/Augments/ARAM_BluntForce', 'Maps/ModeSpecificData/Augments/Upgrade_DeathFireGrasp']
    }
  ]

  it('keeps every Mayhem pool, but not Arena', () => {
    expect(Object.keys(mayhemPools(lists))).toEqual(['KIWI', 'KIWI_JADE'])
    expect([...mayhemPool(lists)].sort()).toEqual(['aram_bluntforce', 'mysticguard', 'upgrade_deathfiregrasp'])
  })

  it('tells each augment its pools and Riot tags, map-only augments included', () => {
    const built = buildMayhemData(cherry, cherry, null, null, 1, mayhemPool(lists), mayhemPools(lists))
    expect(built.augments[1007]).toMatchObject({ pools: ['KIWI', 'KIWI_JADE'], tags: ['damage'] })
    expect(built.augments[7007]).toMatchObject({ pools: ['KIWI_JADE'], tags: ['classicish', 'damage'], rarity: 'gold' })
    expect(built.augments[3264]).toMatchObject({ pools: ['KIWI'], tags: [] })
  })
})
