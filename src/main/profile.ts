import type { MatchSummary, Platform, ProfileData, RankedEntry, ScoutResult } from '@shared/types'
import { regionalOf, RiotApiError, type RiotClient } from './riot/client'
import type { LeagueEntryDTO, MatchDTO } from './riot/types'

export function parseRiotId(input: string): { gameName: string; tagLine: string } {
  const trimmed = input.trim()
  const idx = trimmed.lastIndexOf('#')
  if (idx <= 0 || idx === trimmed.length - 1) {
    throw new RiotApiError(400, 'Bitte Riot ID im Format Name#TAG eingeben.')
  }
  return { gameName: trimmed.slice(0, idx).trim(), tagLine: trimmed.slice(idx + 1).trim() }
}

function toRanked(e: LeagueEntryDTO): RankedEntry {
  return { queueType: e.queueType, tier: e.tier, rank: e.rank, leaguePoints: e.leaguePoints, wins: e.wins, losses: e.losses }
}

export function summarizeMatch(match: MatchDTO, puuid: string): MatchSummary | null {
  const me = match.info.participants.find((p) => p.puuid === puuid)
  if (!me) return null
  const teamKills = match.info.participants.filter((p) => p.teamId === me.teamId).reduce((n, p) => n + p.kills, 0)
  const primary = me.perks.styles.find((s) => s.description === 'primaryStyle')
  const sub = me.perks.styles.find((s) => s.description === 'subStyle')
  return {
    matchId: match.metadata.matchId,
    queueId: match.info.queueId,
    gameCreation: match.info.gameCreation,
    gameDuration: match.info.gameDuration,
    win: me.win,
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
    subStyle: sub?.style ?? 0,
    killParticipation: teamKills ? (me.kills + me.assists) / teamKills : 0,
    teams: match.info.participants.map((p) => ({
      championId: p.championId,
      riotId: p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline ?? ''}` : (p.summonerName ?? ''),
      teamId: p.teamId,
      puuid: p.puuid
    }))
  }
}

export class ProfileService {
  constructor(private readonly client: RiotClient) {}

  async lookup(riotId: string, platform: Platform, matchCount = 15): Promise<ProfileData> {
    const { gameName, tagLine } = parseRiotId(riotId)
    const regional = regionalOf(platform)
    const account = await this.client.accountByRiotId(regional, gameName, tagLine)
    if (!account) throw new RiotApiError(404, `Spieler ${gameName}#${tagLine} nicht gefunden.`)

    const [summoner, entries, mastery, ids] = await Promise.all([
      this.client.summonerByPuuid(platform, account.puuid),
      this.client.leagueEntries(platform, account.puuid),
      this.client.topMastery(platform, account.puuid, 6),
      this.client.matchIds(regional, account.puuid, { count: matchCount })
    ])
    if (!summoner) throw new RiotApiError(404, `Kein LoL-Account auf ${platform.toUpperCase()} für ${gameName}#${tagLine}.`)

    const matches = (await Promise.all(ids.map((id) => this.client.match(regional, id))))
      .filter((m): m is MatchDTO => !!m)
      .map((m) => summarizeMatch(m, account.puuid))
      .filter((m): m is MatchSummary => !!m)

    const champMap = new Map<number, { games: number; wins: number; k: number; d: number; a: number }>()
    for (const m of matches) {
      if (m.remake) continue
      const c = champMap.get(m.championId) ?? { games: 0, wins: 0, k: 0, d: 0, a: 0 }
      c.games++
      if (m.win) c.wins++
      c.k += m.kills
      c.d += m.deaths
      c.a += m.assists
      champMap.set(m.championId, c)
    }

    return {
      puuid: account.puuid,
      gameName: account.gameName,
      tagLine: account.tagLine,
      platform,
      summonerLevel: summoner.summonerLevel,
      profileIconId: summoner.profileIconId,
      ranked: entries.map(toRanked),
      mastery: mastery.map((m) => ({ championId: m.championId, level: m.championLevel, points: m.championPoints })),
      matches,
      championSummary: [...champMap.entries()]
        .map(([championId, c]) => ({ championId, games: c.games, wins: c.wins, kda: (c.k + c.a) / Math.max(1, c.d) }))
        .sort((a, b) => b.games - a.games)
    }
  }

  /** Loading-screen scouting: ranks of all 10 players of a running game. */
  async scout(riotId: string, platform: Platform): Promise<ScoutResult | null> {
    const { gameName, tagLine } = parseRiotId(riotId)
    const account = await this.client.accountByRiotId(regionalOf(platform), gameName, tagLine)
    if (!account) throw new RiotApiError(404, `Spieler ${gameName}#${tagLine} nicht gefunden.`)
    return this.scoutByPuuid(account.puuid, platform)
  }

  async scoutByPuuid(puuid: string, platform: Platform): Promise<ScoutResult | null> {
    const game = await this.client.activeGame(platform, puuid)
    if (!game) return null
    const players = await Promise.all(
      game.participants.map(async (p) => {
        const entries = p.puuid ? await this.client.leagueEntries(platform, p.puuid).catch(() => []) : []
        const solo = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5') ?? null
        return {
          puuid: p.puuid,
          riotId: p.riotId ?? 'Unbekannt',
          championId: p.championId,
          teamId: p.teamId,
          spells: [p.spell1Id, p.spell2Id],
          ranked: solo ? toRanked(solo) : null,
          recent: null
        }
      })
    )
    return { gameId: game.gameId, gameMode: game.gameMode, gameStartTime: game.gameStartTime, players }
  }
}
