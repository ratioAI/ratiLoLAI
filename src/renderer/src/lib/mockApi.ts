/**
 * Demo implementation of the IPC API. It is used when the UI runs in a normal browser
 * (web demo / GitHub Pages / screenshots). Static data is loaded live from Data Dragon;
 * all statistics are *synthetic* and generated from a fixed seed.
 */
import { buildChampionView, buildTierList } from '@shared/analysis'
import { DDRAGON, loadStaticData } from '@shared/staticData'
import { buildMayhemData, mayhemPool, type AmAugmentRow, type AmComboRow, type AmFile, type AugmentList, type CherryAugment } from '@shared/mayhem'
import type {
  ChampionRoleStats,
  ChampSelectState,
  ClientStatus,
  CrawlerStatus,
  LiveGameState,
  MatchSummary,
  PatchStats,
  ProfileData,
  RcApi,
  RcEvents,
  Role,
  GameMode,
  MayhemData,
  MayhemPersonal,
  StatRole,
  ScoutResult,
  Settings,
  StaticData,
  WG
} from '@shared/types'
import { ROLES } from '@shared/types'

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, arr: T[]): T => arr[Math.floor(r() * arr.length)]

function wg(r: () => number, games: number, baseWr: number, spread = 0.04): WG {
  const g = Math.max(1, Math.round(games))
  const w = Math.round(g * Math.min(0.7, Math.max(0.3, baseWr + (r() - 0.5) * spread * 2)))
  return { g, w }
}

const ROLE_BY_TAG: Record<string, Role[]> = {
  Marksman: ['BOTTOM'],
  Support: ['UTILITY'],
  Mage: ['MIDDLE', 'UTILITY'],
  Assassin: ['MIDDLE', 'JUNGLE'],
  Fighter: ['TOP', 'JUNGLE'],
  Tank: ['TOP', 'UTILITY', 'JUNGLE']
}

const TREE_BY_TAG: Record<string, [number, number]> = {
  Marksman: [8000, 8100],
  Support: [8400, 8200],
  Mage: [8200, 8300],
  Assassin: [8100, 8000],
  Fighter: [8000, 8400],
  Tank: [8400, 8300]
}

const SPELLS: Record<Role, number[][]> = {
  TOP: [[4, 12], [4, 14], [4, 6]],
  JUNGLE: [[4, 11], [6, 11]],
  MIDDLE: [[4, 14], [4, 12], [4, 21]],
  BOTTOM: [[4, 7], [4, 21], [4, 1]],
  UTILITY: [[4, 14], [4, 3], [4, 7]]
}

const ARAM_SPELLS = [[4, 32], [32, 14], [4, 14]]
const ARAM_STARTERS = [[1056, 2003, 2003, 1052], [1055, 2003, 1036], [1054, 1028, 2003]]

const STARTERS: Record<Role, number[][]> = {
  TOP: [[1055, 2003], [1054, 2003], [1056, 2003]],
  JUNGLE: [[1101, 2003], [1102, 2003], [1103, 2003]],
  MIDDLE: [[1056, 2003, 2003], [1055, 2003], [1082, 2003]],
  BOTTOM: [[1055, 2003], [1083]],
  UTILITY: [[3865, 2003, 2003]]
}

function itemPool(d: StaticData, tag: string): number[] {
  const completed = Object.values(d.items).filter((i) => i.completed && i.gold >= 2200 && i.gold <= 3500)
  const has = (i: { tags: string[] }, ...t: string[]): boolean => t.some((x) => i.tags.includes(x))
  let pool: typeof completed
  switch (tag) {
    case 'Marksman':
      pool = completed.filter((i) => has(i, 'CriticalStrike', 'AttackSpeed') && has(i, 'Damage'))
      break
    case 'Mage':
      pool = completed.filter((i) => has(i, 'SpellDamage') && !has(i, 'Health'))
      break
    case 'Support':
      pool = completed.filter((i) => has(i, 'ManaRegen', 'Aura', 'HealthRegen') && !has(i, 'Damage'))
      break
    case 'Tank':
      pool = completed.filter((i) => has(i, 'Health') && has(i, 'Armor', 'SpellBlock') && !has(i, 'Damage', 'SpellDamage'))
      break
    case 'Assassin':
      pool = completed.filter((i) => has(i, 'ArmorPenetration', 'Damage') && !has(i, 'CriticalStrike', 'Armor'))
      break
    default:
      pool = completed.filter((i) => has(i, 'Damage') && has(i, 'Health', 'CooldownReduction', 'AbilityHaste'))
  }
  const ids = pool.map((i) => i.id)
  return ids.length >= 6 ? ids : completed.map((i) => i.id)
}

function bootsFor(d: StaticData, tag: string): number[] {
  const all = Object.values(d.items)
    .filter((i) => i.boots)
    .map((i) => i.id)
  const prefer: Record<string, number[]> = {
    Marksman: [3006, 3009],
    Mage: [3020, 3158],
    Support: [3158, 3009, 3111],
    Tank: [3047, 3111],
    Assassin: [3158, 3047, 3111],
    Fighter: [3047, 3111]
  }
  const p = (prefer[tag] ?? []).filter((id) => all.includes(id))
  return p.length ? p : all.slice(0, 2)
}

function generateStats(d: StaticData, patch: string, mode: GameMode = 'ranked'): PatchStats {
  const aram = mode === 'aram'
  const r = rng(aram ? 4242 : 1337)
  const stats: PatchStats = { patch, mode, matches: aram ? 61_507 : 48_213, updatedAt: Date.now() - 1000 * 60 * 42, bans: {}, champions: {} }
  const trees = d.runeTrees
  const shardSets: Record<string, number[][]> = {
    Marksman: [[5005, 5008, 5011], [5008, 5008, 5011]],
    Mage: [[5008, 5008, 5011], [5007, 5008, 5011]],
    Support: [[5007, 5008, 5011], [5008, 5010, 5011]],
    Tank: [[5007, 5010, 5011], [5008, 5008, 5001]],
    Assassin: [[5008, 5008, 5011], [5008, 5010, 5011]],
    Fighter: [[5008, 5008, 5011], [5007, 5008, 5001]]
  }

  for (const champ of Object.values(d.champions)) {
    const tag = champ.tags[0] ?? 'Fighter'
    const roles = [...(ROLE_BY_TAG[tag] ?? ['TOP'])]
    if (champ.tags[1] && ROLE_BY_TAG[champ.tags[1]] && r() < 0.35) roles.push(ROLE_BY_TAG[champ.tags[1]][0])
    const mainRole = roles[0]
    const secondRole = r() < 0.4 ? roles.find((x) => x !== mainRole) : undefined
    const popularity = Math.pow(r(), 2.2)
    const baseWr = 0.47 + r() * 0.075
    if (!aram) stats.bans[champ.key] = Math.round(stats.matches * Math.pow(r(), 3) * 0.35)

    const entries: [StatRole | undefined, number][] = aram
      ? [['ARAM', 1]]
      : [
          [mainRole, 1],
          [secondRole, 0.15 + r() * 0.3]
        ]
    for (const [role, share] of entries) {
      if (!role) continue
      const games = aram ? Math.round(stats.matches * 10 / 172 * (0.9 + r() * 0.2)) : Math.round((300 + popularity * 9000) * share)
      const wr = baseWr + (share < 1 ? -0.015 : 0)
      const s: ChampionRoleStats = {
        championId: champ.key,
        role,
        ...wg(r, games, wr, 0.005),
        runes: {},
        spells: {},
        starters: {},
        core: {},
        boots: {},
        slots: [{}, {}, {}, {}, {}, {}],
        skillMax: {},
        skillPath: {},
        matchups: {},
        duration: games * (1650 + r() * 250)
      }

      // runes
      const [primId, subId] = TREE_BY_TAG[tag] ?? [8000, 8400]
      for (let v = 0; v < 4; v++) {
        const prim = trees.find((t) => t.id === (v === 3 ? subId : primId)) ?? trees[0]
        const sub = trees.find((t) => t.id === (v === 3 ? primId : subId) && t.id !== prim.id) ?? trees[1]
        const primary = prim.slots.map((slot) => pick(r, slot).id)
        const subSlots = [1, 2, 3].sort(() => r() - 0.5).slice(0, 2).sort()
        const secondary = subSlots.map((i) => pick(r, sub.slots[i] ?? sub.slots[1]).id)
        const shards = pick(r, shardSets[tag] ?? shardSets.Fighter)
        const key = [prim.id, primary.join(','), sub.id, secondary.join(','), shards.join(',')].join('|')
        s.runes[key] = wg(r, s.g * [0.46, 0.21, 0.09, 0.05][v], wr)
      }

      // spells & starters
      const itemRole: Role = role === 'ARAM' ? mainRole : role
      ;(aram ? ARAM_SPELLS : SPELLS[itemRole]).forEach((sp, i) => (s.spells[sp.join(',')] = wg(r, s.g * [0.78, 0.15, 0.05][i], wr)))
      ;(aram ? ARAM_STARTERS : STARTERS[itemRole]).forEach((st, i) => (s.starters[[...st].sort((a, b) => a - b).join(',')] = wg(r, s.g * [0.7, 0.2, 0.08][i], wr)))

      // items
      const pool = itemPool(d, itemRole === 'UTILITY' && tag !== 'Mage' ? 'Support' : tag)
      const rp = [...pool].sort(() => r() - 0.5)
      const coreA = rp.slice(0, 3)
      const variants = [coreA, [coreA[0], coreA[2], coreA[1]], [coreA[0], coreA[1], rp[3]], [rp[4], coreA[0], coreA[1]]]
      variants.forEach((c, i) => (s.core[c.join(',')] = wg(r, s.g * [0.31, 0.16, 0.1, 0.06][i], wr, 0.03)))
      bootsFor(d, tag).forEach((b, i) => (s.boots[b] = wg(r, s.g * ([0.66, 0.22][i] ?? 0.05), wr)))
      for (let slot = 0; slot < 6; slot++) {
        const candidates = slot < 3 ? coreA : rp.slice(2, 10)
        candidates.forEach((id, i) => (s.slots[slot][id] = wg(r, (s.g / (slot + 1)) * (0.5 / (i + 1)), wr + 0.02, 0.05)))
      }

      // skills
      const maxOrders = tag === 'Marksman' ? ['QWE', 'QEW', 'WQE'] : tag === 'Tank' ? ['QEW', 'WQE', 'EQW'] : ['QEW', 'QWE', 'EQW']
      maxOrders.forEach((m, i) => {
        s.skillMax[m] = wg(r, s.g * [0.74, 0.18, 0.06][i], wr)
        const [a, b, c] = [...m]
        const path = `${a}${b}${c}${a}${a}R${a}${b}${a}${b}R${b}${b}${c}${c}`
        s.skillPath[path] = wg(r, s.g * [0.52, 0.12, 0.04][i], wr)
      })
      stats.champions[`${champ.key}:${role}`] = s
    }
  }

  // matchups within each role
  for (const role of aram ? (['ARAM'] as StatRole[]) : ROLES) {
    const inRole = Object.values(stats.champions).filter((c) => c.role === role)
    for (const c of inRole) {
      for (const o of inRole) {
        if (o === c || r() < 0.55) continue
        const games = Math.round(Math.min(c.g, o.g) * (0.05 + r() * 0.08))
        if (games < 5) continue
        c.matchups[o.championId] = wg(r, games, c.w / c.g - (o.w / o.g - 0.5), 0.06)
      }
    }
  }
  return stats
}

function demoProfile(d: StaticData, riotId: string): ProfileData {
  const r = rng([...riotId].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7))
  const champs = Object.values(d.champions)
  const favs = [0, 1, 2, 3].map(() => pick(r, champs).key)
  const [gameName, tagLine = 'EUW'] = riotId.split('#')
  const matches: MatchSummary[] = Array.from({ length: 15 }, (_, i) => {
    const championId = r() < 0.75 ? pick(r, favs) : pick(r, champs).key
    const win = r() < 0.56
    const items = [...itemPool(d, d.champions[championId]?.tags[0] ?? 'Fighter')].sort(() => r() - 0.5).slice(0, 5)
    return {
      matchId: `EUW1_70000${i}`,
      queueId: r() < 0.8 ? 420 : 440,
      gameCreation: Date.now() - i * 1000 * 60 * 60 * 5 - Math.round(r() * 1000 * 60 * 60 * 3),
      gameDuration: 1400 + Math.round(r() * 900),
      win,
      remake: false,
      championId,
      role: 'MIDDLE',
      kills: Math.round(r() * 12),
      deaths: Math.round(1 + r() * 7),
      assists: Math.round(r() * 14),
      cs: Math.round(150 + r() * 120),
      gold: Math.round(9000 + r() * 6000),
      damage: Math.round(12000 + r() * 25000),
      visionScore: Math.round(10 + r() * 30),
      items: [...items, 0, 3340],
      spells: [4, 14],
      keystone: pick(r, [8112, 8214, 8010, 8229]),
      subStyle: pick(r, [8300, 8400, 8200]),
      killParticipation: 0.35 + r() * 0.4,
      teams: Array.from({ length: 10 }, (_, j) => ({
        championId: j === 0 ? championId : pick(r, champs).key,
        riotId: j === 0 ? riotId : `Player${Math.floor(r() * 9999)}#EUW`,
        teamId: j < 5 ? 100 : 200,
        puuid: `p${j}`
      }))
    }
  })
  const summary = new Map<number, { games: number; wins: number; k: number; d: number; a: number }>()
  for (const m of matches) {
    const s = summary.get(m.championId) ?? { games: 0, wins: 0, k: 0, d: 0, a: 0 }
    s.games++
    s.wins += m.win ? 1 : 0
    s.k += m.kills
    s.d += m.deaths
    s.a += m.assists
    summary.set(m.championId, s)
  }
  return {
    puuid: 'demo',
    gameName,
    tagLine,
    platform: 'euw1',
    summonerLevel: 312,
    profileIconId: 5367,
    ranked: [
      { queueType: 'RANKED_SOLO_5x5', tier: 'DIAMOND', rank: 'II', leaguePoints: 61, wins: 118, losses: 97 },
      { queueType: 'RANKED_FLEX_SR', tier: 'EMERALD', rank: 'I', leaguePoints: 23, wins: 24, losses: 19 }
    ],
    mastery: favs.map((championId, i) => ({ championId, level: 10 + (3 - i) * 4, points: 480_000 - i * 95_000 })),
    matches,
    championSummary: [...summary.entries()]
      .map(([championId, s]) => ({ championId, games: s.games, wins: s.wins, kda: (s.k + s.a) / Math.max(1, s.d) }))
      .sort((a, b) => b.games - a.games)
  }
}

export function createMockApi(): RcApi {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const emit = <K extends keyof RcEvents>(e: K, p: RcEvents[K]): void => listeners.get(e)?.forEach((cb) => cb(p))

  let staticData: Promise<StaticData> | null = null
  const getStatic = (): Promise<StaticData> =>
    (staticData ??= (async () => {
      const get = async <T,>(path: string): Promise<T> => (await fetch(`${DDRAGON}${path}`)).json() as Promise<T>
      const version = (await get<string[]>('/api/versions.json'))[0]
      return loadStaticData(get, version, settings.language)
    })())

  const statsPromise: Partial<Record<GameMode, Promise<PatchStats>>> = {}
  const getStats = (mode: GameMode = 'ranked'): Promise<PatchStats> =>
    (statsPromise[mode] ??= getStatic().then((d) => generateStats(d, d.patch, mode)))

  let mayhemPromise: Promise<MayhemData> | null = null
  const getMayhem = (): Promise<MayhemData> =>
    (mayhemPromise ??= (async () => {
      const cd = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global'
      const am = 'https://arammayhem.com/data/v1/latest'
      const j = async <T,>(u: string): Promise<T> => (await fetch(u)).json() as Promise<T>
      const [en, de, aug, combos, lists] = await Promise.all([
        j<CherryAugment[]>(`${cd}/default/v1/cherry-augments.json`),
        j<CherryAugment[]>(`${cd}/de_de/v1/cherry-augments.json`).catch(() => null),
        j<AmFile<AmAugmentRow>>(`${am}/augments.json`).catch(() => null),
        j<AmFile<AmComboRow>>(`${am}/combos.json`).catch(() => null),
        j<AugmentList[]>(`${cd}/default/v1/augment-lists.json`).catch(() => null)
      ])
      return buildMayhemData(en, de ?? en, aug, combos, Date.now(), mayhemPool(lists))
    })())

  let settings: Settings = {
    platform: 'euw1',
    language: 'en_US',
    hasApiKey: true,
    leaguePath: '',
    crawler: {
      seedTiers: ['CHALLENGER', 'GRANDMASTER', 'MASTER'],
      extraPlatforms: ['kr'],
      maxMatchesPerRun: 1500,
      matchesPerPlayer: 10,
      minGamesForTierList: 20
    },
    overlay: { enabled: true, hotkey: 'Alt+Shift+A', autoExpand: true, cardFrames: true, animation: 'smooth', gameDisplayId: null },
    minimap: { enabled: true, inhibitors: true, scale: 1 },
    client: { autoImportRunes: true, autoImportItems: true, autoImportSpells: false, flashOn: 'F', autoAccept: true }
  }

  let crawler: CrawlerStatus = {
    mode: 'ranked',
    running: false,
    phase: 'done',
    message: 'Done – 1500 new matches',
    patch: null,
    players: 3120,
    playersDone: 412,
    matchesThisRun: 1500,
    matchesTotal: 48_213,
    skippedOldPatch: 311,
    requests: 3322,
    startedAt: Date.now() - 1000 * 60 * 95,
    lastError: null
  }
  let crawlTimer: ReturnType<typeof setInterval> | null = null

  const client: ClientStatus = {
    connected: true,
    phase: 'ChampSelect',
    summoner: { gameName: 'Demo Summoner', tagLine: 'EUW', puuid: 'demo', summonerLevel: 312, profileIconId: 5367, platform: 'euw1' }
  }

  const champSelect = async (): Promise<ChampSelectState> => {
    const d = await getStatic()
    const byName = (id: string): number => Object.values(d.champions).find((c) => c.id === id)?.key ?? 1
    const ally = (cellId: number, champ: string, role: Role, isLocal = false) => ({
      cellId,
      championId: byName(champ),
      role,
      isLocal,
      team: 'ally' as const,
      spell1Id: 4,
      spell2Id: 14
    })
    const enemy = (cellId: number, champ: string) => ({
      cellId,
      championId: byName(champ),
      role: null,
      isLocal: false,
      team: 'enemy' as const,
      spell1Id: 0,
      spell2Id: 0
    })
    const noRole = (p: ReturnType<typeof ally>) => ({ ...p, role: null })
    return {
      active: true,
      queueId: 2400,
      mode: 'mayhem',
      myChampionId: byName('Lux'),
      myRole: null,
      locked: false,
      allies: [ally(0, 'Garen', 'TOP'), ally(1, 'LeeSin', 'JUNGLE'), ally(2, 'Lux', 'MIDDLE', true), ally(3, 'Jinx', 'BOTTOM'), ally(4, 'Thresh', 'UTILITY')].map(noRole),
      enemies: [enemy(5, 'Darius'), enemy(6, 'Vi'), enemy(7, 'Syndra'), enemy(8, 'Kaisa'), enemy(9, 'Nautilus')],
      bans: []
    }
  }

  const api: RcApi = {
    getStatic,
    getSettings: async () => settings,
    saveSettings: async (patch) => {
      settings = { ...settings, ...patch, crawler: { ...settings.crawler, ...patch.crawler }, client: { ...settings.client, ...patch.client } }
      return settings
    },
    setApiKey: async () => ({ ok: true, message: 'Web demo: the key is not stored.' }),
    getPatches: async (mode) => {
      const s = await getStats(mode)
      return [{ patch: s.patch, matches: s.matches, updatedAt: s.updatedAt }]
    },
    getTierList: async (_patch, mode) => buildTierList(await getStats(mode), settings.crawler.minGamesForTierList),
    getChampionBuild: async (_patch, championId, role, mode) => {
      const s = await getStats(mode)
      return buildChampionView(s, championId, role, buildTierList(s, settings.crawler.minGamesForTierList))
    },
    crawlerStart: async (mode) => {
      const s = await getStats(mode)
      crawler = { ...crawler, mode, running: true, phase: 'crawling', message: 'Analysing matches (EUW1)', matchesThisRun: 0, playersDone: 0, startedAt: Date.now(), patch: s.patch }
      emit('crawler', crawler)
      crawlTimer = setInterval(() => {
        crawler = {
          ...crawler,
          matchesThisRun: crawler.matchesThisRun + 1,
          matchesTotal: crawler.matchesTotal + 1,
          playersDone: crawler.playersDone + (Math.random() < 0.2 ? 1 : 0),
          requests: crawler.requests + 2
        }
        emit('crawler', crawler)
      }, 700)
    },
    crawlerStop: async () => {
      if (crawlTimer) clearInterval(crawlTimer)
      crawler = { ...crawler, running: false, phase: 'done', message: 'Stopped' }
      emit('crawler', crawler)
    },
    crawlerStatus: async () => ({ ...crawler, patch: (await getStats()).patch }),
    getMayhemData: getMayhem,
    overlayPreview: async (championId) => {
      window.open(`#/overlay?champ=${championId}`, '_blank')
    },
    setOverlayInteractive: () => undefined,
    appInfo: async () => ({ version: 'web-demo', update: { status: 'dev' } }),
    installUpdate: async () => undefined,
    overlayDiagnostics: async () => ({
      gameMode: null,
      queueId: null,
      mayhem: false,
      level: 0,
      dead: false,
      augmentPending: false,
      canOpen: false,
      scanning: false,
      cardsVisible: false,
      overlayVisible: false,
      captureStream: 'off',
      log: ['web demo – no game running']
    }),
    overlayTestScan: async () => ({ captureMs: 0, screens: [] }),
    openDiagnosticsFolder: async () => undefined,
    getMayhemPersonal: async (): Promise<MayhemPersonal> => {
      const m = await getMayhem()
      const r = rng(99)
      const ids = Object.values(m.augments)
        .filter((a) => a.pickRate != null)
        .map((a) => a.id)
      const d = await getStatic()
      const champs = Object.values(d.champions)
      const recent = Array.from({ length: 12 }, (_, i) => ({
        gameId: i,
        championId: pick(r, champs).key,
        win: r() < 0.58,
        augments: [0, 1, 2, 3].map(() => pick(r, ids.slice(0, 40))),
        createdAt: Date.now() - i * 1000 * 60 * 60 * 7
      }))
      const agg = new Map<number, { games: number; wins: number }>()
      for (const g of recent) for (const id of g.augments) {
        const e = agg.get(id) ?? { games: 0, wins: 0 }
        e.games++
        e.wins += g.win ? 1 : 0
        agg.set(id, e)
      }
      return {
        games: recent.length,
        wins: recent.filter((g) => g.win).length,
        augments: [...agg.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.games - a.games),
        champions: [],
        recent
      }
    },
    resetStats: async () => undefined,
    clientStatus: async () => client,
    champSelect,
    importBuild: async (championId) => {
      const d = await getStatic()
      return {
        runes: `RC: ${d.champions[championId]?.name}`,
        items: `RC ${d.champions[championId]?.name}`,
        errors: []
      }
    },
    liveGame: async (): Promise<LiveGameState | null> => null,
    lookupProfile: async (riotId) => demoProfile(await getStatic(), riotId),
    scoutActiveGame: async (): Promise<ScoutResult | null> => {
      const cs = await champSelect()
      const tiers = ['DIAMOND', 'EMERALD', 'MASTER', 'DIAMOND', 'PLATINUM']
      return {
        gameId: 1,
        gameMode: 'CLASSIC',
        gameStartTime: Date.now() - 1000 * 60 * 4,
        players: [...cs.allies, ...cs.enemies].map((p, i) => ({
          puuid: `p${i}`,
          riotId: i === 2 ? 'Demo Summoner#EUW' : `Player${1000 + i * 137}#EUW`,
          championId: p.championId,
          teamId: i < 5 ? 100 : 200,
          spells: [4, [12, 11, 14, 7, 3][i % 5]],
          ranked: { queueType: 'RANKED_SOLO_5x5', tier: tiers[i % 5], rank: ['I', 'II', 'III', 'IV'][i % 4], leaguePoints: (i * 17) % 100, wins: 60 + i * 7, losses: 55 + i * 5 },
          recent: null
        }))
      }
    },
    openExternal: async (url) => void window.open(url, '_blank'),
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb as (p: unknown) => void)
      listeners.set(event, set)
      return () => set.delete(cb as (p: unknown) => void)
    }
  }
  return api
}
