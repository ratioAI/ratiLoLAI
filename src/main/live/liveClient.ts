import https from 'node:https'
import type { LiveGameState, LivePlayer } from '@shared/types'

// the game serves this API with a self-signed certificate on localhost
const agent = new https.Agent({ rejectUnauthorized: false })

/** Riot's official in-game Live Client Data API (only available while a game is running). */
export function fetchAllGameData(): Promise<unknown | null> {
  return new Promise((resolve) => {
    const req = https.get({ host: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata', agent, timeout: 2000 }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (raw += chunk))
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null)
        try {
          resolve(JSON.parse(raw))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
}

interface RawLive {
  activePlayer?: { riotId?: string; summonerName?: string }
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
      EventName: string
      EventTime: number
      KillerName?: string
      VictimName?: string
      DragonType?: string
      InhibKilled?: string
      InhibRespawned?: string
    }[]
  }
  gameData?: { gameTime: number; gameMode: string; mapNumber?: number; mapName?: string }
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
  const inhibitorEvents = (data.events?.Events ?? []).flatMap((event): InhibEvent[] =>
    event.EventName === 'InhibKilled' && event.InhibKilled
      ? [{ type: 'killed', inhibitor: event.InhibKilled, time: event.EventTime }]
      : event.EventName === 'InhibRespawned' && event.InhibRespawned
        ? [{ type: 'respawned', inhibitor: event.InhibRespawned, time: event.EventTime }]
        : []
  )
  return {
    active: true,
    gameTime: data.gameData.gameTime,
    gameMode: data.gameData.gameMode,
    mapNumber: data.gameData.mapNumber ?? null,
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
    players,
    events,
    inhibitorEvents
  }
}
