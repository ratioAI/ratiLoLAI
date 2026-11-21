import { existsSync } from 'node:fs'
import type { Clip, ExportJob } from '@shared/types'
import type { GameSummary } from '@shared/summary'
import {
  buildHighlightProject,
  ffmpegLoudnessArgs,
  loudnessBaseline,
  monthRange,
  parseFeed,
  parseLoudness,
  pickHighlights,
  reelSeconds,
  scoreHighlight,
  REEL_GAME,
  REEL_MONTH,
  type AudioStats,
  type HighlightCandidate,
  type HighlightPlan,
  type HighlightScope,
  type HighlightScore,
  type RecordingFeed,
  type ReelClip
} from '@shared/highlights'
import type { EditProject } from '@shared/editProject'
import type { ClipStore } from './clipStore'
import type { Exporter } from './exporter'
import { run } from './ffmpeg'
import type { RecorderEnv } from './setup'

export interface HighlightDeps {
  env: RecorderEnv
  store: ClipStore
  /** the saved summary of a game */
  summary(gameId: number): GameSummary | null
  /** results of the games saved in a time range (the recap's numbers) */
  results(from: number, to: number): boolean[]
  exporter: Pick<Exporter, 'start'>
  /** a game or a recording runs: no FFmpeg work then */
  busy(): boolean
  championName(championId: number): Promise<string | null>
  /** clips got (new) scores: the library can show them */
  scored(clipIds: number[]): void
  log(message: string): void
  now?(): number
  run?: typeof run
}

const MODE: Record<string, string> = { KIWI: 'ARAM: Mayhem', ARAM: 'ARAM', CLASSIC: "Summoner's Rift" }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * Highlight videos (see @shared/highlights): measures the sound of each clip once with FFmpeg,
 * scores the clips of a game or a month, picks the best and hands the montage to the exporter.
 * Measuring never runs while a game or a recording does.
 */
export class HighlightService {
  /** one measuring run at a time */
  private measuring: Promise<number> | null = null

  constructor(private readonly deps: HighlightDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The clips of a scope; exports (edited videos) are never part of a highlight video. */
  clipsOf(scope: HighlightScope): Clip[] {
    if ('gameId' in scope) return this.deps.store.ofGame(scope.gameId).filter((clip) => clip.kind !== 'export')
    const range = monthRange(scope.month)
    if (!range) return []
    return this.deps.store.list().filter((clip) => clip.kind !== 'export' && clip.createdAt >= range.from && clip.createdAt < range.to)
  }

  /** Measures the sound of the clips that were not measured yet. Stops when a game starts. */
  measure(clips: readonly Clip[]): Promise<number> {
    // one after the other; a run that failed must not fail every run after it
    const before = (this.measuring ?? Promise.resolve(0)).catch(() => 0)
    const work = before.then(() => this.doMeasure(clips))
    this.measuring = work
    const done = (): void => {
      if (this.measuring === work) this.measuring = null
    }
    work.then(done, done)
    return work
  }

  private async doMeasure(clips: readonly Clip[]): Promise<number> {
    const ffmpeg = this.deps.env.ffmpeg.path
    if (!ffmpeg) return 0
    const done = this.deps.store.audioOf(clips.map((clip) => clip.id))
    let measured = 0
    for (const clip of clips) {
      if (done.has(clip.id)) continue
      if (this.deps.busy()) break
      const file = this.deps.store.files(clip.id)?.file
      if (!file || !existsSync(file)) continue
      const result = await (this.deps.run ?? run)(ffmpeg, ffmpegLoudnessArgs(file), { timeoutMs: 60_000, lowPriority: true })
      const stats = result.code === 0 ? parseLoudness(`${result.stderr}\n${result.stdout}`) : null
      this.deps.store.saveAudio(clip.id, stats ? JSON.stringify(stats) : null, this.now())
      measured++
    }
    if (measured) this.deps.log(`highlights: measured the sound of ${measured} clip${measured === 1 ? '' : 's'}`)
    return measured
  }

  /** Scores clips with everything known about them, and keeps the scores for the library. */
  score(clips: readonly Clip[]): { clip: Clip; score: HighlightScore }[] {
    const audioRows = this.deps.store.audioOf(clips.map((clip) => clip.id))
    const audio = new Map<number, AudioStats | null>()
    for (const [id, json] of audioRows) {
      try {
        audio.set(id, json ? (JSON.parse(json) as AudioStats) : null)
      } catch {
        audio.set(id, null)
      }
    }
    const shared = this.deps.store.sharedIds()
    const recordings = new Map<number, { offset: number | null; feed: RecordingFeed | null }>()
    const recordingOf = (id: number) => {
      if (!recordings.has(id)) {
        const row = this.deps.store.recording(id)
        recordings.set(id, { offset: row?.gameOffset ?? null, feed: parseFeed(this.deps.store.recordingFeed(id)) })
      }
      return recordings.get(id)!
    }
    const summaries = new Map<number, GameSummary | null>()
    const summaryOf = (gameId: number) => {
      if (!summaries.has(gameId)) summaries.set(gameId, this.deps.summary(gameId))
      return summaries.get(gameId)!
    }
    // what counts as loud is measured per game: the same voice chat, the same volume settings
    const baselines = new Map<string, number | null>()
    const groupOf = (clip: Clip): string =>
      clip.gameId !== null ? `g${clip.gameId}` : clip.recordingId !== null ? `r${clip.recordingId}` : `c${clip.id}`
    for (const group of new Set(clips.map(groupOf))) {
      const members = clips.filter((clip) => groupOf(clip) === group)
      baselines.set(group, members.length >= 3 ? loudnessBaseline(members.map((clip) => audio.get(clip.id) ?? null)) : null)
    }

    return clips.map((clip) => {
      const recording = clip.recordingId !== null ? recordingOf(clip.recordingId) : null
      const summary = clip.gameId !== null ? summaryOf(clip.gameId) : null
      const candidate: HighlightCandidate = {
        clipId: clip.id,
        kind: clip.kind,
        durationMs: clip.durationMs,
        favorite: clip.favorite,
        shared: shared.has(clip.id),
        gameStart: recording?.offset != null ? clip.startMs / 1000 - recording.offset : null,
        feed: recording?.feed ?? null,
        game: summary
          ? { duration: summary.duration, win: summary.win, curve: summary.curve, timeline: summary.curveSource !== 'none' }
          : null,
        audio: audio.get(clip.id) ?? null,
        baseline: baselines.get(groupOf(clip)) ?? null
      }
      const score = scoreHighlight(candidate)
      if (audioRows.has(clip.id)) this.deps.store.saveScore(clip.id, { score: score.score, tier: score.tier, label: score.label })
      return { clip, score }
    })
  }

  /** What the video of a scope would be: measures what is missing first (unless a game runs). */
  async plan(scope: HighlightScope): Promise<{ plan: HighlightPlan; project: EditProject | null }> {
    const clips = this.clipsOf(scope)
    if (!this.deps.busy()) await this.measure(clips)
    const scored = this.score(clips)
    this.deps.scored(scored.map(({ clip }) => clip.id))
    const reelClips: ReelClip[] = scored.map(({ clip, score }) => ({
      score,
      recordingId: clip.recordingId,
      gameId: clip.gameId,
      championId: clip.game?.championId ?? null,
      startMs: clip.startMs,
      endMs: clip.endMs,
      createdAt: clip.createdAt
    }))
    const month = 'month' in scope
    const picked = pickHighlights(reelClips, month ? REEL_MONTH : REEL_GAME)
    const text = await this.texts(scope, picked.length)
    const project = buildHighlightProject(picked, month ? 'month' : 'game', { ...text, title: text.title.toUpperCase() })
    const pickedIds = new Set(picked.map((clip) => clip.score.clipId))
    const plan: HighlightPlan = {
      scope,
      title: text.title,
      subtitle: text.subtitle ?? null,
      clips: [...scored]
        .sort((a, b) => b.score.score - a.score.score)
        .map(({ score }) => ({
          clipId: score.clipId,
          score: score.score,
          tier: score.tier,
          label: score.label,
          reasons: score.reasons,
          core: score.core,
          picked: pickedIds.has(score.clipId)
        })),
      picked: picked.map((clip) => clip.score.clipId),
      seconds: reelSeconds(picked),
      empty: !clips.length
        ? month
          ? 'No clips in this month.'
          : 'This game has no clips.'
        : !picked.length
          ? 'Nothing here is worth a highlight video yet.'
          : null
    }
    return { plan, project }
  }

  /** Makes the video: plans it and starts the export (Discord preset). */
  async create(scope: HighlightScope): Promise<ExportJob> {
    const { plan, project } = await this.plan(scope)
    if (!project || !plan.picked.length) throw new Error(plan.empty ?? 'Nothing here is worth a highlight video yet.')
    const best = plan.clips.find((clip) => clip.picked)!
    this.deps.log(
      `highlights: video of ${'gameId' in scope ? `game ${scope.gameId}` : scope.month} – ${plan.picked.length} clips, ${Math.round(plan.seconds)} s (${plan.clips
        .filter((clip) => clip.picked)
        .map((clip) => `${clip.label} ${clip.score}`)
        .join(', ')})`
    )
    return this.deps.exporter.start({
      clipId: best.clipId,
      standalone: 'month' in scope,
      project,
      title: 'month' in scope ? `Recap · ${plan.title}` : `Highlights · ${plan.title}`,
      images: {}
    })
  }

  /** After a game: measure and score its clips in the background (skipped while the next game runs). */
  async afterGame(gameId: number): Promise<void> {
    if (this.deps.busy()) return
    const clips = this.clipsOf({ gameId })
    if (!clips.length) return
    await this.measure(clips)
    this.deps.scored(this.score(clips).map(({ clip }) => clip.id))
  }

  /** Clips without a score yet (older ones): measured and scored, newest first, while nothing else runs. */
  async backfill(limit = 200): Promise<void> {
    if (this.deps.busy() || !this.deps.env.ffmpeg.path) return
    const clips = this.deps.store
      .list()
      .filter((clip) => clip.kind !== 'export' && !clip.highlight)
      .slice(0, limit)
    if (!clips.length) return
    await this.measure(clips)
    // scored by game, so each game's loudness yardstick is complete
    const byGame = new Map<string, Clip[]>()
    for (const clip of clips) {
      const key = clip.gameId !== null ? `g${clip.gameId}` : `c${clip.id}`
      byGame.set(key, [...(byGame.get(key) ?? []), clip])
    }
    const ids: number[] = []
    for (const [key, group] of byGame) {
      const all = key.startsWith('g') ? this.clipsOf({ gameId: Number(key.slice(1)) }) : group
      ids.push(...this.score(all).map(({ clip }) => clip.id))
    }
    this.deps.scored(ids)
  }

  /** Title and subtitle of the video. */
  private async texts(scope: HighlightScope, picked: number): Promise<{ title: string; subtitle?: string }> {
    if ('month' in scope) {
      const range = monthRange(scope.month)
      const [year, month] = scope.month.split('-').map(Number)
      const results = range ? this.deps.results(range.from, range.to) : []
      const wins = results.filter(Boolean).length
      const parts = [
        results.length ? `${results.length} game${results.length === 1 ? '' : 's'}` : '',
        results.length ? `${wins} win${wins === 1 ? '' : 's'}` : '',
        picked ? `${picked} highlight${picked === 1 ? '' : 's'}` : ''
      ].filter(Boolean)
      return { title: `${MONTHS[month - 1] ?? ''} ${year}`, subtitle: parts.join(' · ') || undefined }
    }
    const summary = this.deps.summary(scope.gameId)
    const me = summary?.players.find((player) => player.me)
    if (!summary || !me) return { title: 'Highlights' }
    const champion = (await this.deps.championName(me.championId).catch(() => null)) ?? 'Highlights'
    const date = new Date(summary.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    return {
      title: `${champion} · ${me.kills}/${me.deaths}/${me.assists} · ${summary.win ? 'Victory' : 'Defeat'}`,
      subtitle: `${MODE[summary.mode] ?? summary.mode} · ${date}`
    }
  }
}
