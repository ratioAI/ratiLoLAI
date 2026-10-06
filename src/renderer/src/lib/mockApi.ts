/**
 * Fake IPC API for running the UI in a plain browser (web demo, GitHub Pages, screenshots).
 * Static data still comes live from Data Dragon, but all stats are synthetic and generated from a
 * fixed seed so the demo looks the same every time.
 */
import { buildChampionView, buildTierList } from '@shared/analysis'
import { DDRAGON, loadStaticData } from '@shared/staticData'
import {
  buildMayhemData,
  mayhemPool,
  type AmAugmentRow,
  type AmComboRow,
  type AmFile,
  type AugmentList,
  type CherryAugment
} from '@shared/mayhem'
import { buildSummary, type GameSummary } from '@shared/summary'
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

// mulberry32: tiny seeded PRNG, returns floats in [0, 1)
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

const pick = <T>(rand: () => number, items: T[]): T => items[Math.floor(rand() * items.length)]

// games/wins pair with the win rate jittered around baseWr and clamped to 30-70%
function wg(rand: () => number, games: number, baseWr: number, spread = 0.04): WG {
  const g = Math.max(1, Math.round(games))
  const w = Math.round(g * Math.min(0.7, Math.max(0.3, baseWr + (rand() - 0.5) * spread * 2)))
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
  TOP: [
    [4, 12],
    [4, 14],
    [4, 6]
  ],
  JUNGLE: [
    [4, 11],
    [6, 11]
  ],
  MIDDLE: [
    [4, 14],
    [4, 12],
    [4, 21]
  ],
  BOTTOM: [
    [4, 7],
    [4, 21],
    [4, 1]
  ],
  UTILITY: [
    [4, 14],
    [4, 3],
    [4, 7]
  ]
}

const ARAM_SPELLS = [
  [4, 32],
  [32, 14],
  [4, 14]
]
const ARAM_STARTERS = [
  [1056, 2003, 2003, 1052],
  [1055, 2003, 1036],
  [1054, 1028, 2003]
]

const STARTERS: Record<Role, number[][]> = {
  TOP: [
    [1055, 2003],
    [1054, 2003],
    [1056, 2003]
  ],
  JUNGLE: [
    [1101, 2003],
    [1102, 2003],
    [1103, 2003]
  ],
  MIDDLE: [
    [1056, 2003, 2003],
    [1055, 2003],
    [1082, 2003]
  ],
  BOTTOM: [[1055, 2003], [1083]],
  UTILITY: [[3865, 2003, 2003]]
}

// rough list of completed items that suit a champion class
function itemPool(data: StaticData, tag: string): number[] {
  const completed = Object.values(data.items).filter((item) => item.completed && item.gold >= 2200 && item.gold <= 3500)
  const has = (item: { tags: string[] }, ...wanted: string[]): boolean => wanted.some((name) => item.tags.includes(name))
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
  const ids = pool.map((item) => item.id)
  // too few matches for this class: just use every completed item
  return ids.length >= 6 ? ids : completed.map((item) => item.id)
}

function bootsFor(data: StaticData, tag: string): number[] {
  const all = Object.values(data.items)
    .filter((item) => item.boots)
    .map((item) => item.id)
  const prefer: Record<string, number[]> = {
    Marksman: [3006, 3009],
    Mage: [3020, 3158],
    Support: [3158, 3009, 3111],
    Tank: [3047, 3111],
    Assassin: [3158, 3047, 3111],
    Fighter: [3047, 3111]
  }
  const preferred = (prefer[tag] ?? []).filter((id) => all.includes(id))
  return preferred.length ? preferred : all.slice(0, 2)
}

function generateStats(data: StaticData, patch: string, mode: GameMode = 'ranked'): PatchStats {
  const aram = mode === 'aram'
  const rand = rng(aram ? 4242 : 1337)
  const stats: PatchStats = {
    patch,
    mode,
    matches: aram ? 61_507 : 48_213,
    updatedAt: Date.now() - 1000 * 60 * 42,
    bans: {},
    champions: {}
  }
  const trees = data.runeTrees
  const shardSets: Record<string, number[][]> = {
    Marksman: [
      [5005, 5008, 5011],
      [5008, 5008, 5011]
    ],
    Mage: [
      [5008, 5008, 5011],
      [5007, 5008, 5011]
    ],
    Support: [
      [5007, 5008, 5011],
      [5008, 5010, 5011]
    ],
    Tank: [
      [5007, 5010, 5011],
      [5008, 5008, 5001]
    ],
    Assassin: [
      [5008, 5008, 5011],
      [5008, 5010, 5011]
    ],
    Fighter: [
      [5008, 5008, 5011],
      [5007, 5008, 5001]
    ]
  }

  for (const champ of Object.values(data.champions)) {
    const tag = champ.tags[0] ?? 'Fighter'
    const roles = [...(ROLE_BY_TAG[tag] ?? ['TOP'])]
    if (champ.tags[1] && ROLE_BY_TAG[champ.tags[1]] && rand() < 0.35) roles.push(ROLE_BY_TAG[champ.tags[1]][0])
    const mainRole = roles[0]
    const secondRole = rand() < 0.4 ? roles.find((other) => other !== mainRole) : undefined
    const popularity = Math.pow(rand(), 2.2)
    const baseWr = 0.47 + rand() * 0.075
    if (!aram) stats.bans[champ.key] = Math.round(stats.matches * Math.pow(rand(), 3) * 0.35)

    const entries: [StatRole | undefined, number][] = aram
      ? [['ARAM', 1]]
      : [
          [mainRole, 1],
          [secondRole, 0.15 + rand() * 0.3]
        ]
    for (const [role, share] of entries) {
      if (!role) continue
      const games = aram ? Math.round(((stats.matches * 10) / 172) * (0.9 + rand() * 0.2)) : Math.round((300 + popularity * 9000) * share)
      const wr = baseWr + (share < 1 ? -0.015 : 0)
      const entry: ChampionRoleStats = {
        championId: champ.key,
        role,
        ...wg(rand, games, wr, 0.005),
        runes: {},
        spells: {},
        starters: {},
        core: {},
        boots: {},
        slots: [{}, {}, {}, {}, {}, {}],
        skillMax: {},
        skillPath: {},
        matchups: {},
        duration: games * (1650 + rand() * 250)
      }

      // four rune pages; the last one swaps primary and secondary tree
      const [primId, subId] = TREE_BY_TAG[tag] ?? [8000, 8400]
      for (let variant = 0; variant < 4; variant++) {
        const primTree = trees.find((tree) => tree.id === (variant === 3 ? subId : primId)) ?? trees[0]
        const subTree = trees.find((tree) => tree.id === (variant === 3 ? primId : subId) && tree.id !== primTree.id) ?? trees[1]
        const primary = primTree.slots.map((slot) => pick(rand, slot).id)
        const subSlots = [1, 2, 3]
          .sort(() => rand() - 0.5)
          .slice(0, 2)
          .sort()
        const secondary = subSlots.map((i) => pick(rand, subTree.slots[i] ?? subTree.slots[1]).id)
        const shards = pick(rand, shardSets[tag] ?? shardSets.Fighter)
        const key = [primTree.id, primary.join(','), subTree.id, secondary.join(','), shards.join(',')].join('|')
        entry.runes[key] = wg(rand, entry.g * [0.46, 0.21, 0.09, 0.05][variant], wr)
      }

      // spells & starters
      const itemRole: Role = role === 'ARAM' ? mainRole : role
      ;(aram ? ARAM_SPELLS : SPELLS[itemRole]).forEach(
        (spellPair, i) => (entry.spells[spellPair.join(',')] = wg(rand, entry.g * [0.78, 0.15, 0.05][i], wr))
      )
      ;(aram ? ARAM_STARTERS : STARTERS[itemRole]).forEach(
        (starter, i) => (entry.starters[[...starter].sort((a, b) => a - b).join(',')] = wg(rand, entry.g * [0.7, 0.2, 0.08][i], wr))
      )

      // items
      const pool = itemPool(data, itemRole === 'UTILITY' && tag !== 'Mage' ? 'Support' : tag)
      const shuffled = [...pool].sort(() => rand() - 0.5)
      // one main core plus a few reorderings / swaps of it
      const coreA = shuffled.slice(0, 3)
      const variants = [coreA, [coreA[0], coreA[2], coreA[1]], [coreA[0], coreA[1], shuffled[3]], [shuffled[4], coreA[0], coreA[1]]]
      variants.forEach((core, i) => (entry.core[core.join(',')] = wg(rand, entry.g * [0.31, 0.16, 0.1, 0.06][i], wr, 0.03)))
      bootsFor(data, tag).forEach((bootsId, i) => (entry.boots[bootsId] = wg(rand, entry.g * ([0.66, 0.22][i] ?? 0.05), wr)))
      for (let slot = 0; slot < 6; slot++) {
        const candidates = slot < 3 ? coreA : shuffled.slice(2, 10)
        candidates.forEach((id, i) => (entry.slots[slot][id] = wg(rand, (entry.g / (slot + 1)) * (0.5 / (i + 1)), wr + 0.02, 0.05)))
      }

      // skills
      const maxOrders = tag === 'Marksman' ? ['QWE', 'QEW', 'WQE'] : tag === 'Tank' ? ['QEW', 'WQE', 'EQW'] : ['QEW', 'QWE', 'EQW']
      maxOrders.forEach((order, i) => {
        entry.skillMax[order] = wg(rand, entry.g * [0.74, 0.18, 0.06][i], wr)
        // standard level 1-15 path for that max order
        const [first, second, third] = [...order]
        const path = `${first}${second}${third}${first}${first}R${first}${second}${first}${second}R${second}${second}${third}${third}`
        entry.skillPath[path] = wg(rand, entry.g * [0.52, 0.12, 0.04][i], wr)
      })
      stats.champions[`${champ.key}:${role}`] = entry
    }
  }

  // matchups within each role
  for (const role of aram ? (['ARAM'] as StatRole[]) : ROLES) {
    const inRole = Object.values(stats.champions).filter((entry) => entry.role === role)
    for (const champStats of inRole) {
      for (const opponent of inRole) {
        if (opponent === champStats || rand() < 0.55) continue
        const games = Math.round(Math.min(champStats.g, opponent.g) * (0.05 + rand() * 0.08))
        if (games < 5) continue
        // own win rate, shifted by how strong the opponent is overall
        champStats.matchups[opponent.championId] = wg(rand, games, champStats.w / champStats.g - (opponent.w / opponent.g - 0.5), 0.06)
      }
    }
  }
  return stats
}

function demoProfile(data: StaticData, riotId: string): ProfileData {
  // seeded from the Riot ID so the same name always gives the same profile
  const rand = rng([...riotId].reduce((hash, char) => hash * 31 + char.charCodeAt(0), 7))
  const champs = Object.values(data.champions)
  const favs = [0, 1, 2, 3].map(() => pick(rand, champs).key)
  const [gameName, tagLine = 'EUW'] = riotId.split('#')
  const matches: MatchSummary[] = Array.from({ length: 15 }, (_, i) => {
    const championId = rand() < 0.75 ? pick(rand, favs) : pick(rand, champs).key
    const win = rand() < 0.56
    const items = [...itemPool(data, data.champions[championId]?.tags[0] ?? 'Fighter')].sort(() => rand() - 0.5).slice(0, 5)
    return {
      matchId: `EUW1_70000${i}`,
      queueId: rand() < 0.8 ? 420 : 440,
      gameCreation: Date.now() - i * 1000 * 60 * 60 * 5 - Math.round(rand() * 1000 * 60 * 60 * 3),
      gameDuration: 1400 + Math.round(rand() * 900),
      win,
      remake: false,
      championId,
      role: 'MIDDLE',
      kills: Math.round(rand() * 12),
      deaths: Math.round(1 + rand() * 7),
      assists: Math.round(rand() * 14),
      cs: Math.round(150 + rand() * 120),
      gold: Math.round(9000 + rand() * 6000),
      damage: Math.round(12000 + rand() * 25000),
      visionScore: Math.round(10 + rand() * 30),
      items: [...items, 0, 3340],
      spells: [4, 14],
      keystone: pick(rand, [8112, 8214, 8010, 8229]),
      subStyle: pick(rand, [8300, 8400, 8200]),
      killParticipation: 0.35 + rand() * 0.4,
      teams: Array.from({ length: 10 }, (_, j) => ({
        championId: j === 0 ? championId : pick(rand, champs).key,
        riotId: j === 0 ? riotId : `Player${Math.floor(rand() * 9999)}#EUW`,
        teamId: j < 5 ? 100 : 200,
        puuid: `p${j}`
      }))
    }
  })
  const summary = new Map<number, { games: number; wins: number; kills: number; deaths: number; assists: number }>()
  for (const match of matches) {
    const totals = summary.get(match.championId) ?? { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 }
    totals.games++
    totals.wins += match.win ? 1 : 0
    totals.kills += match.kills
    totals.deaths += match.deaths
    totals.assists += match.assists
    summary.set(match.championId, totals)
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
      .map(([championId, totals]) => ({
        championId,
        games: totals.games,
        wins: totals.wins,
        kda: (totals.kills + totals.assists) / Math.max(1, totals.deaths)
      }))
      .sort((a, b) => b.games - a.games)
  }
}

export function createMockApi(): RcApi {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const emit = <K extends keyof RcEvents>(event: K, payload: RcEvents[K]): void =>
    listeners.get(event)?.forEach((listener) => listener(payload))
  // lets screenshot scripts fire app events in the web demo (e.g. the galaxy jump)
  ;(window as unknown as { __rcEmit: typeof emit }).__rcEmit = emit

  let staticData: Promise<StaticData> | null = null
  const getStatic = (): Promise<StaticData> =>
    (staticData ??= (async () => {
      const get = async <T>(path: string): Promise<T> => (await fetch(`${DDRAGON}${path}`)).json() as Promise<T>
      const version = (await get<string[]>('/api/versions.json'))[0]
      return loadStaticData(get, version, settings.language)
    })())

  const statsPromise: Partial<Record<GameMode, Promise<PatchStats>>> = {}
  const getStats = (mode: GameMode = 'ranked'): Promise<PatchStats> =>
    (statsPromise[mode] ??= getStatic().then((data) => generateStats(data, data.patch, mode)))

  let mayhemPromise: Promise<MayhemData> | null = null
  const getMayhem = (): Promise<MayhemData> =>
    (mayhemPromise ??= (async () => {
      const cdragon = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global'
      const aramMayhem = 'https://arammayhem.com/data/v1/latest'
      const fetchJson = async <T>(url: string): Promise<T> => (await fetch(url)).json() as Promise<T>
      // only the English augment list is required, everything else is optional
      const [augmentsEn, augmentsDe, amAugments, combos, lists] = await Promise.all([
        fetchJson<CherryAugment[]>(`${cdragon}/default/v1/cherry-augments.json`),
        fetchJson<CherryAugment[]>(`${cdragon}/de_de/v1/cherry-augments.json`).catch(() => null),
        fetchJson<AmFile<AmAugmentRow>>(`${aramMayhem}/augments.json`).catch(() => null),
        fetchJson<AmFile<AmComboRow>>(`${aramMayhem}/combos.json`).catch(() => null),
        fetchJson<AugmentList[]>(`${cdragon}/default/v1/augment-lists.json`).catch(() => null)
      ])
      return buildMayhemData(augmentsEn, augmentsDe ?? augmentsEn, amAugments, combos, Date.now(), mayhemPool(lists))
    })())

  let owned: number[] = []
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
      minGamesForTierList: 20,
      autoCrawl: true
    },
    overlay: {
      enabled: true,
      hotkey: 'Alt+Shift+A',
      autoExpand: true,
      cardFrames: true,
      animation: 'smooth',
      loadingScreen: true,
      showInCapture: false,
      gameDisplayId: null
    },
    minimap: { enabled: true, inhibitors: true, relics: true, scale: 1 },
    ui: { background: 'animated' },
    client: { autoImportRunes: true, autoImportItems: true, autoImportSpells: false, flashOn: 'F', autoAccept: true, acceptDelay: 'human' }
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
    const data = await getStatic()
    const byName = (id: string): number => Object.values(data.champions).find((champ) => champ.id === id)?.key ?? 1
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
    // Mayhem has no assigned positions
    const noRole = (seat: ReturnType<typeof ally>) => ({ ...seat, role: null })
    return {
      active: true,
      queueId: 2400,
      mode: 'mayhem',
      myChampionId: byName('Lux'),
      myRole: null,
      locked: false,
      allies: [
        ally(0, 'Garen', 'TOP'),
        ally(1, 'LeeSin', 'JUNGLE'),
        ally(2, 'Lux', 'MIDDLE', true),
        ally(3, 'Jinx', 'BOTTOM'),
        ally(4, 'Thresh', 'UTILITY')
      ].map(noRole),
      enemies: [enemy(5, 'Darius'), enemy(6, 'Vi'), enemy(7, 'Syndra'), enemy(8, 'Kaisa'), enemy(9, 'Nautilus')],
      bans: []
    }
  }

  const api: RcApi = {
    getStatic,
    getSettings: async () => settings,
    saveSettings: async (patch) => {
      settings = {
        ...settings,
        ...patch,
        crawler: { ...settings.crawler, ...patch.crawler },
        client: { ...settings.client, ...patch.client }
      }
      return settings
    },
    setApiKey: async () => ({ ok: true, message: 'Web demo: the key is not stored.' }),
    getPatches: async (mode) => {
      const stats = await getStats(mode)
      return [{ patch: stats.patch, matches: stats.matches, updatedAt: stats.updatedAt }]
    },
    getTierList: async (_patch, mode) => buildTierList(await getStats(mode), settings.crawler.minGamesForTierList),
    getChampionBuild: async (_patch, championId, role, mode) => {
      const stats = await getStats(mode)
      return buildChampionView(stats, championId, role, buildTierList(stats, settings.crawler.minGamesForTierList))
    },
    crawlerStart: async (mode) => {
      const stats = await getStats(mode)
      crawler = {
        ...crawler,
        mode,
        running: true,
        phase: 'crawling',
        message: 'Analysing matches (EUW1)',
        matchesThisRun: 0,
        playersDone: 0,
        startedAt: Date.now(),
        patch: stats.patch
      }
      emit('crawler', crawler)
      // pretend to crawl: one match every 700 ms
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
    overlayScanNow: async () => undefined,
    listGames: async () => {
      const summary = demoSummary()
      const me = summary.players.find((player) => player.me)!
      return [
        {
          gameId: summary.gameId,
          createdAt: summary.createdAt,
          duration: summary.duration,
          queueId: summary.queueId,
          mode: summary.mode,
          win: summary.win,
          championId: me.championId,
          kda: [me.kills, me.deaths, me.assists] as [number, number, number],
          blamedPremade: summary.players.filter((player) => player.ally).sort((a, b) => a.score - b.score)[0]?.riotId ?? null
        }
      ]
    },
    getGame: async () => demoSummary(),
    // minimap timers only exist in the '#...demo-live' preview
    getMapTimers: async () =>
      window.location.hash.includes('demo-live')
        ? {
            gameTime: 612,
            measuredAt: Date.now(),
            rect: { x: 0.84, y: 0.72, w: 0.15, h: 0.26 },
            inhibitors: [{ team: 'CHAOS' as const, respawnAt: 700, pos: { x: 0.75, y: 0.25 } }],
            relics: [
              {
                id: 'order-inner',
                team: 'ORDER' as const,
                kind: 'inner' as const,
                pos: { x: 0.37, y: 0.69 },
                state: 'up' as const,
                at: null
              },
              {
                id: 'order-outer',
                team: 'ORDER' as const,
                kind: 'outer' as const,
                pos: { x: 0.46, y: 0.59 },
                state: 'spawn' as const,
                at: 655
              },
              {
                id: 'chaos-outer',
                team: 'CHAOS' as const,
                kind: 'outer' as const,
                pos: { x: 0.59, y: 0.47 },
                state: 'spawn' as const,
                at: 634
              },
              {
                id: 'chaos-inner',
                team: 'CHAOS' as const,
                kind: 'inner' as const,
                pos: { x: 0.69, y: 0.39 },
                state: 'up' as const,
                at: null
              }
            ]
          }
        : null,
    getOwnedAugments: async () => {
      // '?owned=30,48' in the hash pre-selects augments for screenshots
      const ownedParam = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('owned')
      if (ownedParam) owned = ownedParam.split(',').filter(Boolean).map(Number)
      return owned
    },
    setOwnedAugments: async (ids) => {
      owned = ids
      emit('augmentsOwned', ids)
    },
    overlayTestScan: async () => ({ captureMs: 0, screens: [] }),
    openDiagnosticsFolder: async () => undefined,
    getMayhemPersonal: async (): Promise<MayhemPersonal> => {
      const mayhem = await getMayhem()
      const rand = rng(99)
      const ids = Object.values(mayhem.augments)
        .filter((augment) => augment.pickRate != null)
        .map((augment) => augment.id)
      const data = await getStatic()
      const champs = Object.values(data.champions)
      const recent = Array.from({ length: 12 }, (_, i) => ({
        gameId: i,
        championId: pick(rand, champs).key,
        win: rand() < 0.58,
        augments: [0, 1, 2, 3].map(() => pick(rand, ids.slice(0, 40))),
        createdAt: Date.now() - i * 1000 * 60 * 60 * 7
      }))
      const perAugment = new Map<number, { games: number; wins: number }>()
      for (const game of recent)
        for (const id of game.augments) {
          const totals = perAugment.get(id) ?? { games: 0, wins: 0 }
          totals.games++
          totals.wins += game.win ? 1 : 0
          perAugment.set(id, totals)
        }
      return {
        games: recent.length,
        wins: recent.filter((game) => game.win).length,
        augments: [...perAugment.entries()].map(([id, totals]) => ({ id, ...totals })).sort((a, b) => b.games - a.games),
        champions: [],
        recent
      }
    },
    resetStats: async () => undefined,
    clientStatus: async () => client,
    champSelect: async () => (window.location.hash.includes('demo-live') ? null : champSelect()),
    importBuild: async (championId) => {
      const data = await getStatic()
      return {
        runes: `ratioAI: ${data.champions[championId]?.name}`,
        items: `RC ${data.champions[championId]?.name}`,
        errors: []
      }
    },
    // '#/live?demo-live&owned=30,48' shows an example ARAM: Mayhem game (screenshots)
    liveGame: async (): Promise<LiveGameState | null> => {
      const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
      if (!params.has('demo-live')) return null
      owned = (params.get('owned') ?? '').split(',').filter(Boolean).map(Number)
      const player = (riotId: string, championName: string, team: 'ORDER' | 'CHAOS', items: number[], kills: number) => ({
        riotId,
        championName,
        team,
        level: 9,
        kills,
        deaths: 2,
        assists: 7,
        creepScore: 41,
        items,
        spells: ['Flash', 'Mark'],
        position: '',
        isDead: false,
        respawnTimer: 0
      })
      return {
        active: true,
        gameMode: 'KIWI',
        gameTime: 612,
        activePlayer: 'Axel Fungus#EUW',
        activeChampion: 'Lux',
        activeChampionKey: 'Lux',
        players: [
          player('Axel Fungus#EUW', 'Lux', 'ORDER', [3285, 3020, 3089], 6),
          player('blackbird#EUW', 'Garen', 'ORDER', [3071, 3047], 4),
          player('Doulul#EUW', 'Thresh', 'ORDER', [3190, 3117], 1),
          player('Toni#EUW', 'Jinx', 'CHAOS', [3031, 3006, 3094], 5),
          player('ratio#EUW', 'Ryze', 'CHAOS', [3003, 3158], 3)
        ],
        premades: ['blackbird#EUW'],
        events: [{ name: 'ChampionKill', time: 598, text: 'Axel Fungus killed Toni' }]
      }
    },
    lookupProfile: async (riotId) => demoProfile(await getStatic(), riotId),
    scoutActiveGame: async (): Promise<ScoutResult | null> => {
      const select = await champSelect()
      const tiers = ['DIAMOND', 'EMERALD', 'MASTER', 'DIAMOND', 'PLATINUM']
      return {
        gameId: 1,
        gameMode: 'CLASSIC',
        gameStartTime: Date.now() - 1000 * 60 * 4,
        players: [...select.allies, ...select.enemies].map((seat, i) => ({
          puuid: `p${i}`,
          riotId: i === 2 ? 'Demo Summoner#EUW' : `Player${1000 + i * 137}#EUW`,
          championId: seat.championId,
          teamId: i < 5 ? 100 : 200,
          spells: [4, [12, 11, 14, 7, 3][i % 5]],
          ranked: {
            queueType: 'RANKED_SOLO_5x5',
            tier: tiers[i % 5],
            rank: ['I', 'II', 'III', 'IV'][i % 4],
            leaguePoints: (i * 17) % 100,
            wins: 60 + i * 7,
            losses: 55 + i * 5
          },
          recent: null
        }))
      }
    },
    openExternal: async (url) => void window.open(url, '_blank'),
    on(event, callback) {
      const set = listeners.get(event) ?? new Set()
      set.add(callback as (payload: unknown) => void)
      listeners.set(event, set)
      return () => set.delete(callback as (payload: unknown) => void)
    }
  }
  return api
}

/** Made-up ARAM: Mayhem game for the post-game summary demo (a big early lead that gets thrown). */
function demoSummary(): GameSummary {
  // [name, championId, is me, premade with me]
  const names: [string, number, boolean, boolean][] = [
    ['Axel Fungus', 412, true, false],
    ['blackbird', 86, false, true],
    ['Doulul', 99, false, true],
    ['Toni', 222, false, false],
    ['ratio', 103, false, false],
    ['simwai', 157, false, false],
    ['Psychedelic Bard', 432, false, false],
    ['Guido', 25, false, false],
    ['Splitter', 11, false, false],
    ['NOATAQQ', 54, false, false]
  ]
  // kills, deaths, assists, damage to champions, damage taken, healing on teammates
  const stats = [
    [3, 7, 21, 14200, 31000, 9000],
    [9, 9, 11, 28100, 22000, 0],
    [4, 11, 9, 16900, 18000, 1200],
    [11, 6, 12, 33800, 15000, 0],
    [5, 8, 14, 21000, 26000, 3800],
    [12, 5, 14, 35100, 17000, 0],
    [6, 7, 20, 18800, 29000, 11000],
    [14, 6, 9, 31900, 14000, 0],
    [3, 7, 19, 15200, 38000, 2100],
    [6, 7, 16, 22400, 21000, 0]
  ]
  const augments = [
    [1011, 2107, 1349],
    [1180, 2139, 1149],
    [1072, 2034],
    [1238, 1401, 2102],
    [1013, 1353],
    [1205, 1305],
    [1328, 1358, 1421],
    [1098, 2080],
    [1020, 2032],
    [1054, 1325]
  ]
  const game = {
    gameId: 7300000001,
    gameCreation: Date.now() - 40 * 60_000,
    gameDuration: 19 * 60 + 12,
    queueId: 2400,
    gameMode: 'KIWI',
    participants: names.map(([, champ], i) => ({
      participantId: i + 1,
      championId: champ,
      teamId: i < 5 ? 100 : 200,
      stats: {
        win: i >= 5,
        kills: stats[i][0],
        deaths: stats[i][1],
        assists: stats[i][2],
        totalDamageDealtToChampions: stats[i][3],
        totalDamageTaken: stats[i][4],
        damageSelfMitigated: Math.round(stats[i][4] * 0.4),
        totalHealsOnTeammates: stats[i][5],
        goldEarned: 9000 + stats[i][0] * 350,
        champLevel: 18,
        ...Object.fromEntries([3020, 3089, 3157, 4645, 3135, 3165, 3340].map((itemId, slot) => [`item${slot}`, itemId])),
        ...Object.fromEntries(augments[i].map((augmentId, slot) => [`playerAugment${slot + 1}`, augmentId]))
      }
    })),
    participantIdentities: names.map(([name], i) => ({
      participantId: i + 1,
      player: { puuid: `p${i}`, gameName: name, tagLine: 'EUW' }
    }))
  }
  // our gold lead per minute
  const lead = [0, 300, 900, 1600, 2400, 3100, 3800, 4200, 3900, 3300, 2600, 1800, 900, 200, -700, -1500, -2300, -3200, -4100, -5000]
  const timeline = {
    frames: lead.map((goldLead, minute) => ({
      timestamp: minute * 60_000,
      participantFrames: Object.fromEntries(
        names.map((_, i) => [String(i + 1), { totalGold: 500 + minute * 600 + (i < 5 ? goldLead / 5 : 0) }])
      ),
      // one kill per minute (ours until minute 9, theirs after) plus an extra enemy kill every third minute
      events:
        minute > 0
          ? [
              {
                type: 'CHAMPION_KILL',
                timestamp: minute * 60_000 - 20_000,
                killerId: minute < 9 ? 1 + (minute % 5) : 6 + (minute % 5),
                victimId: 3
              },
              ...(minute % 3 === 0
                ? [{ type: 'CHAMPION_KILL', timestamp: minute * 60_000 - 5_000, killerId: 6 + (minute % 5), victimId: 2 }]
                : [])
            ]
          : []
    }))
  }
  return buildSummary(game, timeline, 'p0', new Set(['p1', 'p2']))
}
