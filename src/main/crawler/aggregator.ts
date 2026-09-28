import type { ChampionRoleStats, PatchStats, Role, WG } from '@shared/types'
import { ROLES } from '@shared/types'
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

export function emptyPatchStats(patch: string): PatchStats {
  return { patch, matches: 0, updatedAt: Date.now(), bans: {}, champions: {} }
}

export function emptyRoleStats(championId: number, role: Role): ChampionRoleStats {
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
  const e = map[key] ?? (map[key] = { g: 0, w: 0 })
  e.g++
  if (win) e.w++
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

export function runeKey(p: ParticipantDTO): string | null {
  const primary = p.perks.styles.find((s) => s.description === 'primaryStyle')
  const sub = p.perks.styles.find((s) => s.description === 'subStyle')
  if (!primary || !sub || primary.selections.length < 4 || sub.selections.length < 2) return null
  const { offense, flex, defense } = p.perks.statPerks
  return [
    primary.style,
    primary.selections.map((s) => s.perk).join(','),
    sub.style,
    sub.selections.map((s) => s.perk).join(','),
    [offense, flex, defense].join(',')
  ].join('|')
}

export function spellKey(p: ParticipantDTO): string {
  return [p.summoner1Id, p.summoner2Id].sort((a, b) => a - b).join(',')
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

/**
 * Replays the timeline events of one participant and returns the purchase order,
 * honouring ITEM_UNDO so that refunded items don't pollute the statistics.
 */
export function replayParticipant(
  events: TimelineEvent[],
  participantId: number,
  classify: ItemClassifier
): PurchaseTimeline {
  const purchases: { itemId: number; t: number }[] = []
  let skills = ''

  for (const ev of events) {
    if (ev.participantId !== participantId) continue
    switch (ev.type) {
      case 'ITEM_PURCHASED':
        purchases.push({ itemId: ev.itemId as number, t: ev.timestamp })
        break
      case 'ITEM_UNDO': {
        const before = ev.beforeId as number
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
        if (ev.levelUpType === 'NORMAL') skills += SKILL_KEYS[ev.skillSlot as number] ?? ''
        break
    }
  }

  const starters = purchases
    .filter((p) => p.t <= STARTER_WINDOW_MS && !classify(p.itemId)?.trinket)
    .map((p) => p.itemId)
    .sort((a, b) => a - b)

  const completed: number[] = []
  let boots: number | null = null
  for (const { itemId } of purchases) {
    const c = classify(itemId)
    if (!c) continue
    if (c.boots && boots === null) boots = itemId
    if (c.completed && !c.boots && !completed.includes(itemId)) completed.push(itemId)
  }
  return { starters, completed, boots, skills }
}

/** Order in which Q, W and E are maxed, e.g. "QEW". */
export function skillMaxOrder(skills: string): string | null {
  const count: Record<string, number> = { Q: 0, W: 0, E: 0 }
  const maxedAt: Record<string, number> = {}
  const firstAt: Record<string, number> = {}
  ;[...skills].forEach((s, i) => {
    if (!(s in count)) return
    count[s]++
    if (firstAt[s] === undefined) firstAt[s] = i
    if (count[s] === 5 && maxedAt[s] === undefined) maxedAt[s] = i
  })
  if (skills.length < 9) return null
  return (['Q', 'W', 'E'] as const)
    .slice()
    .sort((a, b) => {
      const ma = maxedAt[a] ?? Infinity
      const mb = maxedAt[b] ?? Infinity
      if (ma !== mb) return ma - mb
      if (count[a] !== count[b]) return count[b] - count[a]
      return (firstAt[a] ?? Infinity) - (firstAt[b] ?? Infinity)
    })
    .join('')
}

export function isRemake(match: MatchDTO): boolean {
  return match.info.gameDuration < 300 || match.info.participants.some((p) => p.gameEndedInEarlySurrender)
}

/**
 * Adds one ranked match (and optionally its timeline) to the patch statistics.
 * Returns false if the match was not counted (remake, wrong patch, missing roles).
 */
export function aggregateMatch(
  stats: PatchStats,
  match: MatchDTO,
  timeline: TimelineDTO | null,
  classify: ItemClassifier
): boolean {
  if (patchOf(match.info.gameVersion) !== stats.patch) return false
  if (isRemake(match)) return false
  const parts = match.info.participants
  if (parts.length !== 10 || parts.some((p) => !isRole(p.teamPosition))) return false

  const events = timeline ? timeline.info.frames.flatMap((f) => f.events) : []

  stats.matches++
  stats.updatedAt = Date.now()

  for (const team of match.info.teams) {
    for (const ban of team.bans) {
      if (ban.championId > 0) stats.bans[ban.championId] = (stats.bans[ban.championId] ?? 0) + 1
    }
  }

  for (const p of parts) {
    const role = p.teamPosition as Role
    const key = `${p.championId}:${role}`
    const s = stats.champions[key] ?? (stats.champions[key] = emptyRoleStats(p.championId, role))
    const win = p.win

    s.g++
    if (win) s.w++
    s.duration += match.info.gameDuration

    const rk = runeKey(p)
    if (rk) bump(s.runes, rk, win)
    bump(s.spells, spellKey(p), win)

    const opponent = parts.find((o) => o.teamId !== p.teamId && o.teamPosition === p.teamPosition)
    if (opponent) bump(s.matchups, String(opponent.championId), win)

    if (timeline) {
      const r = replayParticipant(events, p.participantId, classify)
      if (r.starters.length) bump(s.starters, r.starters.join(','), win)
      if (r.boots) bump(s.boots, String(r.boots), win)
      if (r.completed.length >= 3) bump(s.core, r.completed.slice(0, 3).join(','), win)
      r.completed.slice(0, 6).forEach((id, i) => bump(s.slots[i], String(id), win))
      if (r.skills.length >= 15) bump(s.skillPath, r.skills.slice(0, 15), win)
      const max = skillMaxOrder(r.skills)
      if (max) bump(s.skillMax, max, win)
    }
  }
  return true
}
