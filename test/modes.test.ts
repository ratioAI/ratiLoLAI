import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { selectModeOfQueue, statsModeOf } from '../src/shared/types'
import { StatsStore } from '../src/main/crawler/statsStore'
import { parseChampSelect } from '../src/main/lcu/champSelect'

describe('queue detection', () => {
  it('maps queues to modes', () => {
    expect(selectModeOfQueue(420)).toBe('ranked')
    expect(selectModeOfQueue(450)).toBe('aram')
    expect(selectModeOfQueue(2400)).toBe('mayhem')
    expect(selectModeOfQueue(9999, 'KIWI')).toBe('mayhem')
    expect(selectModeOfQueue(1700)).toBe('other')
    expect(selectModeOfQueue(null)).toBe('other')
  })
  it('uses ARAM statistics for Mayhem builds', () => {
    expect(statsModeOf('mayhem')).toBe('aram')
    expect(statsModeOf('aram')).toBe('aram')
    expect(statsModeOf('ranked')).toBe('ranked')
  })
  it('passes the queue into the champ select state', () => {
    const s = parseChampSelect({ localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 99 }], theirTeam: [], actions: [] }, 2400, 'KIWI')!
    expect(s).toMatchObject({ mode: 'mayhem', queueId: 2400, myChampionId: 99, locked: false })
  })
})

describe('StatsStore modes', () => {
  it('keeps ranked and ARAM statistics apart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-modes-'))
    const store = new StatsStore(dir)
    ;(await store.load('15.19', 'ranked')).stats.matches = 3
    ;(await store.load('15.19', 'aram')).stats.matches = 7
    store.markDirty('15.19', 'ranked')
    store.markDirty('15.19', 'aram')
    await store.flush()
    const fresh = new StatsStore(dir)
    expect((await fresh.patches('ranked')).map((p) => p.matches)).toEqual([3])
    expect((await fresh.patches('aram')).map((p) => p.matches)).toEqual([7])
    expect((await fresh.load('15.19', 'aram')).stats.mode).toBe('aram')
  })
})
