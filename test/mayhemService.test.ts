import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MayhemService } from '../src/main/mayhem'

const CHERRY = [
  { id: 1205, augmentNameId: 'ARAM_BigBrain', nameTRA: 'Big Brain', augmentSmallIconPath: '/lol-game-data/assets/ASSETS/UX/Kiwi/BigBrain.png', rarity: 'kSilver' }
]
const POOL = [{ modeName: 'KIWI', augmentList: ['Maps/ModeSpecificData/Augments/ARAM_BigBrain'] }]

/** fetch stand-in: the client augment list always answers, the Mayhem pool only when `pool` is set */
function serve(pool: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.endsWith('cherry-augments.json') ? CHERRY : url.endsWith('augment-lists.json') ? pool : null
      return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 503, json: async () => null }
    })
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('MayhemService', () => {
  it('saves a list with augments', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rc-mayhem-')), 'mayhem.json')
    const logs: string[] = []
    serve(POOL)
    const data = await new MayhemService(file, 'en_US', (message) => logs.push(message)).get()
    expect(Object.keys(data.augments)).toEqual(['1205'])
    expect(JSON.parse(readFileSync(file, 'utf8')).data.augments[1205].nameEn).toBe('Big Brain')
    expect(logs).toEqual(['Mayhem data: 1 augments (no pick rates)'])
  })

  it('keeps the saved copy when a source is down and the answer has no augments', async () => {
    // what happened in a real game: the list came back empty and replaced the good copy, so no card title matched
    const file = join(mkdtempSync(join(tmpdir(), 'rc-mayhem-')), 'mayhem.json')
    serve(POOL)
    await new MayhemService(file, 'en_US').get()
    const good = readFileSync(file, 'utf8')

    serve(null)
    const logs: string[] = []
    const service = new MayhemService(file, 'en_US', (message) => logs.push(message))
    const data = await service.get()
    expect(Object.keys(data.augments)).toEqual(['1205'])
    expect(readFileSync(file, 'utf8')).toBe(good)
    expect(logs[0]).toMatch(/download failed \(no augments in the answer \(client list 1, Mayhem pool missing, pick rates missing\)\) – using the saved copy/)
    // no new download right away, the saved copy stands in for a while
    const calls = vi.mocked(fetch).mock.calls.length
    await service.get()
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls)
  })

  it('does not take an empty saved copy either', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rc-mayhem-')), 'mayhem.json')
    writeFileSync(file, JSON.stringify({ language: 'en_US', data: { patch: null, statsDate: null, fetchedAt: 1, augments: {}, combos: [] } }))
    serve(null)
    await expect(new MayhemService(file, 'en_US').get()).rejects.toThrow(/Mayhem data unavailable: no augments/)
  })
})
