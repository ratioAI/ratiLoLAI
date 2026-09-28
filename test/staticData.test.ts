import { describe, expect, it } from 'vitest'
import { classifyRawItem } from '../src/shared/staticData'

const base = { name: '', description: '', plaintext: '', maps: { '11': true }, tags: [] as string[] }

describe('classifyRawItem', () => {
  it('detects completed legendary items', () => {
    const c = classifyRawItem(3031, { ...base, gold: { total: 3450, purchasable: true }, depth: 3, from: ['1038', '1018'] })
    expect(c.completed).toBe(true)
    expect(c.boots).toBe(false)
  })
  it('detects tier-2 boots', () => {
    const c = classifyRawItem(3006, { ...base, tags: ['Boots'], gold: { total: 1100, purchasable: true }, from: ['1001'], depth: 2 })
    expect(c.boots).toBe(true)
    expect(c.completed).toBe(false)
  })
  it('does not treat components or consumables as completed', () => {
    expect(classifyRawItem(1038, { ...base, gold: { total: 1300, purchasable: true }, into: ['3031'] }).completed).toBe(false)
    expect(classifyRawItem(2003, { ...base, tags: ['Consumable'], gold: { total: 50, purchasable: true } }).starter).toBe(true)
  })
  it('excludes Ornn upgrades', () => {
    expect(classifyRawItem(7000, { ...base, gold: { total: 3000, purchasable: true }, depth: 4, requiredAlly: 'Ornn' }).completed).toBe(false)
  })
})
