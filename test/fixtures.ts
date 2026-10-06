import type { MatchDTO, ParticipantDTO, TimelineDTO, TimelineEvent } from '../src/main/riot/types'
import type { ItemClassifier } from '../src/main/crawler/aggregator'

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']

export function participant(i: number, over: Partial<ParticipantDTO> = {}): ParticipantDTO {
  const teamId = i < 5 ? 100 : 200
  return {
    participantId: i + 1,
    puuid: `puuid-${i}`,
    riotIdGameName: `Player${i}`,
    riotIdTagline: 'EUW',
    championId: 100 + i,
    teamId,
    teamPosition: ROLES[i % 5],
    win: teamId === 100,
    kills: 5,
    deaths: 3,
    assists: 7,
    totalMinionsKilled: 180,
    neutralMinionsKilled: 10,
    goldEarned: 12000,
    totalDamageDealtToChampions: 20000,
    visionScore: 20,
    item0: 3031,
    item1: 3006,
    item2: 0,
    item3: 0,
    item4: 0,
    item5: 0,
    item6: 3340,
    summoner1Id: 14,
    summoner2Id: 4,
    perks: {
      statPerks: { offense: 5008, flex: 5008, defense: 5011 },
      styles: [
        { description: 'primaryStyle', style: 8000, selections: [{ perk: 8010 }, { perk: 9111 }, { perk: 9104 }, { perk: 8299 }] },
        { description: 'subStyle', style: 8400, selections: [{ perk: 8444 }, { perk: 8242 }] }
      ]
    },
    ...over
  }
}

export function match(over: Partial<MatchDTO['info']> = {}, id = 'EUW1_1'): MatchDTO {
  return {
    metadata: { matchId: id, participants: [] },
    info: {
      gameId: Number(id.split('_')[1]) || 1,
      gameCreation: 1_700_000_000_000,
      gameDuration: 1800,
      gameVersion: '15.19.712.1234',
      queueId: 420,
      participants: Array.from({ length: 10 }, (_, i) => participant(i)),
      teams: [
        {
          teamId: 100,
          win: true,
          bans: [
            { championId: 1, pickTurn: 1 },
            { championId: -1, pickTurn: 2 }
          ]
        },
        { teamId: 200, win: false, bans: [{ championId: 2, pickTurn: 6 }] }
      ],
      ...over
    }
  }
}

export function timeline(events: TimelineEvent[]): TimelineDTO {
  return { metadata: { matchId: 'EUW1_1' }, info: { frames: [{ timestamp: 0, events }] } }
}

const buy = (participantId: number, itemId: number, timestamp: number): TimelineEvent => ({
  type: 'ITEM_PURCHASED',
  participantId,
  itemId,
  timestamp
})
const skill = (participantId: number, skillSlot: number, timestamp: number): TimelineEvent => ({
  type: 'SKILL_LEVEL_UP',
  participantId,
  skillSlot,
  levelUpType: 'NORMAL',
  timestamp
})

/** Participant 1 (champion 100, TOP): Doran's Blade + Potion, then Boots, Kraken, IE, Undo'd Collector, Shieldbow */
export function standardTimeline(): TimelineDTO {
  const skills = 'QWEQQRQEQERWWWW'
  return timeline([
    buy(1, 1055, 10_000),
    buy(1, 2003, 11_000),
    buy(1, 3340, 12_000),
    buy(1, 1001, 400_000),
    buy(1, 3006, 700_000),
    buy(1, 6672, 900_000),
    buy(1, 3031, 1_200_000),
    buy(1, 6676, 1_300_000),
    { type: 'ITEM_UNDO', participantId: 1, beforeId: 6676, afterId: 0, timestamp: 1_301_000 },
    buy(1, 6673, 1_500_000),
    ...[...skills].map((s, i) => skill(1, ' QWER'.indexOf(s), 60_000 * (i + 1)))
  ])
}

const COMPLETED = new Set([6672, 3031, 6676, 6673, 3094, 3036])
const BOOTS = new Set([3006, 3047])
export const classify: ItemClassifier = (id) => ({ completed: COMPLETED.has(id), boots: BOOTS.has(id), trinket: id === 3340 })
