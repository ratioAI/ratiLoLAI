import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Clip } from '../src/shared/types'
import { NO_CLIP_FILTER, clipDuration, clipFacets, clipKindLabel, clipTitle, filterClips, sortClips } from '../src/shared/clipLibrary'
import { clipProtocolHandler, mediaTypeOf, serveFile } from '../src/main/recorder/protocol'

const day = 86_400_000
const now = 50 * day
const clip = (id: number, patch: Partial<Clip> = {}): Clip => ({
  id,
  gameId: 100 + id,
  recordingId: 1,
  createdAt: now - id * day,
  startMs: 0,
  endMs: 30_000,
  durationMs: 30_000,
  kind: 'manual',
  title: '',
  favorite: false,
  bytes: 1e6 * id,
  url: `rcclip://clip/${id}`,
  thumbUrl: null,
  game: { championId: 99, kda: [5, 2, 9], win: true, mode: 'ARAM', queueId: 450, createdAt: now - id * day },
  ...patch
})
const names: Record<number, string> = { 99: 'Lux', 103: 'Ahri' }
const clips = [
  clip(1, { kind: 'auto:penta', title: 'the one', favorite: true }),
  clip(2, { kind: 'bookmark', game: { ...clip(2).game!, championId: 103, mode: 'KIWI' }, durationMs: 90_000 }),
  clip(3, { kind: 'export', title: 'Montage' }),
  clip(9, { game: null, gameId: null }),
  clip(20, { kind: 'auto:ace' })
]
const ids = (list: Clip[]): number[] => list.map((entry) => entry.id)

describe('clip library', () => {
  it('labels kinds and falls back to them as titles', () => {
    expect(clipKindLabel('auto:penta')).toBe('Pentakill')
    expect(clipKindLabel('manual')).toBe('Clip')
    expect(clipTitle(clips[0])).toBe('the one')
    expect(clipTitle(clips[1])).toBe('Bookmark')
    expect(clipDuration(90_400)).toBe('1:30')
  })

  it('filters by champion, mode, date, kind and favorites', () => {
    const filter = (patch: Partial<typeof NO_CLIP_FILTER>) => ids(filterClips(clips, { ...NO_CLIP_FILTER, ...patch }, now, (id) => names[id] ?? ''))
    expect(filter({})).toEqual([1, 2, 3, 9, 20])
    expect(filter({ championId: 103 })).toEqual([2])
    expect(filter({ mode: 'ARAM' })).toEqual([1, 3, 20])
    expect(filter({ days: 7 })).toEqual([1, 2, 3])
    expect(filter({ kind: 'auto' })).toEqual([1, 20])
    expect(filter({ kind: 'bookmark' })).toEqual([2])
    expect(filter({ kind: 'export' })).toEqual([3])
    expect(filter({ favorites: true })).toEqual([1])
    expect(filter({ kind: 'auto', days: 7, favorites: true })).toEqual([1])
  })

  it('searches titles, kinds and champion names', () => {
    const search = (text: string) => ids(filterClips(clips, { ...NO_CLIP_FILTER, search: text }, now, (id) => names[id] ?? ''))
    expect(search('ahri')).toEqual([2])
    expect(search('penta')).toEqual([1])
    expect(search('lux montage')).toEqual([3])
    expect(search('  ')).toEqual([1, 2, 3, 9, 20])
    expect(search('nothing')).toEqual([])
  })

  it('sorts', () => {
    expect(ids(sortClips(clips, 'newest'))).toEqual([1, 2, 3, 9, 20])
    expect(ids(sortClips(clips, 'oldest'))).toEqual([20, 9, 3, 2, 1])
    expect(ids(sortClips(clips, 'longest'))[0]).toBe(2)
    expect(ids(sortClips(clips, 'largest'))[0]).toBe(20)
  })

  it('lists the champions and modes that occur', () => {
    expect(clipFacets(clips)).toEqual({
      champions: [
        { id: 99, count: 3 },
        { id: 103, count: 1 }
      ],
      modes: [
        { mode: 'ARAM', count: 3 },
        { mode: 'KIWI', count: 1 }
      ]
    })
  })
})

describe('rcclip protocol', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-proto-'))
  const video = join(dir, 'clip.mp4')
  writeFileSync(video, Buffer.from('0123456789'))
  const secret = join(dir, 'settings.json')
  writeFileSync(secret, '{}')
  const request = (url: string, range?: string, method = 'GET') => ({ url, method, headers: { get: (name: string) => (name === 'range' ? (range ?? null) : null) } })
  const handler = clipProtocolHandler((kind, id) => (kind === 'clip' && id === '5' ? video : kind === 'clip' && id === '6' ? secret : null))

  it('serves a clip by id, whole or as a byte range', async () => {
    const whole = await handler(request('rcclip://clip/5'))
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('video/mp4')
    expect(whole.headers.get('accept-ranges')).toBe('bytes')
    expect(await whole.text()).toBe('0123456789')
    const part = await handler(request('rcclip://clip/5', 'bytes=2-5'))
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    expect((await handler(request('rcclip://clip/5', 'bytes=40-'))).status).toBe(416)
  })

  it('refuses unknown ids, paths, other files and writing', async () => {
    expect((await handler(request('rcclip://clip/7'))).status).toBe(404)
    expect((await handler(request('rcclip://clip/..%2F..%2Fsettings.json'))).status).toBe(404)
    expect((await handler(request(`rcclip://clip/${encodeURIComponent(secret)}`))).status).toBe(404)
    // even when the database pointed at something that is not a media file
    expect((await handler(request('rcclip://clip/6'))).status).toBe(404)
    expect((await handler(request('rcclip://clip/5', undefined, 'POST'))).status).toBe(405)
    expect((await serveFile(join(dir, 'missing.mp4'), null)).status).toBe(404)
    expect(mediaTypeOf('a.EXE')).toBeNull()
    expect(mediaTypeOf('song.MP3')).toBe('audio/mpeg')
  })
})
