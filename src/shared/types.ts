// Types shared between the Electron main process and the React renderer.

export const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const
export type Role = (typeof ROLES)[number]

/** 'ARAM' is used as pseudo role for the Howling Abyss, where there are no lanes. */
export type StatRole = Role | 'ARAM'

export const ROLE_LABELS: Record<StatRole, string> = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'ADC',
  UTILITY: 'Support',
  ARAM: 'ARAM'
}

export type GameMode = 'ranked' | 'aram'
export const GAME_MODES: Record<GameMode, { label: string; queue: number; roles: readonly StatRole[] }> = {
  ranked: { label: 'Ranked Solo/Duo', queue: 420, roles: ROLES },
  aram: { label: 'ARAM', queue: 450, roles: ['ARAM'] }
}

/** Queue ids of the modes the app recognises in champion select. */
export const QUEUE_IDS = { ranked: [420, 440, 400, 430, 490], aram: [450, 100], mayhem: [2400, 3270] } as const
export type SelectMode = 'ranked' | 'aram' | 'mayhem' | 'other'

export function selectModeOfQueue(queueId: number | null | undefined, gameMode?: string | null): SelectMode {
  if (gameMode === 'KIWI' || (queueId != null && (QUEUE_IDS.mayhem as readonly number[]).includes(queueId))) return 'mayhem'
  if (queueId == null) return 'other'
  if ((QUEUE_IDS.aram as readonly number[]).includes(queueId) || gameMode === 'ARAM') return 'aram'
  if ((QUEUE_IDS.ranked as readonly number[]).includes(queueId)) return 'ranked'
  return 'other'
}

/** Which statistics a champion select mode uses for builds. */
export function statsModeOf(mode: SelectMode): GameMode {
  return mode === 'aram' || mode === 'mayhem' ? 'aram' : 'ranked'
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
  role: StatRole
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
  /** defaults to 'ranked' for files written by v0.1 */
  mode?: GameMode
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
  role: StatRole
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
  role: StatRole
  mode: GameMode
  patch: string
  games: number
  winRate: number
  pickRate: number
  banRate: number
  tier: Tier | null
  availableRoles: { role: StatRole; games: number }[]
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
  mode: GameMode
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
  overlay: {
    /** show the in-game augment overlay in ARAM: Mayhem */
    enabled: boolean
    /** Electron accelerator, e.g. "Alt+Shift+A" */
    hotkey: string
    /** pop the panel open automatically at augment levels (3/7/11/15) */
    autoExpand: boolean
    /** recognise the offered augment cards on screen and frame them by tier */
    cardFrames: boolean
    /** animated frames: 30 fps, 15 fps or static */
    animation: 'smooth' | 'low' | 'off'
    /** show the overlays in screen shares / recordings (Discord, OBS) – off keeps them private */
    showInCapture: boolean
    /** loading screen panel with the players' win rates in Mayhem / ARAM (Space toggles) */
    loadingScreen: boolean
    /** screen the game was last seen on (set automatically) */
    gameDisplayId: number | null
  }
  ui: {
    /** animated background: animated (24 fps), calm (10 fps) or static */
    background: 'animated' | 'calm' | 'static'
  }
  minimap: {
    /** timers on the minimap in ARAM / ARAM: Mayhem */
    enabled: boolean
    inhibitors: boolean
    /** health relic timers – watches the four relic pads on the minimap once per second */
    relics: boolean
    /** minimap size relative to the default (in-game minimap scale) */
    scale: number
  }
  client: {
    autoImportRunes: boolean
    autoImportItems: boolean
    autoImportSpells: boolean
    flashOn: 'D' | 'F'
    autoAccept: boolean
    /** how long to wait before accepting: instant, random 2–6 s or random 4–8 s */
    acceptDelay: AcceptDelay
  }
}

/** Loading screen: the players of the game with their recent record in this mode. */
export interface LoadingPlayer {
  puuid: string
  riotId: string
  championId: number
  ally: boolean
  me: boolean
  premade: boolean
  /** recent games of this mode in the player's match history, null while loading / unavailable */
  record: { games: number; wins: number } | null
  loading: boolean
}

export interface LoadingState {
  mode: 'mayhem' | 'aram'
  players: LoadingPlayer[]
}

export type AcceptDelay = 'instant' | 'human' | 'slow'

/** Timers shown on the minimap (all times are game time in seconds). */
export interface MinimapState {
  gameTime: number
  /** Date.now() when gameTime was measured – the overlay counts down locally in between */
  measuredAt: number
  rect: { x: number; y: number; w: number; h: number }
  /** minimap inside the overlay window (DIP), filled in by the main process */
  local?: { x: number; y: number; w: number; h: number }
  inhibitors: { team: 'ORDER' | 'CHAOS'; respawnAt: number; pos: { x: number; y: number } }[]
  relics: {
    id: string
    team: 'ORDER' | 'CHAOS'
    kind: 'outer' | 'inner'
    pos: { x: number; y: number }
    /** up = seen on the minimap, spawn = comes back at `at`, unknown = up but not confirmed */
    state: 'up' | 'spawn' | 'unknown'
    at: number | null
  }[]
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
  queueId: number | null
  mode: SelectMode
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
  /** champion name of the local player (localized) */
  activeChampion: string | null
  /** Data Dragon id of the local player's champion (e.g. "MonkeyKing"), language independent */
  activeChampionKey?: string | null
  /** Riot IDs of the players you queued with (from the client lobby) */
  premades?: string[]
  /** inhibitor kills / respawns from the event feed */
  inhibitorEvents?: { type: 'killed' | 'respawned'; inhibitor: string; time: number }[]
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
// ARAM: Mayhem
// ---------------------------------------------------------------------------

export type AugmentRarity = 'silver' | 'gold' | 'prismatic'
export type ComboType = 'god' | 'strong' | 'blackTech' | 'entertainment' | 'trap' | 'bug'

export interface MayhemAugment {
  /** augment id as used by the game client (cherry-augments.json) */
  id: number
  slug: string
  name: string
  /** English client name (used to recognise the augment on screen) */
  nameEn: string
  rarity: AugmentRarity
  /** absolute icon URL (CommunityDragon) */
  icon: string
  /** global pick rate in percent (arammayhem.com, China servers) */
  pickRate: number | null
  pickRateRank: number | null
  pickRateChange: number | null
  url: string | null
}

export interface MayhemCombo {
  championAlias: string // Data Dragon id, e.g. "MonkeyKing"
  augments: number[]
  types: ComboType[]
  url: string
}

export interface MayhemData {
  patch: string | null
  statsDate: string | null
  fetchedAt: number
  augments: Record<number, MayhemAugment>
  combos: MayhemCombo[]
  attribution: { text: string; url: string }
}

export interface MayhemPersonal {
  games: number
  wins: number
  augments: { id: number; games: number; wins: number }[]
  champions: { championId: number; games: number; wins: number }[]
  recent: { gameId: number; championId: number; win: boolean; augments: number[]; createdAt: number }[]
}

// ---------------------------------------------------------------------------
// IPC contract
// ---------------------------------------------------------------------------

export interface RcApi {
  getStatic(): Promise<StaticData>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Omit<Settings, 'hasApiKey'>>): Promise<Settings>
  setApiKey(key: string): Promise<{ ok: boolean; message: string }>
  getPatches(mode: GameMode): Promise<{ patch: string; matches: number; updatedAt: number }[]>
  getTierList(patch: string, mode: GameMode): Promise<TierEntry[]>
  getChampionBuild(patch: string, championId: number, role: StatRole | undefined, mode: GameMode): Promise<ChampionBuild | null>
  crawlerStart(mode: GameMode): Promise<void>
  crawlerStop(): Promise<void>
  crawlerStatus(): Promise<CrawlerStatus>
  resetStats(patch: string, mode: GameMode): Promise<void>
  clientStatus(): Promise<ClientStatus>
  champSelect(): Promise<ChampSelectState | null>
  importBuild(
    championId: number,
    role: StatRole | null,
    what: ('runes' | 'items' | 'spells')[] | undefined,
    mode: GameMode
  ): Promise<ImportResult>
  getMayhemData(): Promise<MayhemData>
  getMayhemPersonal(): Promise<MayhemPersonal | null>
  overlayPreview(championId: number): Promise<void>
  setOverlayInteractive(interactive: boolean): void
  appInfo(): Promise<{ version: string; update: UpdateState }>
  installUpdate(): Promise<void>
  overlayDiagnostics(): Promise<OverlayDiagnostics>
  /** look for augment cards right now (and for the next 20 s), e.g. from the overlay pill */
  overlayScanNow(): Promise<void>
  /** augments picked in the running Mayhem game (recognised from the augment choice) */
  getOwnedAugments(): Promise<number[]>
  getMapTimers(): Promise<MinimapState | null>
  setOwnedAugments(ids: number[]): Promise<void>
  overlayTestScan(): Promise<ScanTestResult>
  openDiagnosticsFolder(): Promise<void>
  liveGame(): Promise<LiveGameState | null>
  lookupProfile(riotId: string, platform: Platform): Promise<ProfileData>
  scoutActiveGame(riotId: string, platform: Platform): Promise<ScoutResult | null>
  openExternal(url: string): Promise<void>
  on<K extends keyof RcEvents>(event: K, cb: (payload: RcEvents[K]) => void): () => void
}

/** Augment cards currently offered on screen (detected by screen recognition). */
export interface AugmentOffer {
  displayId: number
  /** only for the settings preview: rate the cards for this champion instead of the live one */
  championId?: number
  /** card rectangles relative to the display, in DIP */
  cards: { augmentId: number | null; text: string; score: number; rect: { x: number; y: number; width: number; height: number } }[]
}

/** Live status of the overlay / screen recognition (Settings → Diagnostics). */
export interface OverlayDiagnostics {
  gameMode: string | null
  queueId: number | null
  mayhem: boolean
  level: number
  dead: boolean
  augmentPending: boolean
  canOpen: boolean
  scanning: boolean
  cardsVisible: boolean
  overlayVisible: boolean
  /** state of the shared screen stream */
  captureStream: string
  log: string[]
}

export interface ScanTestResult {
  captureMs: number
  screens: {
    displayId: number
    size: string
    /** augment cards found on this screen */
    visible: boolean
    /** screenshot is completely black (exclusive fullscreen) */
    black: boolean
    titles: string[]
    matches: (number | null)[]
    file: string
  }[]
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error' | 'dev'
  version?: string
  progress?: number
  message?: string
}

export interface RcEvents {
  crawler: CrawlerStatus
  client: ClientStatus
  champSelect: ChampSelectState | null
  live: LiveGameState | null
  imported: ImportResult & { championId: number }
  statsUpdated: { patch: string; mode: GameMode }
  overlayToggle: null
  augmentOffer: AugmentOffer | null
  /** augment cards on screen (even when their titles could not be read) */
  augmentCards: { visible: boolean }
  /** offer with card rects relative to the frames window (sent to that window only) */
  framesOffer: AugmentOffer | null
  augmentsOwned: number[]
  loading: LoadingState | null
  /** map timers for the main window (the minimap overlay gets its own copy with positions) */
  mapTimers: MinimapState | null
  minimap: MinimapState | null
  overlayPreview: { championId: number }
  update: UpdateState
}
