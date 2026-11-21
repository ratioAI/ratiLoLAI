import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { CleanupPreview, Clip, ClipStorageInfo, LiveGameState, RecorderStatus, SessionRecording } from '@shared/types'
import {
  autoClipWindows,
  cleanupPlan,
  concatList,
  ffmpegClipArgs,
  ffmpegRecordArgs,
  ffmpegScreenshotArgs,
  ffmpegThumbArgs,
  hotkeyConflicts,
  mergeClipWindows,
  parseSegmentList,
  pickEncoder,
  resolveProfile,
  ringExpired,
  segmentsFor,
  SEGMENT_LIST,
  type CaptureSource,
  type CleanupPlan,
  type ClipKind,
  type ClipWindow,
  type FeedEvent,
  type RecorderMode,
  type RecorderSettings,
  type ResolvedProfile,
  type Segment,
  type StoredItem
} from '@shared/recorder'
import { emptyFeed, FEED_EVENTS, type LiveTeam, type RecordingFeed } from '@shared/highlights'
import type { GameWindowSettings } from '../lcu/gameSettings'
import type { ClipStore } from './clipStore'
import { run } from './ffmpeg'
import { endLeftoverFfmpeg, lowerPriority } from './helper'
import { windowsSupported, type RecorderEnv } from './setup'

export interface RecorderDeps {
  env: RecorderEnv
  store: ClipStore
  settings(): RecorderSettings
  /** the augment overlay's hotkey, which the recorder must not take */
  takenHotkeys(): Record<string, string>
  emit(status: RecorderStatus): void
  clipSaved(clip: Clip): void
  /** registers these global hotkeys and releases the ones registered before (empty = none) */
  hotkeys(bindings: { accelerator: string; run(): void }[]): void
  /** size of the screen the game runs on in pixels, used when the helper cannot measure the window */
  displaySize(): { width: number; height: number } | null
  /** League's video settings (window mode, resolution) from the client or game.cfg; null when unknown */
  gameVideo(): Promise<GameWindowSettings | null>
  log(message: string): void
  now?(): number
  /** tests: runs FFmpeg for clips, thumbnails and screenshots */
  run?: typeof run
  /** tests: starts the recording FFmpeg */
  spawn?: typeof spawn
  /** tests: ends an FFmpeg an earlier app run left recording, true when there was one */
  endLeftover?(pid: number): Promise<boolean>
  /** tests: pretend to be on a supported Windows */
  supported?: boolean
}

interface Recording {
  id: number
  dir: string
  child: ChildProcessWithoutNullStreams
  startedAt: number
  /** wall-clock time of second 0 of the recording (estimated from FFmpeg's progress) */
  zeroWall: number
  zeroKnown: boolean
  test: boolean
  mode: RecorderMode
  replaySeconds: number
  profile: ResolvedProfile
  segments: Segment[]
  sizes: Map<string, number>
  /** segments deleted from the ring (FFmpeg's list still names them) */
  deleted: Set<string>
  /** recording time minus game time, in seconds; null until the game clock was seen */
  offset: number | null
  /** the offset last written to the database (the highlight videos map clips to the game with it) */
  savedOffset: number | null
  /** what happened in the game, for the highlight videos; written now and then and at the end */
  feed: RecordingFeed
  /** game time the feed was last written */
  feedSavedAt: number
  lastEventId: number | null
  lastGameTime: number
  /** automatic clips waiting for their lead-out (game seconds) */
  pending: ClipWindow[]
  /** bookmark marks in recording seconds */
  bookmarks: number[]
  /** ranges being cut right now (recording seconds): the ring must not delete them */
  cutting: { start: number; end: number }[]
  stopping: boolean
  /** the work of stop(), for everyone who asks to stop while it runs */
  stopped?: Promise<void>
  closed: Promise<number>
  stderr: string[]
  /** the end of FFmpeg's last output piece, while its line is not finished yet */
  stderrRest: string
  /** FFmpeg's frame counters (see trackPicture): totals so far, and where the current minute began */
  picture: { minute: number; frames: number; dup: number; drop: number; minuteDup: number; minuteDrop: number }
}

const IN_GAME_PHASES = ['InProgress', 'Reconnect', 'GameStart']
/** how often the game window is looked for before giving up on a game (once per live poll, 2 s) */
const MAX_START_ATTEMPTS = 120
/**
 * Recordings per game that FFmpeg may break off before the recorder stays off. Each new try waits for
 * the next live poll (2 s): tried again at once, the second start used to fail the same way.
 */
const MAX_FAILURES = 3
/**
 * Below this the game window shows no picture yet: League creates it at 2×2 pixels and only then
 * brings it to its size. Captured that small, the encoder fails with -22 (Invalid argument), even
 * when the capture is told to scale it up (seen in a game on 2026-11-20).
 */
const MIN_WINDOW = { width: 320, height: 180 }
/** next to the segments while FFmpeg records, so the next app run finds an FFmpeg that was left running */
const PID_FILE = 'ffmpeg.pid'
/**
 * Share of repeated frames from which a minute is logged. A smooth game repeats about 8 % too (the
 * capture misses a few of the screen's 60 refreshes, 2026-11-20 at 200 game FPS), so only a clear
 * dip counts: 20 % means the game showed fewer than 48 new frames per second.
 */
const UNEVEN = 0.2
export const FULLSCREEN_HINT = 'If League runs in exclusive fullscreen, switch it to Borderless or Windowed (like for the augment overlay).'

const stamp = (time: number): string => new Date(time).toISOString().replace(/[:.]/g, '-').slice(0, 19)

type Size = { width: number; height: number }
const hasSize = (size: Size | null | undefined): size is Size => !!size && size.width > 0 && size.height > 0

/**
 * Size of the game's picture from League's video settings, without looking at the window (whose
 * size right at the start says nothing). Borderless always fills the screen; windowed and
 * fullscreen run at the resolution in League's video settings. Null when neither is known.
 */
export function gameSize(video: GameWindowSettings | null, screen: Size | null): (Size & { from: string }) | null {
  if (video?.mode === 'borderless' && hasSize(screen))
    return { width: screen.width, height: screen.height, from: `League borderless = screen ${screen.width}x${screen.height}` }
  if (video && hasSize(video)) return { width: video.width, height: video.height, from: `League ${video.mode ?? 'settings'} ${video.width}x${video.height}` }
  if (hasSize(screen)) return { width: screen.width, height: screen.height, from: `screen ${screen.width}x${screen.height} (League settings unknown)` }
  return null
}

/** what the recording's sound holds, for the log */
const soundLabel = (settings: RecorderSettings): string =>
  [settings.audio.game ? (settings.audio.source === 'all' ? 'whole PC but ratioAI' : 'game only') : null, settings.audio.mic ? 'mic' : null]
    .filter(Boolean)
    .join(' + ')

async function dirSize(dir: string): Promise<number> {
  let bytes = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) bytes += await dirSize(path)
    else bytes += (await stat(path).catch(() => null))?.size ?? 0
  }
  return bytes
}

/**
 * The gameplay recorder. Starts FFmpeg when a game is in progress and stops it when the game is
 * over; cuts clips out of the 2-second segments (stream copy, nothing is encoded twice) on the
 * hotkey, for bookmarks and for the moments the live event feed reports. It has no timer of its
 * own: everything that happens during a game hangs on the live poll (onLive).
 *
 * Only operating system interfaces are used: FFmpeg captures the game window through Windows
 * Graphics Capture (or Desktop Duplication), the helper records the game's sound through WASAPI
 * process loopback. FFmpeg and the helper run at below-normal priority, frames stay on the GPU,
 * and when the encoder cannot keep up frames are dropped in the capture, never in the game.
 */
export class RecorderService {
  private rec: Recording | null = null
  private phase = 'None'
  private state: RecorderStatus['state'] = 'off'
  private message: string | null = null
  private usedBytes = 0
  private lastClip: Clip | null = null
  private saving = 0
  private starting = false
  private ticking = false
  /** the newest live poll that arrived while a tick was still running: it runs right after */
  private queuedLive: { events: readonly FeedEvent[]; state: LiveGameState | null } | null = null
  private attempts = 0
  /** recordings FFmpeg broke off in this game */
  private failures = 0
  /** what an earlier app run left unfinished is cleaned up before the first recording starts */
  private recovering: Promise<void> | null = null
  private lastRecordingId: number | null = null
  private lastEndedAt = 0
  private lastStatus = ''
  /** the work after a recording ended (last clips, bookmarks, joining), while it runs */
  private finishing: Promise<void> | null = null

  constructor(private readonly deps: RecorderDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get run(): typeof run {
    return this.deps.run ?? run
  }

  get recording(): boolean {
    return !!this.rec
  }

  // --- status ---

  status(): RecorderStatus {
    const settings = this.deps.settings()
    const rec = this.rec
    const newest = rec?.segments.length ? rec.segments[rec.segments.length - 1].end : 0
    const oldest = rec?.segments.length ? rec.segments[0].start : 0
    const ringBytes = rec ? [...rec.sizes.values()].reduce((sum, bytes) => sum + bytes, 0) : 0
    return {
      state: !settings.enabled && !rec ? 'off' : this.saving > 0 ? 'saving' : rec ? 'recording' : this.state === 'error' ? 'error' : this.message ? 'off' : 'idle',
      message: !settings.enabled && !rec ? null : this.message,
      mode: rec?.mode ?? settings.mode,
      encoder: rec?.profile.encoder.label ?? null,
      startedAt: rec?.startedAt ?? null,
      bytes: this.usedBytes + ringBytes,
      quotaBytes: settings.storage.maxGb * 1e9,
      ringSeconds: rec ? Math.round(Math.min(newest - oldest, rec.mode === 'replay' ? rec.replaySeconds : newest - oldest)) : 0,
      bookmarks: rec?.bookmarks.length ?? 0,
      lastClip: this.lastClip
    }
  }

  private emit(): void {
    const status = this.status()
    const key = JSON.stringify(status)
    if (key === this.lastStatus) return
    this.lastStatus = key
    this.deps.emit(status)
  }

  private off(message: string | null, error = false): void {
    if (message && message !== this.message) this.deps.log(`recorder: ${message}`)
    this.message = message
    this.state = error ? 'error' : message ? 'off' : 'idle'
    this.emit()
  }

  /** Call once at start and whenever the settings changed. */
  async refresh(): Promise<void> {
    if (!this.rec) {
      this.state = 'idle'
      this.message = null
    }
    await this.scanStorage()
    this.emit()
  }

  // --- game flow ---

  /**
   * The League client's gameflow phase changed. InProgress comes the moment the game process starts,
   * when its window is still a few pixels small and cannot be captured (FFmpeg fails with -22): the
   * recording starts with the game's first live answer instead (onLive).
   */
  onPhase(phase: string): void {
    this.phase = phase
    if (IN_GAME_PHASES.includes(phase)) {
      if (phase === 'InProgress' && !this.rec) {
        this.attempts = 0
        this.failures = 0
      }
    } else if (this.rec && !this.rec.test) void this.stop('the game is over')
  }

  /**
   * Every poll of the live data (about every 2 s during a game, also from the admin tool's
   * simulated game). Looks at new segments, new events and due automatic clips, trims the ring.
   */
  onLive(events: readonly FeedEvent[], state: LiveGameState | null): void {
    if (!this.rec) {
      // Riot's live API answers once the game runs (loading screen included, ~8 s after InProgress):
      // its window has its size by then. Not after GameEnd: the Nexus has fallen, nothing left to record
      if (this.phase === 'InProgress' && state?.active && !state.result) void this.tryStart()
      return
    }
    // a poll that comes in while the last one is still busy (slow disk) is not dropped: the newest
    // one runs right after, otherwise a due clip would wait for the next poll (or be lost at game end)
    // a snapshot: the caller may keep adding to its array while the tick still waits for the disk,
    // and an event seen early would count as "already known" without ever making a clip
    const snapshot = [...events]
    if (this.ticking) {
      this.queuedLive = { events: snapshot, state }
      return
    }
    this.ticking = true
    void this.drainLive(snapshot, state)
  }

  private async drainLive(events: readonly FeedEvent[], state: LiveGameState | null): Promise<void> {
    let next: { events: readonly FeedEvent[]; state: LiveGameState | null } | null = { events, state }
    try {
      while (next) {
        await this.tick(next.events, next.state).catch((error) => this.deps.log(`recorder: tick failed – ${String(error)}`))
        next = this.queuedLive
        this.queuedLive = null
      }
    } finally {
      this.ticking = false
    }
  }

  private async tick(events: readonly FeedEvent[], state: LiveGameState | null): Promise<void> {
    const rec = this.rec
    if (!rec || rec.stopping) return
    await this.readSegments(rec)
    if (state?.active) {
      // the clock went backwards: a new game, whose event ids start over
      if (state.gameTime + 5 < rec.lastGameTime) {
        rec.lastEventId = null
        rec.pending = []
        rec.feed = emptyFeed()
      }
      rec.lastGameTime = state.gameTime
      rec.offset = this.streamNow(rec) - state.gameTime
      this.keepFeed(rec, events, state)
      const me = state.activePlayer ?? ''
      const found = autoClipWindows(events, {
        me,
        myTeam: state.players.find((player) => player.riotId === me)?.team ?? null,
        lastEventId: rec.lastEventId,
        enabled: this.deps.settings().autoClips
      })
      rec.lastEventId = found.lastEventId
      if (found.windows.length) rec.pending = mergeClipWindows([...rec.pending, ...found.windows])
      // a clip is made once its lead-out is over and its multikill can't grow any more
      const due = rec.pending.filter((window) => state.gameTime >= window.ready)
      rec.pending = rec.pending.filter((window) => !due.includes(window))
      for (const window of due) await this.cutWindow(rec, window)
    }
    if (rec.mode === 'replay') await this.trimRing(rec)
    this.emit()
  }

  /**
   * Keeps what the highlight videos need: the game clock of the recording, the events that can make
   * a highlight and your health. Written to the database once a minute and at the end.
   */
  private keepFeed(rec: Recording, events: readonly FeedEvent[], state: LiveGameState): void {
    if (rec.test) return
    const feed = rec.feed
    feed.me = state.activePlayer ?? feed.me
    for (const player of state.players) if (player.riotId && (player.team === 'ORDER' || player.team === 'CHAOS')) feed.teams[player.riotId] = player.team as LiveTeam
    const mine = state.players.find((player) => player.riotId === feed.me)?.team
    if (mine === 'ORDER' || mine === 'CHAOS') feed.myTeam = mine
    const known = new Set(feed.events.map((event) => event.EventID))
    for (const event of events) {
      if (!FEED_EVENTS.has(event.EventName) || known.has(event.EventID)) continue
      const { EventID, EventName, EventTime, KillerName, VictimName, Assisters, KillStreak, Acer, AcingTeam, Recipient, Result } = event
      feed.events.push({ EventID, EventName, EventTime, KillerName, VictimName, Assisters, KillStreak, Acer, AcingTeam, Recipient, Result })
    }
    const last = feed.health[feed.health.length - 1]
    if (state.started && state.activeHealth != null && (!last || state.gameTime - last[0] >= 1.5))
      feed.health.push([Math.round(state.gameTime * 10) / 10, Math.round(state.activeHealth * 1000) / 1000])
    if (rec.offset !== null && (rec.savedOffset === null || Math.abs(rec.offset - rec.savedOffset) > 1)) {
      rec.savedOffset = rec.offset
      this.deps.store.updateRecording(rec.id, { gameOffset: Math.round(rec.offset * 1000) / 1000 })
    }
    if (state.gameTime - rec.feedSavedAt >= 60) this.saveFeed(rec)
  }

  private saveFeed(rec: Recording): void {
    if (rec.test || !rec.feed.me) return
    rec.feedSavedAt = rec.lastGameTime
    try {
      this.deps.store.updateRecording(rec.id, { feed: JSON.stringify(rec.feed) })
    } catch (error) {
      this.deps.log(`recorder: saving the game feed failed – ${String(error)}`)
    }
  }

  private streamNow(rec: Recording): number {
    return Math.max(0, (this.now() - rec.zeroWall) / 1000)
  }

  private windowRange(rec: Recording, window: ClipWindow): { start: number; end: number } | null {
    return rec.offset === null ? null : { start: window.start + rec.offset, end: window.end + rec.offset }
  }

  private async cutWindow(rec: Recording, window: ClipWindow): Promise<void> {
    const range = this.windowRange(rec, window)
    if (!range) return
    await this.cut(rec, range, `auto:${window.kind}`, window.title)
  }

  // --- starting and stopping ---

  private async tryStart(test = false): Promise<void> {
    if (this.starting || this.rec) return
    const settings = this.deps.settings()
    if (!test && (!settings.enabled || this.phase !== 'InProgress' || this.attempts >= MAX_START_ATTEMPTS)) return
    this.starting = true
    try {
      await this.recovering
      await this.start(settings, test)
    } catch (error) {
      this.off(`Recording could not start: ${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      this.starting = false
    }
  }

  /** The game window is not ready yet: the next live poll tries again, until MAX_START_ATTEMPTS. */
  private notYet(why: string, giveUp: string): void {
    if (++this.attempts === 1) this.deps.log(`recorder: ${why} – trying again with the next live poll`)
    if (this.attempts >= MAX_START_ATTEMPTS) this.off(giveUp)
  }

  private async start(settings: RecorderSettings, test: boolean): Promise<void> {
    const env = this.deps.env
    if (!test && !(this.deps.supported ?? windowsSupported())) return this.off('Recording needs Windows 10 version 2004 or newer.')
    const ffmpeg = env.ffmpeg.path
    if (!ffmpeg) return this.off('FFmpeg is not downloaded yet (Settings › Clips).')
    // the encoder test uses the GPU, so during a game only its cached result is used
    const probe = env.encoders.current ?? (test ? await env.testEncoders() : null)
    if (!probe) return this.off('The encoders are tested once no game is running (Settings › Clips).')
    const encoder = pickEncoder(probe.available, settings.encoder)
    if (!encoder) return this.off('No hardware encoder (NVENC, AMF, Quick Sync) found – recording is off.')
    if (!probe.capture && !test) return this.off('This FFmpeg cannot capture windows.')

    let source: CaptureSource
    let size: Size | null
    let audioPipe: string | null = null
    /** for the log: where the picture's size came from, and the window as it was found */
    let sizeNote = ''
    if (test) {
      source = { kind: 'testsrc', width: 1920, height: 1080 }
      size = { width: 1920, height: 1080 }
    } else {
      const window = env.helper.available ? await env.helper.findWindow() : null
      if (env.helper.available && (!window || window.minimized)) {
        // the game window appears a few seconds after the client reports the game: try again on the next poll
        return this.notYet(window ? 'the game window is minimised' : 'game window not found', 'Game window not found – nothing is recorded.')
      }
      if (window && (window.width < MIN_WINDOW.width || window.height < MIN_WINDOW.height)) {
        return this.notYet(`the game window is still ${window.width}x${window.height}`, 'The game window never got its size – nothing is recorded.')
      }
      const video = await this.deps.gameVideo().catch(() => null)
      if (window) {
        const screen = { width: window.monitorWidth, height: window.monitorHeight }
        const game = gameSize(video, hasSize(screen) ? screen : this.deps.displaySize())
        if (probe.capture === 'gfxcapture') {
          // Windows Graphics Capture follows the window and scales it to the game's size
          source = { kind: 'gfxcapture', hwnd: window.hwnd }
          size = game ?? { width: window.width, height: window.height }
          sizeNote = `; size from ${game?.from ?? 'the window'}`
        } else {
          // Desktop Duplication cuts the window out of the screen and cannot follow it: borderless waits
          // until the window fills the screen (a window in windowed mode may stay smaller than its resolution)
          if (video?.mode === 'borderless' && game && (window.width < game.width || window.height < game.height)) {
            return this.notYet(
              `the game window is ${window.width}x${window.height}, not yet the screen's ${game.width}x${game.height}`,
              'The game window never got its size – nothing is recorded.'
            )
          }
          const fullScreen = window.width >= window.monitorWidth && window.height >= window.monitorHeight
          source = {
            kind: 'ddagrab',
            outputIdx: window.monitor,
            crop: fullScreen ? null : { x: window.x - window.monitorX, y: window.y - window.monitorY, width: window.width, height: window.height }
          }
          size = { width: window.width, height: window.height }
          sizeNote = '; size from the window'
        }
        sizeNote += `; window ${window.width}x${window.height}, hwnd ${window.hwnd}`
        if (settings.audio.game || settings.audio.mic)
          audioPipe = await env.helper.start({
            pid: window.pid,
            source: settings.audio.source,
            game: settings.audio.game,
            mic: settings.audio.mic,
            micVolume: settings.audio.micVolume
          })
      } else {
        // without the helper the window can still be found by its program name, but only by Windows Graphics Capture;
        // Desktop Duplication would record the whole screen, and that is never done
        if (probe.capture !== 'gfxcapture') return this.off('The sound helper is missing, so the game window cannot be found.')
        source = { kind: 'gfxcapture' }
        const game = gameSize(video, this.deps.displaySize())
        size = game
        if (game) sizeNote = `; size from ${game.from}`
      }
    }

    const now = this.now()
    const dir = join(env.folder(), 'recordings', stamp(now))
    await mkdir(dir, { recursive: true })
    const profile = resolveProfile(settings.quality, settings.fps, encoder, size)
    const args = ffmpegRecordArgs(profile, source, audioPipe, dir)
    const child = (this.deps.spawn ?? spawn)(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    lowerPriority(child.pid)
    // written at once (a few bytes): FFmpeg breaking off right away removes the folder again
    try {
      if (child.pid) writeFileSync(join(dir, PID_FILE), String(child.pid))
    } catch {
      // without it, only the next app run's cleanup misses this FFmpeg
    }
    const rec: Recording = {
      id: this.deps.store.addRecording(now, dir),
      dir,
      child,
      startedAt: now,
      // FFmpeg needs a moment to open the capture; corrected by its first progress line
      zeroWall: now + 700,
      zeroKnown: false,
      test,
      mode: settings.mode,
      replaySeconds: settings.replaySeconds,
      profile,
      segments: [],
      sizes: new Map(),
      deleted: new Set(),
      offset: null,
      savedOffset: null,
      feed: emptyFeed(),
      feedSavedAt: 0,
      lastEventId: null,
      lastGameTime: 0,
      pending: [],
      bookmarks: [],
      cutting: [],
      stopping: false,
      closed: new Promise((resolveClosed) => child.once('close', (code) => resolveClosed(code ?? -1))),
      stderr: [],
      stderrRest: '',
      picture: { minute: 0, frames: 0, dup: 0, drop: 0, minuteDup: 0, minuteDrop: 0 }
    }
    child.stdin.on('error', () => undefined)
    child.stdout.resume()
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => this.onStderr(rec, chunk))
    child.once('error', (error) => this.deps.log(`recorder: FFmpeg could not be started – ${error.message}`))
    child.once('close', (code) => {
      if (!rec.stopping) void this.onExit(rec, code ?? -1)
    })
    this.rec = rec
    this.message = null
    this.state = 'recording'
    this.deps.log(
      `recorder: recording started (${test ? 'test picture' : source.kind}, ${encoder.id}, ${profile.width ?? '?'}x${profile.height ?? '?'}@${profile.fps}, ${settings.mode}, sound ${audioPipe ? soundLabel(settings) : 'none'}${sizeNote})`
    )
    this.registerHotkeys(settings)
    this.emit()
  }

  private onStderr(rec: Recording, chunk: string): void {
    // FFmpeg's output arrives in arbitrary pieces, often mid-line: the unfinished end waits for the
    // next piece (cut in two, a progress line lost its counters and error lines came out torn)
    const lines = (rec.stderrRest + chunk).split(/[\r\n]+/)
    rec.stderrRest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const time = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
      if (time) {
        // progress line: second 0 of the recording was that long ago (the earliest estimate is the best one)
        const seconds = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])
        const zero = this.now() - seconds * 1000
        if (!rec.zeroKnown || zero < rec.zeroWall) rec.zeroWall = zero
        rec.zeroKnown = true
        this.trackPicture(rec, line, seconds)
        continue
      }
      rec.stderr.push(line.trim().slice(0, 300))
      if (rec.stderr.length > 30) rec.stderr.shift()
    }
  }

  /**
   * FFmpeg's progress line counts frames it repeated ("dup": the game window showed no new frame in
   * time, so the game ran below the recording's frame rate) and frames it threw away ("drop": the
   * encoder fell behind). Logged per minute when noticeable, so a report of lag in a game can be
   * laid next to what the recording saw.
   */
  private trackPicture(rec: Recording, line: string, seconds: number): void {
    const count = (name: string): number => Number(new RegExp(String.raw`\b${name}=\s*(\d+)`).exec(line)?.[1] ?? 0)
    const picture = rec.picture
    // the counters only grow (FFmpeg leaves dup and drop out while they are 0)
    picture.frames = Math.max(picture.frames, count('frame'))
    picture.dup = Math.max(picture.dup, count('dup'))
    picture.drop = Math.max(picture.drop, count('drop'))
    const minute = Math.floor(seconds / 60)
    if (minute <= picture.minute) return
    const expected = (minute - picture.minute) * 60 * rec.profile.fps
    const repeated = picture.dup - picture.minuteDup
    const dropped = picture.drop - picture.minuteDrop
    if (repeated > expected * UNEVEN || dropped > 0) {
      const speed = /speed=\s*([\d.]+)x/.exec(line)?.[1]
      this.deps.log(
        `recorder: minute ${minute}: ${Math.round((100 * repeated) / expected)} % of the frames repeated (the game showed ~${Math.round(rec.profile.fps * (1 - repeated / expected))} new frames per second), ${dropped} dropped by the encoder${speed ? `, speed ${speed}x` : ''}`
      )
    }
    Object.assign(picture, { minute, minuteDup: picture.dup, minuteDrop: picture.drop })
  }

  /** FFmpeg ended although nobody stopped it. */
  private async onExit(rec: Recording, code: number): Promise<void> {
    if (this.rec !== rec) return
    rec.stopping = true
    const stillInGame = this.phase === 'InProgress' && !rec.test
    // exit code 0: the captured window is gone, which is how a game normally ends
    if (rec.stderrRest.trim()) rec.stderr.push(rec.stderrRest.trim().slice(0, 300))
    if (code !== 0) {
      // more than the last lines: the encoder's complaint comes last, the capture's cause before it
      this.deps.log(`recorder: FFmpeg stopped with code ${code}: ${rec.stderr.slice(-8).join(' | ') || 'no output'}`)
    }
    await this.finish(rec)
    if (code === 0 || !stillInGame) return
    if (++this.failures < MAX_FAILURES) {
      // not at once: what broke it off (the game window on its way to its size) needs a moment.
      // With this.rec gone, the next live poll starts a new recording
      this.deps.log(`recorder: trying again with the next live poll (failure ${this.failures} of ${MAX_FAILURES})`)
    } else {
      // the recorder stays off until the next game
      this.attempts = MAX_START_ATTEMPTS
      this.off(`Recording failed ${MAX_FAILURES} times and is off for this game. ${FULLSCREEN_HINT}`, true)
    }
  }

  /** Ends the running recording properly: FFmpeg finishes its last segment, pending clips are cut. */
  /**
   * Ends the running recording properly; resolves once it is finished (clips cut, the whole game
   * joined). Asked again while that runs, it waits for the same work: closing the app asks twice
   * (its window closes, then all windows are closed), and the second call used to let the app quit
   * in the middle of the first, so the whole-game recording was never joined (2026-11-20).
   */
  stop(reason: string): Promise<void> {
    const rec = this.rec
    if (!rec) return Promise.resolve()
    // FFmpeg ended on its own: onExit is finishing the recording already
    if (rec.stopping) return rec.stopped ?? this.settled()
    rec.stopping = true
    rec.stopped = this.doStop(rec, reason)
    return rec.stopped
  }

  private async doStop(rec: Recording, reason: string): Promise<void> {
    this.deps.log(`recorder: stopping (${reason})`)
    try {
      rec.child.stdin.write('q\n')
    } catch {
      // already gone
    }
    const timeout = new Promise<number>((resolveTimeout) => setTimeout(() => resolveTimeout(-2), 6000))
    if ((await Promise.race([rec.closed, timeout])) === -2) {
      rec.child.kill()
      await rec.closed
    }
    await this.finish(rec)
  }

  /** Resolves once a recording that just ended has made its last clips (at once when nothing is going on). */
  async settled(): Promise<void> {
    // while FFmpeg is still closing its last segment, `finishing` is not set yet: wait for the stop itself
    await (this.rec?.stopped ?? this.finishing)?.catch(() => undefined)
    await this.finishing?.catch(() => undefined)
  }

  /** After FFmpeg ended: last clips, bookmarks, the whole-game file, cleanup. */
  private finish(rec: Recording): Promise<void> {
    const work = this.doFinish(rec).finally(() => {
      if (this.finishing === work) this.finishing = null
    })
    this.finishing = work
    return work
  }

  /**
   * Whatever goes wrong while the clips are cut and the game is joined (disk full, the clips drive
   * unplugged, the database refusing to write): the recorder must come back to idle. It used to
   * stay "recording" until the app was restarted – no later game was recorded and every export
   * waited for a game that was long over.
   */
  private async doFinish(rec: Recording): Promise<void> {
    let finished = false
    try {
      await this.wrapUp(rec)
      finished = true
    } catch (error) {
      this.deps.log(`recorder: finishing the recording failed – ${String(error)}`)
    }
    if (this.rec === rec) this.rec = null
    this.state = 'idle'
    try {
      this.deps.env.helper.quit()
    } catch {
      // the helper is gone already
    }
    // after a failure the segments are all that is left of the game: leave them alone
    if (finished) await this.cleanupRun().catch((error) => this.deps.log(`recorder: cleanup failed – ${String(error)}`))
    this.emit()
  }

  private async wrapUp(rec: Recording): Promise<void> {
    this.deps.hotkeys([])
    this.deps.env.helper.stop()
    await this.readSegments(rec)
    this.saveFeed(rec)
    for (const window of rec.pending) await this.cutWindow(rec, window)
    rec.pending = []
    for (const mark of rec.bookmarks) await this.cut(rec, { start: mark - rec.replaySeconds, end: mark + 3 }, 'bookmark', 'Bookmark')
    const now = this.now()
    const kept = rec.mode === 'session' && !rec.test && rec.segments.length ? await this.joinSession(rec.dir, rec.segments, rec.startedAt) : null
    // without a single segment (FFmpeg broke off right at the start) there is nothing to keep either
    if (kept || rec.mode === 'replay' || rec.test || !rec.segments.length) {
      await this.removeRecordingDir(rec.dir)
      this.deps.store.updateRecording(rec.id, { endedAt: now, dir: kept?.file ?? '', bytes: kept?.bytes ?? 0 })
    } else {
      // joining failed: the segments stay where they are (storageItems keeps the cleanup away from them)
      this.deps.log('recorder: the whole game could not be joined into one file – its segments stay in the recording folder')
      this.deps.store.updateRecording(rec.id, { endedAt: now, bytes: [...rec.sizes.values()].reduce((sum, bytes) => sum + bytes, 0) })
    }
    // the game's summary is attached to this recording; one that broke off at the start holds nothing to attach to
    if (rec.test) this.lastRecordingId = null
    else if (rec.segments.length) {
      this.lastRecordingId = rec.id
      this.lastEndedAt = now
    }
    const { frames, dup, drop } = rec.picture
    const picture = frames ? ` (${frames} frames: ${Math.round((100 * dup) / frames)} % repeated, ${drop} dropped)` : ''
    this.deps.log(`recorder: recording ended after ${Math.round((now - rec.startedAt) / 1000)} s${picture}`)
  }

  /** The whole game as one file: joining is a plain copy. Null when it failed (the segments stay then). */
  private async joinSession(dir: string, segments: Segment[], startedAt: number): Promise<{ file: string; bytes: number } | null> {
    const ffmpeg = this.deps.env.ffmpeg.path
    if (!ffmpeg) return null
    const file = join(this.deps.env.folder(), 'sessions', `${stamp(startedAt)}.mp4`)
    await mkdir(dirname(file), { recursive: true })
    const list = join(dir, 'session.txt')
    await writeFile(list, concatList(segments.map((segment) => join(dir, segment.file))))
    const joined = await this.run(ffmpeg, ffmpegClipArgs(list, 0, null, file), { timeoutMs: 300_000, lowPriority: true })
    const bytes = (await stat(file).catch(() => null))?.size ?? 0
    if (joined.code === 0 && bytes > 0) return { file, bytes }
    this.deps.log(`recorder: joining the whole-game recording failed – ${joined.stderr.trim().slice(-200)}`)
    return null
  }

  /**
   * Once at app start, before the first recording: an earlier app run that crashed or was restarted
   * during a game never finished its recording, and its FFmpeg may still run (Windows does not end
   * it with the app), recording next to the new one until the game is over; its folder was later
   * deleted as a leftover. That FFmpeg is ended and what it recorded is kept like a finished recording.
   */
  recover(): Promise<void> {
    this.recovering ??= this.doRecover().catch((error) => this.deps.log(`recorder: cleaning up the last run failed – ${String(error)}`))
    return this.recovering
  }

  private async doRecover(): Promise<void> {
    const unfinished = this.deps.store
      .recordings()
      .filter((row) => row.endedAt === null && row.id !== this.rec?.id && !!row.dir && !row.dir.endsWith('.mp4'))
    for (const row of unfinished) {
      const pid = Number((await readFile(join(row.dir, PID_FILE), 'utf8').catch(() => '')).trim())
      if (pid > 0 && (await (this.deps.endLeftover ?? endLeftoverFfmpeg)(pid)))
        this.deps.log(`recorder: ended FFmpeg ${pid}, which the last app run left recording`)
      const segments = parseSegmentList(await readFile(join(row.dir, SEGMENT_LIST), 'utf8').catch(() => ''))
      const mode = this.deps.settings().mode
      const kept = mode === 'session' && segments.length ? await this.joinSession(row.dir, segments, row.startedAt) : null
      const endedAt = row.startedAt + Math.round((segments[segments.length - 1]?.end ?? 0) * 1000)
      let outcome: string
      if (kept || !segments.length || mode === 'replay') {
        await this.removeRecordingDir(row.dir)
        this.deps.store.updateRecording(row.id, { endedAt, dir: kept?.file ?? '', bytes: kept?.bytes ?? 0 })
        outcome = kept
          ? `kept as a whole-game recording (${Math.round((endedAt - row.startedAt) / 1000)} s)`
          : segments.length
            ? 'replay mode, deleted'
            : 'nothing in it'
      } else {
        this.deps.store.updateRecording(row.id, { endedAt })
        outcome = 'joining failed, its segments stay'
      }
      this.deps.log(`recorder: the recording from ${new Date(row.startedAt).toISOString().slice(0, 16)} was never finished – ${outcome}`)
    }
  }

  /** Only ever deletes a folder below <clips folder>/recordings. */
  private async removeRecordingDir(dir: string): Promise<void> {
    const root = resolve(this.deps.env.folder(), 'recordings') + sep
    if (!resolve(dir).startsWith(root) || resolve(dir) === resolve(root)) return
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  /** The summary of the game that was just recorded arrived: its recording and clips belong to it. */
  onSummary(gameId: number): void {
    if (this.lastRecordingId === null || !(gameId > 0) || this.now() - this.lastEndedAt > 15 * 60_000) return
    this.deps.store.attachGame(this.lastRecordingId, gameId)
    this.lastRecordingId = null
    this.emit()
  }

  /** The app is closing: finish the running recording first. */
  async shutdown(): Promise<void> {
    await this.stop('the app is closing')
    this.deps.env.helper.quit()
  }

  // --- segments ---

  private async readSegments(rec: Recording): Promise<void> {
    const csv = await readFile(join(rec.dir, SEGMENT_LIST), 'utf8').catch(() => '')
    rec.segments = parseSegmentList(csv).filter((segment) => !rec.deleted.has(segment.file))
    for (const segment of rec.segments) {
      if (!rec.sizes.has(segment.file)) rec.sizes.set(segment.file, (await stat(join(rec.dir, segment.file)).catch(() => null))?.size ?? 0)
    }
  }

  /** Replay mode: deletes what fell out of the ring, except what bookmarks and waiting clips still need. */
  private async trimRing(rec: Recording): Promise<void> {
    const protect = [
      ...rec.cutting,
      ...rec.bookmarks.map((mark) => ({ start: mark - rec.replaySeconds, end: mark + 3 })),
      ...rec.pending.flatMap((window) => this.windowRange(rec, window) ?? [])
    ]
    for (const segment of ringExpired(rec.segments, rec.replaySeconds, protect)) {
      rec.deleted.add(segment.file)
      rec.sizes.delete(segment.file)
      await unlink(join(rec.dir, segment.file)).catch(() => undefined)
    }
    rec.segments = rec.segments.filter((segment) => !rec.deleted.has(segment.file))
  }

  // --- clips ---

  /**
   * Cuts [start, end] (recording seconds) out of the segments into its own MP4. A stream copy: no
   * encoding, a fraction of a second. Returns null when nothing of the range was recorded.
   */
  private async cut(rec: Recording, range: { start: number; end: number }, kind: ClipKind, title: string): Promise<Clip | null> {
    const ffmpeg = this.deps.env.ffmpeg.path
    if (!ffmpeg) return null
    this.saving++
    rec.cutting.push(range)
    this.emit()
    try {
      const plan = segmentsFor(range, rec.segments)
      if (!plan) {
        this.deps.log(`recorder: nothing recorded for the ${kind} clip (${Math.round(range.start)}–${Math.round(range.end)} s)`)
        return null
      }
      const now = this.now()
      const name = `${stamp(now)}-${kind.replace(/[^a-z]/gi, '-')}`
      const file = join(this.deps.env.folder(), 'clips', new Date(now).toISOString().slice(0, 7), `${name}.mp4`)
      await mkdir(dirname(file), { recursive: true })
      const list = join(rec.dir, `${name}.txt`)
      await writeFile(list, concatList(plan.segments.map((segment) => join(rec.dir, segment.file))))
      const result = await this.run(ffmpeg, ffmpegClipArgs(list, plan.offset, plan.duration, file), { timeoutMs: 60_000, lowPriority: true })
      await unlink(list).catch(() => undefined)
      const bytes = (await stat(file).catch(() => null))?.size ?? 0
      if (result.code !== 0 || !bytes) {
        this.deps.log(`recorder: cutting the clip failed – ${result.stderr.trim().slice(-200) || `exit code ${result.code}`}`)
        return null
      }
      const thumb = file.replace(/\.mp4$/, '.jpg')
      const thumbed = await this.run(ffmpeg, ffmpegThumbArgs(file, (plan.end - plan.start) / 2, thumb), { timeoutMs: 30_000, lowPriority: true })
      const clip = this.deps.store.addClip({
        gameId: this.deps.store.recording(rec.id)?.gameId ?? null,
        recordingId: rec.id,
        createdAt: now,
        startMs: plan.start * 1000,
        endMs: plan.end * 1000,
        file,
        thumb: thumbed.code === 0 ? thumb : null,
        kind,
        title,
        bytes
      })
      this.usedBytes += bytes
      this.lastClip = clip
      this.deps.log(`recorder: ${kind} clip saved (${Math.round(plan.end - plan.start)} s, ${(bytes / 1e6).toFixed(1)} MB)`)
      this.deps.clipSaved(clip)
      return clip
    } finally {
      rec.cutting = rec.cutting.filter((other) => other !== range)
      this.saving--
      this.emit()
    }
  }

  /** The clip hotkey: the last `replaySeconds` up to now. */
  async clipNow(): Promise<Clip | null> {
    const rec = this.rec
    if (!rec || rec.stopping) return null
    const end = this.streamNow(rec)
    const range = { start: end - rec.replaySeconds, end }
    // protect the range right away, then wait until FFmpeg has finished the segment that holds "now"
    rec.cutting.push(range)
    try {
      for (let i = 0; i < 14 && this.rec === rec; i++) {
        await this.readSegments(rec)
        const newest = rec.segments.length ? rec.segments[rec.segments.length - 1].end : 0
        if (newest >= end) break
        await new Promise((resolveWait) => setTimeout(resolveWait, 300))
      }
      return await this.cut(rec, range, 'manual', '')
    } finally {
      rec.cutting = rec.cutting.filter((other) => other !== range)
    }
  }

  /** The bookmark hotkey: only a mark now, the clip is made after the game. */
  bookmark(): void {
    const rec = this.rec
    if (!rec || rec.stopping) return
    rec.bookmarks.push(this.streamNow(rec))
    this.deps.log(`recorder: bookmark at ${Math.round(this.streamNow(rec))} s`)
    this.emit()
  }

  /** The screenshot hotkey: the newest recorded frame as a PNG (up to one segment old). */
  async screenshot(): Promise<string | null> {
    const rec = this.rec
    const ffmpeg = this.deps.env.ffmpeg.path
    if (!rec || !ffmpeg) return null
    await this.readSegments(rec)
    const newest = rec.segments[rec.segments.length - 1]
    if (!newest) return null
    const file = join(this.deps.env.folder(), 'screenshots', `${stamp(this.now())}.png`)
    await mkdir(dirname(file), { recursive: true })
    const result = await this.run(ffmpeg, ffmpegScreenshotArgs(join(rec.dir, newest.file), file), { timeoutMs: 20_000, lowPriority: true })
    if (result.code !== 0) {
      this.deps.log(`recorder: screenshot failed – ${result.stderr.trim().slice(-200)}`)
      return null
    }
    this.deps.log(`recorder: screenshot saved (${basename(file)})`)
    return file
  }

  private registerHotkeys(settings: RecorderSettings): void {
    const conflicts = hotkeyConflicts(settings.hotkeys, this.deps.takenHotkeys())
    if (conflicts.length) {
      this.deps.log(`recorder: hotkeys not registered – ${conflicts.join('; ')}`)
      return this.deps.hotkeys([])
    }
    this.deps.hotkeys(
      [
        { accelerator: settings.hotkeys.clip, run: () => void this.clipNow() },
        { accelerator: settings.hotkeys.bookmark, run: () => this.bookmark() },
        { accelerator: settings.hotkeys.screenshot, run: () => void this.screenshot() }
      ].filter((binding) => binding.accelerator.trim())
    )
  }

  /** The settings changed: new hotkeys apply to the running recording right away. */
  settingsChanged(): void {
    if (this.rec && !this.rec.stopping) this.registerHotkeys(this.deps.settings())
    this.emit()
  }

  // --- admin tool ---

  /** Records a test picture until stopped, so a simulated game has something to cut clips from. */
  async testRecording(on: boolean): Promise<RecorderStatus> {
    if (on) {
      if (this.phase === 'InProgress') throw new Error('A real game is running.')
      await this.tryStart(true)
      if (!this.rec) throw new Error(this.message ?? 'The recording did not start.')
    } else if (this.rec?.test) await this.stop('test recording stopped')
    return this.status()
  }

  ring(): { segments: number; from: number; to: number; bytes: number; pending: string[]; bookmarks: number; offset: number | null } {
    const rec = this.rec
    return {
      segments: rec?.segments.length ?? 0,
      from: rec?.segments[0]?.start ?? 0,
      to: rec?.segments[rec.segments.length - 1]?.end ?? 0,
      bytes: rec ? [...rec.sizes.values()].reduce((sum, bytes) => sum + bytes, 0) : 0,
      pending: rec?.pending.map((window) => `${window.kind} ${Math.round(window.start)}–${Math.round(window.end)} s`) ?? [],
      bookmarks: rec?.bookmarks.length ?? 0,
      offset: rec?.offset ?? null
    }
  }

  // --- storage ---

  /** Everything in the clips folder that takes space. */
  async storageItems(): Promise<StoredItem[]> {
    const folder = this.deps.env.folder()
    const items: StoredItem[] = this.deps.store
      .storage()
      .map((clip) => ({ path: clip.file, bytes: clip.bytes, at: clip.createdAt, type: 'clip' as const, favorite: clip.favorite }))
    for (const recording of this.deps.store.recordings()) {
      if (!recording.dir || recording.id === this.rec?.id) continue
      const info = await stat(recording.dir).catch(() => null)
      if (!info) continue
      // a file is a joined whole-game recording
      if (info.isFile()) items.push({ path: recording.dir, bytes: info.size, at: recording.startedAt, type: 'session', kept: recording.kept })
      // A folder of a recording that ended is a whole game that could not be joined (disk full, too
      // slow): its segments are the only copy. It counts as a whole-game recording, kept as long as
      // those are – as a "replay leftover" the cleanup right after the game deleted it.
      else if (recording.endedAt !== null)
        items.push({ path: recording.dir, bytes: await dirSize(recording.dir), at: recording.startedAt, type: 'session', kept: recording.kept })
    }
    const known = new Set(items.map((item) => resolve(item.path)))
    for (const entry of await readdir(join(folder, 'recordings'), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const dir = join(folder, 'recordings', entry.name)
      if (known.has(resolve(dir))) continue
      const active = this.rec?.dir === dir
      const info = await stat(dir).catch(() => null)
      items.push({ path: dir, bytes: active ? 0 : await dirSize(dir), at: info?.mtimeMs ?? 0, type: 'replay', active })
    }
    // screenshots and exports count towards the space used, and like clips they are never deleted on their own
    for (const sub of ['screenshots', 'exports']) {
      const bytes = await dirSize(join(folder, sub))
      if (bytes && !known.has(resolve(join(folder, sub)))) items.push({ path: join(folder, sub), bytes, at: 0, type: 'clip' })
    }
    return items
  }

  private async scanStorage(): Promise<StoredItem[]> {
    const items = await this.storageItems()
    this.usedBytes = items.reduce((sum, item) => sum + item.bytes, 0)
    return items
  }

  /** What a cleanup would delete right now. */
  async cleanupPreview(): Promise<CleanupPlan> {
    const settings = this.deps.settings()
    return cleanupPlan(await this.scanStorage(), { maxBytes: settings.storage.maxGb * 1e9, keepSessionsDays: settings.storage.keepSessionsDays }, this.now())
  }

  /** Deletes what the plan names: leftovers of replay recordings and expired whole-game recordings. Never clips. */
  async cleanupRun(): Promise<CleanupPlan> {
    const plan = await this.cleanupPreview()
    for (const item of plan.delete) {
      if (item.type === 'replay') await this.removeRecordingDir(item.path)
      else if (item.type === 'session') {
        // a file – or the folder of a whole game that could not be joined
        await unlink(item.path).catch(() => this.removeRecordingDir(item.path))
        const row = this.deps.store.recordings().find((recording) => recording.dir === item.path)
        if (row) this.deps.store.updateRecording(row.id, { dir: '', bytes: 0 })
      }
    }
    this.usedBytes = plan.usedAfter
    if (plan.overQuota) this.deps.log('recorder: the clips alone are above the storage limit (they are never deleted automatically)')
    return plan
  }

  /** Space in use, split by what it is. */
  async storageInfo(): Promise<ClipStorageInfo> {
    const items = await this.scanStorage()
    const sum = (type: StoredItem['type']): number => items.filter((item) => item.type === type).reduce((total, item) => total + item.bytes, 0)
    const clipBytes = this.deps.store.storage().reduce((total, clip) => total + clip.bytes, 0)
    return {
      usedBytes: this.usedBytes,
      quotaBytes: this.deps.settings().storage.maxGb * 1e9,
      clipBytes,
      sessionBytes: sum('session'),
      otherBytes: Math.max(0, this.usedBytes - clipBytes - sum('session')),
      clips: this.deps.store.storage().length,
      sessions: items.filter((item) => item.type === 'session').length
    }
  }

  private preview(plan: CleanupPlan): CleanupPreview {
    return {
      items: plan.delete.map((item) => ({ name: basename(item.path), type: item.type === 'session' ? 'session' : 'replay', bytes: item.bytes, at: item.at })),
      freedBytes: plan.freedBytes,
      usedAfter: plan.usedAfter,
      overQuota: plan.overQuota
    }
  }

  async cleanupPreviewInfo(): Promise<CleanupPreview> {
    return this.preview(await this.cleanupPreview())
  }

  async cleanupNow(): Promise<CleanupPreview> {
    const plan = await this.cleanupRun()
    this.emit()
    return this.preview(plan)
  }

  // --- whole-game recordings ---

  private toSession(recording: { id: number; gameId: number | null; startedAt: number; endedAt: number | null; bytes: number; kept: boolean }): SessionRecording {
    const days = this.deps.settings().storage.keepSessionsDays
    return {
      id: recording.id,
      gameId: recording.gameId,
      startedAt: recording.startedAt,
      durationMs: Math.max(0, (recording.endedAt ?? recording.startedAt) - recording.startedAt),
      bytes: recording.bytes,
      kept: recording.kept,
      expiresAt: recording.kept ? null : recording.startedAt + days * 86_400_000,
      url: `rcclip://recording/${recording.id}`,
      game: recording.gameId === null ? null : (this.deps.store.gameOf(recording.gameId) ?? null)
    }
  }

  /** Whole-game recordings whose file still exists. */
  sessions(): SessionRecording[] {
    return this.deps.store
      .recordings()
      .filter((recording) => recording.dir.endsWith('.mp4') && recording.id !== this.rec?.id)
      .map((recording) => this.toSession(recording))
  }

  sessionOfGame(gameId: number): SessionRecording | null {
    return this.sessions().find((session) => session.gameId === gameId) ?? null
  }

  keepSession(id: number, keep: boolean): SessionRecording | null {
    this.deps.store.updateRecording(id, { kept: keep })
    return this.sessions().find((session) => session.id === id) ?? null
  }

  async deleteSession(id: number): Promise<void> {
    const recording = this.deps.store.recording(id)
    if (!recording || recording.id === this.rec?.id) return
    if (recording.dir.endsWith('.mp4')) await unlink(recording.dir).catch(() => undefined)
    // the row stays: clips cut from this recording still point to it
    this.deps.store.updateRecording(id, { dir: '', bytes: 0 })
    await this.scanStorage()
    this.emit()
  }

  /** Path of a whole-game recording's file for the player, null when it is gone. */
  sessionFile(id: number): string | null {
    const recording = this.deps.store.recording(id)
    return recording?.dir.endsWith('.mp4') ? recording.dir : null
  }

  /** Cuts [startMs, endMs] out of a whole-game recording into a clip (stream copy, cut on keyframes). */
  async clipFromSession(id: number, startMs: number, endMs: number): Promise<Clip | null> {
    const ffmpeg = this.deps.env.ffmpeg.path
    const source = this.sessionFile(id)
    const recording = this.deps.store.recording(id)
    if (!ffmpeg || !source || !recording || !(endMs > startMs)) return null
    const start = Math.max(0, Math.floor(startMs / 1000))
    const duration = Math.max(1, Math.ceil(endMs / 1000) - start)
    const now = this.now()
    const file = join(this.deps.env.folder(), 'clips', new Date(now).toISOString().slice(0, 7), `${stamp(now)}-manual.mp4`)
    await mkdir(dirname(file), { recursive: true })
    this.saving++
    this.emit()
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', source, '-t', String(duration), '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', file]
      const result = await this.run(ffmpeg, args, { timeoutMs: 120_000, lowPriority: true })
      const bytes = (await stat(file).catch(() => null))?.size ?? 0
      if (result.code !== 0 || !bytes) {
        this.deps.log(`recorder: clip from the whole-game recording failed – ${result.stderr.trim().slice(-200)}`)
        return null
      }
      const thumb = file.replace(/\.mp4$/, '.jpg')
      const thumbed = await this.run(ffmpeg, ffmpegThumbArgs(file, duration / 2, thumb), { timeoutMs: 30_000, lowPriority: true })
      const clip = this.deps.store.addClip({
        gameId: recording.gameId,
        recordingId: id,
        createdAt: now,
        startMs: start * 1000,
        endMs: (start + duration) * 1000,
        file,
        thumb: thumbed.code === 0 ? thumb : null,
        kind: 'manual',
        title: '',
        bytes
      })
      this.usedBytes += bytes
      this.lastClip = clip
      this.deps.clipSaved(clip)
      return clip
    } finally {
      this.saving--
      this.emit()
    }
  }

  /** Deletes clips for good (rows and files). */
  async deleteClips(ids: number[]): Promise<number> {
    const files = this.deps.store.delete(ids.filter((id) => Number.isInteger(id)))
    for (const file of files) await unlink(file).catch(() => undefined)
    if (this.lastClip && ids.includes(this.lastClip.id)) this.lastClip = null
    await this.scanStorage()
    this.emit()
    return files.filter((file) => file.endsWith('.mp4') || file.endsWith('.webm') || file.endsWith('.gif')).length
  }
}
