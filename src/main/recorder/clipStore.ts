import type { DatabaseSync } from 'node:sqlite'
import type { Clip, ClipGame } from '@shared/types'
import type { HighlightTier } from '@shared/highlights'
import type { ClipKind } from '@shared/recorder'

export interface RecordingRow {
  id: number
  gameId: number | null
  startedAt: number
  endedAt: number | null
  /** folder with the segments, or the single file a whole-game recording was joined into */
  dir: string
  bytes: number
  kept: boolean
  /** recording seconds minus game seconds; null when the game clock was never seen (or before 1.3.3) */
  gameOffset: number | null
}

interface ClipRow {
  id: number
  game_id: number | null
  recording_id: number | null
  created_at: number
  start_ms: number
  end_ms: number
  file: string
  thumb: string | null
  kind: string
  title: string
  favorite: number
  bytes: number
  g_champion: number | null
  g_kills: number | null
  g_deaths: number | null
  g_assists: number | null
  g_win: number | null
  g_mode: string | null
  g_queue: number | null
  g_created: number | null
  h_score: number | null
  h_tier: string | null
  h_label: string | null
}

const CLIP_SELECT = `
  SELECT c.*, g.champion_id AS g_champion, g.kills AS g_kills, g.deaths AS g_deaths, g.assists AS g_assists,
         g.win AS g_win, g.mode AS g_mode, g.queue_id AS g_queue, g.created_at AS g_created,
         h.score AS h_score, h.tier AS h_tier, h.label AS h_label
  FROM clips c LEFT JOIN games g ON g.game_id = c.game_id LEFT JOIN clip_signals h ON h.clip_id = c.id`

function toClip(row: ClipRow): Clip {
  const game: ClipGame | null =
    row.g_champion === null
      ? null
      : {
          championId: row.g_champion,
          kda: [row.g_kills ?? 0, row.g_deaths ?? 0, row.g_assists ?? 0],
          win: !!row.g_win,
          mode: row.g_mode ?? '',
          queueId: row.g_queue ?? 0,
          createdAt: row.g_created ?? 0
        }
  return {
    id: row.id,
    gameId: row.game_id,
    recordingId: row.recording_id,
    createdAt: row.created_at,
    startMs: row.start_ms,
    endMs: row.end_ms,
    durationMs: Math.max(0, row.end_ms - row.start_ms),
    kind: row.kind as Clip['kind'],
    title: row.title,
    favorite: !!row.favorite,
    bytes: row.bytes,
    url: `rcclip://clip/${row.id}`,
    // the creation time busts the cache when a thumbnail is made again
    thumbUrl: row.thumb ? `rcclip://thumb/${row.id}?v=${row.created_at}` : null,
    game,
    highlight: row.h_score === null || row.h_score === undefined ? null : { score: row.h_score, tier: (row.h_tier ?? 'C') as HighlightTier, label: row.h_label ?? '' }
  }
}

/**
 * Recordings, clips and editor projects in games.db (tables of migration 4). Only the rows live
 * here; the video files are in the clips folder and belong to RecorderService.
 */
export class ClipStore {
  constructor(private readonly db: DatabaseSync) {}

  // --- recordings ---

  addRecording(startedAt: number, dir: string): number {
    return Number(this.db.prepare('INSERT INTO recordings (started_at, dir) VALUES (?, ?)').run(startedAt, dir).lastInsertRowid)
  }

  updateRecording(
    id: number,
    patch: Partial<Pick<RecordingRow, 'gameId' | 'endedAt' | 'dir' | 'bytes' | 'kept' | 'gameOffset'>> & { feed?: string }
  ): void {
    const sets: string[] = []
    const values: (string | number | null)[] = []
    if (patch.gameId !== undefined) (sets.push('game_id = ?'), values.push(patch.gameId))
    if (patch.endedAt !== undefined) (sets.push('ended_at = ?'), values.push(patch.endedAt))
    if (patch.dir !== undefined) (sets.push('dir = ?'), values.push(patch.dir))
    if (patch.bytes !== undefined) (sets.push('bytes = ?'), values.push(Math.round(patch.bytes)))
    if (patch.kept !== undefined) (sets.push('kept = ?'), values.push(patch.kept ? 1 : 0))
    if (patch.gameOffset !== undefined) (sets.push('game_offset = ?'), values.push(patch.gameOffset))
    if (patch.feed !== undefined) (sets.push('feed = ?'), values.push(patch.feed))
    if (sets.length) this.db.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  }

  private toRecording(row: Record<string, unknown>): RecordingRow {
    return {
      id: Number(row.id),
      gameId: row.game_id === null ? null : Number(row.game_id),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
      dir: String(row.dir),
      bytes: Number(row.bytes),
      kept: !!row.kept,
      gameOffset: row.game_offset === null || row.game_offset === undefined ? null : Number(row.game_offset)
    }
  }

  /** What the recorder kept of the recording's game (JSON, see RecordingFeed), null when nothing. */
  recordingFeed(id: number): string | null {
    const row = this.db.prepare('SELECT feed FROM recordings WHERE id = ?').get(id) as { feed: string | null } | undefined
    return row?.feed ?? null
  }

  recording(id: number): RecordingRow | null {
    const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? this.toRecording(row) : null
  }

  recordings(): RecordingRow[] {
    return (this.db.prepare('SELECT * FROM recordings ORDER BY started_at DESC').all() as Record<string, unknown>[]).map((row) =>
      this.toRecording(row)
    )
  }

  recordingOfGame(gameId: number): RecordingRow | null {
    const row = this.db.prepare('SELECT * FROM recordings WHERE game_id = ? ORDER BY started_at DESC LIMIT 1').get(gameId) as
      | Record<string, unknown>
      | undefined
    return row ? this.toRecording(row) : null
  }

  deleteRecording(id: number): void {
    this.db.prepare('DELETE FROM recordings WHERE id = ?').run(id)
  }

  /** The game of a recording became known (its summary arrived): its clips belong to that game too. */
  attachGame(recordingId: number, gameId: number): void {
    this.db.prepare('UPDATE recordings SET game_id = ? WHERE id = ?').run(gameId, recordingId)
    this.db.prepare('UPDATE clips SET game_id = ? WHERE recording_id = ? AND game_id IS NULL').run(gameId, recordingId)
  }

  /** Champion, K/D/A and result of a saved game, for recordings and clips. */
  gameOf(gameId: number): ClipGame | null {
    const row = this.db
      .prepare('SELECT champion_id, kills, deaths, assists, win, mode, queue_id, created_at FROM games WHERE game_id = ?')
      .get(gameId) as Record<string, number | string> | undefined
    return row
      ? {
          championId: Number(row.champion_id),
          kda: [Number(row.kills), Number(row.deaths), Number(row.assists)],
          win: !!row.win,
          mode: String(row.mode),
          queueId: Number(row.queue_id),
          createdAt: Number(row.created_at)
        }
      : null
  }

  // --- clips ---

  addClip(clip: {
    gameId: number | null
    recordingId: number | null
    createdAt: number
    startMs: number
    endMs: number
    file: string
    thumb: string | null
    kind: ClipKind | 'export'
    title: string
    bytes: number
  }): Clip {
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO clips (game_id, recording_id, created_at, start_ms, end_ms, file, thumb, kind, title, bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          clip.gameId,
          clip.recordingId,
          clip.createdAt,
          Math.round(clip.startMs),
          Math.round(clip.endMs),
          clip.file,
          clip.thumb,
          clip.kind,
          clip.title,
          Math.round(clip.bytes)
        ).lastInsertRowid
    )
    return this.clip(id)!
  }

  clip(id: number): Clip | null {
    const row = this.db.prepare(`${CLIP_SELECT} WHERE c.id = ?`).get(id) as ClipRow | undefined
    return row ? toClip(row) : null
  }

  /** Paths of a clip's files (never sent to the window). */
  files(id: number): { file: string; thumb: string | null } | null {
    const row = this.db.prepare('SELECT file, thumb FROM clips WHERE id = ?').get(id) as { file: string; thumb: string | null } | undefined
    return row ?? null
  }

  list(): Clip[] {
    return (this.db.prepare(`${CLIP_SELECT} ORDER BY c.created_at DESC, c.id DESC`).all() as unknown as ClipRow[]).map(toClip)
  }

  ofGame(gameId: number): Clip[] {
    return (this.db.prepare(`${CLIP_SELECT} WHERE c.game_id = ? ORDER BY c.start_ms, c.id`).all(gameId) as unknown as ClipRow[]).map(toClip)
  }

  update(id: number, patch: { title?: string; favorite?: boolean; thumb?: string | null }): Clip | null {
    if (patch.title !== undefined) this.db.prepare('UPDATE clips SET title = ? WHERE id = ?').run(String(patch.title).slice(0, 120), id)
    if (patch.favorite !== undefined) this.db.prepare('UPDATE clips SET favorite = ? WHERE id = ?').run(patch.favorite ? 1 : 0, id)
    if (patch.thumb !== undefined) this.db.prepare('UPDATE clips SET thumb = ? WHERE id = ?').run(patch.thumb, id)
    return this.clip(id)
  }

  /** Removes the rows (and the clips' editor projects); returns the files that can be deleted now. */
  delete(ids: number[]): string[] {
    const files: string[] = []
    for (const id of ids) {
      const row = this.files(id)
      if (!row) continue
      files.push(row.file)
      if (row.thumb) files.push(row.thumb)
      this.db.prepare('DELETE FROM clips WHERE id = ?').run(id)
      this.db.prepare('DELETE FROM edits WHERE clip_id = ?').run(id)
      this.db.prepare('DELETE FROM clip_signals WHERE clip_id = ?').run(id)
    }
    return files
  }

  /** Every clip file with its size, for the storage overview and the cleanup. */
  storage(): { id: number; file: string; bytes: number; createdAt: number; favorite: boolean }[] {
    return (
      this.db.prepare('SELECT id, file, bytes, created_at, favorite FROM clips').all() as unknown as {
        id: number
        file: string
        bytes: number
        created_at: number
        favorite: number
      }[]
    ).map((row) => ({ id: row.id, file: row.file, bytes: row.bytes, createdAt: row.created_at, favorite: !!row.favorite }))
  }

  // --- highlight signals ---

  /** The sound analysis (JSON) of clips that were analyzed, by clip id. */
  audioOf(ids: number[]): Map<number, string | null> {
    const found = new Map<number, string | null>()
    const select = this.db.prepare('SELECT audio FROM clip_signals WHERE clip_id = ?')
    for (const id of ids) {
      const row = select.get(id) as { audio: string | null } | undefined
      if (row) found.set(id, row.audio)
    }
    return found
  }

  /** Stores a clip's sound analysis (null = it has no sound or FFmpeg could not read it). */
  saveAudio(clipId: number, audio: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO clip_signals (clip_id, audio, analyzed_at) VALUES (?, ?, ?)
         ON CONFLICT (clip_id) DO UPDATE SET audio = excluded.audio, analyzed_at = excluded.analyzed_at`
      )
      .run(clipId, audio, now)
  }

  /** Stores a clip's highlight score (shown in the library); needs its sound analysis row first. */
  saveScore(clipId: number, score: { score: number; tier: string; label: string }): void {
    this.db.prepare('UPDATE clip_signals SET score = ?, tier = ?, label = ? WHERE clip_id = ?').run(score.score, score.tier, score.label, clipId)
  }

  /** Clips that were posted to Discord. */
  sharedIds(): Set<number> {
    return new Set((this.db.prepare('SELECT clip_id FROM clip_posts').all() as { clip_id: number }[]).map((row) => row.clip_id))
  }

  // --- editor projects ---

  edit(clipId: number): { projectJson: string; updatedAt: number } | null {
    const row = this.db.prepare('SELECT project_json, updated_at FROM edits WHERE clip_id = ?').get(clipId) as
      | { project_json: string; updated_at: number }
      | undefined
    return row ? { projectJson: row.project_json, updatedAt: row.updated_at } : null
  }

  saveEdit(clipId: number, projectJson: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO edits (clip_id, project_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (clip_id) DO UPDATE SET project_json = excluded.project_json, updated_at = excluded.updated_at`
      )
      .run(clipId, projectJson, now)
  }
}
