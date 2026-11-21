import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveAnswer } from '../src/main/live/liveClient'
import { parseLiveData } from '../src/main/live/liveClient'
import { LcuManager } from '../src/main/lcu/manager'
import type { LiveGameState, LoadingState, Settings, StaticData } from '../src/shared/types'

// what the game answers, one entry per poll (empty: the game doesn't answer)
const game = vi.hoisted(() => ({ answers: [] as LiveAnswer[] }))

vi.mock('../src/main/live/liveClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/live/liveClient')>()
  return { ...actual, fetchAllGameData: async () => game.answers.shift() ?? { ok: false, reason: 'ECONNREFUSED' } }
})

type FeedEntry = { EventName: string; EventTime: number; Result?: string }

/** An answer of the Live Client Data API with one player. */
function answer(gameTime: number, events: FeedEntry[] = [], level = 1): LiveAnswer {
  return {
    ok: true,
    data: {
      activePlayer: { riotId: 'Me#EUW' },
      gameData: { gameTime, gameMode: 'KIWI' },
      allPlayers: [
        {
          riotId: 'Me#EUW',
          championName: 'Lux',
          team: 'ORDER',
          level,
          position: '',
          isDead: false,
          respawnTimer: 0,
          scores: { kills: 0, deaths: 0, assists: 0, creepScore: 0 },
          items: [],
          summonerSpells: {}
        }
      ],
      events: { Events: events.map((event, i) => ({ EventID: i, ...event })) }
    }
  }
}

const missing: LiveAnswer = { ok: false, reason: 'ECONNREFUSED' }
const GAME_START: FeedEntry = { EventName: 'GameStart', EventTime: 0.03 }

describe('live data from the event feed', () => {
  it('tells the loading screen from the running game by GameStart', () => {
    // during the loading screen the game already answers: level 1, clock at 0, no events
    expect(parseLiveData((answer(0) as { data: unknown }).data)).toMatchObject({ started: false, result: null })
    expect(parseLiveData((answer(0.5, [GAME_START], 3) as { data: unknown }).data)).toMatchObject({ started: true, result: null })
    // a running clock counts as started even without the event
    expect(parseLiveData((answer(40) as { data: unknown }).data)?.started).toBe(true)
  })

  it('reads the result from GameEnd', () => {
    const ended = (result: string) =>
      parseLiveData((answer(900, [GAME_START, { EventName: 'GameEnd', EventTime: 900, Result: result }]) as { data: unknown }).data)
    expect(ended('Win')?.result).toBe('Win')
    expect(ended('Lose')?.result).toBe('Lose')
  })
})

describe('live polling during a game', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    game.answers = []
  })
  afterEach(() => vi.useRealTimers())

  function setup(connected = true) {
    const live: (LiveGameState | null)[] = []
    const logs: string[] = []
    const dumps: string[] = []
    const lcu = new LcuManager({
      settings: () => ({}) as Settings,
      staticData: async () => ({}) as StaticData,
      build: async () => null,
      liveCurve: () => [],
      log: (message) => logs.push(message),
      dump: (name) => dumps.push(name),
      emit: {
        client: () => undefined,
        champSelect: () => undefined,
        live: (state) => live.push(state),
        imported: () => undefined,
        loading: () => undefined,
        summary: () => undefined,
        matchAccepted: () => undefined
      }
    })
    // a connected League client whose session tells nothing
    if (connected) (lcu as unknown as { client: unknown }).client = { get: async () => ({}) }
    const phase = (name: string): void => (lcu as unknown as { onPhase(phase: string): void }).onPhase(name)
    const polls = async (count: number): Promise<void> => {
      for (let i = 0; i < count; i++) await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 2000)
    }
    return { lcu, live, logs, dumps, phase, polls }
  }

  it('keeps the game when one poll gets no answer while the phase is InProgress', async () => {
    const { lcu, live, logs, phase, polls } = setup()
    // loading screen → the game skips one answer as the loading screen ends → running
    game.answers = [answer(0), answer(0), missing, answer(0.5, [GAME_START], 3), answer(2.5, [GAME_START], 3)]
    phase('InProgress')
    await polls(5)
    expect(live).not.toContain(null)
    expect(live.map((state) => state!.started)).toEqual([false, false, true, true])
    expect(lcu.getLive()?.players[0].level).toBe(3)
    expect(logs.some((line) => line.includes('no answer (ECONNREFUSED)'))).toBe(true)
    expect(logs.some((line) => line.includes('answering again after 1 missed poll '))).toBe(true)
    expect(logs.some((line) => line.includes('GameStart'))).toBe(true)
  })

  it('ends the game when Riot says so: the gameflow phase leaves InProgress', async () => {
    const { lcu, live, logs, dumps, phase, polls } = setup()
    const end: FeedEntry = { EventName: 'GameEnd', EventTime: 600, Result: 'Win' }
    game.answers = [answer(598, [GAME_START]), answer(600, [GAME_START, end])]
    phase('InProgress')
    await polls(4) // two answers, then the game is closing and doesn't answer
    expect(live.at(-1)?.result).toBe('Win')
    expect(logs.some((line) => line.includes('GameEnd – Win'))).toBe(true)
    // the game session is kept too (where does the client name the map skin?)
    expect(dumps).toEqual(['session', 'running', 'end'])
    expect(logs).toContain('game session: map skin not in the session')
    phase('WaitingForStats')
    expect(live.at(-1)).toBeNull()
    expect(lcu.getLive()).toBeNull()
  })

  it('still ends the game on a missing answer without a client connection (no phase to go by)', async () => {
    const { live, phase, polls } = setup(false)
    game.answers = [answer(30, [GAME_START]), missing]
    phase('InProgress')
    await polls(2)
    expect(live.map((state) => state?.gameTime ?? null)).toEqual([30, null])
  })

  it('looks nothing up about a stranger the game hides (no name in the session), even when the game knows the name', async () => {
    // seen 2026-11-20: the game session and the summoner lookup had no name for 3 of 10 players –
    // players hidden by the game (streamer mode). Riot: products may not identify or analyse them
    const loading: (LoadingState | null)[] = []
    const logs: string[] = []
    const lcu = new LcuManager({
      settings: () => ({}) as Settings,
      staticData: async () =>
        ({ champions: { 20: { id: 'Nunu', key: 20, name: 'Nunu & Willump' }, 99: { id: 'Lux', key: 99, name: 'Lux' } } }) as unknown as StaticData,
      build: async () => null,
      liveCurve: () => [],
      log: (message) => logs.push(message),
      emit: {
        client: () => undefined,
        champSelect: () => undefined,
        live: () => undefined,
        imported: () => undefined,
        loading: (state) => loading.push(state),
        summary: () => undefined,
        matchAccepted: () => undefined
      }
    })
    const session = {
      gameData: {
        gameId: 7,
        queue: { id: 2400, gameMode: 'KIWI' },
        teamOne: [{ puuid: 'me', gameName: 'Me', tagLine: 'EUW', championId: 99 }],
        teamTwo: [{ puuid: 'nameless', championId: 20 }]
      }
    }
    const asked: string[] = []
    ;(lcu as unknown as { client: unknown }).client = {
      get: async (path: string) => {
        asked.push(path)
        return path === '/lol-gameflow/v1/session' ? session : null
      }
    }
    const raw = answer(0) as { ok: true; data: { allPlayers: Record<string, unknown>[] } }
    raw.data.allPlayers[0].rawChampionName = 'game_character_displayname_Lux'
    raw.data.allPlayers.push({ ...raw.data.allPlayers[0], riotId: 'Hidden One#EUW', championName: 'Nunu & Willump', rawChampionName: 'game_character_displayname_Nunu', team: 'CHAOS' })
    game.answers = [raw, raw]
    ;(lcu as unknown as { onPhase(phase: string): void }).onPhase('InProgress')
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(i === 0 ? 0 : 2000)
    const players = loading.at(-1)?.players ?? []
    expect(players.map((player) => [player.riotId, !!player.hidden])).toEqual([
      ['Me#EUW', false],
      ['', true]
    ])
    expect(players[1]).toMatchObject({ record: null, loading: false })
    expect(players[1].encounter ?? null).toBeNull()
    // neither the summoner lookup nor the match history was asked about the hidden player
    expect(asked.filter((path) => path.includes('nameless'))).toEqual([])
    expect(logs.some((line) => line.includes('hidden player (no lookups)'))).toBe(true)
  })
})
