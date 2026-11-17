import { release } from 'node:os'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FfmpegState, RecorderSetup } from '@shared/types'
import {
  ffmpegRecordArgs,
  pickEncoder,
  resolveProfile,
  type CaptureSource,
  type EncoderProbe,
  type RecorderSettings
} from '@shared/recorder'
import { EncoderCache } from './encoders'
import { FfmpegProvider, run } from './ffmpeg'
import { AudioHelper } from './helper'

export interface RecorderEnvDeps {
  userData: string
  /** path of ratio-audio.exe (resources/bin) */
  helperExe: string
  /** the system's Videos folder, where clips go unless another folder is set */
  videosDir: string
  settings(): RecorderSettings
  onFfmpeg(state: FfmpegState): void
  inGame(): boolean
  log(message: string): void
  /** development only: a ready FFmpeg instead of the download */
  ffmpegOverride?: string | null
}

/** Process loopback (the game's sound only) and the yellow-border-free window capture need Windows 10 2004. */
export function windowsSupported(platform = process.platform, osRelease = release()): boolean {
  if (platform !== 'win32') return false
  const build = Number(osRelease.split('.')[2])
  return Number.isFinite(build) && build >= 19041
}

/**
 * What the recorder runs on: the downloaded FFmpeg, the tested hardware encoders, the sound helper
 * and the storage folder. Nothing here records a game; see RecorderService for that.
 */
export class RecorderEnv {
  readonly ffmpeg: FfmpegProvider
  readonly encoders: EncoderCache
  readonly helper: AudioHelper

  constructor(private readonly deps: RecorderEnvDeps) {
    this.ffmpeg = new FfmpegProvider({
      dir: join(deps.userData, 'ffmpeg'),
      onState: deps.onFfmpeg,
      log: deps.log,
      override: deps.ffmpegOverride
    })
    this.encoders = new EncoderCache(join(deps.userData, 'recorder', 'encoders.json'), deps.log)
    this.helper = new AudioHelper(deps.helperExe, deps.log)
  }

  /** Clips, screenshots and recordings live here. */
  folder(): string {
    return this.deps.settings().storage.folder.trim() || join(this.deps.videosDir, 'ratioAI')
  }

  /** Looks for an installed FFmpeg and the cached encoder test. Cheap, called once at start. */
  async init(): Promise<void> {
    await this.ffmpeg.check()
    await this.encoders.load()
  }

  setup(): RecorderSetup {
    return {
      ffmpeg: this.ffmpeg.getState(),
      encoders: this.encoders.current,
      audioHelper: this.helper.available,
      folder: this.folder(),
      supported: windowsSupported()
    }
  }

  /** Downloads FFmpeg (when missing) and tests the encoders once it is there. */
  async install(force = false): Promise<FfmpegState> {
    if (force) {
      await this.ffmpeg.remove()
      this.encoders.clear()
    }
    const state = await this.ffmpeg.install(force)
    if (state.status === 'ready') await this.testEncoders(force)
    return state
  }

  /** The encoder test; null without FFmpeg. Never runs during a game (the cached result is returned). */
  async testEncoders(force = false): Promise<EncoderProbe | null> {
    const ffmpeg = this.ffmpeg.path
    if (!ffmpeg) return null
    if (this.deps.inGame()) return this.encoders.current
    return this.encoders.detect(ffmpeg, force)
  }

  /**
   * Admin tool: 20 seconds of a test picture (or of the main screen) through the same FFmpeg
   * arguments a game recording uses, to check encoder, segments and sound without a game.
   */
  async testCapture(kind: 'testsrc' | 'screen', seconds = 20): Promise<{ ok: boolean; dir: string; segments: number; bytes: number; log: string[] }> {
    const ffmpeg = this.ffmpeg.path
    if (!ffmpeg) throw new Error('FFmpeg is not installed yet.')
    if (this.deps.inGame()) throw new Error('Not during a game.')
    const probe = await this.testEncoders()
    const settings = this.deps.settings()
    const encoder = pickEncoder(probe?.available ?? [], settings.encoder)
    if (!encoder) throw new Error('No hardware encoder (NVENC, AMF, Quick Sync) works on this machine.')
    const source: CaptureSource =
      kind === 'testsrc'
        ? { kind: 'testsrc', width: 1920, height: 1080 }
        : probe?.capture === 'ddagrab'
          ? { kind: 'ddagrab', outputIdx: 0, crop: null }
          : { kind: 'gfxcapture', monitorIdx: 0 }
    const dir = join(this.folder(), '_test', new Date().toISOString().replace(/[:.]/g, '-'))
    await mkdir(dir, { recursive: true })
    const profile = resolveProfile(settings.quality, settings.fps, encoder, kind === 'testsrc' ? { width: 1920, height: 1080 } : null)
    const args = ffmpegRecordArgs(profile, source, null, dir, seconds)
    this.deps.log(`recorder: test capture (${kind}, ${encoder.id}) → ${dir}`)
    const result = await run(ffmpeg, args, { timeoutMs: (seconds + 25) * 1000 })
    const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.mp4'))
    let bytes = 0
    for (const name of files) bytes += (await stat(join(dir, name)).catch(() => null))?.size ?? 0
    const log = [`ffmpeg ${args.join(' ')}`, ...result.stderr.split(/\r?\n/).filter(Boolean).slice(-25)]
    return { ok: result.code === 0 && files.length > 0, dir, segments: files.length, bytes, log }
  }
}
