import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ENCODERS, encoderProbeArgs, type EncoderProbe } from '@shared/recorder'
import { run } from './ffmpeg'

type Runner = typeof run

/** "ffmpeg version n8.1-..." → "n8.1-..." */
export function parseFfmpegVersion(output: string): string | null {
  return /ffmpeg version (\S+)/.exec(output)?.[1] ?? null
}

/** Which capture filter this FFmpeg has: Windows Graphics Capture first, Desktop Duplication as the fallback. */
export function parseCaptureFilter(filters: string): EncoderProbe['capture'] {
  const has = (name: string): boolean => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(filters)
  return has('gfxcapture') ? 'gfxcapture' : has('ddagrab') ? 'ddagrab' : null
}

/**
 * Tests every hardware encoder with a ten-frame encode of a test picture and looks up the capture
 * filter. Takes a few seconds and uses the GPU, so it runs once (the result is cached per FFmpeg
 * version) and never during a game.
 */
export async function probeEncoders(ffmpeg: string, runner: Runner = run, now = Date.now()): Promise<EncoderProbe> {
  const version = parseFfmpegVersion((await runner(ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 8000 })).stdout)
  const filters = await runner(ffmpeg, ['-hide_banner', '-filters'], { timeoutMs: 8000 })
  const available: string[] = []
  for (const encoder of ENCODERS) {
    const result = await runner(ffmpeg, encoderProbeArgs(encoder.id), { timeoutMs: 12_000 })
    if (result.code === 0) available.push(encoder.id)
  }
  return { available, capture: parseCaptureFilter(filters.stdout), ffmpegVersion: version, testedAt: now }
}

/** The cached result of the encoder test (userData/recorder/encoders.json). */
export class EncoderCache {
  private probe: EncoderProbe | null = null
  private running: Promise<EncoderProbe | null> | null = null

  constructor(
    private readonly file: string,
    private readonly log: (message: string) => void,
    private readonly runner: Runner = run
  ) {}

  get current(): EncoderProbe | null {
    return this.probe
  }

  async load(): Promise<EncoderProbe | null> {
    this.probe = await readFile(this.file, 'utf8')
      .then((raw) => JSON.parse(raw) as EncoderProbe)
      .then((probe) => (Array.isArray(probe.available) ? probe : null))
      .catch(() => null)
    return this.probe
  }

  /** The cached result, or a fresh test when there is none (or `force`). */
  detect(ffmpeg: string, force = false): Promise<EncoderProbe | null> {
    if (this.probe && !force) return Promise.resolve(this.probe)
    this.running ??= probeEncoders(ffmpeg, this.runner)
      .then(async (probe) => {
        this.probe = probe
        this.log(`recorder: encoders ${probe.available.join(', ') || 'none'}; capture ${probe.capture ?? 'none'}; ffmpeg ${probe.ffmpegVersion ?? '?'}`)
        await mkdir(dirname(this.file), { recursive: true })
        await writeFile(this.file, JSON.stringify(probe, null, 2))
        return probe
      })
      .catch((error) => {
        this.log(`recorder: encoder test failed – ${String(error)}`)
        return null
      })
      .finally(() => (this.running = null))
    return this.running
  }

  clear(): void {
    this.probe = null
  }
}
