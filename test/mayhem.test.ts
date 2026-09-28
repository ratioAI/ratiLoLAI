import { describe, expect, it } from 'vitest'
import { buildMayhemData, cdragonIcon, combosForChampion, indexCherry, popularByRarity, type CherryAugment } from '../src/shared/mayhem'
import { isMayhemGame, personalMayhemStats } from '../src/main/mayhem'
import type { StaticData } from '../src/shared/types'

// Excerpts of the real CommunityDragon / arammayhem.com data (patch 26.19)
const cherryEn: CherryAugment[] = [
  { id: 63, augmentNameId: 'OutlawsGrit', nameTRA: "Outlaw's Grit", augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/OutlawsGrit_small.png', rarity: 'kGold' },
  { id: 1063, augmentNameId: 'ARAM_OutlawsGrit', nameTRA: "Outlaw's Grit", augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/OutlawsGrit_small.png', rarity: 'kGold' },
  { id: 1373, augmentNameId: 'ShrinkEngine', nameTRA: 'Shrink Engine', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/ShrinkEngine_small.png', rarity: 'kGold' },
  { id: 48, augmentNameId: 'JeweledGauntlet', nameTRA: 'Jeweled Gauntlet', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Cherry/Augments/Icons/JeweledGauntlet_small.png', rarity: 'kPrismatic' },
  { id: 2018, augmentNameId: 'PuristCaster', nameTRA: 'Purist - Caster', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/PuristCaster_small.png', rarity: 'kSilver' },
  { id: 1500, augmentNameId: 'SlowAndSteady', nameTRA: 'Slow and Steady', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Kiwi/Augments/Icons/SlowAndSteady_small.png', rarity: 'kSilver' }
]
const cherryDe = cherryEn.map((a) => ({ ...a, nameTRA: a.id === 48 ? 'Juwelenbesetzter Handschuh' : a.nameTRA }))

const augments = {
  meta: { patch: '26.19', statsDate: '2026-09-25' },
  rows: [
    { augmentId: 'shrink_engine', name: { en: 'Shrink Engine' }, rarity: 'gold', pickRate: 56.48, pickRateRank: 3, pickRateChange: 0.4, url: 'u1' },
    { augmentId: 'jeweled_gauntlet', name: { en: 'Jeweled Gauntlet' }, rarity: 'prismatic', pickRate: 52.45, pickRateRank: 4, pickRateChange: -1, url: 'u2' },
    { augmentId: 'purist___caster', name: { en: 'Purist - Caster' }, rarity: 'silver', pickRate: 40.26, pickRateRank: 12, pickRateChange: 0, url: 'u3' },
    { augmentId: 'outlaws_grit', name: { en: "Outlaw's Grit" }, rarity: 'gold', pickRate: 10.38, pickRateRank: 120, pickRateChange: null, url: 'u4' }
  ]
}
const combos = {
  rows: [
    { championId: 'Garen', augmentIds: ['slow_and_steady'], types: ['god'], url: 'c1' },
    { championId: 'Garen', augmentIds: ['jeweled_gauntlet'], types: ['trap'], url: 'c2' },
    { championId: 'Garen', augmentIds: ['slow_and_steady', 'shrink_engine'], types: [], url: 'c3' },
    { championId: 'Lux', augmentIds: ['unknown_augment'], types: ['strong'], url: 'c4' }
  ]
}
const statics = { champions: { 86: { id: 'Garen', key: 86, name: 'Garen', title: '', tags: [] } } } as unknown as StaticData

describe('Mayhem data', () => {
  const data = buildMayhemData(cherryEn, cherryDe, augments, combos, 1)

  it('prefers the Mayhem (ARAM_) variant of augments that also exist in Arena', () => {
    expect(indexCherry(cherryEn).get('outlawsgrit')?.id).toBe(1063)
    expect(data.augments[1063]?.pickRate).toBe(10.38)
    expect(data.augments[63]).toBeUndefined()
  })

  it('uses localised names, rarities and CommunityDragon icons', () => {
    expect(data.augments[48]).toMatchObject({ name: 'Juwelenbesetzter Handschuh', rarity: 'prismatic', pickRateRank: 4 })
    expect(data.augments[1373].icon).toBe(
      'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/assets/ux/kiwi/augments/icons/shrinkengine_small.png'
    )
    expect(cdragonIcon('/lol-game-data/assets/ASSETS/X.png')).toMatch(/assets\/x\.png$/)
  })

  it('resolves combo slugs, including augments without pick-rate data', () => {
    expect(data.combos).toHaveLength(3) // the unknown augment is dropped
    expect(data.augments[1500]).toMatchObject({ name: 'Slow and Steady', pickRate: null })
  })

  it('sorts combos for a champion: top tips first, traps last, builds after single tips', () => {
    const list = combosForChampion(data, statics, 86)
    expect(list.map((c) => c.url)).toEqual(['c1', 'c2', 'c3'])
  })

  it('lists the most popular augments per rarity', () => {
    const pop = popularByRarity(data, 5)
    expect(pop.gold.map((a) => a.id)).toEqual([1373, 1063])
    expect(pop.prismatic[0].id).toBe(48)
  })

  it('attributes the data source', () => {
    expect(data.attribution.text).toContain('CC BY 4.0')
    expect(data.patch).toBe('26.19')
  })
})

describe('personal Mayhem stats', () => {
  const game = (gameId: number, queueId: number, win: boolean, augs: number[]) => ({
    gameId,
    queueId,
    gameMode: queueId === 2400 ? 'KIWI' : 'CLASSIC',
    gameCreation: gameId * 1000,
    participants: [
      {
        participantId: 1,
        championId: 99,
        stats: { win, ...Object.fromEntries(augs.map((a, i) => [`playerAugment${i + 1}`, a])), playerAugment6: 0 }
      }
    ],
    participantIdentities: [{ participantId: 1, player: { puuid: 'me' } }]
  })

  it('only counts Mayhem games and aggregates augments', () => {
    const stats = personalMayhemStats(
      { games: { games: [game(1, 2400, true, [1063, 48]), game(2, 2400, false, [1063]), game(3, 420, true, [])] } },
      'me'
    )
    expect(stats.games).toBe(2)
    expect(stats.wins).toBe(1)
    expect(stats.augments[0]).toEqual({ id: 1063, games: 2, wins: 1 })
    expect(stats.recent[0].gameId).toBe(2)
    expect(stats.recent[1].augments).toEqual([1063, 48])
  })

  it('recognises Mayhem by queue or game mode', () => {
    expect(isMayhemGame({ queueId: 2400, gameMode: 'X' })).toBe(true)
    expect(isMayhemGame({ queueId: 0, gameMode: 'KIWI' })).toBe(true)
    expect(isMayhemGame({ queueId: 450, gameMode: 'ARAM' })).toBe(false)
  })
})
