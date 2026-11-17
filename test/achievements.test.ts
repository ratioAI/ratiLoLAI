import { describe, expect, it } from 'vitest'
import {
  ACHIEVEMENTS,
  AchievementTracker,
  CONSTELLATION_SPREAD,
  SKY_RADIUS,
  constellationOf,
  evaluateAchievements,
  type AchievementOptions
} from '../src/shared/achievements'
import { GALAXY_TYPES, UNIVERSE, cosmicSeed, extentOf, galaxyOf, length, type Vec3 } from '../src/shared/universe'
import type { GameSummary, SummaryPlayer } from '../src/shared/summary'
import type { Tier } from '../src/shared/types'
import { GameStore } from '../src/main/games'
import { AchievementService } from '../src/main/achievements'

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** noon of day n in local time (so the "day" and "hour" rules don't depend on the time zone) */
const noon = (day: number): number => new Date(2026, 0, 1 + day, 12).getTime()

const player = (puuid: string, over: Partial<SummaryPlayer> = {}): SummaryPlayer => ({
  puuid,
  riotId: `${puuid}#EUW`,
  championId: 1,
  ally: true,
  me: puuid === 'me',
  premade: false,
  kills: 3,
  deaths: 4,
  assists: 5,
  damage: 1000,
  tanked: 1000,
  support: 0,
  gold: 0,
  level: 18,
  items: [],
  augments: [],
  score: 50,
  ...over
})

let nextId = 1
/** One game on day `day` (default: one game per day, ids rising). `me` patches your player. */
function game(over: Partial<GameSummary> & { me?: Partial<SummaryPlayer>; day?: number } = {}): GameSummary {
  const id = nextId++
  const { me, day, ...rest } = over
  return {
    gameId: id,
    createdAt: noon(day ?? id) + id,
    duration: 20 * 60,
    queueId: 2400,
    mode: 'KIWI',
    win: true,
    players: [player('me', { score: 60, ...me }), player('a1'), player('a2'), player('e1', { ally: false }), player('e2', { ally: false })],
    curve: [],
    curveSource: 'none',
    kills: [],
    mvp: 'me',
    blame: 'a1',
    highlights: [],
    cosmos: id * 1000,
    ...rest
  }
}

const unlockedIds = (history: GameSummary[], options: AchievementOptions = {}) =>
  evaluateAchievements(history, undefined, options)
    .filter((result) => result.unlocked)
    .map((result) => result.id)
const resultOf = (history: GameSummary[], id: string, options: AchievementOptions = {}) =>
  evaluateAchievements(history, undefined, options).find((result) => result.id === id)!

describe('achievement conditions', () => {
  it('has about 25 achievements with unique ids', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(25)
    expect(new Set(ACHIEVEMENTS.map((def) => def.id)).size).toBe(ACHIEVEMENTS.length)
  })

  it('combat: multikills, 20 kills, untouchable, one-man army', () => {
    expect(unlockedIds([game({ me: { pentas: 1, multikill: 5 } })])).toEqual(expect.arrayContaining(['penta', 'quadra', 'triple']))
    expect(unlockedIds([game({ me: { multikill: 4 } })])).toEqual(expect.arrayContaining(['quadra', 'triple']))
    expect(unlockedIds([game({ me: { multikill: 4 } })])).not.toContain('penta')
    expect(unlockedIds([game({ me: { kills: 20 } })])).toContain('kills20')
    expect(unlockedIds([game({ me: { kills: 19 } })])).not.toContain('kills20')
    expect(unlockedIds([game({ me: { deaths: 0 } })])).toContain('untouchable')
    expect(unlockedIds([game({ win: false, me: { deaths: 0 } })])).not.toContain('untouchable')
    // team kills 10 + 3 + 3 = 16, half is 8
    expect(unlockedIds([game({ me: { kills: 10 } })])).toContain('oneManArmy')
    expect(unlockedIds([game({ me: { kills: 5 } })])).not.toContain('oneManArmy')
  })

  it('games saved before 1.2 (no multikill / pentas) never count', () => {
    const old = game()
    delete old.players[0].multikill
    delete old.players[0].pentas
    expect(unlockedIds([old])).not.toEqual(expect.arrayContaining(['triple']))
  })

  it('augments: ratio approved, certified, trap enjoyer', () => {
    const tiers: Record<number, Tier[]> = {}
    const options: AchievementOptions = { augTiers: (summary) => ({ me: tiers[summary.gameId] ?? [] }) }
    const approved = Array.from({ length: 10 }, () => game())
    approved.forEach((summary) => (tiers[summary.gameId] = ['S', 'S+', 'S']))
    const trap = game()
    tiers[trap.gameId] = ['D', 'D', 'B', 'D']
    const ids = unlockedIds([...approved, trap], options)
    expect(ids).toEqual(expect.arrayContaining(['ratioApproved', 'ratioCertified', 'trapEnjoyer']))
    expect(resultOf(approved.slice(0, 9), 'ratioCertified', options)).toMatchObject({ unlocked: false, progress: 9, goal: 10 })
    // without tier data the augment achievements stay locked
    expect(unlockedIds(approved)).not.toContain('ratioApproved')
  })

  it('team: MVP counts, serial offender, full stack, best duo', () => {
    const mvps = Array.from({ length: 10 }, () => game())
    expect(resultOf(mvps, 'mvp10')).toMatchObject({ unlocked: true, gameId: mvps[9].gameId })
    expect(resultOf(mvps, 'mvp50')).toMatchObject({ unlocked: false, progress: 10, goal: 50 })

    // the troll is the lowest score of your team
    const troll = () => game({ me: { score: 10 }, mvp: 'a1', blame: 'me' })
    expect(unlockedIds([troll(), troll(), game(), troll()])).not.toContain('serialOffender')
    const three = [troll(), troll(), troll()]
    expect(resultOf(three, 'serialOffender')).toMatchObject({ unlocked: true, gameId: three[2].gameId })

    const stack = game({
      players: [player('me'), ...[1, 2, 3, 4].map((i) => player(`m${i}`, { premade: true })), player('e', { ally: false })]
    })
    expect(unlockedIds([stack])).toContain('fullStack')
    expect(unlockedIds([{ ...stack, win: false }])).not.toContain('fullStack')

    const duo = Array.from({ length: 50 }, (_, i) =>
      game({ players: [player('me'), player(i % 2 ? 'duo' : 'other', { premade: true }), player('duo', { premade: i % 2 === 0 })] })
    )
    expect(resultOf(duo, 'bestDuo')).toMatchObject({ unlocked: true, gameId: duo[49].gameId })
    expect(resultOf(duo.slice(0, 49), 'bestDuo')).toMatchObject({ unlocked: false, progress: 49 })
  })

  it('endurance: game counts, seven days in a row, ten wins in a row', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => game({ day: 500 + Math.floor(i / 20) }))
    expect(resultOf(hundred, 'games100')).toMatchObject({ unlocked: true, gameId: hundred[99].gameId })
    expect(resultOf(hundred, 'games500')).toMatchObject({ progress: 100, goal: 500 })

    const week = [0, 1, 2, 3, 3, 4, 5].map((day) => game({ day: 100 + day }))
    expect(resultOf(week, 'days7')).toMatchObject({ unlocked: false, progress: 6 })
    const gap = game({ day: 108 })
    const full = [...week, game({ day: 106 })]
    expect(resultOf(full, 'days7')).toMatchObject({ unlocked: true, gameId: full[7].gameId })
    expect(resultOf([...week, gap], 'days7').progress).toBe(6)

    const broken = [...Array.from({ length: 5 }, () => game()), game({ win: false }), ...Array.from({ length: 5 }, () => game())]
    expect(resultOf(broken, 'winStreak10')).toMatchObject({ unlocked: false, progress: 5 })
    const wins = Array.from({ length: 10 }, () => game())
    expect(resultOf(wins, 'winStreak10')).toMatchObject({ unlocked: true, gameId: wins[9].gameId })
  })

  it('secret: throw, miracle, donation account, speedrun, night owl', () => {
    const curve = (gold: number) => [
      { t: 0, gold: 0, kills: 0 },
      { t: 600, gold, kills: 0 },
      { t: 1200, gold: 0, kills: 0 }
    ]
    expect(unlockedIds([game({ win: false, curve: curve(8000) })])).toContain('throwOfTheCentury')
    expect(unlockedIds([game({ win: true, curve: curve(8000) })])).not.toContain('throwOfTheCentury')
    expect(unlockedIds([game({ win: true, curve: curve(-8000) })])).toContain('miracle')
    expect(unlockedIds([game({ win: true, curve: curve(-7999) })])).not.toContain('miracle')
    expect(unlockedIds([game({ me: { deaths: 15 } })])).toContain('donationAccount')
    expect(unlockedIds([game({ duration: 13 * 60 + 59 })])).toContain('speedrun')
    expect(unlockedIds([game({ duration: 14 * 60 })])).not.toContain('speedrun')
    expect(unlockedIds([game({ duration: 13 * 60, win: false })])).not.toContain('speedrun')
    const at = (hour: number) => game({ createdAt: new Date(2026, 5, 1, hour, 30).getTime() + nextId })
    expect(unlockedIds([at(3)])).toContain('nightOwl')
    expect(unlockedIds([at(4)])).toContain('nightOwl')
    expect(unlockedIds([at(5)])).not.toContain('nightOwl')
    expect(unlockedIds([at(2)])).not.toContain('nightOwl')
  })

  it('cosmos: galaxies from games and flights, both flight kinds, every kind of galaxy', () => {
    const history = Array.from({ length: 30 }, () => game())
    const visited = new Set(history.map((summary) => galaxyOf(cosmicSeed(summary.cosmos!)).id)).size
    expect(resultOf(history, 'galaxies25').progress).toBe(Math.min(25, visited))

    const fromFlights = UNIVERSE.slice(0, 100).map((galaxy) => galaxy.id)
    const results = evaluateAchievements([], { flights: { wormhole: 2, slingshot: 1 }, galaxiesVisited: fromFlights })
    const byId = new Map(results.map((result) => [result.id, result]))
    expect(byId.get('galaxies100')).toMatchObject({ unlocked: true })
    expect(byId.get('galaxies100')?.gameId).toBeUndefined()
    expect(byId.get('bothFlights')).toMatchObject({ unlocked: true })
    expect(evaluateAchievements([], { flights: { wormhole: 3 }, galaxiesVisited: [] }).find((r) => r.id === 'bothFlights')?.unlocked).toBe(
      false
    )
    const oneOfEach = GALAXY_TYPES.map((type) => UNIVERSE.find((galaxy) => galaxy.type === type)!.id)
    const kinds = evaluateAchievements([], { flights: {}, galaxiesVisited: oneOfEach }).find((r) => r.id === 'allKinds')
    expect(kinds).toMatchObject({ unlocked: true, progress: GALAXY_TYPES.length })
  })

  it('unlocks at the first game that meets the condition, in time order whatever the input order', () => {
    const early = game({ me: { kills: 25 } })
    const late = game({ me: { kills: 30 } })
    expect(resultOf([late, early], 'kills20')).toMatchObject({ gameId: early.gameId, at: early.createdAt + early.duration * 1000 })
  })
})

describe('incremental = full', () => {
  it('adding games one by one gives the same results as evaluating the whole history', () => {
    const tiers = (summary: GameSummary): Record<string, Tier[]> => ({ me: summary.gameId % 3 ? ['S', 'S'] : ['D', 'D', 'D'] })
    const history = Array.from({ length: 120 }, (_, i) =>
      game({
        win: i % 4 !== 1,
        me: { kills: (i * 7) % 23, deaths: (i * 5) % 17, multikill: i % 9, pentas: i === 77 ? 1 : 0, score: 30 + ((i * 13) % 50) },
        mvp: i % 3 ? 'me' : 'a1',
        day: 900 + Math.floor(i / 3)
      })
    )
    const extra = { flights: { wormhole: 1 }, galaxiesVisited: [1, 2, 3] }
    const tracker = new AchievementTracker({ augTiers: tiers })
    history.forEach((summary, i) => {
      tracker.add(summary)
      if (i % 17 === 0 || i === history.length - 1)
        expect(tracker.results(extra)).toEqual(evaluateAchievements(history.slice(0, i + 1), extra, { augTiers: tiers }))
    })
  })

  it('refuses a game that is older than the last one or already there', () => {
    const a = game()
    const b = game()
    const tracker = new AchievementTracker()
    tracker.add(b)
    expect(tracker.canAdd(a)).toBe(false)
    expect(tracker.canAdd(b)).toBe(false)
    expect(() => tracker.add(a)).toThrow()
  })
})

describe('constellations', () => {
  it('are deterministic, have 4 to 9 stars joined by a spanning tree plus at most one line', () => {
    for (const def of ACHIEVEMENTS) {
      const first = constellationOf(def.id)
      expect(JSON.stringify(first)).toBe(JSON.stringify(constellationOf(def.id)))
      expect(first.stars.length).toBeGreaterThanOrEqual(4)
      expect(first.stars.length).toBeLessThanOrEqual(9)
      expect(first.lines.length).toBeGreaterThanOrEqual(first.stars.length - 1)
      expect(first.lines.length).toBeLessThanOrEqual(first.stars.length)
      // connected
      const reached = new Set([0])
      for (let changed = true; changed;) {
        changed = false
        for (const [a, b] of first.lines)
          if (reached.has(a) !== reached.has(b)) {
            reached.add(a)
            reached.add(b)
            changed = true
          }
      }
      expect(reached.size).toBe(first.stars.length)
    }
  })

  it('sit outside every galaxy, on the sky sphere', () => {
    const outermost = Math.max(...UNIVERSE.map((galaxy) => length(galaxy.pos) + galaxy.radius * extentOf(galaxy)))
    expect(SKY_RADIUS).toBeGreaterThan(outermost)
    for (const def of ACHIEVEMENTS) for (const star of constellationOf(def.id).stars) expect(length(star)).toBeCloseTo(SKY_RADIUS, 6)
  })

  it('never overlap: every star is closer to its own centre than to any other constellation', () => {
    const angle = (a: Vec3, b: Vec3) =>
      Math.acos(Math.min(1, Math.max(-1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (length(a) * length(b)))))
    const all = ACHIEVEMENTS.map((def) => constellationOf(def.id))
    for (let i = 0; i < all.length; i++) {
      for (const star of all[i].stars) expect(angle(star, all[i].dir)).toBeLessThanOrEqual(CONSTELLATION_SPREAD + 1e-9)
      for (let j = i + 1; j < all.length; j++) expect(angle(all[i].dir, all[j].dir)).toBeGreaterThan(2 * CONSTELLATION_SPREAD)
    }
  })
})

describe('AchievementService', () => {
  const setup = (history: GameSummary[]) => {
    const store = new GameStore(':memory:')
    history.forEach((summary) => store.save(summary))
    const announced: string[][] = []
    const service = new AchievementService({
      db: store.database,
      history: () => store.all(),
      tiers: async () => null,
      unlocked: (ids) => announced.push(ids),
      log: () => undefined
    })
    return { store, service, announced }
  }

  it('the first run stores the history’s unlocks quietly, later games announce theirs', async () => {
    const first = game({ me: { kills: 22 } })
    const { store, service, announced } = setup([first])
    await service.rebuild()
    expect(announced).toEqual([])
    const kills = service.list().find((achievement) => achievement.id === 'kills20')!
    expect(kills).toMatchObject({ unlocked: true, gameId: first.gameId, seen: true, unlockedAt: first.createdAt + first.duration * 1000 })

    const next = game({ me: { deaths: 0 } })
    store.save(next)
    await service.onGame(next)
    expect(announced).toEqual([['untouchable']])
    expect(service.list().find((achievement) => achievement.id === 'untouchable')).toMatchObject({ seen: false, gameId: next.gameId })
    service.store.markSeen(['untouchable'])
    expect(service.list().find((achievement) => achievement.id === 'untouchable')?.seen).toBe(true)
  })

  it('keeps unlocked_at forever, even when the game that earned it is gone', async () => {
    const earned = game({ me: { kills: 22 } })
    const { store, service } = setup([earned])
    await service.rebuild()
    const before = service.list().find((achievement) => achievement.id === 'kills20')!.unlockedAt
    store.database.exec(`DELETE FROM games WHERE game_id = ${earned.gameId}`)
    await service.rebuild()
    expect(service.list().find((achievement) => achievement.id === 'kills20')).toMatchObject({ unlocked: true, unlockedAt: before })
  })

  it('an older game makes it work everything out again; flights count for the cosmos', async () => {
    const newer = game()
    const older = { ...game(), createdAt: newer.createdAt - DAY, me: undefined }
    const { store, service, announced } = setup([newer])
    await service.rebuild()
    store.save({ ...older, players: older.players.map((p) => (p.me ? { ...p, kills: 30 } : p)) })
    await service.onGame({ ...older, players: older.players.map((p) => (p.me ? { ...p, kills: 30 } : p)) })
    expect(announced.flat()).toContain('kills20')
    await service.onFlight('wormhole', 1)
    await service.onFlight('slingshot', 2)
    expect(announced.flat()).toContain('bothFlights')
  })
})
