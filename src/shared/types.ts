import type { OverlayNotice } from './overlayNotice'
import type { GameSummary } from './summary'
import type { Encounter } from './encounters'
import type { AchievementCategory, AchievementRank } from './achievements'
import type { ClipKind, EncoderProbe, RecorderMode, RecorderSettings } from './recorder'
import type { EditProject, ExportPresetId } from './editProject'
import type { HighlightPlan, HighlightScope } from './highlights'
// Types shared between the Electron main process and the React renderer.

export const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'] as const
export type Role = (typeof ROLES)[number]

/** 'ARAM' is a pseudo role for the Howling Abyss, which has no lanes. */
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
  /** completed legendary/mythic item (no further upgrades, at least 2 components deep) */
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
  /** completed items by purchase slot (0 is the first completed item, up to 5) */
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
  /** a Discord webhook URL is saved (the URL itself never leaves the main process) */
  hasDiscordWebhook: boolean
  leaguePath: string
  crawler: {
    seedTiers: SeedTier[]
    /** extra platforms to crawl in addition to the main platform */
    extraPlatforms: Platform[]
    maxMatchesPerRun: number
    matchesPerPlayer: number
    minGamesForTierList: number
    /** keep the statistics fresh on its own: a run shortly after start and every few hours */
    autoCrawl: boolean
  }
  overlay: {
    /** show the in-game augment overlay in ARAM: Mayhem */
    enabled: boolean
    /** Electron accelerator, e.g. "Alt+Shift+A": look for the augment cards right now */
    hotkey: string
    /** recognise the offered augment cards on screen and frame them by tier */
    cardFrames: boolean
    /** animated frames: 30 fps, 15 fps or static */
    animation: 'smooth' | 'low' | 'off'
    /** show the overlays in screen shares and recordings (Discord, OBS). Off keeps them private. */
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
    /** health relic timers. Watches the four relic pads on the minimap once per second. */
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
    /** how long to wait before accepting: instant, random 2 to 6 s or random 4 to 8 s */
    acceptDelay: AcceptDelay
  }
  /** post a summary of every finished game to your friends' Discord channel (your own webhook) */
  discord: {
    enabled: boolean
    /** which games: ARAM: Mayhem, ARAM, ranked, everything else */
    modes: ('mayhem' | 'aram' | 'ranked' | 'other')[]
    /** only games you played with at least one premade */
    onlyWithPremades: boolean
    /** players that aren't you or your premades appear only as their champion */
    anonymizeRandoms: boolean
    includeQuips: boolean
    includeAchievements: boolean
    /** after a game was posted, add its best automatic clip (off by default) */
    attachBestClip: boolean
    /** files above this many MB are exported smaller before they are sent (Discord: 20; boosted servers 50 or 100) */
    uploadLimitMb: number
  }
  /** Clips: records your games through Windows' own capture interfaces (off by default) */
  recorder: RecorderSettings
}

/** The settings the renderer can change (the flags about stored secrets are read-only). */
export type EditableSettings = Omit<Settings, 'hasApiKey' | 'hasDiscordWebhook'>

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
  /** what your saved games say about this player (never set for you and your premades) */
  encounter?: Encounter | null
  /**
   * The game hides this player (streamer mode, "Hide My Name"): the session gives no name. Riot does
   * not allow identifying or analysing hidden players, so they get no name, record or badge.
   */
  hidden?: boolean
}

/** You and one other player in your saved games (Profile page). */
export interface PlayerHistory {
  encounter: Encounter | null
  /** saved games you shared, newest first */
  gameIds: number[]
}

export interface LoadingState {
  mode: 'mayhem' | 'aram'
  players: LoadingPlayer[]
  /** galaxy seed of this game (set by the main process) */
  seed?: number
}

/** One finished game in the list of post-game summaries. */
export interface GameListEntry {
  gameId: number
  createdAt: number
  duration: number
  queueId: number
  mode: string
  win: boolean
  championId: number
  kda: [number, number, number]
  blamedPremade: string | null
  /** seed of the place in the universe where the game was played (see shared/universe.ts) */
  cosmos: number
}

/** An achievement as the app shows it (see shared/achievements.ts). */
export interface AchievementState {
  id: string
  name: string
  description: string
  category: AchievementCategory
  rank: AchievementRank
  secret: boolean
  unlocked: boolean
  /** when it was unlocked (the game's end), never changes once set */
  unlockedAt: number | null
  /** the game that unlocked it, null when it came from flights */
  gameId: number | null
  /** shown to you already (the unlock animation played) */
  seen: boolean
  progress: number
  goal: number
}

/** One row of the MVP / troll leaderboard: you or one of your premades, over all saved games. */
export interface LeaderboardEntry {
  puuid: string
  riotId: string
  me: boolean
  /** their most played champion in those games */
  championId: number
  games: number
  wins: number
  /** games as the best player of your team */
  mvps: number
  /** games as the worst player of your team */
  trolls: number
  avgScore: number
  /** average will to win (0–100) of your team in their games that have it; null when none has */
  avgWill: number | null
  /** games the average will is taken over */
  willGames: number
}

export type AcceptDelay = 'instant' | 'human' | 'slow'

// ---------------------------------------------------------------------------
// Clips (gameplay recorder)
// ---------------------------------------------------------------------------

/** The FFmpeg build the recorder uses (downloaded once into userData/ffmpeg, never bundled). */
export interface FfmpegState {
  status: 'missing' | 'downloading' | 'verifying' | 'unpacking' | 'ready' | 'error'
  /** 0 to 1 while downloading */
  progress?: number
  version?: string
  message?: string
}

/** The game a clip belongs to, for the library (from the saved summary). */
export interface ClipGame {
  championId: number
  kda: [number, number, number]
  win: boolean
  mode: string
  queueId: number
  createdAt: number
}

/** A saved clip. The video is served to the window as rcclip://clip/<id>. */
export interface Clip {
  id: number
  gameId: number | null
  recordingId: number | null
  createdAt: number
  /** position in its recording */
  startMs: number
  endMs: number
  durationMs: number
  /** manual, bookmark, auto:penta … or 'export' for something the editor made */
  kind: ClipKind | 'export'
  title: string
  favorite: boolean
  bytes: number
  url: string
  thumbUrl: string | null
  /** null for clips without a saved game (tests, games whose summary never came) */
  game: ClipGame | null
  /** how worth watching it is (see @shared/highlights); null until it was looked at */
  highlight?: { score: number; tier: 'S' | 'A' | 'B' | 'C'; label: string } | null
}

/** A whole-game recording (session mode), joined into one file after the game. */
export interface SessionRecording {
  id: number
  gameId: number | null
  startedAt: number
  durationMs: number
  bytes: number
  /** marked "keep": never deleted by the cleanup */
  kept: boolean
  /** when the cleanup deletes it (null when kept) */
  expiresAt: number | null
  url: string
  game: ClipGame | null
}

/** Space used by clips and recordings. */
export interface ClipStorageInfo {
  usedBytes: number
  quotaBytes: number
  clipBytes: number
  sessionBytes: number
  /** leftovers of replay recordings, screenshots, exports */
  otherBytes: number
  clips: number
  sessions: number
}

/** What "Clean up" would delete. Clips and favorites are never on this list. */
export interface CleanupPreview {
  items: { name: string; type: 'replay' | 'session'; bytes: number; at: number }[]
  freedBytes: number
  usedAfter: number
  overQuota: boolean
}

/** What the editor sends to export a project. */
export interface ExportRequest {
  /** the clip the project belongs to (the export shows up next to it in the library) */
  clipId: number
  /** belongs to no game (a month's recap made of many games) */
  standalone?: boolean
  project: EditProject
  title: string
  /**
   * Pictures the window drew for the export, as PNG data URLs: one per sticker id (emoji and
   * imported pictures alike) and 'stats' for the stats overlay at output size.
   */
  images: Record<string, string>
}

/** An export in progress or finished. One runs at a time, never during a game. */
export interface ExportJob {
  id: number
  /** paused = a game started; it starts again from the beginning when the game is over */
  state: 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  /** 0 to 1 */
  progress: number
  preset: ExportPresetId
  title: string
  message: string | null
  bytes: number
  /** the finished export as a clip of the library */
  clip: Clip | null
}

/** A file the user picked for the editor (music or a picture); the window plays it through `url`. */
export interface PickedMedia {
  url: string
  path: string
  name: string
}

/** What the recorder is doing, for the header of the main window and the Clips settings. */
export interface RecorderStatus {
  /** off = switched off or something is missing (see message), error = recording failed */
  state: 'off' | 'idle' | 'recording' | 'saving' | 'error'
  message: string | null
  mode: RecorderMode
  /** "NVIDIA AV1" while recording */
  encoder: string | null
  startedAt: number | null
  /** space used by clips and recordings */
  bytes: number
  quotaBytes: number
  /** seconds of footage a clip could go back right now */
  ringSeconds: number
  /** bookmarks set in the running game */
  bookmarks: number
  lastClip: Clip | null
}

/** What the recorder needs before it can run, for the Clips settings. */
export interface RecorderSetup {
  ffmpeg: FfmpegState
  /** null until the encoders were tested (needs FFmpeg) */
  encoders: EncoderProbe | null
  /** the small helper that records the game's sound (ratio-audio.exe) is there */
  audioHelper: boolean
  /** the storage folder in use */
  folder: string
  /** recording only works on Windows 10 2004 or newer */
  supported: boolean
}

/** Timers shown on the minimap (all times are game time in seconds). */
export interface MinimapState {
  gameTime: number
  /** Date.now() when gameTime was measured. The overlay counts down locally in between. */
  measuredAt: number
  rect: { x: number; y: number; w: number; h: number }
  /** minimap inside the overlay window (DIP), filled in by the main process */
  local?: { x: number; y: number; w: number; h: number }
  /** `since` = when it was destroyed, for the progress ring */
  inhibitors: { team: 'ORDER' | 'CHAOS'; respawnAt: number; since?: number; pos: { x: number; y: number } }[]
  relics: {
    id: string
    team: 'ORDER' | 'CHAOS'
    /** base = the extra relic between the nexus turrets (Mayhem, Cafe Cuties headliner) */
    kind: 'outer' | 'inner' | 'base'
    pos: { x: number; y: number }
    /** up = seen on the minimap, spawn = comes back at `at`, unknown = up but not confirmed */
    state: 'up' | 'spawn' | 'unknown'
    at: number | null
    /** when it was taken (game seconds), for the progress ring */
    since?: number | null
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
  /** Data Dragon id of the champion (from rawChampionName, e.g. "MonkeyKing"), language independent */
  championKey?: string | null
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
  /**
   * Riot's GameStart event is in the feed (or the clock runs): the loading screen is over. The game
   * already answers during the loading screen, with level 1 and the clock at 0.
   */
  started: boolean
  /** Riot's GameEnd event: "Win" or "Lose" once a Nexus fell, null while the game runs */
  result: 'Win' | 'Lose' | null
  gameTime: number
  gameMode: string
  /** 12 = Howling Abyss (other numbers: Butcher's Bridge, Koeshin's Crossing, …) */
  mapNumber?: number | null
  /** as reported by the game, for diagnostics ("Map12", "Default", …) */
  mapName?: string | null
  mapTerrain?: string | null
  /** champion name of the local player (localized) */
  activeChampion: string | null
  /** Data Dragon id of the local player's champion (e.g. "MonkeyKing"), language independent */
  activeChampionKey?: string | null
  /** the local player's health as a share of their maximum (0–1), null when the game didn't say */
  activeHealth?: number | null
  /** Riot IDs of the players you queued with (from the client lobby) */
  premades?: string[]
  /** inhibitor kills / respawns from the event feed ("soon" = the 15 s warning before a respawn) */
  inhibitorEvents?: { type: 'killed' | 'soon' | 'respawned'; inhibitor: string; time: number }[]
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
  /**
   * Riot's display tags of the augment without the "k" prefix, lower case ("damage", "resilience",
   * "speed", "ally", "classicish", …). Missing in data saved before November 2026.
   */
  tags?: string[]
  /**
   * Augment pools of the game client the augment is in: "KIWI" is the normal Mayhem pool, other
   * "KIWI_…" pools belong to a map skin ("KIWI_JADE" = MapSkin_Map12_Jade). Missing in older data.
   */
  pools?: string[]
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
  /** how often you took each augment – no win rate: Riot does not allow showing win rates of augments */
  augments: { id: number; games: number }[]
  champions: { championId: number; games: number; wins: number }[]
  recent: { gameId: number; championId: number; win: boolean; augments: number[]; createdAt: number }[]
}

// ---------------------------------------------------------------------------
// IPC contract
// ---------------------------------------------------------------------------

export interface RcApi {
  getStatic(): Promise<StaticData>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<EditableSettings>): Promise<Settings>
  setApiKey(key: string): Promise<{ ok: boolean; message: string }>
  /** stores the Discord webhook URL encrypted ('' removes it) */
  setDiscordWebhook(url: string): Promise<{ ok: boolean; message: string }>
  /** sends a made-up game marked [TEST] to the saved webhook */
  testDiscordWebhook(): Promise<{ ok: boolean; message: string }>
  /** posts a saved game to the webhook now, whatever the automatic rules say */
  postGameToDiscord(gameId: number): Promise<{ ok: boolean; message: string }>
  /** sends the will to win of a game (the button on the game page; never on its own) */
  postWillToDiscord(gameId: number): Promise<{ ok: boolean; message: string }>
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
  listGames(): Promise<GameListEntry[]>
  getGame(gameId: number): Promise<GameSummary | null>
  /** reads the will-to-win signals of a game saved before 1.3.3 from the League client; the summary as it is if that isn't possible */
  fillGameEffort(gameId: number): Promise<GameSummary | null>
  getLeaderboard(): Promise<LeaderboardEntry[]>
  getAchievements(): Promise<AchievementState[]>
  /** the unlock animation of these has played */
  markAchievementsSeen(ids: string[]): Promise<void>
  /** a flight to the next galaxy was shown (wormhole or slingshot), for the cosmos achievements */
  recordFlight(variant: 'wormhole' | 'slingshot', seed: number): Promise<void>
  /** FFmpeg, encoders and helper of the recorder */
  recorderSetup(): Promise<RecorderSetup>
  /** downloads and verifies the FFmpeg build (progress comes as 'ffmpeg' events) */
  installFfmpeg(): Promise<FfmpegState>
  /** tests the GPU encoders again (never during a game) */
  testEncoders(): Promise<EncoderProbe | null>
  recorderStatus(): Promise<RecorderStatus>
  /** the same as the clip hotkey: saves the last seconds of the running recording */
  clipNow(): Promise<Clip | null>
  listClips(): Promise<Clip[]>
  updateClip(id: number, patch: { title?: string; favorite?: boolean }): Promise<Clip | null>
  /** deletes clips and their files for good, returns how many */
  deleteClips(ids: number[]): Promise<number>
  /** shows a clip's file in the file manager */
  showClipInFolder(id: number): Promise<void>
  clipStorage(): Promise<ClipStorageInfo>
  cleanupPreview(): Promise<CleanupPreview>
  cleanupRun(): Promise<CleanupPreview>
  /** whole-game recordings that still exist, newest first */
  listRecordings(): Promise<SessionRecording[]>
  /** the whole-game recording of a game, null when there is none (any more) */
  gameRecording(gameId: number): Promise<SessionRecording | null>
  keepRecording(id: number, keep: boolean): Promise<SessionRecording | null>
  deleteRecording(id: number): Promise<void>
  /** cuts a clip out of a whole-game recording (stream copy) */
  clipFromRecording(id: number, startMs: number, endMs: number): Promise<Clip | null>
  /** the editor's saved project of a clip, null when there is none yet */
  getEdit(clipId: number): Promise<EditProject | null>
  saveEdit(clipId: number, project: EditProject): Promise<void>
  /** asks for a music file or a picture from the disk */
  pickMedia(kind: 'music' | 'image'): Promise<PickedMedia | null>
  /** a playable URL for a file a saved project names (music, picture); null when it is gone */
  mediaUrl(path: string): Promise<string | null>
  /** starts an export in the background; progress comes as 'exportProgress' events */
  exportStart(request: ExportRequest): Promise<ExportJob>
  exportCancel(): Promise<void>
  /** which clips of a game or a month a highlight video would show, with their scores */
  highlightPlan(scope: HighlightScope): Promise<HighlightPlan>
  /** makes that video (an export with the Discord preset); progress comes as 'exportProgress' events */
  createHighlightVideo(scope: HighlightScope): Promise<ExportJob>
  exportStatus(): Promise<ExportJob | null>
  /** posts a clip to the Discord webhook; a clip that was posted before needs `again` */
  shareClipToDiscord(id: number, options?: { quip?: boolean; again?: boolean }): Promise<{ ok: boolean; message: string; alreadyPosted?: boolean }>
  /** puts a clip's file on the clipboard, ready to paste into Discord or a folder */
  copyClipFile(id: number): Promise<boolean>
  /** "Save as…": copies a clip's file to a place of your choice; false when cancelled */
  saveClipAs(id: number): Promise<boolean>
  /** opens the folder with your clips (creates it if needed) */
  openClipFolder(): Promise<void>
  /** asks for another storage folder; null when cancelled */
  chooseClipFolder(): Promise<string | null>
  /** your saved games with or against a player; null when you never met */
  getPlayerHistory(puuid: string, riotId?: string): Promise<PlayerHistory | null>
  setOwnedAugments(ids: number[]): Promise<void>
  overlayTestScan(): Promise<ScanTestResult>
  openDiagnosticsFolder(): Promise<void>
  liveGame(): Promise<LiveGameState | null>
  lookupProfile(riotId: string, platform: Platform): Promise<ProfileData>
  scoutActiveGame(riotId: string, platform: Platform): Promise<ScoutResult | null>
  openExternal(url: string): Promise<void>
  /** adds a line to overlay.log (the flight's GPU and timings, so a report shows what happened) */
  logDiag(message: string): void
  on<K extends keyof RcEvents>(event: K, cb: (payload: RcEvents[K]) => void): () => void
  /** developer tools, only there in `npm run dev` (never in the installer) */
  admin?: AdminApi
}

// ---------------------------------------------------------------------------
// Admin tool (development builds only)
// ---------------------------------------------------------------------------

/** A health relic pad as measured on a map's minimap (positions are fractions of the minimap). */
export interface AdminRelicPad {
  id: string
  team: 'ORDER' | 'CHAOS'
  kind: 'outer' | 'inner' | 'base'
  pos: { x: number; y: number }
}

export type AdminRelicSeen = 'present' | 'absent' | 'unclear'

/** Options of a simulated ARAM game (fed through the same code path as the real live data). */
export interface AdminSimOptions {
  mode: 'aram' | 'mayhem'
  /** map number the game reports (12 = Howling Abyss) */
  map: number
  /** game time to start at, in seconds */
  startAt: number
  /** how long a destroyed inhibitor really stays down in the simulation (to test the learning) */
  inhibitorRespawn: number
}

export type AdminSimAction =
  | { type: 'inhibitor'; team: 'ORDER' | 'CHAOS'; event: 'killed' | 'soon' | 'respawned' }
  | { type: 'relicTaken'; padId: string }
  | { type: 'skip'; seconds: number }
  /** a fight in the simulated game's event feed (goes through the automatic clips like a real one) */
  | { type: 'fight'; kind: AdminSimFight }

export type AdminSimFight =
  'firstBlood' | 'triple' | 'quadra' | 'penta' | 'premadePenta' | 'allyAce' | 'enemyAce' | 'myDeath' | 'victory' | 'defeat'

export interface AdminSimState {
  options: AdminSimOptions
  gameTime: number
  /** inhibitor events sent so far */
  inhibitorEvents: NonNullable<LiveGameState['inhibitorEvents']>
  /** relic pads of the map and when each was last taken in the simulation */
  pads: (AdminRelicPad & { takenAt: number | null })[]
}

export interface AdminMinimapSnapshot {
  /** map the pads belong to: the running game's, else the Howling Abyss */
  map: number
  mapName: string | null
  inGame: boolean
  display: { id: number; width: number; height: number; scaleFactor: number }
  /** minimap on the display, in fractions */
  rect: { x: number; y: number; w: number; h: number }
  /** the minimap at physical resolution (RGBA), null if the screen couldn't be captured */
  image: { width: number; height: number; data: Uint8Array } | null
  error?: string
  /** pads in use on this map and what the relic detection sees there right now */
  pads: (AdminRelicPad & { seen: AdminRelicSeen | null })[]
  source: 'measured' | 'built-in' | 'none'
  /** side of the square the detection looks at around a pad, as a fraction of the minimap */
  patch: number
}

export interface AdminApi {
  /** the same as accepting a match in the client: the app flies to the next galaxy */
  acceptMatch(): Promise<void>
  /** sends the champion select to the main window as if it came from the League client (null ends it) */
  emit<K extends 'champSelect'>(event: K, payload: RcEvents[K]): Promise<void>
  simStart(options: AdminSimOptions): Promise<AdminSimState>
  simAction(action: AdminSimAction): Promise<AdminSimState | null>
  simState(): Promise<AdminSimState | null>
  simStop(): Promise<void>
  /** example minimap timers on the game screen until hideOverlays ('pads' = every relic pad of `map`) */
  showMinimapDemo(scenario: 'mixed' | 'soon' | 'pads', map?: number): Promise<void>
  /** card frames of an augment choice for this champion until hideOverlays */
  showFrames(championId: number): Promise<void>
  showLoading(state: LoadingState): Promise<void>
  /** the loading panel with the players you met most often in your saved games and their real encounters */
  showHistoryLobby(): Promise<number>
  /** ends every preview and puts the real overlays back */
  hideOverlays(): Promise<void>
  /** stores a made-up summary as a game with a negative id and opens it */
  saveTestGame(summary: GameSummary): Promise<void>
  /** removes every game with a negative id, returns how many */
  deleteTestGames(): Promise<number>
  /** unlocks an achievement now (as if the newest game did it) and sends the unlock event */
  unlockAchievement(id: string): Promise<void>
  /** the Discord message the newest saved game would get, and why it would not be posted automatically */
  discordPreview(): Promise<{ gameId: number | null; payload: unknown; skip: string | null }>
  /** starts or stops a recording of a test picture, so the simulated game has something to cut clips from */
  recorderTestRecording(on: boolean): Promise<RecorderStatus>
  /** the segments of the running recording, pending automatic clips and bookmarks */
  recorderRing(): Promise<{ segments: number; from: number; to: number; bytes: number; pending: string[]; bookmarks: number; offset: number | null }>
  /** downloads FFmpeg again and tests the encoders from scratch */
  recorderReloadFfmpeg(): Promise<RecorderSetup>
  /** records 20 s of a test picture or of the main screen through the real pipeline; returns the folder and what FFmpeg said */
  recorderTestCapture(source: 'testsrc' | 'screen'): Promise<{ ok: boolean; dir: string; segments: number; bytes: number; log: string[] }>
  /** locks every achievement again (they are worked out anew from the history), returns the unlocked ones after that */
  resetAchievements(): Promise<number>
  log(lines: number): Promise<string[]>
  minimapSnapshot(): Promise<AdminMinimapSnapshot>
  /** what the relic detection sees at these pads in the last snapshot */
  classifyPads(pads: AdminRelicPad[]): Promise<(AdminRelicSeen | null)[]>
  measuredPads(): Promise<Record<string, AdminRelicPad[]>>
  /** stores the pads of a map (null = back to the built-in ones), returns all measured pads */
  savePads(map: number, pads: AdminRelicPad[] | null): Promise<Record<string, AdminRelicPad[]>>
}

/** Augment cards currently offered on screen (detected by screen recognition). */
export interface AugmentOffer {
  displayId: number
  /** which card layout matched on this screen (see @shared/cardLayout), for the log */
  fit?: 'height' | 'fit16x9'
  /** only for the settings preview: rate the cards for this champion instead of the live one */
  championId?: number
  /** card rectangles relative to the display, in DIP */
  cards: {
    augmentId: number | null
    text: string
    score: number
    rect: { x: number; y: number; width: number; height: number }
  }[]
}

/** Live status of the overlay and screen recognition (Settings > Diagnostics). */
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
  /** League's window mode as far as we know it ('fullscreen' | 'windowed' | 'borderless') */
  windowMode: string | null
  /** hotkeys Windows refused the last time they were registered (held by another program, or no key combination) */
  hotkeysFailed: string[]
  /** one line per monitor: id, position, size in DIP, Windows scaling */
  displays: string[]
  /** what keeps the overlay from working, if anything */
  notice: OverlayNotice | null
  log: string[]
}

export interface ScanTestResult {
  captureMs: number
  screens: {
    displayId: number
    size: string
    /** Windows display scaling of this screen (1 = 100 %) */
    scaleFactor?: number
    primary?: boolean
    /** card layout that matched (null when no cards were found) */
    layout?: 'height' | 'fit16x9' | null
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
  augmentOffer: AugmentOffer | null
  /** offer with card rects relative to the frames window (sent to that window only) */
  framesOffer: AugmentOffer | null
  augmentsOwned: number[]
  /** a new game started, the Games page jumps to the next galaxy */
  journey: { seed: number }
  /** a post-game summary is ready */
  gameSummary: GameSummary
  /** ids of achievements that were just unlocked */
  achievementsUnlocked: string[]
  loading: LoadingState | null
  /** download progress and state of the recorder's FFmpeg */
  ffmpeg: FfmpegState
  /** recorder status: idle, recording, saving, space used, last clip */
  recorder: RecorderStatus
  /** a clip was saved (hotkey, automatic, bookmark) */
  clipSaved: Clip
  exportProgress: ExportJob
  /** clips got (new) highlight scores */
  highlightsScored: number[]
  /** map timers for the main window (the minimap overlay gets its own copy with positions) */
  mapTimers: MinimapState | null
  minimap: MinimapState | null
  update: UpdateState
  /** why the in-game overlay can't work right now (fullscreen, windowed, black capture), null when fine */
  overlayNotice: OverlayNotice | null
}
export type { OverlayNotice } from './overlayNotice'
