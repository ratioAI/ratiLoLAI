import https from 'node:https'
import type { LiveGameState, LivePlayer } from '@shared/types'

const agent = new https.Agent({ rejectUnauthorized: false })

/** Riot's official in-game Live Client Data API (only available while a game is running). */
export function fetchAllGameData(): Promise<unknown | null> {
  return new Promise((resolve) => {
    const req = https.get(
      { host: '127.0.0.1', port: 2999, path: '/liveclientdata/allgamedata', agent, timeout: 2000 },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null)
          try {
            resolve(JSON.parse(raw))
          } catch {
            resolve(null)
          }
        })
      }
    )
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
  gameData?: { gameTime: number; gameMode: string }
}

function describe(e: { EventName: string; KillerName?: string; VictimName?: string; DragonType?: string }): string {
  switch (e.EventName) {
    case 'ChampionKill':
      return `${e.KillerName ?? '?'} killed ${e.VictimName ?? '?'}`
    case 'DragonKill':
      return `${e.KillerName ?? '?'} slew the ${e.DragonType ?? ''} dragon`
    case 'BaronKill':
      return `${e.KillerName ?? '?'} slew Baron Nashor`
    case 'HeraldKill':
      return `${e.KillerName ?? '?'} slew the Rift Herald`
    case 'TurretKilled':
      return `Turret destroyed (${e.KillerName ?? '?'})`
    case 'InhibKilled':
      return `Inhibitor destroyed (${e.KillerName ?? '?'})`
    case 'FirstBlood':
      return 'First Blood!'
    case 'GameStart':
      return 'Game started'
    case 'MinionsSpawning':
      return 'Minions spawned'
    default:
      return e.EventName
  }
}

export function parseLiveData(raw: unknown): LiveGameState | null {
  const d = raw as RawLive | null
  if (!d?.allPlayers || !d.gameData) return null
  const players: LivePlayer[] = d.allPlayers.map((p) => ({
    riotId: p.riotId ?? p.summonerName ?? '',
    championName: p.championName,
    team: p.team,
    level: p.level,
    kills: p.scores.kills,
    deaths: p.scores.deaths,
    assists: p.scores.assists,
    creepScore: p.scores.creepScore,
    items: [...p.items].sort((a, b) => a.slot - b.slot).map((i) => i.itemID),
    spells: [p.summonerSpells.summonerSpellOne?.displayName ?? '', p.summonerSpells.summonerSpellTwo?.displayName ?? ''],
    position: p.position,
    isDead: p.isDead,
    respawnTimer: p.respawnTimer
  }))
  const events = (d.events?.Events ?? [])
    .filter((e) => e.EventName !== 'MinionsSpawning')
    .slice(-12)
    .reverse()
    .map((e) => ({ name: e.EventName, time: e.EventTime, text: describe(e) }))
  type InhibEvent = NonNullable<LiveGameState['inhibitorEvents']>[number]
  const inhibitorEvents = (d.events?.Events ?? []).flatMap((e): InhibEvent[] =>
    e.EventName === 'InhibKilled' && e.InhibKilled
      ? [{ type: 'killed', inhibitor: e.InhibKilled, time: e.EventTime }]
      : e.EventName === 'InhibRespawned' && e.InhibRespawned
        ? [{ type: 'respawned', inhibitor: e.InhibRespawned, time: e.EventTime }]
        : []
  )
  return {
    active: true,
    gameTime: d.gameData.gameTime,
    gameMode: d.gameData.gameMode,
    activePlayer: d.activePlayer?.riotId ?? d.activePlayer?.summonerName ?? null,
    activeChampion:
      players.find((p) => p.riotId && p.riotId === (d.activePlayer?.riotId ?? d.activePlayer?.summonerName))?.championName ?? null,
    activeChampionKey: (() => {
      const me = d.allPlayers.find((p) => (p.riotId ?? p.summonerName) === (d.activePlayer?.riotId ?? d.activePlayer?.summonerName))
      return me?.rawChampionName?.replace(/^game_character_displayname_/, '') ?? null
    })(),
    players,
    events,
    inhibitorEvents
  }
}
