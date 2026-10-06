import type { MatchSummary, Platform, ProfileData, RankedEntry, ScoutResult } from '@shared/types'
import { regionalOf, RiotApiError, type RiotClient } from './riot/client'
import type { LeagueEntryDTO, MatchDTO } from './riot/types'

/** Splits "Name#TAG" into game name and tag line. */
export function parseRiotId(input: string): { gameName: string; tagLine: string } {
  const trimmed = input.trim()
  const hashIndex = trimmed.lastIndexOf('#')
  if (hashIndex <= 0 || hashIndex === trimmed.length - 1) {
    throw new RiotApiError(400, 'Please enter a Riot ID like Name#TAG.')
  }
  return { gameName: trimmed.slice(0, hashIndex).trim(), tagLine: trimmed.slice(hashIndex + 1).trim() }
}

function toRanked(entry: LeagueEntryDTO): RankedEntry {
  return {
    queueType: entry.queueType,
    tier: entry.tier,
    rank: entry.rank,
    leaguePoints: entry.leaguePoints,
    wins: entry.wins,
    losses: entry.losses
  }
}

export function summarizeMatch(match: MatchDTO, puuid: string): MatchSummary | null {
  const me = match.info.participants.find((participant) => participant.puuid === puuid)
  if (!me) return null
  const teamKills = match.info.participants
    .filter((participant) => participant.teamId === me.teamId)
    .reduce((sum, participant) => sum + participant.kills, 0)
  const primary = me.perks.styles.find((style) => style.description === 'primaryStyle')
  const secondary = me.perks.styles.find((style) => style.description === 'subStyle')
  return {
    matchId: match.metadata.matchId,
    queueId: match.info.queueId,
    gameCreation: match.info.gameCreation,
    gameDuration: match.info.gameDuration,
    win: me.win,
    // games under 5 minutes are treated as remakes even without the early surrender flag
    remake: !!me.gameEndedInEarlySurrender || match.info.gameDuration < 300,
    championId: me.championId,
    role: me.teamPosition,
    kills: me.kills,
    deaths: me.deaths,
    assists: me.assists,
    cs: me.totalMinionsKilled + me.neutralMinionsKilled,
    gold: me.goldEarned,
    damage: me.totalDamageDealtToChampions,
    visionScore: me.visionScore,
    items: [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6],
    spells: [me.summoner1Id, me.summoner2Id],
    keystone: primary?.selections[0]?.perk ?? 0,
    subStyle: secondary?.style ?? 0,
    killParticipation: teamKills ? (me.kills + me.assists) / teamKills : 0,
    // older matches only have summonerName, no Riot ID
    teams: match.info.participants.map((participant) => ({
      championId: participant.championId,
      riotId: participant.riotIdGameName
        ? `${participant.riotIdGameName}#${participant.riotIdTagline ?? ''}`
        : (participant.summonerName ?? ''),
      teamId: participant.teamId,
      puuid: participant.puuid
    }))
  }
}

export class ProfileService {
  constructor(private readonly client: RiotClient) {}

  async lookup(riotId: string, platform: Platform, matchCount = 15): Promise<ProfileData> {
    const { gameName, tagLine } = parseRiotId(riotId)
    const regional = regionalOf(platform)
    const account = await this.client.accountByRiotId(regional, gameName, tagLine)
    if (!account) throw new RiotApiError(404, `Player ${gameName}#${tagLine} not found.`)

    const [summoner, entries, mastery, matchIds] = await Promise.all([
      this.client.summonerByPuuid(platform, account.puuid),
      this.client.leagueEntries(platform, account.puuid),
      this.client.topMastery(platform, account.puuid, 6),
      this.client.matchIds(regional, account.puuid, { count: matchCount })
    ])
    if (!summoner) throw new RiotApiError(404, `No LoL account on ${platform.toUpperCase()} for ${gameName}#${tagLine}.`)

    const matches = (await Promise.all(matchIds.map((id) => this.client.match(regional, id))))
      .filter((match): match is MatchDTO => !!match)
      .map((match) => summarizeMatch(match, account.puuid))
      .filter((summary): summary is MatchSummary => !!summary)

    const championStats = new Map<number, { games: number; wins: number; kills: number; deaths: number; assists: number }>()
    for (const match of matches) {
      if (match.remake) continue
      const stats = championStats.get(match.championId) ?? { games: 0, wins: 0, kills: 0, deaths: 0, assists: 0 }
      stats.games++
      if (match.win) stats.wins++
      stats.kills += match.kills
      stats.deaths += match.deaths
      stats.assists += match.assists
      championStats.set(match.championId, stats)
    }

    return {
      puuid: account.puuid,
      gameName: account.gameName,
      tagLine: account.tagLine,
      platform,
      summonerLevel: summoner.summonerLevel,
      profileIconId: summoner.profileIconId,
      ranked: entries.map(toRanked),
      mastery: mastery.map((entry) => ({ championId: entry.championId, level: entry.championLevel, points: entry.championPoints })),
      matches,
      championSummary: [...championStats.entries()]
        .map(([championId, stats]) => ({
          championId,
          games: stats.games,
          wins: stats.wins,
          kda: (stats.kills + stats.assists) / Math.max(1, stats.deaths)
        }))
        .sort((a, b) => b.games - a.games)
    }
  }

  /** Loading screen scouting: solo queue ranks of all players in a running game. */
  async scout(riotId: string, platform: Platform): Promise<ScoutResult | null> {
    const { gameName, tagLine } = parseRiotId(riotId)
    const account = await this.client.accountByRiotId(regionalOf(platform), gameName, tagLine)
    if (!account) throw new RiotApiError(404, `Player ${gameName}#${tagLine} not found.`)
    return this.scoutByPuuid(account.puuid, platform)
  }

  async scoutByPuuid(puuid: string, platform: Platform): Promise<ScoutResult | null> {
    const game = await this.client.activeGame(platform, puuid)
    if (!game) return null
    const players = await Promise.all(
      game.participants.map(async (participant) => {
        // puuid can be missing in the spectator data
        const entries = participant.puuid ? await this.client.leagueEntries(platform, participant.puuid).catch(() => []) : []
        const solo = entries.find((entry) => entry.queueType === 'RANKED_SOLO_5x5') ?? null
        return {
          puuid: participant.puuid,
          riotId: participant.riotId ?? 'Unknown',
          championId: participant.championId,
          teamId: participant.teamId,
          spells: [participant.spell1Id, participant.spell2Id],
          ranked: solo ? toRanked(solo) : null,
          recent: null
        }
      })
    )
    return { gameId: game.gameId, gameMode: game.gameMode, gameStartTime: game.gameStartTime, players }
  }
}
