/**
 * Hype announcer: which moments of a running game deserve a sound. Works on the event feed of the
 * Live Client Data API (the same poll the Live tab uses), only on events newer than the last one
 * seen. Pure; the main process sends the result to the main window, which plays it (renderer
 * lib/announcer.ts).
 */

export const TRIGGERS = [
  'myPenta',
  'premadePenta',
  'victory',
  'defeat',
  'allyAce',
  'myQuadra',
  'enemyAce',
  'myTriple',
  'myFirstBlood',
  'myDeathMilestone',
  'deathStreak'
] as const
export type Trigger = (typeof TRIGGERS)[number]

/** Higher wins when several things happen in the same tick. */
export const TRIGGER_PRIORITY: Record<Trigger, number> = {
  myPenta: 100,
  premadePenta: 90,
  victory: 85,
  defeat: 85,
  allyAce: 80,
  myQuadra: 75,
  enemyAce: 70,
  myTriple: 60,
  myFirstBlood: 55,
  myDeathMilestone: 50,
  deathStreak: 40
}

/** These are worth hearing even right after another sound. */
export const IGNORES_COOLDOWN: ReadonlySet<Trigger> = new Set<Trigger>(['myPenta', 'premadePenta', 'victory', 'defeat'])

export const TRIGGER_LABELS: Record<Trigger, string> = {
  myPenta: 'Your pentakill',
  premadePenta: 'Pentakill of a premade',
  victory: 'Victory',
  defeat: 'Defeat',
  allyAce: 'Your team aces',
  myQuadra: 'Your quadra kill',
  enemyAce: 'The enemy aces you',
  myTriple: 'Your triple kill',
  myFirstBlood: 'Your first blood',
  myDeathMilestone: 'Your 5th / 10th / 15th death',
  deathStreak: '3 deaths without a kill or assist'
}

/** Your deaths that get a sound. */
export const DEATH_MILESTONES = [5, 10, 15] as const
/** Deaths in a row without a kill or assist of yours in between. */
export const DEATH_STREAK = 3

/** One event of the Live Client Data feed (only the fields used here). */
export interface LiveEvent {
  EventID: number
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
}

export interface AnnouncerContext {
  /** your Riot ID ("Name#TAG") or name */
  me: string
  /** Riot IDs of your premades */
  premades: readonly string[]
  /** your team: 'ORDER' or 'CHAOS' */
  myTeam: string | null
}

export interface Announcement {
  trigger: Trigger
  /** your death count for myDeathMilestone, the premade's name for premadePenta */
  deaths?: number
  name?: string
  /** event time in the game */
  time: number
}

/**
 * The feed names players by game name, sometimes with the tag line; compare without it and
 * without case or spaces.
 */
export const sameName = (a: string | undefined | null, b: string | undefined | null): boolean => {
  const clean = (value: string | undefined | null) => (value ?? '').split('#')[0].replace(/\s+/g, '').toLowerCase()
  return !!clean(a) && clean(a) === clean(b)
}

/**
 * Announcements for the events after `prevEventId`. `prevEventId` null means this is the first
 * look at a running game (e.g. the app was started mid-game): nothing is played back, only the
 * newest id is taken. Returns the announcements oldest first and the id to pass next time.
 */
export function detectTriggers(
  prevEventId: number | null,
  events: readonly LiveEvent[],
  ctx: AnnouncerContext
): { announcements: Announcement[]; lastEventId: number | null } {
  const sorted = [...events].filter((event) => Number.isFinite(event.EventID)).sort((a, b) => a.EventID - b.EventID)
  const newest = sorted.length ? sorted[sorted.length - 1].EventID : prevEventId
  if (prevEventId === null) return { announcements: [], lastEventId: newest }
  const announcements: Announcement[] = []
  const isMe = (name?: string) => sameName(name, ctx.me)
  const premade = (name?: string) => ctx.premades.find((other) => sameName(other, name) && !isMe(name))

  // your deaths and how many came in a row without a kill or assist, counted over the whole feed
  let deaths = 0
  let streak = 0
  for (const event of sorted) {
    const fresh = event.EventID > prevEventId
    const add = (announcement: Omit<Announcement, 'time'>) => fresh && announcements.push({ ...announcement, time: event.EventTime })
    switch (event.EventName) {
      case 'ChampionKill':
        if (isMe(event.VictimName)) {
          deaths++
          streak++
          if ((DEATH_MILESTONES as readonly number[]).includes(deaths)) add({ trigger: 'myDeathMilestone', deaths })
          else if (streak % DEATH_STREAK === 0) add({ trigger: 'deathStreak', deaths })
        } else if (isMe(event.KillerName) || (event.Assisters ?? []).some(isMe)) streak = 0
        break
      case 'Multikill': {
        const streakSize = event.KillStreak ?? 0
        if (isMe(event.KillerName)) {
          if (streakSize >= 5) add({ trigger: 'myPenta' })
          else if (streakSize === 4) add({ trigger: 'myQuadra' })
          else if (streakSize === 3) add({ trigger: 'myTriple' })
        } else if (streakSize >= 5) {
          const name = premade(event.KillerName)
          if (name) add({ trigger: 'premadePenta', name: name.split('#')[0] })
        }
        break
      }
      case 'FirstBlood':
        if (isMe(event.Recipient)) add({ trigger: 'myFirstBlood' })
        break
      case 'Ace':
        if (ctx.myTeam && event.AcingTeam) add({ trigger: event.AcingTeam === ctx.myTeam ? 'allyAce' : 'enemyAce' })
        break
      case 'GameEnd':
        if (event.Result === 'Win') add({ trigger: 'victory' })
        else if (event.Result === 'Lose') add({ trigger: 'defeat' })
        break
    }
  }
  return { announcements, lastEventId: newest }
}

/**
 * The one announcement to play from what just happened: the most important enabled one, unless
 * the last sound is less than `cooldownS` ago (pentakills, victory and defeat always play).
 */
export function pickAnnouncement(
  announcements: readonly Announcement[],
  options: { enabled: Partial<Record<Trigger, boolean>>; cooldownS: number; lastPlayedAt: number | null; now: number }
): Announcement | null {
  const wanted = announcements.filter((announcement) => options.enabled[announcement.trigger] !== false)
  if (!wanted.length) return null
  const best = [...wanted].sort((a, b) => TRIGGER_PRIORITY[b.trigger] - TRIGGER_PRIORITY[a.trigger] || b.time - a.time)[0]
  const cooling = options.lastPlayedAt !== null && options.now - options.lastPlayedAt < options.cooldownS * 1000
  return cooling && !IGNORES_COOLDOWN.has(best.trigger) ? null : best
}

/** The spoken line for an announcement (English, short). */
export function voiceLine(announcement: Pick<Announcement, 'trigger' | 'deaths' | 'name'>, seed = 0): string {
  const lines: Record<Trigger, string[]> = {
    myPenta: ['Pentakill! Ratio approved.', 'Pentakill! Somebody clip that.', 'Pentakill! Absolute cinema.'],
    premadePenta: [
      `Pentakill for ${announcement.name ?? 'your premade'}! Carry detected.`,
      `${announcement.name ?? 'Your premade'} got a pentakill. Show off.`
    ],
    victory: ['Victory. Ratio.', 'Victory. Too easy.', 'Victory. Screenshot it.'],
    defeat: ['Defeat. It was the Bard.', 'Defeat. Next game is the one.', 'Defeat. Blame the augments.'],
    allyAce: ['Ace! Clean sweep.', 'Ace! Nobody left standing.'],
    myQuadra: ['Quadra kill! So close.', 'Quadra kill! One more, come on.'],
    enemyAce: ['Enemy ace. Oops.', 'Team wiped. Classic.'],
    myTriple: ['Triple kill.', 'Triple kill. Warming up.'],
    myFirstBlood: ['First blood. Bloodthirsty.', 'First blood. Someone woke up hungry.'],
    myDeathMilestone: [
      `${spell(announcement.deaths ?? 5)} deaths. Impressive.`,
      `${spell(announcement.deaths ?? 5)} deaths. The fountain misses you.`
    ],
    deathStreak: ['Three deaths in a row. Maybe buy armor?', 'Another one. The enemy says thanks.']
  }
  const pool = lines[announcement.trigger]
  return pool[Math.abs(Math.round(seed)) % pool.length]
}

const spell = (n: number): string => ({ 5: 'Five', 10: 'Ten', 15: 'Fifteen' })[n] ?? String(n)
