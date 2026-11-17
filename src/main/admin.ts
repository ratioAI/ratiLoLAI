/**
 * Developer tools behind the Admin page (renderer/src/pages/Admin.tsx). This module is only loaded
 * when the app runs from `npm run dev` (see registerIpc in index.ts), so it is not part of the
 * installer your friends get.
 *
 * Everything here feeds the same code paths as the real League client: a simulated game goes
 * through updateOverlay like the live data does, the relic detection just gets told what the pads
 * show instead of looking at the screen.
 */
import type {
  AdminMinimapSnapshot,
  AdminRelicPad,
  AdminRelicSeen,
  AdminSimAction,
  AdminSimFight,
  AdminSimOptions,
  AdminSimState,
  AugmentOffer,
  LiveGameState,
  LivePlayer,
  LoadingState,
  MinimapState,
  RcEvents
} from '@shared/types'
import type { GameSummary } from '@shared/summary'
import type { CaptureFrame } from '@shared/capture'
import type { CaptureService } from './capture/captureService'
import type { DiagLog } from './diag'
import type { GameStore } from './games'
import type { AchievementService } from './achievements'
import type { DiscordPoster } from './discord'
import type { RecorderEnv } from './recorder/setup'
import type { RecorderService } from './recorder/service'
import type { OverlayManager } from './overlay'
import type { MinimapWatcher } from './minimap/watcher'
import { validPads, writeMeasuredPads } from './minimap/store'
import { toEncounter } from '@shared/encounters'
import { TRIGGERS, type LiveEvent, type Trigger } from '@shared/announcer'
import {
  firstSpawn,
  INHIBITOR_POS,
  INHIBITOR_RESPAWN,
  INHIBITOR_WARNING,
  minimapRect,
  RELIC_PADS,
  RELIC_PATCH,
  RELIC_TIMES,
  RELICS,
  relicPadsFor,
  relicSeen,
  type InhibitorEvent,
  type RelicPad
} from './minimap/timers'

export interface AdminContext {
  handle: <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) => void
  emit: <K extends keyof RcEvents>(event: K, payload: RcEvents[K]) => void
  /** what happens when a match is accepted in the client */
  acceptMatch: () => void
  /** the path the live data of a real game takes (main window + overlays + announcer) */
  feedLive: (live: LiveGameState | null, events?: LiveEvent[]) => void
  realLive: () => LiveGameState | null
  /** puts the real overlays back after a preview */
  restore: () => void
  previewOffer: (championId: number) => Promise<AugmentOffer | null>
  gameDisplay: () => Electron.Display
  minimapScale: () => number
  cosmosSeed: () => number
  overlay: OverlayManager
  minimap: MinimapWatcher
  capture: CaptureService
  games: GameStore
  achievements: AchievementService
  discord: DiscordPoster
  recorderEnv: RecorderEnv
  recorder: RecorderService
  diag: DiagLog
  padsFile: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Inhibitor names as the event feed has them (T1 = blue side). */
const INHIBITOR_NAME = { ORDER: 'Barracks_T1_L1', CHAOS: 'Barracks_T2_L1' } as const
const TEAM_NAME = { ORDER: 'Blue', CHAOS: 'Red' } as const

const SIM_PLAYERS: [string, string, 'ORDER' | 'CHAOS'][] = [
  ['You#DEV', 'Lux', 'ORDER'],
  ['blackbird#DEV', 'Garen', 'ORDER'],
  ['Doulul#DEV', 'Thresh', 'ORDER'],
  ['Toni#DEV', 'Jinx', 'ORDER'],
  ['ratio#DEV', 'Ahri', 'ORDER'],
  ['simwai#DEV', 'Darius', 'CHAOS'],
  ['Guido#DEV', 'Ezreal', 'CHAOS'],
  ['Splitter#DEV', 'Syndra', 'CHAOS'],
  ['NOATAQQ#DEV', 'Nautilus', 'CHAOS'],
  ['Bard#DEV', 'Sona', 'CHAOS']
]

/**
 * A made-up ARAM game whose clock runs in real time. Inhibitors come back on their own after
 * `inhibitorRespawn` seconds (with the 15 s warning before), like the real event feed has it.
 */
export class SimGame {
  gameTime: number
  readonly events: InhibitorEvent[] = []
  /** events the game will send later: the warning and the respawn of a destroyed inhibitor */
  private readonly scheduled: InhibitorEvent[] = []
  readonly takenAt = new Map<string, number>()
  readonly feed: LiveGameState['events'] = []
  /** the raw event feed with ids, like the Live Client Data API has it (announcer) */
  readonly liveEvents: LiveEvent[] = [{ EventID: 0, EventName: 'GameStart', EventTime: 0 }]
  /** a random fight every this many seconds, so the announcer has something to do */
  static readonly FIGHT_EVERY = 45

  constructor(
    readonly options: AdminSimOptions,
    private readonly measured: () => Record<string, RelicPad[]>
  ) {
    this.gameTime = options.startAt
  }

  pads(): readonly RelicPad[] {
    return relicPadsFor(this.options.map, this.measured()) ?? []
  }

  /** Moves the clock and sends whatever the game would have sent in between. */
  advance(seconds: number): void {
    const before = this.gameTime
    this.gameTime += seconds
    if (Math.floor(this.gameTime / SimGame.FIGHT_EVERY) > Math.floor(before / SimGame.FIGHT_EVERY) && this.gameTime > 60) {
      const kinds: AdminSimFight[] = ['triple', 'allyAce', 'enemyAce', 'myDeath', 'myDeath', 'quadra', 'premadePenta', 'penta']
      this.fight(kinds[Math.floor(Math.random() * kinds.length)])
    }
    for (const event of [...this.scheduled].sort((a, b) => a.time - b.time)) {
      if (event.time > this.gameTime) continue
      this.scheduled.splice(this.scheduled.indexOf(event), 1)
      this.add(event)
    }
  }

  private add(event: InhibitorEvent): void {
    this.events.push(event)
    const team = event.inhibitor.includes('_T1_') ? 'ORDER' : 'CHAOS'
    const text = { killed: 'destroyed', soon: 'respawning soon', respawned: 'respawned' }[event.type]
    this.feed.push({ name: `Inhib_${event.type}`, time: event.time, text: `${TEAM_NAME[team]} inhibitor ${text}` })
  }

  private push(event: Omit<LiveEvent, 'EventID' | 'EventTime'>, text: string): void {
    this.liveEvents.push({ ...event, EventID: this.liveEvents.length, EventTime: this.gameTime })
    this.feed.push({ name: event.EventName, time: this.gameTime, text })
  }

  /** A fight in the event feed: kills, multikills, aces, your death, the end of the game. */
  fight(kind: AdminSimFight): void {
    const allies = SIM_PLAYERS.filter(([, , team]) => team === 'ORDER').map(([riotId]) => riotId.split('#')[0])
    const enemies = SIM_PLAYERS.filter(([, , team]) => team === 'CHAOS').map(([riotId]) => riotId.split('#')[0])
    const kill = (killer: string, victim: string, assisters: string[] = []) =>
      this.push({ EventName: 'ChampionKill', KillerName: killer, VictimName: victim, Assisters: assisters }, `${killer} killed ${victim}`)
    const spree = (killer: string, count: number) => {
      for (let i = 0; i < count; i++) {
        kill(killer, enemies[i % enemies.length])
        if (i > 0) this.push({ EventName: 'Multikill', KillerName: killer, KillStreak: i + 1 }, `${killer}: ${i + 1} kills in a row`)
      }
    }
    const ace = (team: 'ORDER' | 'CHAOS') => {
      const [killers, victims] = team === 'ORDER' ? [allies, enemies] : [enemies, allies]
      victims.forEach((victim, i) => kill(killers[(i + 1) % killers.length], victim))
      this.push({ EventName: 'Ace', Acer: killers[0], AcingTeam: team }, `Ace (${team === 'ORDER' ? 'blue' : 'red'})`)
    }
    switch (kind) {
      case 'firstBlood':
        kill('You', enemies[0])
        this.push({ EventName: 'FirstBlood', Recipient: 'You' }, 'First Blood!')
        break
      case 'triple':
        return spree('You', 3)
      case 'quadra':
        return spree('You', 4)
      case 'penta':
        return spree('You', 5)
      case 'premadePenta':
        return spree('blackbird', 5)
      case 'allyAce':
        return ace('ORDER')
      case 'enemyAce':
        return ace('CHAOS')
      case 'myDeath':
        return kill(enemies[Math.floor(Math.random() * enemies.length)], 'You')
      case 'victory':
      case 'defeat':
        return this.push({ EventName: 'GameEnd', Result: kind === 'victory' ? 'Win' : 'Lose' }, kind === 'victory' ? 'Victory' : 'Defeat')
    }
  }

  inhibitor(team: 'ORDER' | 'CHAOS', type: InhibitorEvent['type']): void {
    const inhibitor = INHIBITOR_NAME[team]
    // a manual event replaces what the game would have sent for this inhibitor
    for (const event of [...this.scheduled]) if (event.inhibitor === inhibitor) this.scheduled.splice(this.scheduled.indexOf(event), 1)
    this.add({ type, inhibitor, time: this.gameTime })
    if (type === 'killed') {
      const back = this.gameTime + this.options.inhibitorRespawn
      this.scheduled.push({ type: 'soon', inhibitor, time: back - INHIBITOR_WARNING }, { type: 'respawned', inhibitor, time: back })
    } else if (type === 'soon') this.scheduled.push({ type: 'respawned', inhibitor, time: this.gameTime + INHIBITOR_WARNING })
  }

  /** What the relic detection would see on the pads right now. */
  seen(pads: readonly RelicPad[], now: number): AdminRelicSeen[] {
    return pads.map((pad) => {
      const first = firstSpawn(pad)
      if (first !== null && now < first) return 'absent'
      const taken = this.takenAt.get(pad.id)
      return taken !== undefined && now < taken + RELIC_TIMES.respawn ? 'absent' : 'present'
    })
  }

  live(): LiveGameState {
    const level = Math.min(18, 1 + Math.floor(this.gameTime / 75))
    const players: LivePlayer[] = SIM_PLAYERS.map(([riotId, championName, team], i) => ({
      riotId,
      championName,
      team,
      level,
      kills: (i * 3) % 7,
      deaths: (i * 2) % 5,
      assists: (i * 5) % 9,
      creepScore: Math.round(this.gameTime / 12),
      items: [],
      spells: ['Flash', 'Mark'],
      position: '',
      isDead: false,
      respawnTimer: 0
    }))
    return {
      active: true,
      gameTime: this.gameTime,
      gameMode: this.options.mode === 'mayhem' ? 'KIWI' : 'ARAM',
      mapNumber: this.options.map,
      mapName: `Map${this.options.map}`,
      mapTerrain: 'Default',
      activeChampion: 'Lux',
      activeChampionKey: 'Lux',
      activePlayer: 'You#DEV',
      premades: ['blackbird#DEV'],
      inhibitorEvents: [...this.events],
      players,
      events: [...this.feed]
    }
  }

  state(): AdminSimState {
    return {
      options: this.options,
      gameTime: this.gameTime,
      inhibitorEvents: [...this.events],
      pads: this.pads().map((pad) => ({ ...pad, takenAt: this.takenAt.get(pad.id) ?? null }))
    }
  }
}

/** Crops the square the relic detection looks at around a pad out of a minimap picture. */
function padPatch(image: CaptureFrame, pad: AdminRelicPad): CaptureFrame {
  const side = Math.max(9, Math.round(RELIC_PATCH * image.width))
  const x0 = Math.max(0, Math.min(image.width - side, Math.round(pad.pos.x * image.width - side / 2)))
  const y0 = Math.max(0, Math.min(image.height - side, Math.round(pad.pos.y * image.height - side / 2)))
  const data = new Uint8Array(side * side * 4)
  for (let y = 0; y < side; y++) {
    const from = ((y0 + y) * image.width + x0) * 4
    data.set(image.data.subarray(from, from + side * 4), y * side * 4)
  }
  return { width: side, height: side, data }
}

export function registerAdmin(ctx: AdminContext): void {
  const { handle, overlay, minimap, diag } = ctx
  const log = (message: string): void => diag.log(`admin: ${message}`)
  let sim: SimGame | null = null
  let simTimer: NodeJS.Timeout | null = null
  let lastImage: CaptureFrame | null = null

  const stopSim = (reason: string): void => {
    if (!sim) return
    if (simTimer) clearInterval(simTimer)
    simTimer = null
    sim = null
    minimap.seenOverride = null
    log(`simulated game stopped (${reason})`)
    ctx.feedLive(null)
  }

  const tickSim = (): void => {
    if (!sim) return
    // a real game always wins
    if (ctx.realLive()?.active) return stopSim('a real game started')
    sim.advance(1)
    ctx.feedLive(sim.live(), sim.liveEvents)
  }

  handle('admin:acceptMatch', () => {
    log('match accepted (simulated)')
    ctx.acceptMatch()
  })

  handle('admin:emit', (event: 'champSelect', payload: RcEvents['champSelect']) => {
    if (event !== 'champSelect') throw new Error(`not an admin event: ${String(event)}`)
    log(`champion select ${payload ? 'sent' : 'cleared'}`)
    ctx.emit(event, payload)
  })

  handle('admin:simStart', (options: AdminSimOptions) => {
    if (ctx.realLive()?.active) throw new Error('A real game is running.')
    stopSim('restarted')
    const map = Number.isInteger(options.map) && options.map > 0 ? options.map : 12
    const respawn = Number(options.inhibitorRespawn)
    sim = new SimGame(
      {
        mode: options.mode === 'mayhem' ? 'mayhem' : 'aram',
        map,
        startAt: Math.max(0, Math.min(3000, Number(options.startAt) || 0)),
        inhibitorRespawn: respawn > 60 && respawn < 600 ? respawn : INHIBITOR_RESPAWN
      },
      () => minimap.measuredPads
    )
    const current = sim
    minimap.seenOverride = (pads, now) => current.seen(pads, now)
    log(
      `simulated ${current.options.mode} game on map ${map} from ${current.gameTime} s (inhibitors back after ${current.options.inhibitorRespawn} s)`
    )
    ctx.feedLive(sim.live(), sim.liveEvents)
    simTimer = setInterval(tickSim, 1000)
    return sim.state()
  })

  handle('admin:simAction', (action: AdminSimAction) => {
    if (!sim) return null
    if (action.type === 'inhibitor') {
      sim.inhibitor(action.team === 'CHAOS' ? 'CHAOS' : 'ORDER', action.event)
      log(`${TEAM_NAME[action.team]} inhibitor ${action.event} at ${sim.gameTime} s`)
    } else if (action.type === 'relicTaken') {
      const pad = sim.pads().find((candidate) => candidate.id === action.padId)
      if (pad && sim.seen([pad], sim.gameTime)[0] === 'present') {
        sim.takenAt.set(pad.id, sim.gameTime)
        log(`relic ${pad.id} taken at ${sim.gameTime} s`)
      }
    } else if (action.type === 'skip') {
      const seconds = Math.max(1, Math.min(600, Math.round(action.seconds)))
      sim.advance(seconds)
      log(`skipped ${seconds} s → ${sim.gameTime} s`)
      // the overlay counts down on its own, so it needs the new clock right away
      minimap.resync()
    } else if (action.type === 'fight') {
      sim.fight(action.kind)
      log(`fight "${action.kind}" at ${sim.gameTime} s`)
    }
    ctx.feedLive(sim.live(), sim.liveEvents)
    return sim.state()
  })

  handle('admin:simState', () => sim?.state() ?? null)
  handle('admin:simStop', () => stopSim('stopped in the admin tool'))

  handle('admin:showMinimapDemo', (scenario: 'mixed' | 'soon' | 'pads', map?: number) => {
    const display = ctx.gameDisplay()
    const rect = minimapRect(display.size.width, display.size.height, ctx.minimapScale())
    const now = 300
    const relic = (pad: RelicPad, state: 'up' | 'spawn', inSeconds: number): MinimapState['relics'][number] => ({
      ...pad,
      pos: { ...pad.pos },
      state,
      at: state === 'spawn' ? now + inSeconds : null,
      since: state === 'spawn' ? now + inSeconds - RELIC_TIMES.respawn : null
    })
    const inhibitor = (team: 'ORDER' | 'CHAOS', inSeconds: number): MinimapState['inhibitors'][number] => ({
      team,
      respawnAt: now + inSeconds,
      since: now + inSeconds - INHIBITOR_RESPAWN,
      pos: INHIBITOR_POS[team]
    })
    let state: MinimapState
    if (scenario === 'pads') {
      // every pad of the map counting down, to check that measured pads sit on the minimap's crosses
      const pads = relicPadsFor(map ?? 12, minimap.measuredPads) ?? []
      state = { gameTime: now, measuredAt: Date.now(), rect, inhibitors: [], relics: pads.map((pad, i) => relic(pad, 'spawn', 40 + i * 9)) }
    } else if (scenario === 'soon') {
      state = {
        gameTime: now,
        measuredAt: Date.now(),
        rect,
        inhibitors: [inhibitor('ORDER', 9), inhibitor('CHAOS', 24)],
        relics: RELICS.map((pad, i) => relic(pad, i === 2 ? 'up' : 'spawn', 4 + i * 2))
      }
    } else {
      state = {
        gameTime: now,
        measuredAt: Date.now(),
        rect,
        inhibitors: [inhibitor('ORDER', 58), inhibitor('CHAOS', 134)],
        relics: RELICS.map((pad, i) => relic(pad, i % 2 ? 'up' : 'spawn', 31 + i * 17))
      }
    }
    log(`minimap demo "${scenario}" on display ${display.id}`)
    const local = overlay.showMinimap(display.id, rect)
    void overlay.minimap.send('minimap', { ...state, local })
  })

  handle('admin:showFrames', async (championId: number) => {
    const offer = await ctx.previewOffer(Number(championId))
    if (!offer) throw new Error('No augment data loaded yet.')
    log(`card frames for champion ${championId}`)
    overlay.preview(offer, 10 * 60_000)
  })

  handle('admin:showLoading', (state: LoadingState) => {
    const display = ctx.gameDisplay()
    log(`loading panel on display ${display.id} (${state.players.length} players)`)
    overlay.showLoading(display.id)
    void overlay.loading.send('loading', { ...state, seed: ctx.cosmosSeed() })
  })

  // the loading panel with the strangers you met most often, through the real encounter query
  handle('admin:showHistoryLobby', () => {
    const met = ctx.games.mostMet(9)
    if (!met.length) throw new Error('No saved games with other players yet – save a test game first.')
    const allies = met.filter((player) => player.together >= player.against).slice(0, 4)
    const enemies = met.filter((player) => !allies.includes(player)).slice(0, 5)
    const stats = ctx.games.encounters(
      null,
      [...allies, ...enemies].map((player) => player.puuid)
    )
    const row = (player: (typeof met)[number], ally: boolean): LoadingState['players'][number] => ({
      puuid: player.puuid,
      riotId: player.riotId,
      championId: player.championId,
      ally,
      me: false,
      premade: false,
      record: null,
      loading: false,
      encounter: toEncounter(stats.get(player.puuid), player.riotId)
    })
    const state: LoadingState = {
      mode: 'mayhem',
      players: [
        { puuid: 'admin-me', riotId: 'You#DEV', championId: 99, ally: true, me: true, premade: false, record: null, loading: false },
        ...allies.map((player) => row(player, true)),
        ...enemies.map((player) => row(player, false))
      ]
    }
    const display = ctx.gameDisplay()
    log(`loading panel from the history: ${state.players.length - 1} players you met`)
    overlay.showLoading(display.id)
    void overlay.loading.send('loading', { ...state, seed: ctx.cosmosSeed() })
    return state.players.length - 1
  })

  handle('admin:hideOverlays', () => {
    overlay.endPreview()
    overlay.hideMinimap()
    void overlay.minimap.send('minimap', null)
    overlay.hideLoading()
    void overlay.loading.send('loading', null)
    ctx.restore()
  })

  handle('admin:saveTestGame', (summary: GameSummary) => {
    if (!summary || !(summary.gameId < 0)) throw new Error('Test games need a negative game id.')
    const saved = { ...summary, cosmos: ctx.cosmosSeed() }
    ctx.games.save(saved)
    log(`test game ${summary.gameId} saved`)
    ctx.emit('gameSummary', saved)
    void ctx.achievements.onGame(saved)
  })

  // straight to the main window, no game needed
  handle('admin:announce', (trigger: Trigger) => {
    if (!(TRIGGERS as readonly string[]).includes(trigger)) throw new Error(`unknown trigger ${String(trigger)}`)
    log(`announce ${trigger}`)
    ctx.emit('announce', {
      trigger,
      time: 0,
      deaths: trigger === 'myDeathMilestone' ? 10 : undefined,
      name: trigger === 'premadePenta' ? 'blackbird' : undefined
    })
  })

  handle('admin:discordPreview', async () => {
    const newest = ctx.games.list()[0]
    const summary = newest ? ctx.games.get(newest.gameId) : null
    if (!summary) return { gameId: null, payload: null, skip: 'no saved games' }
    return { gameId: summary.gameId, payload: await ctx.discord.payload(summary), skip: ctx.discord.skipReason(summary) }
  })

  handle('admin:unlockAchievement', (id: string) => {
    const newest = ctx.games.list()[0]?.gameId ?? null
    if (!ctx.achievements.unlockNow(String(id), newest)) throw new Error('Already unlocked – reset first.')
    log(`achievement ${id} unlocked by hand`)
  })

  handle('admin:resetAchievements', async () => {
    ctx.achievements.store.reset()
    await ctx.achievements.rebuild()
    const unlocked = ctx.achievements.list().filter((achievement) => achievement.unlocked).length
    log(`achievements reset, ${unlocked} unlocked again from the history`)
    return unlocked
  })

  handle('admin:deleteTestGames', () => {
    const removed = ctx.games.deleteTestGames()
    log(`${removed} test game${removed === 1 ? '' : 's'} deleted`)
    return removed
  })

  handle('admin:recorderReloadFfmpeg', async () => {
    log('recorder: FFmpeg removed and downloaded again')
    await ctx.recorderEnv.install(true)
    return ctx.recorderEnv.setup()
  })

  handle('admin:recorderTestRecording', async (on: boolean) => {
    const status = await ctx.recorder.testRecording(!!on)
    log(`recorder: test recording ${on ? 'started' : 'stopped'}`)
    return status
  })

  handle('admin:recorderRing', () => ctx.recorder.ring())

  handle('admin:recorderTestCapture', async (source: 'testsrc' | 'screen') => {
    const result = await ctx.recorderEnv.testCapture(source === 'screen' ? 'screen' : 'testsrc')
    log(`recorder: test capture ${result.ok ? 'ok' : 'failed'} – ${result.segments} segments, ${Math.round(result.bytes / 1e5) / 10} MB`)
    return result
  })

  handle('admin:log', (lines: number) => diag.recent(Math.max(1, Math.min(200, Math.round(Number(lines) || 80)))))

  handle('admin:minimapSnapshot', async (): Promise<AdminMinimapSnapshot> => {
    const display = ctx.gameDisplay()
    const rect = minimapRect(display.size.width, display.size.height, ctx.minimapScale())
    const live = ctx.realLive()
    const map = live?.mapNumber ?? sim?.options.map ?? 12
    const width = Math.round(rect.w * display.size.width * display.scaleFactor)
    const height = Math.round(rect.h * display.size.height * display.scaleFactor)
    let image: CaptureFrame | null = null
    // the relic timers ask for 1 fps too, so this doesn't reopen a stream that is already running
    ctx.capture.demand('admin', { displays: [display.id], fps: 1 })
    try {
      for (let attempt = 0; attempt < 5 && !image; attempt++) {
        await ctx.capture.settled()
        const frames = await ctx.capture.grab(display, [{ ...rect, outW: width, outH: height }])
        if (frames?.[0]) image = frames[0]
        else await sleep(400)
      }
    } finally {
      ctx.capture.demand('admin', null)
    }
    lastImage = image
    const measured = minimap.measuredPads[String(map)]
    const pads = relicPadsFor(map, minimap.measuredPads) ?? []
    log(`minimap snapshot of display ${display.id}: ${image ? `${image.width}×${image.height}` : 'failed'} (map ${map})`)
    return {
      map,
      mapName: live?.mapName ?? null,
      inGame: !!live?.active,
      display: { id: display.id, width: display.size.width, height: display.size.height, scaleFactor: display.scaleFactor },
      rect,
      image,
      error: image ? undefined : (ctx.capture.failed ?? 'The screen stream sent no picture.'),
      pads: pads.map((pad) => ({ ...pad, seen: image ? relicSeen(padPatch(image, pad)) : null })),
      source: measured ? 'measured' : RELIC_PADS[map] ? 'built-in' : 'none',
      patch: RELIC_PATCH
    }
  })

  handle('admin:classifyPads', (pads: AdminRelicPad[]) => {
    const image = lastImage
    return validPads(pads).map((pad) => (image ? relicSeen(padPatch(image, pad)) : null))
  })

  handle('admin:measuredPads', () => minimap.measuredPads)

  handle('admin:savePads', (map: number, pads: AdminRelicPad[] | null) => {
    if (!Number.isInteger(map) || map <= 0 || map > 9999) throw new Error(`Invalid map number: ${map}`)
    const next = { ...minimap.measuredPads }
    const clean = pads ? validPads(pads) : []
    if (clean.length) next[String(map)] = clean
    else delete next[String(map)]
    minimap.measuredPads = next
    writeMeasuredPads(ctx.padsFile, next)
    log(clean.length ? `${clean.length} relic pads saved for map ${map}` : `map ${map} back to the built-in relic pads`)
    return next
  })

  log('admin tool ready')
}
