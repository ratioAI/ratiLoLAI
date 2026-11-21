import https from 'node:https'
import type { LiveGameState, LivePlayer } from '@shared/types'
import type { LiveEvent } from '@shared/liveEvents'

// the game serves this API with a self-signed certificate on localhost
const agent = new https.Agent({ rejectUnauthorized: false })

/** One request to the game: its data, or why there was none (for the log). */
export type LiveAnswer = { ok: true; data: unknown } | { ok: false; reason: string }

/** Riot's official in-game Live Client Data API (only available while a game is running). */
export function fetchAllGameData(): Promise<LiveAnswer> {
  return new Promise((resolve) => {
    let timedOut = false
    const req = https.get({ host: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata', agent, timeout: 2000 }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (raw += chunk))
      // the game closed in the middle of an answer: without a listener this is an uncaught error
      res.on('error', (error: NodeJS.ErrnoException) => resolve({ ok: false, reason: error.code ?? error.message }))
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, reason: `HTTP ${res.statusCode}` })
        try {
          resolve({ ok: true, data: JSON.parse(raw) })
        } catch {
          resolve({ ok: false, reason: `no JSON (${raw.length} bytes)` })
        }
      })
    })
    req.on('timeout', () => {
      timedOut = true
      req.destroy()
    })
    req.on('error', (error: NodeJS.ErrnoException) =>
      resolve({ ok: false, reason: timedOut ? 'timeout (2 s)' : (error.code ?? error.message) })
    )
  })
}

interface RawLive {
  activePlayer?: { riotId?: string; summonerName?: string; championStats?: { currentHealth?: number; maxHealth?: number } }
  allPlayers?: {
    riotId?: string
    summonerName?: string
    championName: string
    rawChampionName?: string
    team: 'ORDER' | 'CHAOS'
    level: number
    position: string
    isDead: boolean
    respawnTimer: number
    scores: { kills: number; deaths: number; assists: number; creepScore: number }
    items: { itemID: number; slot: number }[]
    summonerSpells: { summonerSpellOne?: { displayName: string }; summonerSpellTwo?: { displayName: string } }
  }[]
  events?: {
    Events?: {
      EventID?: number
      EventName: string
      EventTime: number
      KillerName?: string
      VictimName?: string
      Assisters?: string[]
      KillStreak?: number
      Acer?: string
      AcingTeam?: string
      Recipient?: string
      Result?: string
      DragonType?: string
      InhibKilled?: string
      InhibRespawningSoon?: string
      InhibRespawned?: string
    }[]
  }
  gameData?: { gameTime: number; gameMode: string; mapNumber?: number; mapName?: string; mapTerrain?: string }
}

function describe(event: { EventName: string; KillerName?: string; VictimName?: string; DragonType?: string }): string {
  switch (event.EventName) {
    case 'ChampionKill':
      return `${event.KillerName ?? '?'} killed ${event.VictimName ?? '?'}`
    case 'DragonKill':
      return `${event.KillerName ?? '?'} slew the ${event.DragonType ?? ''} dragon`
    case 'BaronKill':
      return `${event.KillerName ?? '?'} slew Baron Nashor`
    case 'HeraldKill':
      return `${event.KillerName ?? '?'} slew the Rift Herald`
    case 'TurretKilled':
      return `Turret destroyed (${event.KillerName ?? '?'})`
    case 'InhibKilled':
      return `Inhibitor destroyed (${event.KillerName ?? '?'})`
    case 'InhibRespawningSoon':
      return 'Inhibitor respawning soon'
    case 'InhibRespawned':
      return 'Inhibitor respawned'
    case 'FirstBlood':
      return 'First Blood!'
    case 'GameStart':
      return 'Game started'
    case 'MinionsSpawning':
      return 'Minions spawned'
    default:
      return event.EventName
  }
}

export function parseLiveData(raw: unknown): LiveGameState | null {
  const data = raw as RawLive | null
  if (!data?.allPlayers || !data.gameData) return null
  const players: LivePlayer[] = data.allPlayers.map((player) => ({
    riotId: player.riotId ?? player.summonerName ?? '',
    championName: player.championName,
    // "game_character_displayname_Ahri" → "Ahri", the same in every client language
    championKey: player.rawChampionName?.replace(/^game_character_displayname_/, '') || null,
    team: player.team,
    level: player.level,
    kills: player.scores.kills,
    deaths: player.scores.deaths,
    assists: player.scores.assists,
    creepScore: player.scores.creepScore,
    items: [...player.items].sort((a, b) => a.slot - b.slot).map((item) => item.itemID),
    spells: [player.summonerSpells.summonerSpellOne?.displayName ?? '', player.summonerSpells.summonerSpellTwo?.displayName ?? ''],
    position: player.position,
    isDead: player.isDead,
    respawnTimer: player.respawnTimer
  }))
  // latest 12 events, newest first
  const events = (data.events?.Events ?? [])
    .filter((event) => event.EventName !== 'MinionsSpawning')
    .slice(-12)
    .reverse()
    .map((event) => ({ name: event.EventName, time: event.EventTime, text: describe(event) }))
  type InhibEvent = NonNullable<LiveGameState['inhibitorEvents']>[number]
  // "respawning soon" comes 15 s before the respawn (that's when the announcer calls it)
  const inhibitorEvents = (data.events?.Events ?? []).flatMap((event): InhibEvent[] =>
    event.EventName === 'InhibKilled' && event.InhibKilled
      ? [{ type: 'killed', inhibitor: event.InhibKilled, time: event.EventTime }]
      : event.EventName === 'InhibRespawningSoon' && event.InhibRespawningSoon
        ? [{ type: 'soon', inhibitor: event.InhibRespawningSoon, time: event.EventTime }]
        : event.EventName === 'InhibRespawned' && event.InhibRespawned
          ? [{ type: 'respawned', inhibitor: event.InhibRespawned, time: event.EventTime }]
          : []
  )
  const feed = data.events?.Events ?? []
  const gameEnd = feed.find((event) => event.EventName === 'GameEnd')
  return {
    active: true,
    // the game answers during the loading screen too; GameStart comes when the clock starts
    started: feed.some((event) => event.EventName === 'GameStart') || data.gameData.gameTime > 1,
    result: gameEnd ? (gameEnd.Result === 'Win' ? 'Win' : 'Lose') : null,
    gameTime: data.gameData.gameTime,
    gameMode: data.gameData.gameMode,
    mapNumber: data.gameData.mapNumber ?? null,
    mapName: data.gameData.mapName ?? null,
    mapTerrain: data.gameData.mapTerrain ?? null,
    activePlayer: data.activePlayer?.riotId ?? data.activePlayer?.summonerName ?? null,
    activeChampion:
      players.find((player) => player.riotId && player.riotId === (data.activePlayer?.riotId ?? data.activePlayer?.summonerName))
        ?.championName ?? null,
    // rawChampionName looks like "game_character_displayname_Ahri", the suffix is the Data Dragon key
    activeChampionKey: (() => {
      const activePlayer = data.allPlayers.find(
        (player) => (player.riotId ?? player.summonerName) === (data.activePlayer?.riotId ?? data.activePlayer?.summonerName)
      )
      return activePlayer?.rawChampionName?.replace(/^game_character_displayname_/, '') ?? null
    })(),
    activeHealth: (() => {
      const stats = data.activePlayer?.championStats
      const max = Number(stats?.maxHealth)
      const current = Number(stats?.currentHealth)
      return max > 0 && Number.isFinite(current) ? Math.max(0, Math.min(1, current / max)) : null
    })(),
    players,
    events,
    inhibitorEvents
  }
}

/**
 * Every event of the feed with its id (the automatic clips need all of them and the ids; the Live tab
 * only gets the newest twelve as text). Events without an id are dropped.
 */
export function parseLiveEvents(raw: unknown): LiveEvent[] {
  const events = (raw as RawLive | null)?.events?.Events ?? []
  return events.flatMap((event): LiveEvent[] =>
    typeof event.EventID === 'number'
      ? [
          {
            EventID: event.EventID,
            EventName: event.EventName,
            EventTime: event.EventTime,
            KillerName: event.KillerName,
            VictimName: event.VictimName,
            Assisters: event.Assisters,
            KillStreak: event.KillStreak,
            Acer: event.Acer,
            AcingTeam: event.AcingTeam,
            Recipient: event.Recipient,
            Result: event.Result
          }
        ]
      : []
  )
}
