// Minimal subsets of the Riot API DTOs that ratioAI uses.

export interface LeagueListDTO {
  tier: string
  entries: LeagueItemDTO[]
}

export interface LeagueItemDTO {
  puuid: string
  leaguePoints: number
  wins: number
  losses: number
  rank?: string
}

export interface LeagueEntryDTO {
  queueType: string
  tier: string
  rank: string
  leaguePoints: number
  wins: number
  losses: number
  puuid: string
}

export interface AccountDTO {
  puuid: string
  gameName: string
  tagLine: string
}

export interface SummonerDTO {
  puuid: string
  profileIconId: number
  summonerLevel: number
}

export interface MasteryDTO {
  championId: number
  championLevel: number
  championPoints: number
}

export interface PerkStyleSelection {
  perk: number
}

export interface PerkStyle {
  description: 'primaryStyle' | 'subStyle' | string
  style: number
  selections: PerkStyleSelection[]
}

export interface ParticipantDTO {
  participantId: number
  puuid: string
  riotIdGameName?: string
  riotIdTagline?: string
  summonerName?: string
  championId: number
  teamId: number
  teamPosition: string
  individualPosition?: string
  win: boolean
  kills: number
  deaths: number
  assists: number
  totalMinionsKilled: number
  neutralMinionsKilled: number
  goldEarned: number
  totalDamageDealtToChampions: number
  visionScore: number
  item0: number
  item1: number
  item2: number
  item3: number
  item4: number
  item5: number
  item6: number
  summoner1Id: number
  summoner2Id: number
  gameEndedInEarlySurrender?: boolean
  perks: {
    statPerks: { offense: number; flex: number; defense: number }
    styles: PerkStyle[]
  }
}

export interface MatchDTO {
  metadata: { matchId: string; participants: string[] }
  info: {
    gameId: number
    gameCreation: number
    gameDuration: number
    gameVersion: string
    queueId: number
    participants: ParticipantDTO[]
    teams: { teamId: number; win: boolean; bans: { championId: number; pickTurn: number }[] }[]
  }
}

export type TimelineEvent =
  | { type: 'ITEM_PURCHASED'; timestamp: number; participantId: number; itemId: number }
  | { type: 'ITEM_SOLD'; timestamp: number; participantId: number; itemId: number }
  | { type: 'ITEM_DESTROYED'; timestamp: number; participantId: number; itemId: number }
  | { type: 'ITEM_UNDO'; timestamp: number; participantId: number; beforeId: number; afterId: number }
  | { type: 'SKILL_LEVEL_UP'; timestamp: number; participantId: number; skillSlot: number; levelUpType: string }
  | { type: string; timestamp: number; participantId?: number; [key: string]: unknown }

export interface TimelineDTO {
  metadata: { matchId: string }
  info: {
    frames: { timestamp: number; events: TimelineEvent[] }[]
  }
}

export interface SpectatorParticipant {
  puuid: string
  riotId?: string
  championId: number
  teamId: number
  spell1Id: number
  spell2Id: number
}

export interface CurrentGameInfo {
  gameId: number
  gameMode: string
  gameStartTime: number
  participants: SpectatorParticipant[]
}
