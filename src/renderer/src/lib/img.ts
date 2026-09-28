import type { StaticData } from '@shared/types'
import { DDRAGON } from '@shared/staticData'

export const img = {
  champion: (d: StaticData, championId: number): string => {
    const c = d.champions[championId]
    return c ? `${DDRAGON}/cdn/${d.version}/img/champion/${c.id}.png` : ''
  },
  championByName: (d: StaticData, name: string): string => {
    const c = Object.values(d.champions).find((c) => c.name === name || c.id === name)
    return c ? `${DDRAGON}/cdn/${d.version}/img/champion/${c.id}.png` : ''
  },
  item: (d: StaticData, itemId: number): string => `${DDRAGON}/cdn/${d.version}/img/item/${itemId}.png`,
  spell: (d: StaticData, spellId: number): string => {
    const s = d.spells[spellId]
    return s ? `${DDRAGON}/cdn/${d.version}/img/spell/${s.key}.png` : ''
  },
  rune: (d: StaticData, runeId: number): string => {
    const r = d.runes[runeId] ?? d.runeTrees.find((t) => t.id === runeId)
    if (!r) return ''
    return `${DDRAGON}/cdn/img/${r.icon}`
  },
  profileIcon: (d: StaticData, iconId: number): string => `${DDRAGON}/cdn/${d.version}/img/profileicon/${iconId}.png`
}
