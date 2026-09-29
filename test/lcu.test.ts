import { describe, expect, it } from 'vitest'
import { parseCommandLine, parseLockfile } from '../src/main/lcu/credentials'
import {
  buildItemSet,
  buildRunePagePayload,
  orderSpells,
  parseChampSelect,
  positionToRole,
  regionToPlatform
} from '../src/main/lcu/champSelect'
import { parseLiveData } from '../src/main/live/liveClient'
import type { ChampionBuild, StaticData } from '../src/shared/types'

describe('LCU credentials', () => {
  it('parses the lockfile', () => {
    expect(parseLockfile('LeagueClient:1234:54321:s3cr3t:https')).toEqual({ port: 54321, password: 's3cr3t', protocol: 'https' })
    expect(parseLockfile('garbage')).toBeNull()
  })
  it('parses the LeagueClientUx command line', () => {
    const cmd = '"C:/Riot Games/League of Legends/LeagueClientUx.exe" "--riotclient-auth-token=x" "--app-port=61234" "--remoting-auth-token=AbC-123_x" "--install-directory=C:/Riot Games/League of Legends"'
    expect(parseCommandLine(cmd)).toEqual({ port: 61234, password: 'AbC-123_x', protocol: 'https' })
    expect(parseCommandLine('notepad.exe')).toBeNull()
  })
})

describe('champ select', () => {
  const session = {
    localPlayerCellId: 2,
    myTeam: [
      { cellId: 0, championId: 86, assignedPosition: 'top' },
      { cellId: 2, championId: 0, championPickIntent: 103, assignedPosition: 'middle', spell1Id: 4, spell2Id: 14 }
    ],
    theirTeam: [{ cellId: 5, championId: 122 }],
    actions: [
      [{ actorCellId: 0, championId: 157, completed: true, type: 'ban' }],
      [{ actorCellId: 2, championId: 103, completed: false, type: 'pick' }]
    ]
  }
  it('parses my champion, role and bans', () => {
    const s = parseChampSelect(session)!
    expect(s.myChampionId).toBe(103)
    expect(s.myRole).toBe('MIDDLE')
    expect(s.locked).toBe(false)
    expect(s.bans).toEqual([157])
    expect(s.enemies[0].championId).toBe(122)
  })
  it('detects lock-in', () => {
    const locked = { ...session, actions: [[{ actorCellId: 2, championId: 103, completed: true, type: 'pick' }]] }
    expect(parseChampSelect(locked)!.locked).toBe(true)
  })
  it('maps positions and regions', () => {
    expect(positionToRole('utility')).toBe('UTILITY')
    expect(positionToRole('')).toBeNull()
    expect(regionToPlatform('EUW')).toBe('euw1')
    expect(regionToPlatform('??')).toBeNull()
  })
})

describe('import payloads', () => {
  const build: ChampionBuild = {
    championId: 103,
    role: 'MIDDLE',
    mode: 'ranked',
    patch: '15.19',
    games: 100,
    winRate: 0.52,
    pickRate: 0.1,
    banRate: 0.05,
    tier: 'A',
    availableRoles: [{ role: 'MIDDLE', games: 100 }],
    runes: [
      {
        value: { primaryStyle: 8200, subStyle: 8300, primary: [8214, 8226, 8210, 8237], secondary: [8345, 8347], shards: [5008, 5008, 5011] },
        g: 50,
        w: 27,
        winRate: 0.54,
        pickRate: 0.5
      }
    ],
    spells: [{ value: [4, 14], g: 80, w: 40, winRate: 0.5, pickRate: 0.8 }],
    starters: [{ value: [1056, 2003, 2003], g: 70, w: 35, winRate: 0.5, pickRate: 0.7 }],
    core: [{ value: [6655, 3020, 4645], g: 40, w: 22, winRate: 0.55, pickRate: 0.4 }],
    boots: [{ value: 3020, g: 60, w: 30, winRate: 0.5, pickRate: 0.6 }],
    late: [[{ value: 3089, g: 10, w: 6, winRate: 0.6, pickRate: 0.3 }], [], []],
    skillMax: [],
    skillPath: [],
    counters: [],
    goodAgainst: [],
    avgDuration: 1800
  }
  const data = { champions: { 103: { id: 'Ahri', key: 103, name: 'Ahri', title: '', tags: [] } } } as unknown as StaticData

  it('creates a rune page with 9 perks', () => {
    const page = buildRunePagePayload(build, 'Ahri')!
    expect(page.selectedPerkIds).toHaveLength(9)
    expect(page.name.startsWith('RC: ')).toBe(true)
    expect(page.name.length).toBeLessThanOrEqual(25)
  })

  it('creates an item set with starter, core and consumables', () => {
    const set = buildItemSet(build, data)
    expect(set.associatedChampions).toEqual([103])
    expect(set.blocks[0].items).toEqual([
      { id: '1056', count: 1 },
      { id: '2003', count: 2 }
    ])
    expect(set.blocks.some((b) => b.type.startsWith('Core build'))).toBe(true)
  })

  it('puts Flash on the preferred key', () => {
    expect(orderSpells([14, 4], 'D')).toEqual([4, 14])
    expect(orderSpells([4, 14], 'F')).toEqual([14, 4])
    expect(orderSpells([11, 6], 'F')).toEqual([11, 6])
  })
})

describe('live client data', () => {
  it('parses the Live Client Data API payload', () => {
    const state = parseLiveData({
      activePlayer: { riotId: 'Me#EUW' },
      gameData: { gameTime: 600, gameMode: 'CLASSIC' },
      allPlayers: [
        {
          riotId: 'Me#EUW',
          championName: 'Ahri',
          team: 'ORDER',
          level: 9,
          position: 'MIDDLE',
          isDead: false,
          respawnTimer: 0,
          scores: { kills: 3, deaths: 1, assists: 2, creepScore: 90 },
          items: [{ itemID: 3020, slot: 1 }, { itemID: 6655, slot: 0 }],
          summonerSpells: { summonerSpellOne: { displayName: 'Flash' }, summonerSpellTwo: { displayName: 'Ignite' } }
        }
      ],
      events: { Events: [{ EventName: 'ChampionKill', EventTime: 500, KillerName: 'Me', VictimName: 'You' }] }
    })!
    expect(state.players[0].items).toEqual([6655, 3020])
    expect(state.events[0].text).toContain('Me')
    expect(parseLiveData({})).toBeNull()
  })
})

describe('auto-accept delay', () => {
  it('is random within the chosen range, never instant unless asked', async () => {
    const { acceptDelayMs } = await import('../src/main/lcu/acceptDelay')
    expect(acceptDelayMs('instant')).toBe(0)
    const human = Array.from({ length: 500 }, () => acceptDelayMs('human'))
    expect(Math.min(...human)).toBeGreaterThanOrEqual(2000)
    expect(Math.max(...human)).toBeLessThanOrEqual(6000)
    expect(new Set(human).size).toBeGreaterThan(400)
    expect(acceptDelayMs('slow', 0, () => 0)).toBe(4000)
    expect(acceptDelayMs('slow', 0, () => 1)).toBe(8000)
  })
  it('still accepts in time when the popup was noticed late', async () => {
    const { acceptDelayMs } = await import('../src/main/lcu/acceptDelay')
    expect(acceptDelayMs('slow', 5, () => 1)).toBe(4500)
  })
})
