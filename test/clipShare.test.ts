import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Settings } from '../src/shared/types'
import { DISCORD_LIMITS, DISCORD_UPLOAD_MB, bestAutoClip, buildClipPayload, clipFileName, clipUploadForm } from '../src/shared/discordPayload'
import { migrate } from '../src/main/games'
import { ClipStore } from '../src/main/recorder/clipStore'
import { ClipSharer } from '../src/main/recorder/share'

const WEBHOOK = 'https://discord.com/api/webhooks/123456/abc-DEF_token'
const MB = 1024 * 1024

function setup(options: { statuses?: number[]; clipBytes?: number; shrunkBytes?: number[]; settings?: Partial<Settings['discord']>; webhook?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-share-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  db.exec("INSERT INTO games (game_id, created_at, duration, queue_id, mode, win, champion_id, kills, deaths, assists, summary) VALUES (900, 1, 900, 2400, 'KIWI', 1, 99, 12, 3, 9, '{}')")
  const store = new ClipStore(db)
  const add = (kind: 'manual' | 'auto:penta' | 'auto:triple' | 'export', bytes: number, title = '', gameId: number | null = 900) => {
    const file = join(dir, `clip-${Math.random().toString(36).slice(2)}.mp4`)
    writeFileSync(file, Buffer.alloc(bytes, 1))
    return store.addClip({ gameId, recordingId: null, createdAt: 1_800_000_000_000, startMs: 0, endMs: 30_000, file, thumb: null, kind, title, bytes })
  }
  const clip = add('auto:penta', options.clipBytes ?? 5 * MB, 'the penta')
  const requests: { url: string; form: FormData }[] = []
  const statuses = [...(options.statuses ?? [200])]
  const shrunk = [...(options.shrunkBytes ?? [])]
  const shrinks: { clipId: number; targetMb: number }[] = []
  const discarded: number[] = []
  const logs: string[] = []
  const sharer = new ClipSharer({
    db,
    store,
    settings: () => ({ enabled: true, modes: ['mayhem'], onlyWithPremades: false, anonymizeRandoms: true, includeQuips: true, includeAchievements: true, attachBestClip: true, uploadLimitMb: 20, ...options.settings }),
    webhook: () => (options.webhook === undefined ? WEBHOOK : options.webhook),
    staticData: async () => ({ version: '16.22.1', champions: { 99: { id: 'Lux', key: 99, name: 'Lux', title: '', tags: [] } } }) as never,
    quipOf: async () => 'Carried harder than a backpack.',
    shrink: async (clipId, targetMb) => {
      shrinks.push({ clipId, targetMb })
      const bytes = shrunk.shift()
      return bytes === undefined ? null : add('export', bytes).id
    },
    discard: async (id) => {
      discarded.push(id)
      store.delete([id])
    },
    log: (message) => logs.push(message),
    now: () => 1_800_000_100_000,
    sleep: async () => undefined,
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, form: init.body as FormData })
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]
      return new Response(JSON.stringify(status === 429 ? { retry_after: 0.5 } : status === 413 ? { message: 'Request entity too large' } : {}), { status })
    }) as typeof fetch
  })
  return { sharer, store, db, clip, add, requests, shrinks, discarded, logs }
}

describe('clip message', () => {
  it('has the title, champion, K/D/A, result and the quip', () => {
    const payload = buildClipPayload({
      title: 'the penta',
      durationS: 31,
      createdAt: 1_800_000_000_000,
      champion: { name: 'Lux', id: 'Lux' },
      kda: [12, 3, 9],
      win: true,
      mode: 'KIWI',
      quip: 'Carried *harder* than a backpack.',
      ddragonVersion: '16.22.1'
    })
    const embed = payload.embeds[0]
    expect(embed.title).toBe('🎬 the penta')
    expect(embed.fields).toEqual([
      { name: 'Champion', value: 'Lux', inline: true },
      { name: 'K / D / A', value: '12 / 3 / 9', inline: true },
      { name: 'Result', value: 'Victory', inline: true }
    ])
    expect(embed.description).toContain('backpack')
    expect(embed.description).not.toContain('*harder*')
    expect(embed.footer.text).toBe('ratioAI · ARAM: Mayhem · 0:31')
    expect(embed.thumbnail?.url).toContain('/16.22.1/img/champion/Lux.png')
    expect(payload.allowed_mentions).toEqual({ parse: [] })
  })

  it('works without a game and stays inside Discord\'s limits', () => {
    const payload = buildClipPayload({ title: 'x'.repeat(400), durationS: 5, createdAt: 0 })
    expect(payload.embeds[0].fields).toEqual([])
    expect(payload.embeds[0].title.length).toBeLessThanOrEqual(DISCORD_LIMITS.title)
    expect(payload.embeds[0].description).toBeUndefined()
    expect(buildClipPayload({ title: '', durationS: 5, createdAt: 0 }).embeds[0].title).toBe('🎬 Clip')
  })

  it('builds multipart/form-data with payload_json and files[0]', async () => {
    const payload = buildClipPayload({ title: 'a', durationS: 5, createdAt: 0 })
    const form = clipUploadForm(payload, { name: 'a.mp4', type: 'video/mp4', data: new Uint8Array([1, 2, 3]) })
    expect([...form.keys()]).toEqual(['payload_json', 'files[0]'])
    expect(JSON.parse(form.get('payload_json') as string)).toEqual(payload)
    const file = form.get('files[0]') as File
    expect(file.name).toBe('a.mp4')
    expect(file.type).toBe('video/mp4')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    // the request really is multipart with a boundary
    const request = new Request('https://example.invalid', { method: 'POST', body: form })
    expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    const body = await request.text()
    expect(body).toContain('name="payload_json"')
    expect(body).toContain('name="files[0]"; filename="a.mp4"')
  })

  it('makes safe file names and picks the best automatic clip', () => {
    expect(clipFileName('PENTAKILL: Lux / 1v5!!', '.MP4')).toBe('pentakill-lux-1v5.mp4')
    expect(clipFileName('', 'gif')).toBe('clip.gif')
    const clips = [
      { kind: 'manual', durationMs: 90_000, createdAt: 5 },
      { kind: 'auto:triple', durationMs: 20_000, createdAt: 1 },
      { kind: 'auto:ace', durationMs: 23_000, createdAt: 2 },
      { kind: 'auto:quadra', durationMs: 25_000, createdAt: 3 },
      { kind: 'auto:quadra', durationMs: 31_000, createdAt: 4 }
    ]
    expect(bestAutoClip(clips)).toEqual({ kind: 'auto:quadra', durationMs: 31_000, createdAt: 4 })
    expect(bestAutoClip([{ kind: 'manual', durationMs: 1, createdAt: 1 }, { kind: 'bookmark', durationMs: 1, createdAt: 1 }])).toBeNull()
    expect(DISCORD_UPLOAD_MB).toBe(20)
  })
})

describe('ClipSharer', () => {
  it('uploads the clip with its message and remembers it', async () => {
    const ctx = setup()
    const result = await ctx.sharer.share(ctx.clip.id, { quip: true })
    expect(result).toEqual({ ok: true, message: 'Posted to Discord ✔' })
    expect(ctx.requests).toHaveLength(1)
    expect(ctx.requests[0].url).toBe(WEBHOOK)
    const form = ctx.requests[0].form
    const payload = JSON.parse(form.get('payload_json') as string)
    expect(payload.embeds[0].title).toBe('🎬 the penta')
    expect(payload.embeds[0].description).toContain('backpack')
    expect((form.get('files[0]') as File).name).toBe('the-penta.mp4')
    expect((form.get('files[0]') as File).size).toBe(5 * MB)
    expect(ctx.sharer.posted(ctx.clip.id)).toBe(true)
  })

  it('does not post the same clip twice unless asked to', async () => {
    const ctx = setup()
    await ctx.sharer.share(ctx.clip.id)
    const second = await ctx.sharer.share(ctx.clip.id)
    expect(second).toMatchObject({ ok: false, alreadyPosted: true })
    expect(ctx.requests).toHaveLength(1)
    expect((await ctx.sharer.share(ctx.clip.id, { again: true })).ok).toBe(true)
    expect(ctx.requests).toHaveLength(2)
    // two clicks at once: only one upload
    const other = ctx.add('manual', MB)
    const [a, b] = await Promise.all([ctx.sharer.share(other.id), ctx.sharer.share(other.id)])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect(ctx.requests).toHaveLength(3)
  })

  it('on HTTP 413 exports the clip smaller with the Discord preset and sends that', async () => {
    const ctx = setup({ statuses: [413, 200], shrunkBytes: [12 * MB] })
    const result = await ctx.sharer.share(ctx.clip.id)
    expect(result).toEqual({ ok: true, message: 'Posted to Discord ✔ (as a smaller version)' })
    expect(ctx.shrinks).toEqual([{ clipId: ctx.clip.id, targetMb: 20 }])
    expect(ctx.requests).toHaveLength(2)
    expect((ctx.requests[1].form.get('files[0]') as File).size).toBe(12 * MB)
    // the original counts as posted; the smaller by-product is removed again
    expect(ctx.sharer.posted(ctx.clip.id)).toBe(true)
    expect(ctx.discarded).toHaveLength(1)
    expect(ctx.store.list().map((clip) => clip.id)).toEqual([ctx.clip.id])
  })

  it('does not even try to upload a file above the limit: it is made smaller first', async () => {
    const ctx = setup({ clipBytes: 30 * MB, shrunkBytes: [18 * MB] })
    expect((await ctx.sharer.share(ctx.clip.id)).ok).toBe(true)
    expect(ctx.requests).toHaveLength(1)
    expect((ctx.requests[0].form.get('files[0]') as File).size).toBe(18 * MB)
    // a boosted server with 50 MB takes the file as it is
    const boosted = setup({ clipBytes: 30 * MB, settings: { uploadLimitMb: 50 } })
    expect((await boosted.sharer.share(boosted.clip.id)).ok).toBe(true)
    expect(boosted.shrinks).toEqual([])
  })

  it('tries half the size when Discord still says 413, then gives up without crashing', async () => {
    const ctx = setup({ statuses: [413], shrunkBytes: [15 * MB, 8 * MB] })
    const result = await ctx.sharer.share(ctx.clip.id)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/too large/)
    expect(ctx.shrinks.map((shrink) => shrink.targetMb)).toEqual([20, 10])
    expect(ctx.requests).toHaveLength(3)
    expect(ctx.sharer.posted(ctx.clip.id)).toBe(false)
    expect(ctx.discarded).toHaveLength(2)
    // nothing to make it smaller with (a game or another export is running)
    const busy = setup({ statuses: [413] })
    expect((await busy.sharer.share(busy.clip.id)).message).toMatch(/could not be made smaller/)
  })

  it('reports other failures and never throws', async () => {
    const gone = setup({ statuses: [404] })
    expect(await gone.sharer.share(gone.clip.id)).toMatchObject({ ok: false, message: expect.stringMatching(/webhook doesn’t exist/) })
    expect(gone.logs.join('\n')).toMatch(/clip \d+ failed/)
    expect((await setup({ webhook: null }).sharer.share(1)).message).toMatch(/No Discord webhook/)
    expect((await setup().sharer.share(999)).message).toBe('Clip not found.')
    const limited = setup({ statuses: [429, 200] })
    expect((await limited.sharer.share(limited.clip.id)).ok).toBe(true)
    expect(limited.requests).toHaveLength(2)
  })

  it('adds the best automatic clip of a game once, and only when the option is on', async () => {
    const ctx = setup()
    ctx.add('auto:triple', MB)
    ctx.add('manual', MB)
    await ctx.sharer.attachBest(900)
    expect(ctx.requests).toHaveLength(1)
    expect(JSON.parse(ctx.requests[0].form.get('payload_json') as string).embeds[0].title).toBe('🎬 the penta')
    await ctx.sharer.attachBest(900)
    expect(ctx.requests).toHaveLength(1)
    const off = setup({ settings: { attachBestClip: false } })
    await off.sharer.attachBest(900)
    expect(off.requests).toHaveLength(0)
    const none = setup()
    none.store.delete([none.clip.id])
    none.add('manual', MB)
    await none.sharer.attachBest(900)
    expect(none.requests).toHaveLength(0)
  })
})
