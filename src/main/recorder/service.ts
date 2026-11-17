import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
import type { ClipStore } from './clipStore'
import { run } from './ffmpeg'
import { lowerPriority } from './helper'
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
  log(message: string): void
  now?(): number
  /** tests: runs FFmpeg for clips, thumbnails and screenshots */
  run?: typeof run
  /** tests: starts the recording FFmpeg */
  spawn?: typeof spawn
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
  lastEventId: number | null
  lastGameTime: number
  /** automatic clips waiting for their lead-out (game seconds) */
  pending: ClipWindow[]
  /** bookmark marks in recording seconds */
  bookmarks: number[]
  /** ranges being cut right now (recording seconds): the ring must not delete them */
  cutting: { start: number; end: number }[]
  retried: boolean
  stopping: boolean
  closed: Promise<number>
  stderr: string[]
}

const IN_GAME_PHASES = ['InProgress', 'Reconnect', 'GameStart']
/** how often the game window is looked for before giving up on a game (once per live poll, 2 s) */
const MAX_START_ATTEMPTS = 120
export const FULLSCREEN_HINT = 'If League runs in exclusive fullscreen, switch it to Borderless or Windowed (like for the augment overlay).'

const stamp = (time: number): string => new Date(time).toISOString().replace(/[:.]/g, '-').slice(0, 19)

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
  private attempts = 0
  private lastRecordingId: number | null = null
  private lastEndedAt = 0
  private lastStatus = ''

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

  /** The League client's gameflow phase changed. */
  onPhase(phase: string): void {
    this.phase = phase
    if (IN_GAME_PHASES.includes(phase)) {
      if (phase === 'InProgress' && !this.rec) {
        this.attempts = 0
        void this.tryStart()
      }
    } else if (this.rec && !this.rec.test) void this.stop('the game is over')
  }

  /**
   * Every poll of the live data (about every 2 s during a game, also from the admin tool's
   * simulated game). Looks at new segments, new events and due automatic clips, trims the ring.
   */
  onLive(events: readonly FeedEvent[], state: LiveGameState | null): void {
    if (!this.rec) {
      if (this.phase === 'InProgress') void this.tryStart()
      return
    }
    if (this.ticking) return
    this.ticking = true
    void this.tick(events, state)
      .catch((error) => this.deps.log(`recorder: tick failed – ${String(error)}`))
      .finally(() => (this.ticking = false))
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
      }
      rec.lastGameTime = state.gameTime
      rec.offset = this.streamNow(rec) - state.gameTime
      const me = state.activePlayer ?? ''
      const found = autoClipWindows(events, {
        me,
        myTeam: state.players.find((player) => player.riotId === me)?.team ?? null,
        lastEventId: rec.lastEventId,
        enabled: this.deps.settings().autoClips
      })
      rec.lastEventId = found.lastEventId
      if (found.windows.length) rec.pending = mergeClipWindows([...rec.pending, ...found.windows])
      // a clip is made once its lead-out is over
      const due = rec.pending.filter((window) => state.gameTime >= window.end)
      rec.pending = rec.pending.filter((window) => !due.includes(window))
      for (const window of due) await this.cutWindow(rec, window)
    }
    if (rec.mode === 'replay') await this.trimRing(rec)
    this.emit()
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
      await this.start(settings, test)
    } catch (error) {
      this.off(`Recording could not start: ${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      this.starting = false
    }
  }

  private async start(settings: RecorderSettings, test: boolean, retried = false): Promise<void> {
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
    let size: { width: number; height: number } | null
    let audioPipe: string | null = null
    if (test) {
      source = { kind: 'testsrc', width: 1920, height: 1080 }
      size = { width: 1920, height: 1080 }
    } else {
      const window = env.helper.available ? await env.helper.findWindow() : null
      if (env.helper.available && (!window || window.minimized)) {
        // the game window appears a few seconds after the client reports the game: try again on the next poll
        if (++this.attempts >= MAX_START_ATTEMPTS) this.off('Game window not found – nothing is recorded.')
        return
      }
      if (window) {
        size = { width: window.width, height: window.height }
        const fullScreen = window.width >= window.monitorWidth && window.height >= window.monitorHeight
        source =
          probe.capture === 'gfxcapture'
            ? { kind: 'gfxcapture', hwnd: window.hwnd }
            : {
                kind: 'ddagrab',
                outputIdx: window.monitor,
                crop: fullScreen ? null : { x: window.x - window.monitorX, y: window.y - window.monitorY, width: window.width, height: window.height }
              }
        if (settings.audio.game || settings.audio.mic)
          audioPipe = await env.helper.start({ pid: window.pid, game: settings.audio.game, mic: settings.audio.mic, micVolume: settings.audio.micVolume })
      } else {
        // without the helper the window can still be found by its program name, but only by Windows Graphics Capture;
        // Desktop Duplication would record the whole screen, and that is never done
        if (probe.capture !== 'gfxcapture') return this.off('The sound helper is missing, so the game window cannot be found.')
        source = { kind: 'gfxcapture' }
        size = this.deps.displaySize()
      }
    }

    const now = this.now()
    const dir = join(env.folder(), 'recordings', stamp(now))
    await mkdir(dir, { recursive: true })
    const profile = resolveProfile(settings.quality, settings.fps, encoder, size)
    const args = ffmpegRecordArgs(profile, source, audioPipe, dir)
    const child = (this.deps.spawn ?? spawn)(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    lowerPriority(child.pid)
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
      lastEventId: null,
      lastGameTime: 0,
      pending: [],
      bookmarks: [],
      cutting: [],
      retried,
      stopping: false,
      closed: new Promise((resolveClosed) => child.once('close', (code) => resolveClosed(code ?? -1))),
      stderr: []
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
      `recorder: recording started (${test ? 'test picture' : source.kind}, ${encoder.id}, ${profile.width ?? '?'}x${profile.height ?? '?'}@${profile.fps}, ${settings.mode}, sound ${audioPipe ? 'game only' : 'none'})`
    )
    this.registerHotkeys(settings)
    this.emit()
  }

  private onStderr(rec: Recording, chunk: string): void {
    for (const line of chunk.split(/[\r\n]+/)) {
      if (!line.trim()) continue
      const time = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
      if (time) {
        // progress line: second 0 of the recording was that long ago (the earliest estimate is the best one)
        const zero = this.now() - (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000
        if (!rec.zeroKnown || zero < rec.zeroWall) rec.zeroWall = zero
        rec.zeroKnown = true
        continue
      }
      rec.stderr.push(line.trim().slice(0, 300))
      if (rec.stderr.length > 30) rec.stderr.shift()
    }
  }

  /** FFmpeg ended although nobody stopped it. */
  private async onExit(rec: Recording, code: number): Promise<void> {
    if (this.rec !== rec) return
    rec.stopping = true
    const stillInGame = this.phase === 'InProgress' && !rec.test
    // exit code 0: the captured window is gone, which is how a game normally ends
    if (code !== 0) {
      this.deps.log(`recorder: FFmpeg stopped with code ${code}: ${rec.stderr.slice(-4).join(' | ') || 'no output'}`)
    }
    await this.finish(rec)
    if (code === 0 || !stillInGame) return
    if (!rec.retried) {
      this.deps.log('recorder: trying once more')
      this.starting = true
      try {
        await this.start(this.deps.settings(), false, true)
      } catch (error) {
        this.off(`Recording failed: ${String(error)}`, true)
      } finally {
        this.starting = false
      }
    } else {
      // no third try: the recorder stays off until the next game
      this.attempts = MAX_START_ATTEMPTS
      this.off(`Recording failed twice and is off for this game. ${FULLSCREEN_HINT}`, true)
    }
  }

  /** Ends the running recording properly: FFmpeg finishes its last segment, pending clips are cut. */
  async stop(reason: string): Promise<void> {
    const rec = this.rec
    if (!rec || rec.stopping) return
    rec.stopping = true
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

  /** After FFmpeg ended: last clips, bookmarks, the whole-game file, cleanup. */
  private async finish(rec: Recording): Promise<void> {
    this.deps.hotkeys([])
    this.deps.env.helper.stop()
    await this.readSegments(rec)
    for (const window of rec.pending) await this.cutWindow(rec, window)
    rec.pending = []
    for (const mark of rec.bookmarks) await this.cut(rec, { start: mark - rec.replaySeconds, end: mark + 3 }, 'bookmark', 'Bookmark')
    const now = this.now()
    const folder = this.deps.env.folder()
    let kept: { file: string; bytes: number } | null = null
    if (rec.mode === 'session' && !rec.test && rec.segments.length) {
      // the whole game as one file: joining is a plain copy, and the game is over by now
      const file = join(folder, 'sessions', `${stamp(rec.startedAt)}.mp4`)
      await mkdir(dirname(file), { recursive: true })
      const list = join(rec.dir, 'session.txt')
      await writeFile(list, concatList(rec.segments.map((segment) => join(rec.dir, segment.file))))
      const joined = await this.run(this.deps.env.ffmpeg.path!, ffmpegClipArgs(list, 0, null, file), { timeoutMs: 300_000, lowPriority: true })
      const bytes = (await stat(file).catch(() => null))?.size ?? 0
      if (joined.code === 0 && bytes > 0) kept = { file, bytes }
      else this.deps.log(`recorder: joining the whole-game recording failed – ${joined.stderr.trim().slice(-200)}`)
    }
    if (kept || rec.mode === 'replay' || rec.test) {
      await this.removeRecordingDir(rec.dir)
      this.deps.store.updateRecording(rec.id, { endedAt: now, dir: kept?.file ?? '', bytes: kept?.bytes ?? 0 })
    } else {
      // joining failed: the segments stay where they are
      this.deps.store.updateRecording(rec.id, { endedAt: now, bytes: [...rec.sizes.values()].reduce((sum, bytes) => sum + bytes, 0) })
    }
    if (this.rec === rec) this.rec = null
    this.lastRecordingId = rec.test ? null : rec.id
    this.lastEndedAt = now
    this.state = 'idle'
    this.deps.env.helper.quit()
    this.deps.log(`recorder: recording ended after ${Math.round((now - rec.startedAt) / 1000)} s`)
    await this.cleanupRun().catch((error) => this.deps.log(`recorder: cleanup failed – ${String(error)}`))
    this.emit()
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
      // a file is a joined whole-game recording; a folder is what a recording left behind
      if (info.isFile()) items.push({ path: recording.dir, bytes: info.size, at: recording.startedAt, type: 'session', kept: recording.kept })
    }
    const known = new Set(items.map((item) => resolve(item.path)))
    for (const entry of await readdir(join(folder, 'recordings'), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const dir = join(folder, 'recordings', entry.name)
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
        await unlink(item.path).catch(() => undefined)
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
