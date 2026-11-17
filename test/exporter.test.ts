import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Clip, ExportJob } from '../src/shared/types'
import { newProject, type EditProject } from '../src/shared/editProject'
import { migrate } from '../src/main/games'
import { ClipStore } from '../src/main/recorder/clipStore'
import { Exporter } from '../src/main/recorder/exporter'
import type { RecorderEnv } from '../src/main/recorder/setup'

const PNG = `data:image/png;base64,${Buffer.from('png').toString('base64')}`

function setup(options: { sizes?: number[]; available?: string[] } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'rc-exp-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  const store = new ClipStore(db)
  const source = join(folder, 'source.mp4')
  writeFileSync(source, 'video')
  const clip = store.addClip({ gameId: null, recordingId: null, createdAt: 1, startMs: 0, endMs: 30_000, file: source, thumb: null, kind: 'manual', title: 'my clip', bytes: 5 })
  const jobs: ExportJob[] = []
  const saved: Clip[] = []
  const encodes: string[][] = []
  const runs: string[][] = []
  const texts: Record<string, string> = {}
  const state = { inGame: false, hold: null as null | (() => void) }
  const sizes = [...(options.sizes ?? [1000])]
  const exporter = new Exporter({
    env: {
      ffmpeg: { path: '/fake/ffmpeg' },
      encoders: { current: { available: options.available ?? ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc'], capture: 'gfxcapture', ffmpegVersion: 'n8.1', testedAt: 1 } },
      testEncoders: async () => null,
      folder: () => folder
    } as unknown as RecorderEnv,
    store,
    inGame: () => state.inGame,
    emit: (job) => jobs.push(job),
    clipSaved: (saveClip) => saved.push(saveClip),
    font: '/app/resources/fonts/Anton-Regular.ttf',
    builtinMusic: async () => Buffer.from('music'),
    log: () => undefined,
    now: () => 1_800_000_000_000,
    run: async (_file, args) => {
      runs.push(args)
      // "ffmpeg -i file": the stream list on stderr
      if (args.length === 3 && args[1] === '-i') return { code: 1, stdout: '', stderr: 'Stream #0:0: Video: hevc\n  Stream #0:1(und): Audio: aac' }
      writeFileSync(args[args.length - 1], 'thumb-or-palette')
      return { code: 0, stdout: '', stderr: '' }
    },
    encode: async (_ffmpeg, args, onProgress, handle) => {
      encodes.push(args)
      // remember what the text files held while FFmpeg ran (they are deleted afterwards)
      for (const match of args.join(' ').matchAll(/textfile='([^']+)'/g)) {
        const file = match[1].replace(/\\:/g, ':')
        if (existsSync(file)) texts[file.split('/').pop()!] = readFileSync(file, 'utf8')
      }
      onProgress(15)
      let killed = false
      handle.cancel = () => {
        killed = true
        state.hold?.()
      }
      if (state.hold === null && encodes.length === 1 && state.inGame === false && (options as { wait?: boolean }).wait) {
        await new Promise<void>((resolve) => (state.hold = resolve))
      }
      if (killed) return { code: 1, stderr: 'killed' }
      writeFileSync(args[args.length - 1], Buffer.alloc(sizes.length > 1 ? sizes.shift()! : sizes[0]))
      return { code: 0, stderr: '' }
    }
  })
  return { exporter, store, folder, clip, jobs, saved, encodes, runs, texts, state }
}

const project = (clipId: number, patch: Partial<EditProject> = {}): EditProject => ({ ...newProject(clipId, 30), ...patch })
const finished = async (ctx: ReturnType<typeof setup>): Promise<ExportJob> => {
  for (let i = 0; i < 200; i++) {
    const job = ctx.exporter.status()
    if (job && job.state !== 'running') return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('export did not finish')
}

describe('Exporter', () => {
  it('exports a project, reports progress and adds the result to the library', async () => {
    const ctx = setup()
    const edit = project(ctx.clip.id, {
      texts: [{ id: 'a', kind: 'top', text: 'pentakill', x: 0.5, y: 0.5, size: 0.1, color: '#fff', start: 0, end: null, fade: 0 }],
      stickers: [{ id: 's1', src: 'emoji:1f451', x: 0.5, y: 0.5, scale: 0.1, start: 0, end: null }],
      music: { file: 'builtin:nebula-drift', name: 'Nebula Drift', offset: 0, volume: 0.5, duck: true, fadeIn: 0, fadeOut: 0 }
    })
    ctx.exporter.start({ clipId: ctx.clip.id, project: edit, title: 'Montage', images: { s1: PNG, '../evil': PNG, stats: 'data:text/html,nope' } })
    const job = await finished(ctx)
    expect(job).toMatchObject({ state: 'done', progress: 1, bytes: 1000, preset: 'discord' })
    expect(ctx.jobs.some((entry) => entry.state === 'running' && entry.progress === 0.5)).toBe(true)
    const args = ctx.encodes[0].join(' ')
    // Discord: H.264 so it plays everywhere, with the sound of the clip, the sticker and the built-in loop
    expect(args).toContain('-c:v h264_nvenc')
    expect(args).toContain('[0:a]atrim')
    expect(args).toContain('img-s1.png')
    expect(args).toContain('music.m4a')
    expect(args).not.toContain('evil')
    expect(Object.values(ctx.texts)).toEqual(['PENTAKILL'])
    expect(job.clip).toMatchObject({ kind: 'export', title: 'Montage', durationMs: 30_000, bytes: 1000 })
    expect(ctx.saved).toHaveLength(1)
    expect(ctx.store.list().map((clip) => clip.kind)).toEqual(['export', 'manual'])
    // the temporary files are gone (right after the job reports "done"), the export is in the exports folder
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(readdirSync(join(ctx.folder, 'exports')).filter((name) => !name.endsWith('.jpg'))).toEqual(['2027-01-15T08-00-00-discord.mp4'])
  })

  it('tries again with fewer bits when a Discord export comes out above the limit', async () => {
    const ctx = setup({ sizes: [25 * 1024 * 1024, 19 * 1024 * 1024] })
    ctx.exporter.start({ clipId: ctx.clip.id, project: project(ctx.clip.id), title: '', images: {} })
    const job = await finished(ctx)
    expect(job.state).toBe('done')
    expect(ctx.encodes).toHaveLength(2)
    const rate = (args: string[]): number => Number(args[args.indexOf('-b:v') + 1].replace('k', ''))
    expect(rate(ctx.encodes[1])).toBeLessThan(rate(ctx.encodes[0]))
    expect(job.bytes).toBe(19 * 1024 * 1024)
  })

  it('makes GIFs in two passes and narrower when they are too large', async () => {
    const ctx = setup({ sizes: [30 * 1024 * 1024, 9 * 1024 * 1024] })
    const edit = project(ctx.clip.id)
    edit.output = { preset: 'gif', targetMb: 10, gifFps: 15, gifWidth: 640 }
    ctx.exporter.start({ clipId: ctx.clip.id, project: edit, title: '', images: {} })
    const job = await finished(ctx)
    expect(job.state).toBe('done')
    expect(ctx.runs.filter((args) => args.join(' ').includes('palettegen'))).toHaveLength(2)
    expect(ctx.encodes[0].join(' ')).toContain('scale=640:360')
    expect(ctx.encodes[1].join(' ')).toContain('scale=480:270')
    expect(job.clip?.url).toBeTruthy()
  })

  it('never starts during a game and starts when the game is over', async () => {
    const ctx = setup()
    ctx.state.inGame = true
    const job = ctx.exporter.start({ clipId: ctx.clip.id, project: project(ctx.clip.id), title: '', images: {} })
    expect(job).toMatchObject({ state: 'paused', message: expect.stringMatching(/game is over/) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ctx.encodes).toHaveLength(0)
    ctx.exporter.onGameEnd() // still in the game: nothing happens
    expect(ctx.exporter.status()?.state).toBe('paused')
    ctx.state.inGame = false
    ctx.exporter.onGameEnd()
    expect((await finished(ctx)).state).toBe('done')
    expect(ctx.encodes).toHaveLength(1)
  })

  it('pauses a running export when a game starts and runs it again afterwards', async () => {
    const ctx = setup({ wait: true } as never)
    ctx.exporter.start({ clipId: ctx.clip.id, project: project(ctx.clip.id), title: '', images: {} })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ctx.exporter.status()?.state).toBe('running')
    ctx.state.inGame = true
    ctx.exporter.onGameStart()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ctx.exporter.status()).toMatchObject({ state: 'paused', progress: 0 })
    expect(ctx.store.list()).toHaveLength(1)
    ctx.state.inGame = false
    ctx.exporter.onGameEnd()
    expect((await finished(ctx)).state).toBe('done')
    expect(ctx.encodes).toHaveLength(2)
  })

  it('can be cancelled, refuses a second export and reports failures', async () => {
    const ctx = setup({ wait: true } as never)
    ctx.exporter.start({ clipId: ctx.clip.id, project: project(ctx.clip.id), title: '', images: {} })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(() => ctx.exporter.start({ clipId: ctx.clip.id, project: project(ctx.clip.id), title: '', images: {} })).toThrow(/still running/)
    ctx.exporter.cancel()
    expect((await finished(ctx)).state).toBe('cancelled')
    expect(ctx.store.list()).toHaveLength(1)
    // a project whose clip was deleted
    const gone = setup()
    gone.exporter.start({ clipId: 99, project: project(99), title: '', images: {} })
    expect(await finished(gone)).toMatchObject({ state: 'error', message: expect.stringMatching(/no longer exists/) })
    expect(() => gone.exporter.start({ clipId: 1, project: { clips: [] } as never, title: '', images: {} })).toThrow(/nothing to export/)
  })
})
