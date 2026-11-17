import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Clip, ExportJob, ExportRequest } from '@shared/types'
import {
  ffmpegExportArgs,
  ffmpegGifArgs,
  layoutText,
  normalizeProject,
  parseProgress,
  planExport,
  projectDuration,
  smallerGif,
  BUILTIN_MUSIC,
  type EditProject,
  type ExportFiles,
  type ExportOptions,
  type ExportPlan
} from '@shared/editProject'
import { ffmpegThumbArgs, pickCompatEncoder, pickEncoder, type EncoderInfo } from '@shared/recorder'
import type { ClipStore } from './clipStore'
import { run } from './ffmpeg'
import { lowerPriority } from './helper'
import { mediaTypeOf } from './protocol'
import type { RecorderEnv } from './setup'

export interface ExporterDeps {
  env: RecorderEnv
  store: ClipStore
  inGame(): boolean
  emit(job: ExportJob): void
  /** a finished export was added to the library */
  clipSaved(clip: Clip): void
  /** Anton-Regular.ttf for the texts */
  font: string
  /** reads a built-in music loop ("music/nebula-drift.m4a") out of the app's files */
  builtinMusic(file: string): Promise<Buffer>
  log(message: string): void
  now?(): number
  run?: typeof run
  /** tests: runs the export FFmpeg; resolves with the exit code, calls `onProgress` with seconds done */
  encode?(ffmpeg: string, args: string[], onProgress: (seconds: number) => void, handle: { cancel?: () => void }): Promise<{ code: number; stderr: string }>
}

const stamp = (time: number): string => new Date(time).toISOString().replace(/[:.]/g, '-').slice(0, 19)
const PNG_PREFIX = 'data:image/png;base64,'

/** Runs an FFmpeg export, reporting the seconds done from its -progress output. */
function encodeWithProgress(
  ffmpeg: string,
  args: string[],
  onProgress: (seconds: number) => void,
  handle: { cancel?: () => void }
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    lowerPriority(child.pid)
    let stderr = ''
    handle.cancel = () => child.kill()
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      const seconds = parseProgress(chunk)
      if (seconds !== null) onProgress(seconds)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)))
    child.on('error', (error) => resolve({ code: -1, stderr: error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }))
  })
}

/**
 * Exports editor projects with FFmpeg: one at a time, in the background, with the hardware
 * encoder. An export never starts during a game; one that is running when a game starts is
 * stopped and starts over when the game has ended.
 */
export class Exporter {
  private job: ExportJob | null = null
  private request: ExportRequest | null = null
  private handle: { cancel?: () => void } = {}
  private cancelled = false
  private nextId = 1
  private running: Promise<ExportJob> | null = null

  constructor(private readonly deps: ExporterDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  status(): ExportJob | null {
    return this.job
  }

  private set(patch: Partial<ExportJob>): ExportJob {
    this.job = { ...this.job!, ...patch }
    this.deps.emit(this.job)
    return this.job
  }

  /** Starts an export and returns right away; watch the 'exportProgress' events. */
  start(request: ExportRequest): ExportJob {
    if (this.job && (this.job.state === 'running' || this.job.state === 'paused')) throw new Error('Another export is still running.')
    const project = normalizeProject(request.project)
    if (!project) throw new Error('This project has nothing to export.')
    this.request = { ...request, project }
    this.cancelled = false
    this.job = {
      id: this.nextId++,
      state: this.deps.inGame() ? 'paused' : 'running',
      progress: 0,
      preset: project.output.preset,
      title: String(request.title ?? '').slice(0, 120),
      message: this.deps.inGame() ? 'Waits until your game is over.' : null,
      bytes: 0,
      clip: null
    }
    this.deps.emit(this.job)
    if (this.job.state === 'running') void this.execute()
    return this.job
  }

  /** Runs an export to its end (used for the smaller Discord version of a clip). Throws when one is already running. */
  async runToEnd(request: ExportRequest): Promise<ExportJob> {
    this.start(request)
    return (await this.running) ?? this.job!
  }

  cancel(): void {
    if (!this.job || (this.job.state !== 'running' && this.job.state !== 'paused')) return
    this.cancelled = true
    this.handle.cancel?.()
    if (this.job.state === 'paused') this.set({ state: 'cancelled', message: 'Cancelled.' })
  }

  /** A game started: a running export stops and waits. */
  onGameStart(): void {
    if (this.job?.state !== 'running') return
    this.deps.log('export: paused, a game started')
    this.set({ state: 'paused', progress: 0, message: 'Paused while you play. It starts again after the game.' })
    this.handle.cancel?.()
  }

  /** The game is over: a waiting export starts (again). */
  onGameEnd(): void {
    if (this.job?.state !== 'paused' || this.deps.inGame()) return
    this.set({ state: 'running', progress: 0, message: null })
    void this.execute()
  }

  private execute(): Promise<ExportJob> {
    this.running = this.doExport()
      .catch((error) => {
        // a pause or a cancel kills FFmpeg on purpose
        if (this.job?.state === 'paused') return this.job
        if (this.cancelled) return this.set({ state: 'cancelled', message: 'Cancelled.' })
        const message = error instanceof Error ? error.message : String(error)
        this.deps.log(`export: failed – ${message}`)
        return this.set({ state: 'error', message })
      })
      .finally(() => (this.running = null))
    return this.running
  }

  private async doExport(): Promise<ExportJob> {
    const request = this.request!
    const project = request.project
    const ffmpeg = this.deps.env.ffmpeg.path
    if (!ffmpeg) throw new Error('FFmpeg is not downloaded yet (Settings › Clips).')
    const available = this.deps.env.encoders.current?.available ?? (await this.deps.env.testEncoders())?.available ?? []
    const folder = this.deps.env.folder()
    const id = this.job!.id
    const tmp = join(folder, 'exports', '.tmp', String(id))
    await rm(tmp, { recursive: true, force: true })
    await mkdir(tmp, { recursive: true })
    try {
      const files = await this.prepare(project, tmp)
      let options: ExportOptions = project.output
      const duration = projectDuration(project)
      const runFfmpeg = this.deps.encode ?? encodeWithProgress
      const progress = (seconds: number, from = 0, share = 1): void => {
        if (this.job?.state === 'running') this.set({ progress: Math.min(0.99, from + share * Math.min(1, seconds / Math.max(0.1, duration))) })
      }
      let out = ''
      let bytes = 0
      // the size to stay below never changes; only the encoding gets tighter from try to try
      const limit = project.output.targetMb * 1024 * 1024
      // a file that must fit a size gets a second, smaller try when the first came out too large
      for (let attempt = 0; attempt < 3; attempt++) {
        const plan = planExport(project, options)
        out = join(folder, 'exports', `${stamp(this.now())}-${plan.preset}.${plan.container}`)
        await this.writeTexts(project, plan, files)
        const target: ExportFiles = { ...files, out }
        let result: { code: number; stderr: string }
        if (plan.container === 'gif') {
          const gif = ffmpegGifArgs(project, plan, target, join(tmp, 'palette.png'))
          const palette = await (this.deps.run ?? run)(ffmpeg, gif.palette, { timeoutMs: 600_000, lowPriority: true })
          if (this.stopped()) throw new Error('stopped')
          if (palette.code !== 0) throw new Error(`The GIF palette failed: ${palette.stderr.trim().slice(-300)}`)
          result = await runFfmpeg(ffmpeg, gif.encode, (seconds) => progress(seconds, 0.3, 0.7), this.handle)
        } else {
          // cancelled or paused while the files were being prepared: do not start FFmpeg at all
          if (this.stopped()) throw new Error('stopped')
          result = await runFfmpeg(ffmpeg, ffmpegExportArgs(project, plan, target, this.encoderFor(plan, available)), (seconds) => progress(seconds), this.handle)
        }
        if (this.stopped()) throw new Error('stopped')
        if (result.code !== 0) throw new Error(`FFmpeg failed: ${result.stderr.trim().slice(-300) || `exit code ${result.code}`}`)
        bytes = (await stat(out).catch(() => null))?.size ?? 0
        if (!bytes) throw new Error('The export is empty.')
        const sized = plan.preset === 'discord' || plan.preset === 'gif'
        if (!sized || bytes <= limit) break
        const smaller: ExportOptions | null = plan.preset === 'gif' ? smallerGif(options) : attempt < 2 ? { ...options, targetMb: options.targetMb * 0.85 } : null
        if (!smaller) break
        this.deps.log(`export: ${(bytes / 1048576).toFixed(1)} MB is above ${project.output.targetMb} MB, trying smaller`)
        await rm(out, { force: true })
        options = smaller
        this.set({ progress: 0 })
      }
      const thumb = out.replace(/\.[a-z0-9]+$/, '.jpg')
      const thumbed = await (this.deps.run ?? run)(ffmpeg, ffmpegThumbArgs(out, Math.min(1, duration / 2), thumb), { timeoutMs: 30_000, lowPriority: true })
      const owner = this.deps.store.clip(request.clipId)
      const clip = this.deps.store.addClip({
        gameId: owner?.gameId ?? null,
        recordingId: owner?.recordingId ?? null,
        createdAt: this.now(),
        startMs: 0,
        endMs: Math.round(duration * 1000),
        file: out,
        thumb: thumbed.code === 0 ? thumb : null,
        kind: 'export',
        title: this.job!.title || owner?.title || '',
        bytes
      })
      // the export remembers what it was made of (to edit it again, and to know whether it has music of your own)
      this.deps.store.saveEdit(clip.id, JSON.stringify(project), this.now())
      this.deps.log(`export: ${project.output.preset} done (${(bytes / 1048576).toFixed(1)} MB, ${Math.round(duration)} s)`)
      this.deps.clipSaved(clip)
      return this.set({ state: 'done', progress: 1, bytes, clip, message: null })
    } finally {
      // one export runs at a time, so the whole temporary folder can go
      await rm(dirname(tmp), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private stopped(): boolean {
    return this.cancelled || this.job?.state !== 'running'
  }

  /** H.264 for Discord (plays everywhere), AV1 for WebM when the GPU has it, otherwise the best encoder. */
  private encoderFor(plan: ExportPlan, available: readonly string[]): EncoderInfo | null {
    if (plan.preset === 'discord') return pickCompatEncoder(available)
    if (plan.container === 'webm') return pickEncoder(available.filter((id) => id.startsWith('av1_')))
    return pickEncoder(available)
  }

  /** The files a project needs: clip files, whether they have sound, pictures from the window, music, font. */
  private async prepare(project: EditProject, tmp: string): Promise<ExportFiles> {
    const ffmpeg = this.deps.env.ffmpeg.path!
    const clips: Record<number, string> = {}
    const withAudio: number[] = []
    for (const clipId of new Set(project.clips.map((part) => part.clipId))) {
      const file = this.deps.store.files(clipId)?.file
      if (!file || !(await stat(file).catch(() => null))) throw new Error(`Clip ${clipId} no longer exists.`)
      clips[clipId] = file
      // "ffmpeg -i file" lists the streams (and exits with an error because there is no output)
      const info = await (this.deps.run ?? run)(ffmpeg, ['-hide_banner', '-i', file], { timeoutMs: 15_000 })
      if (/Stream #\d+:\d+.*Audio:/.test(info.stderr)) withAudio.push(clipId)
    }
    const images: Record<string, string> = {}
    for (const [key, dataUrl] of Object.entries(this.request?.images ?? {})) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(key) || typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_PREFIX)) continue
      const file = join(tmp, `img-${key}.png`)
      await writeFile(file, Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64'))
      images[key] = file
    }
    let music: string | null = null
    if (project.music) {
      const builtin = BUILTIN_MUSIC.find((track) => track.id === project.music!.file)
      if (builtin) {
        music = join(tmp, 'music.m4a')
        await writeFile(music, await this.deps.builtinMusic(builtin.file))
      } else if (mediaTypeOf(project.music.file)?.startsWith('audio/') && (await stat(project.music.file).catch(() => null))) music = project.music.file
      else throw new Error('The music file of this project no longer exists.')
    }
    return { clips, withAudio, texts: Object.fromEntries(project.texts.map((text) => [text.id, join(tmp, `text-${text.id.replace(/[^A-Za-z0-9_-]/g, '')}.txt`)])), images, music, font: this.deps.font, out: '' }
  }

  /** Writes each text as wrapped lines, the way it is laid out at this export's picture size. */
  private async writeTexts(project: EditProject, plan: ExportPlan, files: ExportFiles): Promise<void> {
    for (const text of project.texts) await writeFile(files.texts[text.id], layoutText(text, plan).lines.join('\n'), 'utf8')
  }

  /** "Save as…": copies a finished file somewhere else. */
  static async saveAs(source: string, target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
}
