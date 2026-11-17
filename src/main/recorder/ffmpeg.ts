import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { FfmpegState } from '@shared/types'
import { FFMPEG_BUILD, ffmpegBuildPublished } from '@shared/ffmpegBuild'

export interface FfmpegBuild {
  version: string
  url: string
  sha256: string
  bytes: number
}

export interface FfmpegDeps {
  /** userData/ffmpeg */
  dir: string
  build?: FfmpegBuild
  onState(state: FfmpegState): void
  log(message: string): void
  fetch?: typeof fetch
  /** unpacks a zip into a folder (default: tar, which Windows 10 ships and which reads zip files) */
  extract?(zip: string, into: string): Promise<void>
  /** a ready FFmpeg to use instead of the download (development: RATIO_FFMPEG) */
  override?: string | null
}

/** SHA-256 of a file as lowercase hex. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Runs a program to its end and collects what it printed. Never throws; code -1 = could not start or timed out. */
export function run(
  file: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const child = spawn(file, args, { windowsHide: true, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill()
      finish(-1)
    }, options.timeoutMs ?? 20_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout = (stdout + chunk).slice(-200_000)))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-200_000)))
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
  })
}

async function untar(zip: string, into: string): Promise<void> {
  // bsdtar (tar.exe, part of Windows since 10 1803) unpacks zip archives; so does unzip elsewhere
  const result =
    process.platform === 'win32' ? await run('tar', ['-xf', zip, '-C', into], { timeoutMs: 120_000 }) : await run('unzip', ['-o', '-q', zip, '-d', into], { timeoutMs: 120_000 })
  if (result.code !== 0) throw new Error(`unpacking failed: ${result.stderr.trim().slice(0, 200) || `exit code ${result.code}`}`)
}

/** The first file with this name below a folder. */
async function findFile(dir: string, name: string, depth = 4): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) if (entry.isFile() && entry.name.toLowerCase() === name) return join(dir, entry.name)
  if (depth <= 0) return null
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findFile(join(dir, entry.name), name, depth - 1)
    if (found) return found
  }
  return null
}

/**
 * The recorder's FFmpeg: a fixed LGPL build, downloaded once from this repository's release
 * assets, checked against the SHA-256 in the code and unpacked into userData/ffmpeg/<version>.
 * FFmpeg is its own program next to the app; nothing of it is linked in.
 */
export class FfmpegProvider {
  private state: FfmpegState = { status: 'missing' }
  private installing: Promise<FfmpegState> | null = null
  private exe: string | null = null
  private readonly build: FfmpegBuild

  constructor(private readonly deps: FfmpegDeps) {
    this.build = deps.build ?? FFMPEG_BUILD
  }

  private set(state: FfmpegState): FfmpegState {
    this.state = state
    this.deps.onState(state)
    return state
  }

  getState(): FfmpegState {
    return this.state
  }

  /** Path of the FFmpeg program, null until it is installed. */
  get path(): string | null {
    return this.exe
  }

  private get versionDir(): string {
    return join(this.deps.dir, this.build.version)
  }

  /** Looks for an installed build (or the development override). Cheap; called at start. */
  async check(): Promise<FfmpegState> {
    if (this.deps.override && existsSync(this.deps.override)) {
      this.exe = this.deps.override
      return this.set({ status: 'ready', version: 'custom', message: this.deps.override })
    }
    const marker = await readFile(join(this.versionDir, 'installed.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as { sha256?: string; exe?: string })
      .catch(() => null)
    // a build installed from another archive than the one in the code is not trusted
    if (marker?.exe && marker.sha256 === this.build.sha256.toLowerCase() && existsSync(marker.exe)) {
      this.exe = marker.exe
      return this.set({ status: 'ready', version: this.build.version })
    }
    this.exe = null
    return this.set({ status: 'missing' })
  }

  /** Downloads, verifies and unpacks the build. Calling it again while it runs returns the same run. */
  install(force = false): Promise<FfmpegState> {
    if (!this.installing) {
      this.installing = this.doInstall(force)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.deps.log(`ffmpeg: install failed – ${message}`)
          return this.set({ status: 'error', message })
        })
        .finally(() => (this.installing = null))
    }
    return this.installing
  }

  private async doInstall(force: boolean): Promise<FfmpegState> {
    if (!force) {
      const current = await this.check()
      if (current.status === 'ready') return current
    } else if (this.deps.override && existsSync(this.deps.override)) return this.check()
    if (!ffmpegBuildPublished(this.build))
      throw new Error('The FFmpeg build for Clips is not published yet (no checksum in this version).')
    await mkdir(this.deps.dir, { recursive: true })
    const zip = join(this.deps.dir, `ffmpeg-${this.build.version}.zip.part`)
    this.set({ status: 'downloading', progress: 0, version: this.build.version })
    const response = await (this.deps.fetch ?? fetch)(this.build.url, { redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status}).`)
    const total = Number(response.headers.get('content-length')) || this.build.bytes || 0
    const hash = createHash('sha256')
    const out = createWriteStream(zip)
    let received = 0
    let lastShown = -1
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        received += value.length
        if (!out.write(value)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        const progress = total ? Math.min(1, received / total) : 0
        // one event per percent is plenty
        if (Math.floor(progress * 100) !== lastShown) {
          lastShown = Math.floor(progress * 100)
          this.set({ status: 'downloading', progress, version: this.build.version })
        }
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()))
    }
    this.set({ status: 'verifying', version: this.build.version })
    const digest = hash.digest('hex')
    if (digest !== this.build.sha256.toLowerCase()) {
      await rm(zip, { force: true })
      throw new Error('The downloaded FFmpeg does not match its checksum. Nothing was installed.')
    }
    this.set({ status: 'unpacking', version: this.build.version })
    const target = this.versionDir
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await (this.deps.extract ?? untar)(zip, target)
    await rm(zip, { force: true })
    const exe = (await findFile(target, 'ffmpeg.exe')) ?? (await findFile(target, 'ffmpeg'))
    if (!exe) throw new Error('The archive has no ffmpeg.exe in it.')
    await writeFile(join(target, 'installed.json'), JSON.stringify({ sha256: digest, exe, version: this.build.version }))
    this.exe = exe
    this.deps.log(`ffmpeg: ${this.build.version} installed (${Math.round(received / 1e6)} MB)`)
    return this.set({ status: 'ready', version: this.build.version })
  }

  /** Removes the installed build (admin tool: "reload FFmpeg"). */
  async remove(): Promise<void> {
    await rm(this.versionDir, { recursive: true, force: true })
    await this.check()
  }
}

