// Types shared between the Electron main process and the React renderer.

export const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'ADC',
  UTILITY: 'Support'
}

export const PLATFORMS = {
  euw1: { label: 'EUW', regional: 'europe' },
  eun1: { label: 'EUNE', regional: 'europe' },
  tr1: { label: 'TR', regional: 'europe' },
  ru: { label: 'RU', regional: 'europe' },
  na1: { label: 'NA', regional: 'americas' },
  br1: { label: 'BR', regional: 'americas' },
  la1: { label: 'LAN', regional: 'americas' },
  la2: { label: 'LAS', regional: 'americas' },
  kr: { label: 'KR', regional: 'asia' },
  jp1: { label: 'JP', regional: 'asia' },
  oc1: { label: 'OCE', regional: 'sea' },
  sg2: { label: 'SEA', regional: 'sea' },
  tw2: { label: 'TW', regional: 'sea' },
  vn2: { label: 'VN', regional: 'sea' },
  me1: { label: 'ME', regional: 'europe' }
} as const
export type Platform = keyof typeof PLATFORMS
export type Regional = (typeof PLATFORMS)[Platform]['regional']

export type Tier = 'S+' | 'S' | 'A' | 'B' | 'C' | 'D'
export type SeedTier = 'CHALLENGER' | 'GRANDMASTER' | 'MASTER'

/** Wins / games counter. */
export interface WG {
  g: number
  w: number
}

// ---------------------------------------------------------------------------
// Static data (Data Dragon)
// ---------------------------------------------------------------------------

export interface StaticChampion {
  id: string // "MonkeyKing"
  key: number // 62
  name: string
  title: string
  tags: string[]
}

export interface StaticItem {
  id: number
  name: string
  description: string
  plaintext: string
  gold: number
  tags: string[]
  /** completed "legendary"/mythic tier item (no further upgrades, >= 2 components deep). */
  completed: boolean
  boots: boolean
  starter: boolean
}

export interface StaticRune {
  id: number
  key: string
  name: string
  icon: string
  shortDesc: string
}

export interface StaticRuneTree {
  id: number
  key: string
  name: string
  icon: string
  slots: StaticRune[][]
}

export interface StaticSpell {
  id: number
  key: string // "SummonerFlash"
  name: string
  description: string
}

export interface StaticData {
  version: string
  patch: string // "15.19"
  language: string
  champions: Record<number, StaticChampion>
  items: Record<number, StaticItem>
  runeTrees: StaticRuneTree[]
  runes: Record<number, StaticRune>
  spells: Record<number, StaticSpell>
}

// ---------------------------------------------------------------------------
// Aggregated statistics
// ---------------------------------------------------------------------------

export interface ChampionRoleStats extends WG {
  championId: number
  role: Role
  /** key: primaryStyle|p0,p1,p2,p3|subStyle|s0,s1|shard0,shard1,shard2 */
  runes: Record<string, WG>
  /** key: "4,14" (sorted spell ids) */
  spells: Record<string, WG>
  /** key: sorted item ids "1055,2003" */
  starters: Record<string, WG>
  /** key: ordered item ids of the first three completed items "3031,3094,3036" */
  core: Record<string, WG>
  boots: Record<string, WG>
  /** Completed items by purchase slot (0 = first completed item ... 5). */
  slots: Record<string, WG>[]
  /** key: "QEW" (max order) */
  skillMax: Record<string, WG>
  /** key: first 15 skill level-ups "QWEQQRQEQEREEWW" */
  skillPath: Record<string, WG>
  /** key: opposing champion id in the same role */
  matchups: Record<string, WG>
  /** summed game duration in seconds */
  duration: number
}

export interface PatchStats {
  patch: string
  matches: number
  updatedAt: number
  bans: Record<string, number>
  champions: Record<string, ChampionRoleStats> // key: `${championId}:${role}`
}

// ---------------------------------------------------------------------------
// Views for the renderer
// ---------------------------------------------------------------------------

export interface TierEntry {
  championId: number
  role: Role
  tier: Tier
  score: number
  games: number
  winRate: number
  pickRate: number
  banRate: number
  /** share of this champion's games played in this role */
  roleShare: number
  rank: number
}

export interface Option<T> extends WG {
  value: T
  winRate: number
  pickRate: number
}

export interface RunePage {
  primaryStyle: number
  subStyle: number
  primary: number[] // 4 perks
  secondary: number[] // 2 perks
  shards: number[] // 3 shards
}

export interface Matchup {
  championId: number
  games: number
  winRate: number
}

export interface ChampionBuild {
  championId: number
  role: Role
  patch: string
  games: number
  winRate: number
  pickRate: number
  banRate: number
  tier: Tier | null
  availableRoles: { role: Role; games: number }[]
  runes: Option<RunePage>[]
  spells: Option<number[]>[]
  starters: Option<number[]>[]
  core: Option<number[]>[]
  boots: Option<number>[]
  /** situational options for the 4th, 5th, 6th completed item */
  late: Option<number>[][]
  skillMax: Option<string>[]
  skillPath: Option<string>[]
  counters: Matchup[] // champions this champ struggles against
  goodAgainst: Matchup[]
  avgDuration: number
}

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

export interface CrawlerStatus {
  running: boolean
  phase: 'idle' | 'seeding' | 'crawling' | 'stopping' | 'error' | 'done'
  message: string
  patch: string | null
  players: number
  playersDone: number
  matchesThisRun: number
  matchesTotal: number
  skippedOldPatch: number
  requests: number
  startedAt: number | null
  lastError: string | null
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  platform: Platform
  language: string
  hasApiKey: boolean
  leaguePath: string
  crawler: {
    seedTiers: SeedTier[]
    /** extra platforms to crawl in addition to the main platform */
    extraPlatforms: Platform[]
    maxMatchesPerRun: number
    matchesPerPlayer: number
    minGamesForTierList: number
  }
  client: {
    autoImportRunes: boolean
    autoImportItems: boolean
    autoImportSpells: boolean
    flashOn: 'D' | 'F'
    autoAccept: boolean
  }
}

// ---------------------------------------------------------------------------
// League client (LCU) & live game
// ---------------------------------------------------------------------------

export type GameflowPhase =
  | 'None'
  | 'Lobby'
  | 'Matchmaking'
  | 'ReadyCheck'
  | 'ChampSelect'
  | 'GameStart'
  | 'InProgress'
  | 'Reconnect'
  | 'WaitingForStats'
  | 'PreEndOfGame'
  | 'EndOfGame'
  | 'TerminatedInError'
  | string

export interface ClientSummoner {
  gameName: string
  tagLine: string
  puuid: string
  summonerLevel: number
  profileIconId: number
  platform: Platform | null
}

export interface ClientStatus {
  connected: boolean
  phase: GameflowPhase
  summoner: ClientSummoner | null
}

export interface ChampSelectPlayer {
  cellId: number
  championId: number
  role: Role | null
  isLocal: boolean
  team: 'ally' | 'enemy'
  spell1Id: number
  spell2Id: number
}

export interface ChampSelectState {
  active: boolean
  myChampionId: number
  myRole: Role | null
  locked: boolean
  allies: ChampSelectPlayer[]
  enemies: ChampSelectPlayer[]
  bans: number[]
}

export interface ImportResult {
  runes?: string
  items?: string
  spells?: string
  errors: string[]
}

export interface LivePlayer {
  riotId: string
  championName: string
  team: 'ORDER' | 'CHAOS'
  level: number
  kills: number
  deaths: number
  assists: number
  creepScore: number
  items: number[]
  spells: string[]
  position: string
  isDead: boolean
  respawnTimer: number
}

export interface LiveGameState {
  active: boolean
  gameTime: number
  gameMode: string
  activePlayer: string | null
  players: LivePlayer[]
  events: { name: string; time: number; text: string }[]
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export interface RankedEntry {
  queueType: string
  tier: string
  rank: string
  leaguePoints: number
  wins: number
  losses: number
}

export interface MatchSummary {
  matchId: string
  queueId: number
  gameCreation: number
  gameDuration: number
  win: boolean
  remake: boolean
  championId: number
  role: string
  kills: number
  deaths: number
  assists: number
  cs: number
  gold: number
  damage: number
  visionScore: number
  items: number[]
  spells: number[]
  keystone: number
  subStyle: number
  killParticipation: number
  teams: { championId: number; riotId: string; teamId: number; puuid: string }[]
}

export interface ProfileData {
  puuid: string
  gameName: string
  tagLine: string
  platform: Platform
  summonerLevel: number
  profileIconId: number
  ranked: RankedEntry[]
  mastery: { championId: number; level: number; points: number }[]
  matches: MatchSummary[]
  championSummary: { championId: number; games: number; wins: number; kda: number }[]
}

export interface ScoutPlayer {
  puuid: string
  riotId: string
  championId: number
  teamId: number
  spells: number[]
  ranked: RankedEntry | null
  /** ranked stats on the current champion from the last few games, when available */
  recent: { games: number; wins: number } | null
}

export interface ScoutResult {
  gameId: number
  gameMode: string
  gameStartTime: number
  players: ScoutPlayer[]
}

// ---------------------------------------------------------------------------
// IPC contract
// ---------------------------------------------------------------------------

export interface RcApi {
  getStatic(): Promise<StaticData>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Omit<Settings, 'hasApiKey'>>): Promise<Settings>
  setApiKey(key: string): Promise<{ ok: boolean; message: string }>
  getPatches(): Promise<{ patch: string; matches: number; updatedAt: number }[]>
  getTierList(patch: string): Promise<TierEntry[]>
  getChampionBuild(patch: string, championId: number, role?: Role): Promise<ChampionBuild | null>
  crawlerStart(): Promise<void>
  crawlerStop(): Promise<void>
  crawlerStatus(): Promise<CrawlerStatus>
  resetStats(patch: string): Promise<void>
  clientStatus(): Promise<ClientStatus>
  champSelect(): Promise<ChampSelectState | null>
  importBuild(championId: number, role: Role | null, what?: ('runes' | 'items' | 'spells')[]): Promise<ImportResult>
  liveGame(): Promise<LiveGameState | null>
  lookupProfile(riotId: string, platform: Platform): Promise<ProfileData>
  scoutActiveGame(riotId: string, platform: Platform): Promise<ScoutResult | null>
  openExternal(url: string): Promise<void>
  on<K extends keyof RcEvents>(event: K, cb: (payload: RcEvents[K]) => void): () => void
}

export interface RcEvents {
  crawler: CrawlerStatus
  client: ClientStatus
  champSelect: ChampSelectState | null
  live: LiveGameState | null
  imported: ImportResult & { championId: number }
  statsUpdated: { patch: string }
}
