/**
 * Post-game summary, built from the League client's match history entry (all ten players with
 * their augments) and its timeline (gold per minute, kills). If the client has no timeline we fall
 * back to the curve recorded during the live game.
 */

export interface SummaryPlayer {
  puuid: string
  riotId: string
  championId: number
  ally: boolean
  me: boolean
  premade: boolean
  kills: number
  deaths: number
  assists: number
  damage: number
  /** damage taken + self-mitigated */
  tanked: number
  /** healing + shielding on teammates */
  support: number
  gold: number
  level: number
  items: number[]
  augments: number[]
  /** 0 to 100 impact score within the player's own team (heuristic, see impactScores) */
  score: number
}

export interface CurvePoint {
  /** seconds */
  t: number
  /** your team's gold minus the enemy team's */
  gold: number
  /** your team's kills minus the enemy team's */
  kills: number
}

export interface GameSummary {
  gameId: number
  createdAt: number
  duration: number
  queueId: number
  mode: string
  win: boolean
  players: SummaryPlayer[]
  curve: CurvePoint[]
  /** where the curve came from */
  curveSource: 'timeline' | 'live' | 'none'
  kills: { t: number; ally: boolean }[]
  mvp: string | null
  /** lowest impact of your whole team ("most to blame" in a loss, "biggest troll" in a win) */
  blame: string | null
  highlights: string[]
}

// --- raw League client shapes (only the fields we use) ------------------------------

export interface RawGame {
  gameId: number
  gameCreation: number
  gameDuration: number
  queueId: number
  gameMode: string
  participants: { participantId: number; championId: number; teamId: number; stats: Record<string, unknown> }[]
  participantIdentities?: {
    participantId: number
    player?: { puuid?: string; gameName?: string; tagLine?: string; summonerName?: string }
  }[]
}

export interface RawTimeline {
  frames?: {
    timestamp: number
    participantFrames?: Record<string, { totalGold?: number }>
    events?: { type: string; timestamp: number; killerId?: number; victimId?: number }[]
  }[]
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * Impact score per player relative to their own team, from damage, tanking, support and death
 * shares plus kill participation. 50 is an average teammate.
 */
export function impactScores(team: Pick<SummaryPlayer, 'kills' | 'deaths' | 'assists' | 'damage' | 'tanked' | 'support'>[]): number[] {
  const sum = (stat: (player: (typeof team)[number]) => number) => team.reduce((total, player) => total + stat(player), 0) || 1
  const teamDamage = sum((player) => player.damage)
  const teamTanked = sum((player) => player.tanked)
  const teamSupport = sum((player) => player.support)
  const teamDeaths = sum((player) => player.deaths)
  const teamKills = sum((player) => player.kills)
  const teamSize = team.length || 1
  const evenShare = 1 / teamSize
  return team.map((player) => {
    const killParticipation = (player.kills + player.assists) / teamKills
    const raw =
      50 +
      100 *
        (0.38 * (player.damage / teamDamage - evenShare) +
          0.14 * (player.tanked / teamTanked - evenShare) +
          0.12 * (player.support / teamSupport - evenShare) -
          0.36 * (player.deaths / teamDeaths - evenShare)) +
      18 * (killParticipation - 0.5)
    return Math.round(Math.max(0, Math.min(100, raw)))
  })
}

/** Lowest impact on your own team, in wins too. Also works for older summaries saved without `blame`. */
export function teamBlame(summary: Pick<GameSummary, 'win' | 'players'>): SummaryPlayer | null {
  const allies = summary.players.filter((player) => player.ally).sort((a, b) => a.score - b.score)
  return allies[0] ?? null
}

export interface ImpactFactor {
  label: string
  /** the player's value as text, e.g. "31 %" */
  value: string
  /** team average as text */
  avg: string
  /** points this factor added to (or took from) the score */
  points: number
}

/**
 * Breaks a player's score down into the factors of impactScores (their share vs an even share of
 * the team), sorted by how much each one moved the score.
 */
export function explainImpact(players: SummaryPlayer[], puuid: string): ImpactFactor[] {
  const player = players.find((other) => other.puuid === puuid)
  if (!player) return []
  const team = players.filter((other) => other.ally === player.ally)
  const sum = (stat: (other: SummaryPlayer) => number) => team.reduce((total, other) => total + stat(other), 0) || 1
  const evenShare = 1 / (team.length || 1)
  const pct = (value: number) => `${Math.round(value * 100)} %`
  const share = (stat: (other: SummaryPlayer) => number) => stat(player) / sum(stat)
  const killParticipation = (player.kills + player.assists) / sum((other) => other.kills)
  // weights match impactScores
  const factors: ImpactFactor[] = [
    {
      label: 'Damage to champions',
      value: pct(share((other) => other.damage)),
      avg: pct(evenShare),
      points: 38 * (share((other) => other.damage) - evenShare)
    },
    {
      label: 'Deaths of the team',
      value: pct(share((other) => other.deaths)),
      avg: pct(evenShare),
      points: -36 * (share((other) => other.deaths) - evenShare)
    },
    { label: 'Kill participation', value: pct(killParticipation), avg: '50 %', points: 18 * (killParticipation - 0.5) },
    {
      label: 'Damage soaked',
      value: pct(share((other) => other.tanked)),
      avg: pct(evenShare),
      points: 14 * (share((other) => other.tanked) - evenShare)
    },
    {
      label: 'Heals & shields on allies',
      value: pct(share((other) => other.support)),
      avg: pct(evenShare),
      points: 12 * (share((other) => other.support) - evenShare)
    }
  ]
  return factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
}

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`
const formatGold = (gold: number): string => `${(Math.abs(gold) / 1000).toFixed(1)}k`

export function buildSummary(
  game: RawGame,
  timeline: RawTimeline | null,
  me: string | null,
  premades: Set<string>,
  live: CurvePoint[] = []
): GameSummary {
  const identities = new Map((game.participantIdentities ?? []).map((identity) => [identity.participantId, identity.player ?? {}]))
  const myParticipantId = [...identities.entries()].find(([, player]) => player.puuid === me)?.[0]
  const myTeam = game.participants.find((participant) => participant.participantId === myParticipantId)?.teamId ?? 100
  const players: (SummaryPlayer & { pid: number })[] = game.participants.map((participant) => {
    const identity = identities.get(participant.participantId) ?? {}
    const stats = participant.stats
    return {
      pid: participant.participantId,
      puuid: identity.puuid ?? String(participant.participantId),
      riotId: identity.gameName ? `${identity.gameName}#${identity.tagLine ?? ''}` : (identity.summonerName ?? '?'),
      championId: participant.championId,
      ally: participant.teamId === myTeam,
      me: !!me && identity.puuid === me,
      premade: !!identity.puuid && premades.has(identity.puuid),
      kills: num(stats.kills),
      deaths: num(stats.deaths),
      assists: num(stats.assists),
      damage: num(stats.totalDamageDealtToChampions),
      tanked: num(stats.totalDamageTaken) + num(stats.damageSelfMitigated),
      support: num(stats.totalHealsOnTeammates) + num(stats.totalDamageShieldedOnTeammates),
      gold: num(stats.goldEarned),
      level: num(stats.champLevel),
      items: [0, 1, 2, 3, 4, 5, 6].map((i) => num(stats[`item${i}`])),
      augments: [1, 2, 3, 4, 5, 6].map((i) => num(stats[`playerAugment${i}`])).filter((augment) => augment > 0),
      score: 0
    }
  })
  for (const side of [true, false]) {
    const team = players.filter((player) => player.ally === side)
    impactScores(team).forEach((score, i) => (team[i].score = score))
  }
  const mePlayer = players.find((player) => player.me)
  const win = mePlayer ? game.participants.find((participant) => participant.participantId === mePlayer.pid)?.stats.win === true : false

  // --- curve: from the timeline (one frame per minute) or the live recording
  const allyPids = new Set(players.filter((player) => player.ally).map((player) => player.pid))
  let curve: CurvePoint[] = []
  const kills: { t: number; ally: boolean }[] = []
  let source: GameSummary['curveSource'] = 'none'
  if (timeline?.frames?.length) {
    let killDiff = 0
    for (const frame of timeline.frames) {
      for (const event of frame.events ?? []) {
        // killerId 0 means executed by a minion/tower, those don't count for either team
        if (event.type !== 'CHAMPION_KILL' || !event.killerId) continue
        const ally = allyPids.has(event.killerId)
        killDiff += ally ? 1 : -1
        kills.push({ t: event.timestamp / 1000, ally })
      }
      let gold = 0
      for (const [pid, participantFrame] of Object.entries(frame.participantFrames ?? {})) {
        gold += (allyPids.has(Number(pid)) ? 1 : -1) * num(participantFrame.totalGold)
      }
      curve.push({ t: frame.timestamp / 1000, gold, kills: killDiff })
    }
    source = 'timeline'
  } else if (live.length) {
    curve = live
    source = 'live'
  }

  // --- MVP and blame
  const allies = players.filter((player) => player.ally).sort((a, b) => b.score - a.score)
  const mvp = allies[0]?.puuid ?? null
  const blame = allies.length > 1 ? (allies[allies.length - 1]?.puuid ?? null) : null

  // --- highlights
  const highlights: string[] = []
  const name = (player: SummaryPlayer) => player.riotId.split('#')[0]
  if (curve.length > 2) {
    const top = curve.reduce((a, b) => (b.gold > a.gold ? b : a))
    const low = curve.reduce((a, b) => (b.gold < a.gold ? b : a))
    if (!win && top.gold > 2500) highlights.push(`Your team was up ${formatGold(top.gold)} gold at ${clock(top.t)} – and still lost.`)
    else if (win && low.gold < -2500) highlights.push(`Comeback: your team was down ${formatGold(low.gold)} gold at ${clock(low.t)}.`)
    else if (top.gold > 1000) highlights.push(`Biggest lead: +${formatGold(top.gold)} gold at ${clock(top.t)}.`)
    if (low.gold < -1000 && !(win && low.gold < -2500))
      highlights.push(`Biggest deficit: −${formatGold(low.gold)} gold at ${clock(low.t)}.`)
  }
  const most = <K extends keyof SummaryPlayer>(key: K, list = players) =>
    [...list].sort((a, b) => (b[key] as number) - (a[key] as number))[0]
  const dmgTop = most('damage')
  if (dmgTop) highlights.push(`Most damage: ${name(dmgTop)} (${(dmgTop.damage / 1000).toFixed(1)}k).`)
  const deathTop = most(
    'deaths',
    players.filter((player) => player.ally)
  )
  if (deathTop && deathTop.deaths > 0) highlights.push(`Most deaths on your team: ${name(deathTop)} (${deathTop.deaths}).`)
  const tankTop = most(
    'tanked',
    players.filter((player) => player.ally)
  )
  if (tankTop) highlights.push(`Frontline: ${name(tankTop)} soaked ${(tankTop.tanked / 1000).toFixed(1)}k damage.`)
  const allyKills = players.filter((player) => player.ally).reduce((total, player) => total + player.kills, 0)
  const enemyKills = players.filter((player) => !player.ally).reduce((total, player) => total + player.kills, 0)
  highlights.push(`Kills ${allyKills} : ${enemyKills} in ${clock(game.gameDuration)}.`)

  return {
    gameId: game.gameId,
    createdAt: game.gameCreation,
    duration: game.gameDuration,
    queueId: game.queueId,
    mode: game.gameMode,
    win,
    players: players.map(({ pid: _pid, ...player }) => player),
    curve,
    curveSource: source,
    kills,
    mvp,
    blame,
    highlights
  }
}
