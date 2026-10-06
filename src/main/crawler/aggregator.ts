import type { ChampionRoleStats, GameMode, PatchStats, StatRole, WG } from '@shared/types'
import { ROLES, type Role } from '@shared/types'
import type { MatchDTO, ParticipantDTO, TimelineDTO, TimelineEvent } from '../riot/types'

/** What the aggregator needs to know about an item. */
export interface ItemClass {
  completed: boolean
  boots: boolean
  trinket: boolean
}
export type ItemClassifier = (itemId: number) => ItemClass | undefined

const SKILL_KEYS = ['', 'Q', 'W', 'E', 'R']
/** Purchases in the first 70 seconds count as the starting build. */
export const STARTER_WINDOW_MS = 70_000

export function patchOf(gameVersion: string): string {
  const [major, minor] = gameVersion.split('.')
  return `${major}.${minor}`
}

export function emptyPatchStats(patch: string, mode: GameMode = 'ranked'): PatchStats {
  return { patch, mode, matches: 0, updatedAt: Date.now(), bans: {}, champions: {} }
}

export function emptyRoleStats(championId: number, role: StatRole): ChampionRoleStats {
  return {
    championId,
    role,
    g: 0,
    w: 0,
    runes: {},
    spells: {},
    starters: {},
    core: {},
    boots: {},
    slots: [{}, {}, {}, {}, {}, {}],
    skillMax: {},
    skillPath: {},
    matchups: {},
    duration: 0
  }
}

function bump(map: Record<string, WG>, key: string, win: boolean): void {
  const entry = map[key] ?? (map[key] = { g: 0, w: 0 })
  entry.g++
  if (win) entry.w++
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

/** "primaryStyle|perks|subStyle|perks|shards", or null if the rune page is incomplete. */
export function runeKey(participant: ParticipantDTO): string | null {
  const primary = participant.perks.styles.find((style) => style.description === 'primaryStyle')
  const sub = participant.perks.styles.find((style) => style.description === 'subStyle')
  if (!primary || !sub || primary.selections.length < 4 || sub.selections.length < 2) return null
  const { offense, flex, defense } = participant.perks.statPerks
  return [
    primary.style,
    primary.selections.map((selection) => selection.perk).join(','),
    sub.style,
    sub.selections.map((selection) => selection.perk).join(','),
    [offense, flex, defense].join(',')
  ].join('|')
}

/** Sorted so Flash on D and Flash on F count as the same spell pair. */
export function spellKey(participant: ParticipantDTO): string {
  return [participant.summoner1Id, participant.summoner2Id].sort((a, b) => a - b).join(',')
}

export interface PurchaseTimeline {
  /** item ids bought during the starter window (trinkets excluded), sorted */
  starters: number[]
  /** completed items in the order they were first bought */
  completed: number[]
  boots: number | null
  /** skill slots as letters in level-up order */
  skills: string
}

/** Replays one participant's timeline events. ITEM_UNDO removes the refunded purchase so it doesn't end up in the stats. */
export function replayParticipant(events: TimelineEvent[], participantId: number, classify: ItemClassifier): PurchaseTimeline {
  const purchases: { itemId: number; t: number }[] = []
  let skills = ''

  for (const event of events) {
    if (event.participantId !== participantId) continue
    switch (event.type) {
      case 'ITEM_PURCHASED':
        purchases.push({ itemId: event.itemId as number, t: event.timestamp })
        break
      case 'ITEM_UNDO': {
        // beforeId is the item that was undone, drop its most recent purchase
        const before = event.beforeId as number
        if (before) {
          for (let i = purchases.length - 1; i >= 0; i--) {
            if (purchases[i].itemId === before) {
              purchases.splice(i, 1)
              break
            }
          }
        }
        break
      }
      case 'SKILL_LEVEL_UP':
        // ignore EVOLVE level-ups (Kha'Zix, Viktor, ...), they aren't skill points
        if (event.levelUpType === 'NORMAL') skills += SKILL_KEYS[event.skillSlot as number] ?? ''
        break
    }
  }

  const starters = purchases
    .filter((purchase) => purchase.t <= STARTER_WINDOW_MS && !classify(purchase.itemId)?.trinket)
    .map((purchase) => purchase.itemId)
    .sort((a, b) => a - b)

  const completed: number[] = []
  let boots: number | null = null
  for (const { itemId } of purchases) {
    const itemClass = classify(itemId)
    if (!itemClass) continue
    if (itemClass.boots && boots === null) boots = itemId
    if (itemClass.completed && !itemClass.boots && !completed.includes(itemId)) completed.push(itemId)
  }
  return { starters, completed, boots, skills }
}

/** Order in which Q, W and E are maxed, e.g. "QEW". */
export function skillMaxOrder(skills: string): string | null {
  const count: Record<string, number> = { Q: 0, W: 0, E: 0 }
  const maxedAt: Record<string, number> = {}
  const firstAt: Record<string, number> = {}
  ;[...skills].forEach((skill, i) => {
    if (!(skill in count)) return
    count[skill]++
    if (firstAt[skill] === undefined) firstAt[skill] = i
    if (count[skill] === 5 && maxedAt[skill] === undefined) maxedAt[skill] = i
  })
  // too short a game to tell a max order
  if (skills.length < 9) return null
  return (
    (['Q', 'W', 'E'] as const)
      .slice()
      // maxed first wins, then more points, then whichever was learned first
      .sort((a, b) => {
        const maxedA = maxedAt[a] ?? Infinity
        const maxedB = maxedAt[b] ?? Infinity
        if (maxedA !== maxedB) return maxedA - maxedB
        if (count[a] !== count[b]) return count[b] - count[a]
        return (firstAt[a] ?? Infinity) - (firstAt[b] ?? Infinity)
      })
      .join('')
  )
}

/** Games under 5 minutes or ended by an early surrender vote. gameDuration is in seconds. */
export function isRemake(match: MatchDTO): boolean {
  return match.info.gameDuration < 300 || match.info.participants.some((participant) => participant.gameEndedInEarlySurrender)
}

/**
 * Adds one ranked match (and optionally its timeline) to the patch statistics.
 * Returns false if the match was not counted (remake, wrong patch, missing roles).
 */
export function aggregateMatch(stats: PatchStats, match: MatchDTO, timeline: TimelineDTO | null, classify: ItemClassifier): boolean {
  if (patchOf(match.info.gameVersion) !== stats.patch) return false
  if (isRemake(match)) return false
  const participants = match.info.participants
  const aram = stats.mode === 'aram'
  if (participants.length !== 10) return false
  // on Summoner's Rift every player needs a lane, ARAM has none
  if (!aram && participants.some((participant) => !isRole(participant.teamPosition))) return false

  const events = timeline ? timeline.info.frames.flatMap((frame) => frame.events) : []

  stats.matches++
  stats.updatedAt = Date.now()

  for (const team of match.info.teams) {
    for (const ban of team.bans) {
      if (ban.championId > 0) stats.bans[ban.championId] = (stats.bans[ban.championId] ?? 0) + 1
    }
  }

  for (const participant of participants) {
    const role: StatRole = aram ? 'ARAM' : (participant.teamPosition as Role)
    const key = `${participant.championId}:${role}`
    const roleStats = stats.champions[key] ?? (stats.champions[key] = emptyRoleStats(participant.championId, role))
    const win = participant.win

    roleStats.g++
    if (win) roleStats.w++
    roleStats.duration += match.info.gameDuration

    const runes = runeKey(participant)
    if (runes) bump(roleStats.runes, runes, win)
    bump(roleStats.spells, spellKey(participant), win)

    if (aram) {
      // no lanes, so every enemy counts as a matchup
      for (const other of participants) if (other.teamId !== participant.teamId) bump(roleStats.matchups, String(other.championId), win)
    } else {
      const opponent = participants.find((other) => other.teamId !== participant.teamId && other.teamPosition === participant.teamPosition)
      if (opponent) bump(roleStats.matchups, String(opponent.championId), win)
    }

    if (timeline) {
      const purchases = replayParticipant(events, participant.participantId, classify)
      if (purchases.starters.length) bump(roleStats.starters, purchases.starters.join(','), win)
      if (purchases.boots) bump(roleStats.boots, String(purchases.boots), win)
      if (purchases.completed.length >= 3) bump(roleStats.core, purchases.completed.slice(0, 3).join(','), win)
      purchases.completed.slice(0, 6).forEach((id, i) => bump(roleStats.slots[i], String(id), win))
      // full skill order up to level 15
      if (purchases.skills.length >= 15) bump(roleStats.skillPath, purchases.skills.slice(0, 15), win)
      const maxOrder = skillMaxOrder(purchases.skills)
      if (maxOrder) bump(roleStats.skillMax, maxOrder, win)
    }
  }
  return true
}
