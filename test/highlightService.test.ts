import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { ExportRequest } from '../src/shared/types'
import type { GameSummary } from '../src/shared/summary'
import type { RecordingFeed } from '../src/shared/highlights'
import { migrate } from '../src/main/games'
import { ClipStore } from '../src/main/recorder/clipStore'
import { HighlightService } from '../src/main/recorder/highlights'
import type { RecorderEnv } from '../src/main/recorder/setup'

const GAME = 4242
const NOV = new Date(2026, 10, 21, 20, 0).getTime()

function setup(options: { busy?: boolean } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'rc-hl-'))
  const db = new DatabaseSync(':memory:')
  migrate(db)
  db.exec(
    `INSERT INTO games (game_id, created_at, duration, queue_id, mode, win, champion_id, kills, deaths, assists, summary) VALUES (${GAME}, ${NOV}, 1200, 2400, 'KIWI', 1, 222, 14, 3, 9, '{}')`
  )
  const store = new ClipStore(db)
  // the game clock runs 12 s behind the recording
  const recording = store.addRecording(NOV, folder)
  const feed: RecordingFeed = {
    me: 'Me#EUW',
    myTeam: 'ORDER',
    teams: { 'Me#EUW': 'ORDER', 'E1#EUW': 'CHAOS', 'E2#EUW': 'CHAOS', 'E3#EUW': 'CHAOS' },
    events: [
      { EventID: 1, EventName: 'ChampionKill', EventTime: 300, KillerName: 'Me', VictimName: 'E1#EUW', Assisters: [] },
      { EventID: 2, EventName: 'ChampionKill', EventTime: 303, KillerName: 'Me', VictimName: 'E2#EUW', Assisters: [] },
      { EventID: 3, EventName: 'ChampionKill', EventTime: 306, KillerName: 'Me', VictimName: 'E3#EUW', Assisters: [] },
      { EventID: 4, EventName: 'Multikill', EventTime: 306, KillerName: 'Me', KillStreak: 3 },
      { EventID: 5, EventName: 'ChampionKill', EventTime: 700, KillerName: 'E1#EUW', VictimName: 'Me#EUW', Assisters: [] }
    ],
    health: []
  }
  store.updateRecording(recording, { gameId: GAME, gameOffset: 12, feed: JSON.stringify(feed) })
  const clip = (kind: string, startS: number, seconds: number, createdAt = NOV) => {
    const file = join(folder, `${kind.replace(/\W/g, '-')}-${startS}.mp4`)
    writeFileSync(file, 'video')
    return store.addClip({
      gameId: GAME,
      recordingId: recording,
      createdAt,
      startMs: startS * 1000,
      endMs: (startS + seconds) * 1000,
      file,
      thumb: null,
      kind: kind as 'manual',
      title: '',
      bytes: 5
    })
  }
  // game 290–315 s: the triple; game 690–713 s: your death; a hotkey clip over the triple
  const triple = clip('auto:triple', 302, 25)
  const death = clip('auto:death', 702, 23)
  const manual = clip('manual', 300, 30)
  const summary = {
    gameId: GAME,
    createdAt: NOV,
    duration: 1200,
    win: true,
    mode: 'KIWI',
    players: [{ puuid: 'me', me: true, championId: 222, kills: 14, deaths: 3, assists: 9 }],
    curve: [],
    curveSource: 'none'
  } as unknown as GameSummary
  const runs: string[][] = []
  const requests: ExportRequest[] = []
  const scored: number[][] = []
  const service = new HighlightService({
    env: { ffmpeg: { path: '/fake/ffmpeg' } } as unknown as RecorderEnv,
    store,
    summary: (gameId) => (gameId === GAME ? summary : null),
    results: () => [true, false, true],
    exporter: {
      start: (request: ExportRequest) => {
        requests.push(request)
        return { id: 1, state: 'running', progress: 0, preset: 'discord', title: request.title, message: null, bytes: 0, clip: null }
      }
    },
    busy: () => !!options.busy,
    championName: async () => 'Jinx',
    scored: (ids) => scored.push(ids),
    log: () => undefined,
    now: () => NOV + 60_000,
    // the death clip has no sound (FFmpeg fails on -map 0:a:0), the others have a loud second
    run: async (_file, args) => {
      runs.push(args)
      if (args.some((arg) => arg.includes('auto-death'))) return { code: 1, stdout: '', stderr: "Stream map '' matches no streams." }
      const levels = Array.from({ length: 25 }, (_, i) => (i === 8 ? -12 : -30))
      return { code: 0, stdout: '', stderr: levels.map((level) => `lavfi.astats.Overall.RMS_level=${level}`).join('\n') }
    }
  })
  return { store, service, runs, requests, scored, triple, death, manual }
}

describe('HighlightService', () => {
  it('measures each clip once, scores the game and picks one clip per moment', async () => {
    const ctx = setup()
    const { plan, project } = await ctx.service.plan({ gameId: GAME })
    expect(ctx.runs).toHaveLength(3)
    // the triple (from the feed: 3 solo kills); your own clip of the same fight wins over the automatic one
    expect(plan.clips[0]).toMatchObject({ clipId: ctx.manual.id, label: 'Triple kill' })
    expect(plan.clips[1]).toMatchObject({ clipId: ctx.triple.id, label: 'Triple kill' })
    expect(plan.picked).toContain(ctx.manual.id)
    expect(plan.picked).not.toContain(ctx.triple.id)
    expect(plan.title).toBe('Jinx · 14/3/9 · Victory')
    expect(project!.texts[0].text).toBe('JINX · 14/3/9 · VICTORY')
    // scores are kept for the library, and a second look measures nothing again
    expect(ctx.store.clip(ctx.triple.id)!.highlight).toMatchObject({ tier: expect.any(String), label: 'Triple kill' })
    expect(ctx.store.clip(ctx.death.id)!.highlight).toMatchObject({ label: 'Team fight' })
    await ctx.service.plan({ gameId: GAME })
    expect(ctx.runs).toHaveLength(3)
    expect(ctx.scored.length).toBeGreaterThan(0)
  })

  it('makes the video as a Discord export of the best clip; a month recap belongs to no game', async () => {
    const ctx = setup()
    await ctx.service.create({ gameId: GAME })
    expect(ctx.requests[0]).toMatchObject({ clipId: ctx.manual.id, standalone: false, title: 'Highlights · Jinx · 14/3/9 · Victory' })
    expect(ctx.requests[0].project.output.preset).toBe('discord')
    await ctx.service.create({ month: '2026-11' })
    expect(ctx.requests[1]).toMatchObject({ standalone: true, title: 'Recap · November 2026' })
    expect(ctx.requests[1].project.texts[1].text).toMatch(/^3 games · 2 wins · \d highlights?$/)
    await expect(ctx.service.create({ month: '2026-10' })).rejects.toThrow('No clips in this month.')
  })

  it('measures nothing while a game or a recording runs, but still scores what it knows', async () => {
    const ctx = setup({ busy: true })
    const { plan } = await ctx.service.plan({ gameId: GAME })
    expect(ctx.runs).toHaveLength(0)
    expect(plan.clips).toHaveLength(3)
    await ctx.service.afterGame(GAME)
    await ctx.service.backfill()
    expect(ctx.runs).toHaveLength(0)
  })
})
