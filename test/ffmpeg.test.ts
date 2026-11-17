import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FfmpegState } from '../src/shared/types'
import { FfmpegProvider } from '../src/main/recorder/ffmpeg'
import { FFMPEG_BUILD, ffmpegBuildPublished } from '../src/shared/ffmpegBuild'

const archive = Buffer.from('not really a zip, but the bytes that get hashed')
const sha256 = createHash('sha256').update(archive).digest('hex')

function provider(build: { sha256: string }, extract?: (zip: string, into: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-ffmpeg-'))
  const states: FfmpegState[] = []
  const logs: string[] = []
  let fetches = 0
  const ffmpeg = new FfmpegProvider({
    dir,
    build: { version: '8.1', url: 'https://example.invalid/ffmpeg.zip', bytes: archive.length, ...build },
    onState: (state) => states.push(state),
    log: (message) => logs.push(message),
    fetch: (async () => {
      fetches++
      return new Response(archive, { status: 200, headers: { 'content-length': String(archive.length) } })
    }) as typeof fetch,
    extract:
      extract ??
      (async (_zip, into) => {
        await mkdir(join(into, 'ffmpeg-8.1', 'bin'), { recursive: true })
        writeFileSync(join(into, 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'), 'exe')
      })
  })
  return { ffmpeg, dir, states, logs, fetches: () => fetches }
}

describe('FfmpegProvider', () => {
  it('downloads, verifies the SHA-256 and unpacks', async () => {
    const { ffmpeg, dir, states } = provider({ sha256 })
    expect((await ffmpeg.check()).status).toBe('missing')
    const state = await ffmpeg.install()
    expect(state).toEqual({ status: 'ready', version: '8.1' })
    expect(ffmpeg.path).toBe(join(dir, '8.1', 'ffmpeg-8.1', 'bin', 'ffmpeg.exe'))
    expect(states.map((entry) => entry.status)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'unpacking', 'ready']))
    expect(states.find((entry) => entry.status === 'downloading' && entry.progress === 1)).toBeTruthy()
    // the download is gone, only the unpacked build stays
    expect(readdirSync(dir)).toEqual(['8.1'])
  })

  it('finds the installed build again without downloading', async () => {
    const first = provider({ sha256 })
    await first.ffmpeg.install()
    expect(first.fetches()).toBe(1)
    expect((await first.ffmpeg.install()).status).toBe('ready')
    expect(first.fetches()).toBe(1)
  })

  it('installs nothing when the checksum does not match', async () => {
    let extracted = false
    const { ffmpeg, dir, logs } = provider({ sha256: 'a'.repeat(64) }, async () => {
      extracted = true
    })
    const state = await ffmpeg.install()
    expect(state.status).toBe('error')
    expect(state.message).toMatch(/checksum/)
    expect(extracted).toBe(false)
    expect(ffmpeg.path).toBeNull()
    expect(existsSync(join(dir, 'ffmpeg-8.1.zip.part'))).toBe(false)
    expect(logs.join('\n')).toMatch(/install failed/)
  })

  it('refuses to download a build without a checksum in the code', async () => {
    const { ffmpeg, fetches } = provider({ sha256: '' })
    const state = await ffmpeg.install()
    expect(state.status).toBe('error')
    expect(fetches()).toBe(0)
  })

  it('does not trust a build that was installed from another archive', async () => {
    const first = provider({ sha256 })
    await first.ffmpeg.install()
    const other = new FfmpegProvider({
      dir: first.dir,
      build: { version: '8.1', url: 'x', bytes: 0, sha256: 'b'.repeat(64) },
      onState: () => undefined,
      log: () => undefined
    })
    expect((await other.check()).status).toBe('missing')
  })

  it('the build in the code is an LGPL build from this repository', () => {
    expect(FFMPEG_BUILD.url).toMatch(/^https:\/\/github\.com\/ratioAI\/ratiLoLAI\/releases\/download\//)
    expect(FFMPEG_BUILD.license).toMatch(/^LGPL/)
    expect(FFMPEG_BUILD.url).not.toMatch(/(?<!l)gpl/i)
    // until the asset is published the download stays refused
    expect(ffmpegBuildPublished({ sha256: '' })).toBe(false)
    expect(ffmpegBuildPublished({ sha256 })).toBe(true)
  })
})
