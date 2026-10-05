/**
 * Post-game summary: built from the League client's match history entry of the game (all ten
 * players incl. their augments) and its timeline (gold per minute, kills), with a live-recorded
 * fallback curve when the client has no timeline.
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
  /** 0–100 impact score within the own team (heuristic, see impactScores) */
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

// --- raw League client shapes (only what is used) -----------------------------------

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

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Impact score per player relative to their own team: damage share, kill participation,
 * tanking share, support share, minus death share – 50 is an average teammate.
 */
export function impactScores(team: Pick<SummaryPlayer, 'kills' | 'deaths' | 'assists' | 'damage' | 'tanked' | 'support'>[]): number[] {
  const sum = (f: (p: (typeof team)[number]) => number) => team.reduce((s, p) => s + f(p), 0) || 1
  const dmg = sum((p) => p.damage)
  const tank = sum((p) => p.tanked)
  const sup = sum((p) => p.support)
  const deaths = sum((p) => p.deaths)
  const kills = sum((p) => p.kills)
  const n = team.length || 1
  const even = 1 / n
  return team.map((p) => {
    const kp = (p.kills + p.assists) / kills
    const raw =
      50 +
      100 *
        (0.38 * (p.damage / dmg - even) +
          0.14 * (p.tanked / tank - even) +
          0.12 * (p.support / sup - even) -
          0.36 * (p.deaths / deaths - even)) +
      18 * (kp - 0.5)
    return Math.round(Math.max(0, Math.min(100, raw)))
  })
}

/** Lowest impact of the whole own team, in wins too (also for older summaries saved differently). */
export function teamBlame(s: Pick<GameSummary, 'win' | 'players'>): SummaryPlayer | null {
  const allies = s.players.filter((p) => p.ally).sort((a, b) => a.score - b.score)
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
 * Why a player got their score: each factor of impactScores with the player's share vs an even
 * share of the team, sorted by how much it moved the score.
 */
export function explainImpact(players: SummaryPlayer[], puuid: string): ImpactFactor[] {
  const p = players.find((x) => x.puuid === puuid)
  if (!p) return []
  const team = players.filter((x) => x.ally === p.ally)
  const sum = (f: (x: SummaryPlayer) => number) => team.reduce((s, x) => s + f(x), 0) || 1
  const even = 1 / (team.length || 1)
  const pct = (v: number) => `${Math.round(v * 100)} %`
  const share = (f: (x: SummaryPlayer) => number) => f(p) / sum(f)
  const kp = (p.kills + p.assists) / sum((x) => x.kills)
  const f: ImpactFactor[] = [
    { label: 'Damage to champions', value: pct(share((x) => x.damage)), avg: pct(even), points: 38 * (share((x) => x.damage) - even) },
    { label: 'Deaths of the team', value: pct(share((x) => x.deaths)), avg: pct(even), points: -36 * (share((x) => x.deaths) - even) },
    { label: 'Kill participation', value: pct(kp), avg: '50 %', points: 18 * (kp - 0.5) },
    { label: 'Damage soaked', value: pct(share((x) => x.tanked)), avg: pct(even), points: 14 * (share((x) => x.tanked) - even) },
    {
      label: 'Heals & shields on allies',
      value: pct(share((x) => x.support)),
      avg: pct(even),
      points: 12 * (share((x) => x.support) - even)
    }
  ]
  return f.sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
}

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const k = (g: number): string => `${(Math.abs(g) / 1000).toFixed(1)}k`

export function buildSummary(
  game: RawGame,
  timeline: RawTimeline | null,
  me: string | null,
  premades: Set<string>,
  live: CurvePoint[] = []
): GameSummary {
  const ident = new Map((game.participantIdentities ?? []).map((i) => [i.participantId, i.player ?? {}]))
  const myPid = [...ident.entries()].find(([, p]) => p.puuid === me)?.[0]
  const myTeam = game.participants.find((p) => p.participantId === myPid)?.teamId ?? 100
  const players: (SummaryPlayer & { pid: number })[] = game.participants.map((p) => {
    const id = ident.get(p.participantId) ?? {}
    const s = p.stats
    return {
      pid: p.participantId,
      puuid: id.puuid ?? String(p.participantId),
      riotId: id.gameName ? `${id.gameName}#${id.tagLine ?? ''}` : (id.summonerName ?? '?'),
      championId: p.championId,
      ally: p.teamId === myTeam,
      me: !!me && id.puuid === me,
      premade: !!id.puuid && premades.has(id.puuid),
      kills: num(s.kills),
      deaths: num(s.deaths),
      assists: num(s.assists),
      damage: num(s.totalDamageDealtToChampions),
      tanked: num(s.totalDamageTaken) + num(s.damageSelfMitigated),
      support: num(s.totalHealsOnTeammates) + num(s.totalDamageShieldedOnTeammates),
      gold: num(s.goldEarned),
      level: num(s.champLevel),
      items: [0, 1, 2, 3, 4, 5, 6].map((i) => num(s[`item${i}`])),
      augments: [1, 2, 3, 4, 5, 6].map((i) => num(s[`playerAugment${i}`])).filter((a) => a > 0),
      score: 0
    }
  })
  for (const side of [true, false]) {
    const team = players.filter((p) => p.ally === side)
    impactScores(team).forEach((sc, i) => (team[i].score = sc))
  }
  const meP = players.find((p) => p.me)
  const win = meP ? game.participants.find((p) => p.participantId === meP.pid)?.stats.win === true : false

  // --- curve: timeline (gold per minute) or the live recording
  const allyPids = new Set(players.filter((p) => p.ally).map((p) => p.pid))
  let curve: CurvePoint[] = []
  const kills: { t: number; ally: boolean }[] = []
  let source: GameSummary['curveSource'] = 'none'
  if (timeline?.frames?.length) {
    let kd = 0
    for (const f of timeline.frames) {
      for (const e of f.events ?? []) {
        if (e.type !== 'CHAMPION_KILL' || !e.killerId) continue
        const ally = allyPids.has(e.killerId)
        kd += ally ? 1 : -1
        kills.push({ t: e.timestamp / 1000, ally })
      }
      let gold = 0
      for (const [pid, pf] of Object.entries(f.participantFrames ?? {})) gold += (allyPids.has(Number(pid)) ? 1 : -1) * num(pf.totalGold)
      curve.push({ t: f.timestamp / 1000, gold, kills: kd })
    }
    source = 'timeline'
  } else if (live.length) {
    curve = live
    source = 'live'
  }

  // --- MVP & blame
  const allies = players.filter((p) => p.ally).sort((a, b) => b.score - a.score)
  const mvp = allies[0]?.puuid ?? null
  const blame = allies.length > 1 ? (allies[allies.length - 1]?.puuid ?? null) : null

  // --- highlights
  const h: string[] = []
  const name = (p: SummaryPlayer) => p.riotId.split('#')[0]
  if (curve.length > 2) {
    const top = curve.reduce((a, b) => (b.gold > a.gold ? b : a))
    const low = curve.reduce((a, b) => (b.gold < a.gold ? b : a))
    if (!win && top.gold > 2500) h.push(`Your team was up ${k(top.gold)} gold at ${clock(top.t)} – and still lost.`)
    else if (win && low.gold < -2500) h.push(`Comeback: your team was down ${k(low.gold)} gold at ${clock(low.t)}.`)
    else if (top.gold > 1000) h.push(`Biggest lead: +${k(top.gold)} gold at ${clock(top.t)}.`)
    if (low.gold < -1000 && !(win && low.gold < -2500)) h.push(`Biggest deficit: −${k(low.gold)} gold at ${clock(low.t)}.`)
  }
  const most = <K extends keyof SummaryPlayer>(key: K, list = players) =>
    [...list].sort((a, b) => (b[key] as number) - (a[key] as number))[0]
  const dmgTop = most('damage')
  if (dmgTop) h.push(`Most damage: ${name(dmgTop)} (${(dmgTop.damage / 1000).toFixed(1)}k).`)
  const deathTop = most(
    'deaths',
    players.filter((p) => p.ally)
  )
  if (deathTop && deathTop.deaths > 0) h.push(`Most deaths on your team: ${name(deathTop)} (${deathTop.deaths}).`)
  const tankTop = most(
    'tanked',
    players.filter((p) => p.ally)
  )
  if (tankTop) h.push(`Frontline: ${name(tankTop)} soaked ${(tankTop.tanked / 1000).toFixed(1)}k damage.`)
  const allyKills = players.filter((p) => p.ally).reduce((s, p) => s + p.kills, 0)
  const enemyKills = players.filter((p) => !p.ally).reduce((s, p) => s + p.kills, 0)
  h.push(`Kills ${allyKills} : ${enemyKills} in ${clock(game.gameDuration)}.`)

  return {
    gameId: game.gameId,
    createdAt: game.gameCreation,
    duration: game.gameDuration,
    queueId: game.queueId,
    mode: game.gameMode,
    win,
    players: players.map(({ pid: _pid, ...p }) => p),
    curve,
    curveSource: source,
    kills,
    mvp,
    blame,
    highlights: h
  }
}
