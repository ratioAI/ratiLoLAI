import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Clip, LiveGameState, RecorderStatus } from '../src/shared/types'
import { DEFAULT_RECORDER, type EncoderProbe, type FeedEvent, type RecorderSettings } from '../src/shared/recorder'
import { migrate } from '../src/main/games'
import type { GameWindowSettings } from '../src/main/lcu/gameSettings'
import { ClipStore } from '../src/main/recorder/clipStore'
import { gameSize, RecorderService } from '../src/main/recorder/service'
import type { RecorderEnv } from '../src/main/recorder/setup'

/** A stand-in for the recording FFmpeg: writes nothing itself, the test puts the segments there. */
class FakeFfmpeg extends EventEmitter {
  pid = 4242
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  written = ''
  killed = false
  constructor(
    readonly args: string[],
    private readonly quitsOnQ = true
  ) {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.written += chunk.toString()
      if (this.quitsOnQ && this.written.includes('q')) setImmediate(() => this.emit('close', 0))
    })
  }
  kill(): boolean {
    this.killed = true
    setImmediate(() => this.emit('close', 1))
    return true
  }
  /** FFmpeg's progress line: this much has been recorded */
  progress(seconds: number): void {
    const text = new Date(seconds * 1000).toISOString().slice(11, 22)
    this.stderr.write(`frame= 1 fps= 60 q=20.0 size=N/A time=${text} bitrate=N/A speed=1x\r`)
  }
  get dir(): string {
    return this.args[this.args.length - 1].replace(/\/seg_%06d\.mp4$/, '')
  }
  /** segments 0..count-1 of 2 s each, as files and in segments.csv */
  segments(count: number): void {
    let csv = ''
    for (let i = 0; i < count; i++) {
      const name = `seg_${String(i).padStart(6, '0')}.mp4`
      if (!this.gone.has(name)) writeFileSync(join(this.dir, name), 'x'.repeat(1000))
      csv += `${name},${(i * 2).toFixed(6)},${(i * 2 + 2).toFixed(6)}\n`
    }
    writeFileSync(join(this.dir, 'segments.csv'), csv)
  }
  gone = new Set<string>()
}

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function setup(
  options: {
    probe?: EncoderProbe | null
    settings?: Partial<RecorderSettings>
    window?: boolean
    helper?: boolean
    /** League's video settings (null = unknown) */
    video?: GameWindowSettings | null
  } = {}
) {
  const folder = mkdtempSync(join(tmpdir(), 'rc-rec-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new ClipStore(db)
  const settings: RecorderSettings = { ...DEFAULT_RECORDER, enabled: true, ...options.settings }
  const clock = { now: 1_000_000 }
  const spawned: FakeFfmpeg[] = []
  const runs: string[][] = []
  const statuses: RecorderStatus[] = []
  const saved: Clip[] = []
  const logs: string[] = []
  let hotkeys: { accelerator: string; run(): void }[] = []
  const helperCalls: string[] = []
  /** pids of FFmpegs an earlier app run left recording, as the recorder ended them */
  const ended: number[] = []
  const probe: EncoderProbe | null =
    options.probe === undefined ? { available: ['hevc_nvenc', 'h264_nvenc'], capture: 'gfxcapture', ffmpegVersion: 'n8.1', testedAt: 1 } : options.probe
  /** the game window as the helper finds it; tests change it (League makes it 2×2 first) */
  const window = { pid: 77, hwnd: 132456, x: 0, y: 0, width: 2560, height: 1440, minimized: false, monitor: 1, monitorX: 0, monitorY: 0, monitorWidth: 2560, monitorHeight: 1440 }
  const env = {
    ffmpeg: { path: '/fake/ffmpeg' },
    encoders: { current: probe },
    testEncoders: async () => probe,
    folder: () => folder,
    helper: {
      available: options.helper !== false,
      findWindow: async () => (options.window === false ? null : { ...window }),
      start: async (startOptions: { pid: number; source: string; mic: boolean }) => {
        helperCalls.push(`start ${startOptions.source} pid=${startOptions.pid} mic=${startOptions.mic}`)
        return '\\\\.\\pipe\\ratio-audio-test'
      },
      stop: () => helperCalls.push('stop'),
      quit: () => helperCalls.push('quit')
    }
  } as unknown as RecorderEnv
  let quitsOnQ = true
  let crashNext = false
  const service = new RecorderService({
    env,
    store,
    settings: () => settings,
    takenHotkeys: () => ({ augment: 'Alt+Shift+A' }),
    emit: (status) => statuses.push(status),
    clipSaved: (clip) => saved.push(clip),
    hotkeys: (bindings) => (hotkeys = bindings),
    displaySize: () => ({ width: 1920, height: 1080 }),
    gameVideo: async () => options.video ?? null,
    log: (message) => logs.push(message),
    now: () => clock.now,
    supported: true,
    endLeftover: async (pid) => {
      ended.push(pid)
      return true
    },
    spawn: ((_file: string, args: string[]) => {
      const child = new FakeFfmpeg(args, quitsOnQ)
      spawned.push(child)
      if (crashNext) setImmediate(() => child.emit('close', 1))
      return child
    }) as never,
    // clips, thumbnails, screenshots: "FFmpeg" writes its output file
    run: async (_file, args) => {
      runs.push(args)
      writeFileSync(args[args.length - 1], 'y'.repeat(args.includes('concat') ? 5000 : 300))
      return { code: 0, stdout: '', stderr: '' }
    }
  })
  return {
    service,
    store,
    db,
    folder,
    settings,
    clock,
    spawned,
    runs,
    statuses,
    saved,
    logs,
    helperCalls,
    ended,
    window,
    hotkeys: () => hotkeys,
    crash: (on: boolean) => (crashNext = on),
    deaf: () => (quitsOnQ = false)
  }
}

const live = (gameTime: number): LiveGameState => ({
  active: true,
  started: true,
  result: null,
  gameTime,
  gameMode: 'ARAM',
  activePlayer: 'You#DEV',
  activeChampion: 'Lux',
  players: [{ riotId: 'You#DEV', championName: 'Lux', team: 'ORDER', level: 1, kills: 0, deaths: 0, assists: 0, creepScore: 0, items: [], spells: [], position: '', isDead: false, respawnTimer: 0 }],
  events: []
})

/** the game's first live answers come during the loading screen */
const loading = (): LiveGameState => ({ ...live(0), started: false })

/** The client reports InProgress and the game answers: the recording starts with that answer. */
function enterGame(service: RecorderService): void {
  service.onPhase('InProgress')
  service.onLive([], loading())
}

/** Waits until the check holds (polling), so slow file systems (Windows CI) do not break timing-based tests. */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) return false
    await tick(5)
  }
  return true
}

/** Starts a recording whose second 0 is exactly at clock.now. */
async function started(ctx: ReturnType<typeof setup>): Promise<FakeFfmpeg> {
  const before = ctx.spawned.length
  enterGame(ctx.service)
  // the start runs through findWindow, the sound helper and mkdir: on a cold CI runner that takes longer than one tick
  if (!(await waitFor(() => ctx.spawned.length > before))) {
    throw new Error(`FFmpeg was not started: ${JSON.stringify(ctx.service.status())}\n${ctx.logs.join('\n')}`)
  }
  const ffmpeg = ctx.spawned[ctx.spawned.length - 1]
  ffmpeg.progress(0)
  await tick()
  return ffmpeg
}

describe('RecorderService', () => {
  it('starts with the game: window by handle, the whole PC sound (game, Discord, music), hotkeys held while recording', async () => {
    const ctx = setup()
    expect(ctx.service.status().state).toBe('idle')
    ctx.service.onPhase('ChampSelect')
    await tick()
    expect(ctx.spawned).toHaveLength(0)
    const ffmpeg = await started(ctx)
    const args = ffmpeg.args.join(' ')
    expect(args).toContain('gfxcapture=hwnd=132456')
    // 1440p is scaled to 1080p by the compact profile
    expect(args).toContain('width=1920:height=1080')
    expect(args).toContain('-c:v hevc_nvenc')
    expect(args).toContain('\\\\.\\pipe\\ratio-audio-test')
    expect(ctx.helperCalls).toEqual(['start all pid=77 mic=false'])
    expect(ctx.hotkeys().map((binding) => binding.accelerator)).toEqual(['Alt+F9', 'Alt+F10', 'Alt+F11'])
    expect(ctx.service.status()).toMatchObject({ state: 'recording', encoder: 'NVIDIA HEVC', mode: 'replay' })
    expect(ctx.store.recordings()).toHaveLength(1)
  })

  it('starts with the game’s first live answer, not with InProgress, and never after GameEnd', async () => {
    // InProgress comes when the game process starts, its window still a few pixels small: FFmpeg failed with -22
    const ctx = setup()
    ctx.service.onPhase('InProgress')
    await tick()
    expect(ctx.spawned).toHaveLength(0)
    // the game doesn't answer yet
    ctx.service.onLive([], null)
    await tick()
    expect(ctx.spawned).toHaveLength(0)
    // the Nexus has fallen (the app was opened on the end screen): nothing to record
    ctx.service.onLive([], { ...live(900), result: 'Win' })
    await tick()
    expect(ctx.spawned).toHaveLength(0)
    ctx.service.onLive([], loading())
    expect(await waitFor(() => ctx.spawned.length === 1)).toBe(true)
  })

  it('records only the game process when the sound source is set to the game', async () => {
    const ctx = setup({ settings: { audio: { ...DEFAULT_RECORDER.audio, source: 'game', mic: true } } })
    await started(ctx)
    expect(ctx.helperCalls).toEqual(['start game pid=77 mic=true'])
    expect(ctx.logs.join('\n')).toMatch(/sound game only \+ mic/)
  })

  it('records no sound when sound and microphone are off', async () => {
    const ctx = setup({ settings: { audio: { ...DEFAULT_RECORDER.audio, game: false, mic: false } } })
    const ffmpeg = await started(ctx)
    expect(ctx.helperCalls).toEqual([])
    expect(ffmpeg.args.join(' ')).not.toContain('ratio-audio')
  })

  it('does not record when it is switched off, without a hardware encoder or without the game window', async () => {
    const off = setup({ settings: { enabled: false } })
    enterGame(off.service)
    await tick()
    expect(off.spawned).toHaveLength(0)
    expect(off.service.status().state).toBe('off')

    const noEncoder = setup({ probe: { available: [], capture: 'gfxcapture', ffmpegVersion: 'n8.1', testedAt: 1 } })
    enterGame(noEncoder.service)
    await tick()
    expect(noEncoder.spawned).toHaveLength(0)
    expect(noEncoder.service.status()).toMatchObject({ state: 'off', message: expect.stringMatching(/No hardware encoder/) })

    const noWindow = setup({ window: false })
    enterGame(noWindow.service)
    await tick()
    expect(noWindow.spawned).toHaveLength(0)
    // it keeps looking on the next live poll (the window appears a moment after the client says "in progress")
    noWindow.service.onLive([], loading())
    await tick()
    expect(noWindow.spawned).toHaveLength(0)
  })

  it('never falls back to recording the whole screen', async () => {
    const ctx = setup({ helper: false, probe: { available: ['h264_qsv'], capture: 'ddagrab', ffmpegVersion: 'n7', testedAt: 1 } })
    enterGame(ctx.service)
    await tick()
    expect(ctx.spawned).toHaveLength(0)
    expect(ctx.service.status().message).toMatch(/game window cannot be found/)
    // with Windows Graphics Capture the window is found by its program name instead
    const byName = setup({ helper: false })
    await started(byName)
    expect(byName.spawned[0].args.join(' ')).toContain("window_exe='^League of Legends\\\\.exe$'")
    expect(byName.spawned[0].args.join(' ')).not.toContain('aac')
  })

  it('waits while the game window is still 2×2, and takes the picture size from League’s video settings', async () => {
    // League creates its window at 2×2 and only then brings it to its size: captured that small, the
    // encoder failed with -22, even with the capture told to scale it up
    const ctx = setup({ settings: { quality: 'original' }, video: { mode: 'borderless', width: 1920, height: 1080, source: 'game.cfg' } })
    ctx.window.width = 2
    ctx.window.height = 2
    enterGame(ctx.service)
    await tick()
    ctx.service.onLive([], loading())
    await tick()
    expect(ctx.spawned).toHaveLength(0)
    // said once, not on every poll
    expect(ctx.logs.filter((line) => /game window is still 2x2 – trying again with the next live poll/.test(line))).toHaveLength(1)
    // on its way to its size: big enough to record, the picture already has the game's size
    ctx.window.width = 1280
    ctx.window.height = 720
    ctx.service.onLive([], loading())
    expect(await waitFor(() => ctx.spawned.length === 1)).toBe(true)
    const args = ctx.spawned[0].args.join(' ')
    expect(args).toContain('gfxcapture=hwnd=132456')
    // borderless fills the screen the window is on
    expect(args).toContain('width=2560:height=1440:resize_mode=scale_aspect')
    expect(ctx.logs.join('\n')).toMatch(/2560x1440@60.*size from League borderless = screen 2560x1440; window 1280x720, hwnd 132456/)
  })

  it('works out the game’s size: borderless = the screen, otherwise League’s resolution, the screen when nothing is known', () => {
    const screen = { width: 2560, height: 1440 }
    expect(gameSize({ mode: 'borderless', width: 1920, height: 1080, source: 'client' }, screen)).toMatchObject(screen)
    expect(gameSize({ mode: 'windowed', width: 1600, height: 900, source: 'client' }, screen)).toMatchObject({ width: 1600, height: 900 })
    expect(gameSize({ mode: 'fullscreen', width: 1920, height: 1080, source: 'game.cfg' }, screen)).toMatchObject({ width: 1920, height: 1080 })
    // borderless without a known screen: League's resolution
    expect(gameSize({ mode: 'borderless', width: 1920, height: 1080, source: 'client' }, null)).toMatchObject({ width: 1920, height: 1080 })
    expect(gameSize({ mode: 'windowed', width: 0, height: 0, source: 'client' }, screen)).toMatchObject(screen)
    expect(gameSize(null, screen)).toMatchObject(screen)
    expect(gameSize(null, null)).toBeNull()
  })

  it('waits with Desktop Duplication until the window has its size, because it cuts the window out of the screen', async () => {
    const ctx = setup({
      probe: { available: ['h264_nvenc'], capture: 'ddagrab', ffmpegVersion: 'n7', testedAt: 1 },
      video: { mode: 'borderless', width: 2560, height: 1440, source: 'client' }
    })
    ctx.window.width = 2
    ctx.window.height = 2
    enterGame(ctx.service)
    await tick()
    expect(ctx.spawned).toHaveLength(0)
    ctx.window.width = 2560
    ctx.window.height = 1440
    ctx.service.onLive([], loading())
    expect(await waitFor(() => ctx.spawned.length === 1)).toBe(true)
    const args = ctx.spawned[0].args.join(' ')
    // the whole screen the window fills, no crop
    expect(args).toContain('ddagrab=output_idx=1:framerate=60:draw_mouse=1[v]')
  })

  it('saves the last 30 seconds on the clip hotkey as a stream copy', async () => {
    const ctx = setup()
    const ffmpeg = await started(ctx)
    ffmpeg.segments(30) // 60 s recorded
    ctx.clock.now += 60_000
    ctx.hotkeys()[0].run()
    await tick(60)
    expect(ctx.saved).toHaveLength(1)
    const clip = ctx.saved[0]
    expect(clip).toMatchObject({ kind: 'manual', startMs: 30_000, endMs: 60_000, durationMs: 30_000, bytes: 5000, gameId: null })
    expect(clip.url).toBe(`rcclip://clip/${clip.id}`)
    expect(clip.thumbUrl).toMatch(/^rcclip:\/\/thumb\//)
    const cut = ctx.runs.find((args) => args.includes('concat'))!
    expect(cut.join(' ')).toContain('-c copy')
    expect(cut.join(' ')).not.toMatch(/nvenc|libx264/)
    const files = ctx.store.files(clip.id)!
    expect(files.file.startsWith(join(ctx.folder, 'clips'))).toBe(true)
    expect(existsSync(files.file)).toBe(true)
    expect(ctx.service.status().lastClip?.id).toBe(clip.id)
    expect(ctx.statuses.some((status) => status.state === 'saving')).toBe(true)
  })

  it('makes automatic clips once their lead-out is over, hanging on the live poll', async () => {
    const ctx = setup()
    const ffmpeg = await started(ctx)
    const events: FeedEvent[] = [{ EventID: 0, EventName: 'GameStart', EventTime: 0 }]
    // the game clock runs 10 s behind the recording (loading screen)
    ctx.clock.now += 40_000
    ffmpeg.segments(20)
    ctx.service.onLive(events, live(30))
    await tick()
    events.push({ EventID: 1, EventName: 'Multikill', EventTime: 50, KillerName: 'You', KillStreak: 3 })
    ctx.clock.now += 22_000
    ffmpeg.segments(31)
    ctx.service.onLive(events, live(52))
    // wait until the poll has seen the multikill (it is now waiting for its lead-out)
    expect(await waitFor(() => ctx.service.ring().pending.length === 1)).toBe(true)
    // lead-out (5 s) not over yet
    expect(ctx.saved).toHaveLength(0)
    ctx.clock.now += 4000
    ffmpeg.segments(33)
    ctx.service.onLive(events, live(56))
    await tick(60)
    // lead-out over, but the triple can still become a quadra until 60 s
    expect(ctx.saved).toHaveLength(0)
    ctx.clock.now += 4000
    ffmpeg.segments(35)
    ctx.service.onLive(events, live(60))
    // cutting runs through mkdir, the clip FFmpeg and the thumbnail: slow on a cold CI runner
    expect(await waitFor(() => ctx.saved.length > 0)).toBe(true)
    expect(ctx.saved).toHaveLength(1)
    // game 35–55 s is recording 45–65 s
    expect(ctx.saved[0]).toMatchObject({ kind: 'auto:triple', title: 'Triple kill', startMs: 45_000, endMs: 65_000 })
    // the same events again do not make another clip
    ctx.service.onLive(events, live(58))
    await tick(60)
    expect(ctx.saved).toHaveLength(1)
  })

  it('trims the ring in replay mode but keeps what a bookmark needs', async () => {
    const ctx = setup()
    const ffmpeg = await started(ctx)
    ffmpeg.segments(10)
    ctx.clock.now += 20_000
    ctx.hotkeys()[1].run() // bookmark at 20 s
    expect(ctx.service.status().bookmarks).toBe(1)
    ctx.clock.now += 180_000
    ffmpeg.segments(100) // 200 s
    ctx.service.onLive([], live(190))
    // deleting ~70 files takes a moment (longer on Windows): wait until the ring has settled
    const segmentFiles = (): string[] => readdirSync(ffmpeg.dir).filter((name) => name.startsWith('seg_')).sort()
    for (let i = 0; i < 100 && segmentFiles().includes('seg_000078.mp4'); i++) await tick(50)
    const left = segmentFiles()
    // ring: 200 - 30 - 12 = 158 s → segments from 158 s on, plus 0–23 s for the bookmark
    expect(left).toContain('seg_000000.mp4')
    expect(left).toContain('seg_000011.mp4')
    expect(left).not.toContain('seg_000012.mp4')
    expect(left).not.toContain('seg_000078.mp4')
    expect(left).toContain('seg_000079.mp4')
    expect(left).toContain('seg_000099.mp4')
    expect(ctx.service.status().ringSeconds).toBe(30)
  })

  it('stops with the game: FFmpeg gets "q", bookmarks become clips, the ring is deleted, the game is attached', async () => {
    const ctx = setup()
    const ffmpeg = await started(ctx)
    ffmpeg.segments(20)
    ctx.clock.now += 35_000
    ctx.hotkeys()[1].run()
    ctx.clock.now += 5000
    ctx.service.onPhase('WaitingForStats')
    await tick(80)
    expect(ffmpeg.written).toBe('q\n')
    expect(ffmpeg.killed).toBe(false)
    expect(ctx.saved.map((clip) => clip.kind)).toEqual(['bookmark'])
    expect(ctx.saved[0]).toMatchObject({ startMs: 5000, endMs: 38_000 })
    expect(existsSync(ffmpeg.dir)).toBe(false)
    expect(ctx.hotkeys()).toEqual([])
    expect(ctx.helperCalls).toEqual(expect.arrayContaining(['stop', 'quit']))
    expect(ctx.service.status().state).toBe('idle')
    // the summary arrives a moment later
    ctx.db.exec(
      "INSERT INTO games (game_id, created_at, duration, queue_id, mode, win, champion_id, kills, deaths, assists, summary) VALUES (555, 1, 900, 450, 'ARAM', 1, 99, 7, 2, 11, '{}')"
    )
    ctx.service.onSummary(555)
    const clip = ctx.store.list()[0]
    expect(clip.gameId).toBe(555)
    expect(clip.game).toEqual({ championId: 99, kda: [7, 2, 11], win: true, mode: 'ARAM', queueId: 450, createdAt: 1 })
    expect(ctx.store.ofGame(555)).toHaveLength(1)
  })

  it('kills an FFmpeg that does not react and still finishes', async () => {
    const ctx = setup()
    ctx.deaf()
    const ffmpeg = await started(ctx)
    const stopping = ctx.service.stop('test')
    await stopping
    expect(ffmpeg.killed).toBe(true)
    expect(ctx.service.recording).toBe(false)
  }, 12_000)

  it('keeps the whole game in session mode as one file and deletes the segments', async () => {
    const ctx = setup({ settings: { mode: 'session' } })
    const ffmpeg = await started(ctx)
    ffmpeg.segments(50)
    ctx.clock.now += 100_000
    ctx.service.onLive([], live(90))
    await tick()
    // nothing is trimmed in session mode
    expect(readdirSync(ffmpeg.dir).filter((name) => name.startsWith('seg_'))).toHaveLength(50)
    ctx.service.onPhase('EndOfGame')
    await tick(80)
    const recording = ctx.store.recordings()[0]
    expect(recording.dir).toMatch(/sessions.*\.mp4$/)
    expect(existsSync(recording.dir)).toBe(true)
    expect(recording.bytes).toBe(5000)
    expect(existsSync(ffmpeg.dir)).toBe(false)
    const items = await ctx.service.storageItems()
    expect(items).toEqual([expect.objectContaining({ type: 'session', kept: false, bytes: 5000 })])
  })

  it('logs the minutes in which the game showed noticeably fewer frames than recorded (for reports of lag)', async () => {
    const ctx = setup()
    const ffmpeg = await started(ctx)
    const progress = (seconds: number, frames: number, dup: number, drop: number): void => {
      const time = new Date(seconds * 1000).toISOString().slice(11, 22)
      ffmpeg.stderr.write(`frame=${frames} fps= 60 q=20.0 size=N/A time=${time} bitrate=N/A dup=${dup} drop=${drop} speed=0.98x\r`)
    }
    progress(59, 3540, 280, 0)
    progress(61, 3660, 290, 0) // minute 1: 8 % repeated, what a smooth game looks like too – nothing to say
    // FFmpeg's output comes in pieces that cut lines in two: the counters must not get lost
    ffmpeg.stderr.write('frame=7260 fps= 60 q=20.0 size=N/A time=00:02:01.00 bitra')
    await tick()
    ffmpeg.stderr.write('te=N/A dup=1490 drop=3 speed=0.98x\r') // minute 2: a third repeated, the game showed ~40 fps
    await tick()
    const lines = ctx.logs.filter((line) => line.includes('frames repeated'))
    expect(lines).toEqual(['recorder: minute 2: 33 % of the frames repeated (the game showed ~40 new frames per second), 3 dropped by the encoder, speed 0.98x'])
    ctx.service.onPhase('EndOfGame')
    expect(await waitFor(() => ctx.logs.some((line) => line.includes('recording ended')))).toBe(true)
    expect(ctx.logs.join('\n')).toMatch(/recording ended after \d+ s \(7260 frames: 21 % repeated, 3 dropped\)/)
  })

  it('finishes the whole-game recording before the app may quit, even when quitting asks twice', async () => {
    // closing the window quits, then "all windows closed" quits again: the second call used to return at
    // once, the app went while the first was still at work, and the whole game was never joined
    const ctx = setup({ settings: { mode: 'session' } })
    const ffmpeg = await started(ctx)
    ffmpeg.segments(70)
    const first = ctx.service.shutdown()
    const second = ctx.service.shutdown()
    await second
    expect(ctx.store.recordings()[0].dir).toMatch(/sessions.*\.mp4$/)
    expect(ctx.service.recording).toBe(false)
    await first
    expect(ctx.logs.filter((line) => line.includes('stopping (the app is closing)'))).toHaveLength(1)
  })

  it('tries again with the next live polls when FFmpeg breaks off, then stays off with a note in the log', async () => {
    const ctx = setup({ settings: { mode: 'session' } })
    ctx.crash(true)
    enterGame(ctx.service)
    expect(await waitFor(() => ctx.logs.some((line) => /trying again with the next live poll \(failure 1 of 3\)/.test(line)))).toBe(true)
    // not at once (in a game on 2026-11-20 the second start, 20 ms later, failed the same way): the next poll starts again
    expect(ctx.spawned).toHaveLength(1)
    expect(ctx.service.recording).toBe(false)
    expect(ctx.logs.join('\n')).toMatch(/FFmpeg stopped with code 1/)
    ctx.service.onLive([], loading())
    expect(await waitFor(() => ctx.logs.some((line) => /failure 2 of 3/.test(line)))).toBe(true)
    ctx.service.onLive([], live(5))
    expect(await waitFor(() => ctx.service.status().state === 'error')).toBe(true)
    expect(ctx.spawned).toHaveLength(3)
    expect(ctx.service.status()).toMatchObject({ state: 'error', message: expect.stringMatching(/failed 3 times.*Borderless/) })
    // no fourth try in this game
    ctx.service.onLive([], live(10))
    await tick()
    expect(ctx.spawned).toHaveLength(3)
    // recordings that never got going leave nothing behind
    expect(readdirSync(join(ctx.folder, 'recordings'))).toEqual([])
    // the next game starts fresh
    ctx.crash(false)
    ctx.service.onPhase('EndOfGame')
    enterGame(ctx.service)
    expect(await waitFor(() => ctx.service.recording)).toBe(true)
    expect(ctx.spawned).toHaveLength(4)
  })

  it('ends an FFmpeg the last app run left recording and keeps what it recorded as the whole game', async () => {
    // the app crashed or was restarted during a game: its FFmpeg records on, and its folder used to be deleted as a leftover
    const ctx = setup({ settings: { mode: 'session' } })
    const dir = join(ctx.folder, 'recordings', '2026-11-20T13-48-02')
    mkdirSync(dir, { recursive: true })
    let csv = ''
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(dir, `seg_00000${i}.mp4`), 'x'.repeat(1000))
      csv += `seg_00000${i}.mp4,${i * 2}.000000,${i * 2 + 2}.000000\n`
    }
    writeFileSync(join(dir, 'segments.csv'), csv)
    writeFileSync(join(dir, 'ffmpeg.pid'), '5150')
    const left = ctx.store.addRecording(500_000, dir)
    // one whose folder is gone already
    const gone = ctx.store.addRecording(600_000, join(ctx.folder, 'recordings', 'gone'))
    await ctx.service.recover()
    expect(ctx.ended).toEqual([5150])
    const rows = ctx.store.recordings()
    expect(rows.find((row) => row.id === left)).toMatchObject({ endedAt: 506_000, dir: expect.stringMatching(/sessions.*\.mp4$/), bytes: 5000 })
    expect(rows.find((row) => row.id === gone)).toMatchObject({ endedAt: 600_000, dir: '' })
    expect(existsSync(dir)).toBe(false)
    expect(ctx.service.sessions()).toHaveLength(1)
    expect(ctx.logs.join('\n')).toMatch(/ended FFmpeg 5150.*last app run/)
    expect(ctx.logs.join('\n')).toMatch(/never finished – kept as a whole-game recording \(6 s\)/)
  })

  it('notes FFmpeg’s pid next to the segments and leaves a running recording alone when cleaning up', async () => {
    const ctx = setup()
    const ffmpeg = await started(ctx)
    expect(readFileSync(join(ffmpeg.dir, 'ffmpeg.pid'), 'utf8')).toBe('4242')
    await ctx.service.recover()
    expect(ctx.ended).toEqual([])
    expect(ctx.service.recording).toBe(true)
    expect(ctx.store.recordings()[0].endedAt).toBeNull()
  })

  it('does not register hotkeys that collide with the augment hotkey', async () => {
    const ctx = setup({ settings: { hotkeys: { clip: 'Alt+Shift+A', bookmark: 'Alt+F10', screenshot: 'Alt+F11' } } })
    await started(ctx)
    expect(ctx.hotkeys()).toEqual([])
    expect(ctx.logs.join('\n')).toMatch(/hotkeys not registered/)
  })

  it('deletes clips with their files and counts the space used', async () => {
    const ctx = setup()
    const ffmpeg = await started(ctx)
    ffmpeg.segments(30)
    ctx.clock.now += 60_000
    const clip = (await ctx.service.clipNow())!
    const { file, thumb } = ctx.store.files(clip.id)!
    expect(ctx.service.status().bytes).toBeGreaterThanOrEqual(5000)
    expect(await ctx.service.deleteClips([clip.id])).toBe(1)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(thumb!)).toBe(false)
    expect(ctx.store.list()).toEqual([])
  })
})
