import type { StaticData } from '@shared/types'
import { DDRAGON } from '@shared/staticData'

export const img = {
  champion: (data: StaticData, championId: number): string => {
    const champ = data.champions[championId]
    return champ ? `${DDRAGON}/cdn/${data.version}/img/champion/${champ.id}.png` : ''
  },
  championByName: (data: StaticData, name: string): string => {
    const champ = Object.values(data.champions).find((candidate) => candidate.name === name || candidate.id === name)
    return champ ? `${DDRAGON}/cdn/${data.version}/img/champion/${champ.id}.png` : ''
  },
  item: (data: StaticData, itemId: number): string => `${DDRAGON}/cdn/${data.version}/img/item/${itemId}.png`,
  spell: (data: StaticData, spellId: number): string => {
    const spell = data.spells[spellId]
    return spell ? `${DDRAGON}/cdn/${data.version}/img/spell/${spell.key}.png` : ''
  },
  rune: (data: StaticData, runeId: number): string => {
    // tree ids (Precision, Domination, ...) aren't in `runes`, so fall back to the tree list
    const rune = data.runes[runeId] ?? data.runeTrees.find((tree) => tree.id === runeId)
    if (!rune) return ''
    return `${DDRAGON}/cdn/img/${rune.icon}`
  },
  profileIcon: (data: StaticData, iconId: number): string => `${DDRAGON}/cdn/${data.version}/img/profileicon/${iconId}.png`
}
