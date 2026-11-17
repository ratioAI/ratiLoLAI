import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Clip, LiveGameState, RecorderStatus } from '../src/shared/types'
import { DEFAULT_RECORDER, type EncoderProbe, type FeedEvent, type RecorderSettings } from '../src/shared/recorder'
import { migrate } from '../src/main/games'
import { ClipStore } from '../src/main/recorder/clipStore'
import { RecorderService } from '../src/main/recorder/service'
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

function setup(options: { probe?: EncoderProbe | null; settings?: Partial<RecorderSettings>; window?: boolean; helper?: boolean } = {}) {
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
  const probe: EncoderProbe | null =
    options.probe === undefined ? { available: ['hevc_nvenc', 'h264_nvenc'], capture: 'gfxcapture', ffmpegVersion: 'n8.1', testedAt: 1 } : options.probe
  const env = {
    ffmpeg: { path: '/fake/ffmpeg' },
    encoders: { current: probe },
    testEncoders: async () => probe,
    folder: () => folder,
    helper: {
      available: options.helper !== false,
      findWindow: async () =>
        options.window === false
          ? null
          : { pid: 77, hwnd: 132456, x: 0, y: 0, width: 2560, height: 1440, minimized: false, monitor: 1, monitorX: 0, monitorY: 0, monitorWidth: 2560, monitorHeight: 1440 },
      start: async (startOptions: { pid: number; mic: boolean }) => {
        helperCalls.push(`start pid=${startOptions.pid} mic=${startOptions.mic}`)
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
    log: (message) => logs.push(message),
    now: () => clock.now,
    supported: true,
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
    hotkeys: () => hotkeys,
    crash: (on: boolean) => (crashNext = on),
    deaf: () => (quitsOnQ = false)
  }
}

const live = (gameTime: number): LiveGameState => ({
  active: true,
  gameTime,
  gameMode: 'ARAM',
  activePlayer: 'You#DEV',
  activeChampion: 'Lux',
  players: [{ riotId: 'You#DEV', championName: 'Lux', team: 'ORDER', level: 1, kills: 0, deaths: 0, assists: 0, creepScore: 0, items: [], spells: [], position: '', isDead: false, respawnTimer: 0 }],
  events: []
})

/** Starts a recording whose second 0 is exactly at clock.now. */
async function started(ctx: ReturnType<typeof setup>): Promise<FakeFfmpeg> {
  ctx.service.onPhase('InProgress')
  await tick()
  const ffmpeg = ctx.spawned[ctx.spawned.length - 1]
  ffmpeg.progress(0)
  await tick()
  return ffmpeg
}

describe('RecorderService', () => {
  it('starts with the game: window by handle, sound of the game process only, hotkeys held while recording', async () => {
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
    expect(ctx.helperCalls).toEqual(['start pid=77 mic=false'])
    expect(ctx.hotkeys().map((binding) => binding.accelerator)).toEqual(['Alt+F9', 'Alt+F10', 'Alt+F11'])
    expect(ctx.service.status()).toMatchObject({ state: 'recording', encoder: 'NVIDIA HEVC', mode: 'replay' })
    expect(ctx.store.recordings()).toHaveLength(1)
  })

  it('does not record when it is switched off, without a hardware encoder or without the game window', async () => {
    const off = setup({ settings: { enabled: false } })
    off.service.onPhase('InProgress')
    await tick()
    expect(off.spawned).toHaveLength(0)
    expect(off.service.status().state).toBe('off')

    const noEncoder = setup({ probe: { available: [], capture: 'gfxcapture', ffmpegVersion: 'n8.1', testedAt: 1 } })
    noEncoder.service.onPhase('InProgress')
    await tick()
    expect(noEncoder.spawned).toHaveLength(0)
    expect(noEncoder.service.status()).toMatchObject({ state: 'off', message: expect.stringMatching(/No hardware encoder/) })

    const noWindow = setup({ window: false })
    noWindow.service.onPhase('InProgress')
    await tick()
    expect(noWindow.spawned).toHaveLength(0)
    // it keeps looking on the next live poll (the window appears a moment after the client says "in progress")
    noWindow.service.onLive([], null)
    await tick()
    expect(noWindow.spawned).toHaveLength(0)
  })

  it('never falls back to recording the whole screen', async () => {
    const ctx = setup({ helper: false, probe: { available: ['h264_qsv'], capture: 'ddagrab', ffmpegVersion: 'n7', testedAt: 1 } })
    ctx.service.onPhase('InProgress')
    await tick()
    expect(ctx.spawned).toHaveLength(0)
    expect(ctx.service.status().message).toMatch(/game window cannot be found/)
    // with Windows Graphics Capture the window is found by its program name instead
    const byName = setup({ helper: false })
    await started(byName)
    expect(byName.spawned[0].args.join(' ')).toContain("window_exe='^League of Legends\\\\.exe$'")
    expect(byName.spawned[0].args.join(' ')).not.toContain('aac')
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
    await tick()
    // lead-out (5 s) not over yet
    expect(ctx.saved).toHaveLength(0)
    ctx.clock.now += 4000
    ffmpeg.segments(33)
    ctx.service.onLive(events, live(56))
    await tick(60)
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
    await tick(60)
    const left = readdirSync(ffmpeg.dir).filter((name) => name.startsWith('seg_')).sort()
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

  it('tries once more when the encoder breaks off, then stays off with a note in the log', async () => {
    const ctx = setup()
    ctx.crash(true)
    ctx.service.onPhase('InProgress')
    await tick(80)
    expect(ctx.spawned).toHaveLength(2)
    expect(ctx.service.recording).toBe(false)
    expect(ctx.service.status()).toMatchObject({ state: 'error', message: expect.stringMatching(/failed twice.*Borderless/) })
    expect(ctx.logs.join('\n')).toMatch(/FFmpeg stopped with code 1/)
    expect(ctx.logs.join('\n')).toMatch(/trying once more/)
    // no third try in this game
    ctx.service.onLive([], live(10))
    await tick()
    expect(ctx.spawned).toHaveLength(2)
    // the next game starts fresh
    ctx.crash(false)
    ctx.service.onPhase('EndOfGame')
    ctx.service.onPhase('InProgress')
    await tick()
    expect(ctx.spawned).toHaveLength(3)
    expect(ctx.service.recording).toBe(true)
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
