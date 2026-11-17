import { describe, expect, it } from 'vitest'
import {
  DEATH_STREAK,
  detectTriggers,
  pickAnnouncement,
  sameName,
  voiceLine,
  TRIGGERS,
  type Announcement,
  type LiveEvent,
  type Trigger
} from '../src/shared/announcer'
import { AnnouncerFeed } from '../src/main/announcer'
import { parseLiveEvents } from '../src/main/live/liveClient'
import { SimGame } from '../src/main/admin'
import type { LiveGameState, Settings } from '../src/shared/types'

const ctx = { me: 'Axel Fungus#EUW', premades: ['blackbird#EUW'], myTeam: 'ORDER' }

/** Builds a feed with ids in order. */
function feed(...events: Omit<LiveEvent, 'EventID' | 'EventTime'>[]): LiveEvent[] {
  return [
    { EventID: 0, EventName: 'GameStart', EventTime: 0 },
    ...events.map((event, i) => ({ ...event, EventID: i + 1, EventTime: 10 * (i + 1) }))
  ]
}
const kill = (killer: string, victim: string, assisters: string[] = []) => ({
  EventName: 'ChampionKill',
  KillerName: killer,
  VictimName: victim,
  Assisters: assisters
})
const multi = (killer: string, streak: number) => ({ EventName: 'Multikill', KillerName: killer, KillStreak: streak })
const triggers = (prev: number | null, events: LiveEvent[]) => detectTriggers(prev, events, ctx).announcements.map((a) => a.trigger)

describe('detectTriggers', () => {
  it('plays nothing back on the first look at a running game, only takes the newest id', () => {
    const events = feed(kill('Axel Fungus', 'x'), multi('Axel Fungus', 2), multi('Axel Fungus', 3))
    expect(detectTriggers(null, events, ctx)).toEqual({ announcements: [], lastEventId: 3 })
    expect(detectTriggers(null, [], ctx)).toEqual({ announcements: [], lastEventId: null })
  })

  it('only looks at events after the last id', () => {
    const events = feed(kill('Axel Fungus', 'a'), multi('Axel Fungus', 2), kill('Axel Fungus', 'b'), multi('Axel Fungus', 3))
    expect(triggers(2, events)).toEqual(['myTriple'])
    expect(triggers(4, events)).toEqual([])
    expect(detectTriggers(2, events, ctx).lastEventId).toBe(4)
  })

  it('knows your multikills by name (with or without tag, any case) and your premade’s penta', () => {
    const events = feed(
      multi('axel fungus', 3),
      multi('AxelFungus#EUW', 4),
      multi('Axel Fungus', 5),
      multi('blackbird', 5),
      multi('stranger', 5),
      multi('blackbird', 4)
    )
    expect(triggers(0, events)).toEqual(['myTriple', 'myQuadra', 'myPenta', 'premadePenta'])
    expect(detectTriggers(0, events, ctx).announcements[3].name).toBe('blackbird')
  })

  it('first blood, aces of both teams, victory and defeat', () => {
    expect(triggers(0, feed({ EventName: 'FirstBlood', Recipient: 'Axel Fungus' }))).toEqual(['myFirstBlood'])
    expect(triggers(0, feed({ EventName: 'FirstBlood', Recipient: 'someone' }))).toEqual([])
    expect(
      triggers(0, feed({ EventName: 'Ace', Acer: 'x', AcingTeam: 'ORDER' }, { EventName: 'Ace', Acer: 'y', AcingTeam: 'CHAOS' }))
    ).toEqual(['allyAce', 'enemyAce'])
    expect(triggers(0, feed({ EventName: 'GameEnd', Result: 'Win' }))).toEqual(['victory'])
    expect(triggers(0, feed({ EventName: 'GameEnd', Result: 'Lose' }))).toEqual(['defeat'])
  })

  it('counts your deaths over the whole feed: 5th, 10th and 15th death', () => {
    const deaths = Array.from({ length: 15 }, (_, i) => [kill('enemy', 'Axel Fungus'), kill('Axel Fungus', `e${i}`)]).flat()
    const events = feed(...deaths)
    const all = detectTriggers(0, events, ctx).announcements
    expect(all.filter((a) => a.trigger === 'myDeathMilestone').map((a) => a.deaths)).toEqual([5, 10, 15])
    // only the new part of the feed is announced, the count still starts at the beginning
    const late = detectTriggers(18, events, ctx).announcements
    expect(late.map((a) => a.deaths)).toEqual([10, 15])
  })

  it('a death streak needs three deaths without a kill or assist of yours; a kill or assist resets it', () => {
    const die = kill('enemy', 'Axel Fungus')
    expect(triggers(0, feed(die, die, die))).toEqual(['deathStreak'])
    expect(triggers(0, feed(die, die, kill('Axel Fungus', 'x'), die))).toEqual([])
    expect(triggers(0, feed(die, die, kill('mate', 'x', ['Axel Fungus']), die, die))).toEqual([])
    // somebody else's kill doesn't help
    expect(triggers(0, feed(die, kill('mate', 'x'), die, die))).toEqual(['deathStreak'])
    expect(DEATH_STREAK).toBe(3)
    // six in a row: a streak at three and at six
    expect(triggers(0, feed(die, die, die, die, die, die)).filter((t) => t === 'deathStreak')).toHaveLength(2)
  })

  it('the 5th death is a milestone, not also a streak', () => {
    const die = kill('enemy', 'Axel Fungus')
    expect(triggers(0, feed(die, die, die, die, die, die))).toEqual(['deathStreak', 'myDeathMilestone', 'deathStreak'])
  })
})

describe('pickAnnouncement', () => {
  const at = (trigger: Trigger, time = 1): Announcement => ({ trigger, time })
  const all = Object.fromEntries(TRIGGERS.map((t) => [t, true]))
  it('picks the most important of simultaneous events', () => {
    expect(
      pickAnnouncement([at('myTriple'), at('allyAce'), at('myPenta')], { enabled: all, cooldownS: 6, lastPlayedAt: null, now: 0 })?.trigger
    ).toBe('myPenta')
    expect(pickAnnouncement([at('myQuadra'), at('allyAce')], { enabled: all, cooldownS: 6, lastPlayedAt: null, now: 0 })?.trigger).toBe(
      'allyAce'
    )
  })
  it('keeps the cooldown, except for pentakills, victory and defeat', () => {
    const options = { enabled: all, cooldownS: 6, lastPlayedAt: 10_000, now: 14_000 }
    expect(pickAnnouncement([at('allyAce')], options)).toBeNull()
    expect(pickAnnouncement([at('allyAce')], { ...options, now: 16_000 })?.trigger).toBe('allyAce')
    expect(pickAnnouncement([at('myPenta')], options)?.trigger).toBe('myPenta')
    expect(pickAnnouncement([at('victory')], options)?.trigger).toBe('victory')
  })
  it('skips switched off triggers', () => {
    expect(
      pickAnnouncement([at('myPenta'), at('myTriple')], { enabled: { ...all, myPenta: false }, cooldownS: 6, lastPlayedAt: null, now: 0 })
        ?.trigger
    ).toBe('myTriple')
    expect(pickAnnouncement([at('myPenta')], { enabled: { myPenta: false }, cooldownS: 6, lastPlayedAt: null, now: 0 })).toBeNull()
  })
})

describe('AnnouncerFeed', () => {
  const settings = (over: Partial<Settings['announcer']> = {}): Settings['announcer'] => ({
    enabled: true,
    volume: 0.6,
    voice: true,
    cooldownS: 6,
    triggers: Object.fromEntries(TRIGGERS.map((t) => [t, true])) as Settings['announcer']['triggers'],
    ...over
  })
  const live = (gameTime: number): LiveGameState => ({
    active: true,
    gameTime,
    gameMode: 'KIWI',
    activeChampion: 'Lux',
    activePlayer: 'Axel Fungus#EUW',
    premades: ['blackbird#EUW'],
    players: [
      {
        riotId: 'Axel Fungus#EUW',
        championName: 'Lux',
        team: 'ORDER',
        level: 1,
        kills: 0,
        deaths: 0,
        assists: 0,
        creepScore: 0,
        items: [],
        spells: [],
        position: '',
        isDead: false,
        respawnTimer: 0
      }
    ],
    events: []
  })

  it('starts quietly mid-game, then announces new events once; a new game starts over', () => {
    let now = 0
    const played: Trigger[] = []
    let enabled = true
    const announcer = new AnnouncerFeed({ settings: () => settings({ enabled }), announce: (a) => played.push(a.trigger), now: () => now })
    const events = feed(multi('Axel Fungus', 5))
    announcer.tick(events, live(600))
    expect(played).toEqual([])
    const more = [...events, { EventID: 2, EventName: 'Ace', EventTime: 610, AcingTeam: 'ORDER' }]
    now = 10_000
    announcer.tick(more, live(610))
    announcer.tick(more, live(612))
    expect(played).toEqual(['allyAce'])
    // switched off: keeps counting, so switching it on doesn't replay
    enabled = false
    const evenMore = [...more, { EventID: 3, EventName: 'Multikill', EventTime: 620, KillerName: 'Axel Fungus', KillStreak: 3 }]
    announcer.tick(evenMore, live(620))
    enabled = true
    now = 30_000
    announcer.tick(evenMore, live(622))
    expect(played).toEqual(['allyAce'])
    // the clock went back: a new game, its feed starts at 0 again
    announcer.tick(feed(), live(5))
    announcer.tick(feed({ EventName: 'FirstBlood', Recipient: 'Axel Fungus' }), live(70))
    expect(played).toEqual(['allyAce', 'myFirstBlood'])
  })

  it('the simulated game of the admin tool goes through the same path', () => {
    const played: Trigger[] = []
    const announcer = new AnnouncerFeed({ settings: () => settings({ cooldownS: 0 }), announce: (a) => played.push(a.trigger) })
    const sim = new SimGame({ mode: 'mayhem', map: 12, startAt: 90, inhibitorRespawn: 250 }, () => ({}))
    announcer.tick(sim.liveEvents, sim.live())
    for (const kind of ['firstBlood', 'triple', 'quadra', 'penta', 'premadePenta', 'allyAce', 'enemyAce', 'victory'] as const) {
      sim.fight(kind)
      announcer.tick(sim.liveEvents, sim.live())
    }
    expect(played).toEqual(['myFirstBlood', 'myTriple', 'myQuadra', 'myPenta', 'premadePenta', 'allyAce', 'enemyAce', 'victory'])
  })
})

describe('live feed and lines', () => {
  it('parseLiveEvents keeps every event with an id and the announcer fields', () => {
    const raw = {
      events: {
        Events: [
          { EventID: 0, EventName: 'GameStart', EventTime: 0.02 },
          { EventName: 'NoId', EventTime: 1 },
          { EventID: 7, EventName: 'Multikill', EventTime: 312.4, KillerName: 'a', KillStreak: 4 },
          { EventID: 8, EventName: 'Ace', EventTime: 313, Acer: 'a', AcingTeam: 'CHAOS' }
        ]
      }
    }
    expect(parseLiveEvents(raw)).toEqual([
      expect.objectContaining({ EventID: 0, EventName: 'GameStart' }),
      expect.objectContaining({ EventID: 7, KillStreak: 4, KillerName: 'a' }),
      expect.objectContaining({ EventID: 8, AcingTeam: 'CHAOS' })
    ])
    expect(parseLiveEvents(null)).toEqual([])
  })
  it('sameName ignores tag, case and spaces', () => {
    expect(sameName('Axel Fungus#EUW', 'axelfungus')).toBe(true)
    expect(sameName('', '')).toBe(false)
    expect(sameName('a', 'b')).toBe(false)
  })
  it('has a voice line for every trigger', () => {
    for (const trigger of TRIGGERS) expect(voiceLine({ trigger, deaths: 10, name: 'x' }).length).toBeGreaterThan(3)
    expect(voiceLine({ trigger: 'myDeathMilestone', deaths: 10 }, 0)).toBe('Ten deaths. Impressive.')
  })
})
