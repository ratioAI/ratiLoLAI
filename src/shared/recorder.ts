/**
 * Clips: everything the gameplay recorder decides without touching the system. Which encoder to
 * use, the quality profiles, the FFmpeg arguments of a recording, which segments a clip needs,
 * which moments of a game become clips on their own and what gets deleted when the disk fills up.
 * Pure; the main process (main/recorder) runs FFmpeg and the files.
 *
 * Recording only goes through operating system interfaces: Windows Graphics Capture (FFmpeg's
 * gfxcapture) or Desktop Duplication (ddagrab) for the picture and WASAPI process loopback for the
 * sound. Nothing is injected into the game and its memory is never read.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const AUTO_CLIP_KINDS = ['penta', 'quadra', 'triple', 'firstBlood', 'ace', 'death', 'gameEnd'] as const
export type AutoClipKind = (typeof AUTO_CLIP_KINDS)[number]

export const AUTO_CLIP_LABELS: Record<AutoClipKind, string> = {
  penta: 'Your pentakill',
  quadra: 'Your quadra kill',
  triple: 'Your triple kill',
  firstBlood: 'Your first blood',
  ace: 'Your team aces',
  death: 'Your death after a long fight',
  gameEnd: 'The end of the game'
}

/** How a clip came to be. */
export type ClipKind = 'manual' | 'bookmark' | `auto:${AutoClipKind}`

export type RecorderMode = 'replay' | 'session'
export type RecorderQuality = 'compact' | 'high' | 'original'
export type AudioSource = 'all' | 'game'

export interface RecorderSettings {
  /** record games at all (off by default) */
  enabled: boolean
  /** replay = only the last `replaySeconds` are kept, session = the whole game */
  mode: RecorderMode
  replaySeconds: number
  quality: RecorderQuality
  fps: 60 | 30
  /** 'auto' or the id of a hardware encoder ("hevc_nvenc") */
  encoder: string
  audio: {
    /** record sound at all (what `source` says) */
    game: boolean
    /**
     * all = everything the PC plays except ratioAI itself: the game, your friends on Discord, music –
     * the clip sounds like the moment did. game = only the League process.
     */
    source: AudioSource
    mic: boolean
    /** 0 to 1 */
    micVolume: number
  }
  /** Electron accelerators */
  hotkeys: { clip: string; bookmark: string; screenshot: string }
  autoClips: Record<AutoClipKind, boolean>
  storage: {
    /** '' = Videos/ratioAI */
    folder: string
    maxGb: number
    /** session recordings older than this are deleted unless kept */
    keepSessionsDays: number
  }
  /** a short click from the main window when a clip was saved */
  clipSound: boolean
}

export const DEFAULT_RECORDER: RecorderSettings = {
  enabled: false,
  mode: 'replay',
  replaySeconds: 30,
  quality: 'compact',
  fps: 60,
  encoder: 'auto',
  audio: { game: true, source: 'all', mic: false, micVolume: 0.8 },
  hotkeys: { clip: 'Alt+F9', bookmark: 'Alt+F10', screenshot: 'Alt+F11' },
  autoClips: { penta: true, quadra: true, triple: true, firstBlood: true, ace: true, death: false, gameEnd: false },
  storage: { folder: '', maxGb: 30, keepSessionsDays: 7 },
  clipSound: false
}

/** Settings from disk (or a patch from the window) merged over a complete set, with sane bounds. */
export function mergeRecorderSettings(base: RecorderSettings, patch: DeepPartial<RecorderSettings> | undefined): RecorderSettings {
  const merged: RecorderSettings = {
    ...base,
    ...(patch as Partial<RecorderSettings>),
    audio: { ...base.audio, ...patch?.audio },
    hotkeys: { ...base.hotkeys, ...patch?.hotkeys },
    autoClips: { ...base.autoClips, ...patch?.autoClips },
    storage: { ...base.storage, ...patch?.storage }
  }
  merged.mode = merged.mode === 'session' ? 'session' : 'replay'
  merged.quality = (['compact', 'high', 'original'] as const).includes(merged.quality) ? merged.quality : 'compact'
  merged.fps = merged.fps === 30 ? 30 : 60
  merged.replaySeconds = clamp(Math.round(Number(merged.replaySeconds) || 30), 10, 300)
  merged.audio.source = merged.audio.source === 'game' ? 'game' : 'all'
  merged.audio.micVolume = clamp(Number(merged.audio.micVolume) || 0, 0, 1)
  merged.storage.maxGb = clamp(Math.round(Number(merged.storage.maxGb) || 30), 2, 2000)
  merged.storage.keepSessionsDays = clamp(Math.round(Number(merged.storage.keepSessionsDays) || 7), 1, 365)
  return merged
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
/** even and at least 2: encoders want even picture sizes */
const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)

/**
 * Hotkeys that cannot be used: the same key twice, or one the app already uses (the augment
 * hotkey). Returns one message per problem, empty when everything is fine.
 */
export function hotkeyConflicts(hotkeys: RecorderSettings['hotkeys'], taken: Record<string, string>): string[] {
  const norm = (accelerator: string): string =>
    accelerator
      .split('+')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join('+')
  const problems: string[] = []
  const entries = Object.entries(hotkeys).filter(([, key]) => key.trim())
  for (const [name, key] of entries) {
    for (const [other, otherKey] of Object.entries(taken)) {
      if (otherKey.trim() && norm(key) === norm(otherKey)) problems.push(`${name}: ${key} is already the ${other} hotkey`)
    }
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (norm(entries[i][1]) === norm(entries[j][1])) problems.push(`${entries[i][0]} and ${entries[j][0]} use the same key (${entries[i][1]})`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Hardware encoders
// ---------------------------------------------------------------------------

export type VideoCodec = 'av1' | 'hevc' | 'h264'
export type EncoderVendor = 'nvenc' | 'amf' | 'qsv'

export interface EncoderInfo {
  /** FFmpeg encoder name */
  id: string
  codec: VideoCodec
  vendor: EncoderVendor
  /** "NVIDIA AV1" */
  label: string
}

const VENDOR_LABEL: Record<EncoderVendor, string> = { nvenc: 'NVIDIA', amf: 'AMD', qsv: 'Intel' }
const CODEC_LABEL: Record<VideoCodec, string> = { av1: 'AV1', hevc: 'HEVC', h264: 'H.264' }

/**
 * Every hardware encoder the app can use, best first: AV1 (RTX 40/50, RX 7000+, Arc), then HEVC,
 * then H.264. There is no software encoder on purpose: x264 during a game costs frames (and would
 * need a GPL build of FFmpeg).
 */
export const ENCODERS: readonly EncoderInfo[] = (['av1', 'hevc', 'h264'] as const).flatMap((codec) =>
  (['nvenc', 'amf', 'qsv'] as const).map((vendor) => ({
    id: `${codec}_${vendor}`,
    codec,
    vendor,
    label: `${VENDOR_LABEL[vendor]} ${CODEC_LABEL[codec]}`
  }))
)

export const encoderById = (id: string): EncoderInfo | null => ENCODERS.find((encoder) => encoder.id === id) ?? null

/** A tiny encode of a test picture: exits with 0 when this encoder works on this machine. */
export function encoderProbeArgs(id: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1280x720:rate=30',
    '-frames:v',
    '10',
    '-vf',
    'format=nv12',
    '-c:v',
    id,
    '-f',
    'null',
    '-'
  ]
}

/**
 * The encoder to record with: the wanted one when it works here, otherwise the best that does
 * (`available` are the ids that passed the probe). null = no hardware encoder, so no recording.
 */
export function pickEncoder(available: readonly string[], wanted: string = 'auto'): EncoderInfo | null {
  const usable = ENCODERS.filter((encoder) => available.includes(encoder.id))
  return (wanted !== 'auto' && usable.find((encoder) => encoder.id === wanted)) || usable[0] || null
}

/** The encoder for files that must play everywhere (Discord, phones): H.264 first. */
export function pickCompatEncoder(available: readonly string[]): EncoderInfo | null {
  const usable = ENCODERS.filter((encoder) => available.includes(encoder.id))
  return usable.find((encoder) => encoder.codec === 'h264') ?? usable.find((encoder) => encoder.codec === 'hevc') ?? usable[0] ?? null
}

/** What the encoder test found on this machine. */
export interface EncoderProbe {
  /** ids of the encoders that work, in the order of ENCODERS */
  available: string[]
  /** how the picture is captured with this FFmpeg: Windows Graphics Capture, Desktop Duplication or not at all */
  capture: 'gfxcapture' | 'ddagrab' | null
  ffmpegVersion: string | null
  testedAt: number
}

// ---------------------------------------------------------------------------
// Quality profiles
// ---------------------------------------------------------------------------

export interface QualityProfile {
  id: RecorderQuality
  label: string
  /** the picture is scaled down to this height when the game is larger (null = never) */
  maxHeight: number | null
  /** constant quality value per codec (lower = better) */
  cq: Record<VideoCodec, number>
  /** typical bitrate of League at 1080p60 with this quality, in Mbit/s (to estimate file sizes) */
  mbit: Record<VideoCodec, number>
}

export const QUALITY_PROFILES: Record<RecorderQuality, QualityProfile> = {
  compact: { id: 'compact', label: 'Compact', maxHeight: 1080, cq: { av1: 34, hevc: 29, h264: 26 }, mbit: { av1: 6, hevc: 7.5, h264: 11 } },
  high: { id: 'high', label: 'High', maxHeight: 1440, cq: { av1: 30, hevc: 25, h264: 23 }, mbit: { av1: 8, hevc: 10, h264: 15 } },
  original: { id: 'original', label: 'Original', maxHeight: null, cq: { av1: 26, hevc: 22, h264: 20 }, mbit: { av1: 12, hevc: 15, h264: 22 } }
}

export const AUDIO_KBPS = 160

/** A profile worked out for one encoder and one picture size. */
export interface ResolvedProfile {
  quality: RecorderQuality
  encoder: EncoderInfo
  /** output picture; null = whatever the source has (size unknown) */
  width: number | null
  height: number | null
  fps: number
  /** encoder options, without -c:v */
  videoArgs: string[]
  audioKbps: number
  /** estimate for the settings page */
  mbPerMinute: number
}

/** Size of the recorded picture: the game's size, scaled down to the profile's height when larger. */
export function outputSize(
  quality: RecorderQuality,
  source: { width: number; height: number } | null
): { width: number; height: number } | null {
  if (!source || !(source.width > 0) || !(source.height > 0)) return null
  const maxHeight = QUALITY_PROFILES[quality].maxHeight
  if (maxHeight === null || source.height <= maxHeight) return { width: even(source.width), height: even(source.height) }
  return { width: even((source.width * maxHeight) / source.height), height: even(maxHeight) }
}

/**
 * Megabytes per minute a recording takes, roughly. Bitrate grows slower than the pixel count
 * (exponent 0.75) and 30 fps needs about two thirds of 60 fps.
 */
export function estimateMbPerMinute(quality: RecorderQuality, codec: VideoCodec, fps: number, size: { width: number; height: number } | null): number {
  const profile = QUALITY_PROFILES[quality]
  const assumed = size ?? outputSize(quality, quality === 'high' ? { width: 2560, height: 1440 } : { width: 1920, height: 1080 })!
  const pixels = (assumed.width * assumed.height) / (1920 * 1080)
  const mbit = profile.mbit[codec] * Math.pow(pixels, 0.75) * (fps <= 30 ? 0.65 : 1) + AUDIO_KBPS / 1000
  return Math.round((mbit * 60) / 8)
}

/**
 * Encoder options for a constant-quality recording with a keyframe every second, so clips can be
 * cut to the second without encoding again. The presets are the vendors' middle ones: the encoder
 * shares the GPU with the game.
 */
export function encoderArgs(encoder: EncoderInfo, quality: RecorderQuality, fps: number): string[] {
  const cq = String(QUALITY_PROFILES[quality].cq[encoder.codec])
  const gop = ['-g', String(fps)]
  switch (encoder.vendor) {
    case 'nvenc':
      return ['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', cq, '-b:v', '0', ...gop]
    case 'amf':
      return ['-usage', 'transcoding', '-quality', 'balanced', '-rc', 'qvbr', '-qvbr_quality_level', cq, ...gop]
    case 'qsv':
      return ['-preset', 'medium', '-global_quality', cq, ...gop]
  }
}

export function resolveProfile(
  quality: RecorderQuality,
  fps: number,
  encoder: EncoderInfo,
  source: { width: number; height: number } | null
): ResolvedProfile {
  const size = outputSize(quality, source)
  return {
    quality,
    encoder,
    width: size?.width ?? null,
    height: size?.height ?? null,
    fps,
    videoArgs: encoderArgs(encoder, quality, fps),
    audioKbps: AUDIO_KBPS,
    mbPerMinute: estimateMbPerMinute(quality, encoder.codec, fps, size)
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Where the picture comes from. Only the game window, never the whole desktop. */
export type CaptureSource =
  | {
      kind: 'gfxcapture'
      /** window handle of the game; without it the window is found by its executable */
      hwnd?: number | null
      exe?: string
      /** admin tool only: a whole screen instead of the game window */
      monitorIdx?: number
    }
  | {
      kind: 'ddagrab'
      /** index of the screen the game is on */
      outputIdx: number
      /** the game window on that screen, in pixels (null = the whole screen, borderless) */
      crop: { x: number; y: number; width: number; height: number } | null
    }
  /** a moving test picture (admin tool: checks the pipeline without a game) */
  | { kind: 'testsrc'; width: number; height: number }

export const GAME_EXE = 'League of Legends.exe'
export const GAME_WINDOW_TITLE = 'League of Legends (TM) Client'

/** Length of one recording segment in seconds. Clips are put together from whole segments. */
export const SEGMENT_SECONDS = 2
export const SEGMENT_LIST = 'segments.csv'
export const SEGMENT_PATTERN = 'seg_%06d.mp4'

/** Escapes a value inside an FFmpeg filter description. */
const filterValue = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** The capture part of the filter graph: frames stay on the GPU (D3D11) all the way to the encoder. */
export function captureFilter(source: CaptureSource, profile: ResolvedProfile): string {
  const tail = profile.encoder.vendor === 'qsv' ? ',hwmap=derive_device=qsv,format=qsv' : ''
  if (source.kind === 'gfxcapture') {
    const target =
      source.monitorIdx !== undefined
        ? `monitor_idx=${source.monitorIdx}`
        : source.hwnd
          ? `hwnd=${source.hwnd}`
          : `window_exe=${filterValue(`^${(source.exe ?? GAME_EXE).replace(/\./g, '\\.')}$`)}`
    // negative sizes round the source size down to an even number
    const size =
      profile.width && profile.height
        ? `width=${profile.width}:height=${profile.height}:resize_mode=scale_aspect:scale_mode=bilinear`
        : 'width=-2:height=-2'
    return `gfxcapture=${target}:capture_cursor=1:max_framerate=${profile.fps}:${size},fps=${profile.fps}${tail}`
  }
  if (source.kind === 'ddagrab') {
    const crop = source.crop
      ? `:video_size=${even(source.crop.width)}x${even(source.crop.height)}:offset_x=${Math.max(0, Math.round(source.crop.x))}:offset_y=${Math.max(0, Math.round(source.crop.y))}`
      : ''
    return `ddagrab=output_idx=${source.outputIdx}:framerate=${profile.fps}:draw_mouse=1${crop}${tail}`
  }
  return `testsrc2=size=${even(source.width)}x${even(source.height)}:rate=${profile.fps},format=nv12`
}

/**
 * FFmpeg arguments for a recording: the game window (GPU frames) plus the sound from the helper's
 * named pipe, encoded on the GPU and written as 2-second segments of fragmented MP4 into `outDir`.
 * FFmpeg lists every finished segment in segments.csv. Paths use forward slashes.
 */
export function ffmpegRecordArgs(
  profile: ResolvedProfile,
  source: CaptureSource,
  audioPipe: string | null,
  outDir: string,
  /** stop on its own after this many seconds (admin test) */
  limitS?: number
): string[] {
  const dir = outDir.replace(/\\/g, '/').replace(/\/$/, '')
  // -stats: the progress line (time=…) is how the recorder learns when second 0 of the recording was
  const args = ['-hide_banner', '-loglevel', 'warning', '-stats', '-stats_period', '2', '-y']
  if (profile.encoder.vendor === 'qsv' && source.kind !== 'testsrc')
    args.push('-init_hw_device', 'd3d11va=dx', '-init_hw_device', 'qsv=qs@dx', '-filter_hw_device', 'dx')
  if (audioPipe) {
    // 48 kHz stereo PCM; the helper pads silence, so the sound never falls behind the picture
    args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-thread_queue_size', '1024', '-i', audioPipe)
  } else if (source.kind === 'testsrc') {
    args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000')
  }
  const hasAudio = !!audioPipe || source.kind === 'testsrc'
  args.push('-filter_complex', `${captureFilter(source, profile)}[v]`, '-map', '[v]')
  if (hasAudio) args.push('-map', '0:a')
  args.push('-c:v', profile.encoder.id, ...profile.videoArgs)
  if (hasAudio) args.push('-c:a', 'aac', '-b:a', `${profile.audioKbps}k`, '-ac', '2')
  if (limitS) args.push('-t', String(limitS))
  args.push(
    '-f',
    'segment',
    '-segment_time',
    String(SEGMENT_SECONDS),
    '-segment_format',
    'mp4',
    '-segment_format_options',
    'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-segment_list',
    `${dir}/${SEGMENT_LIST}`,
    '-segment_list_type',
    'csv',
    '-segment_list_flags',
    '+live',
    '-reset_timestamps',
    '0',
    `${dir}/${SEGMENT_PATTERN}`
  )
  return args
}

// ---------------------------------------------------------------------------
// Segments and clips
// ---------------------------------------------------------------------------

/** One finished segment of a recording; times are seconds since the recording began. */
export interface Segment {
  file: string
  start: number
  end: number
}

/** segments.csv as FFmpeg's segment muxer writes it: `file,start,end` per finished segment. */
export function parseSegmentList(csv: string): Segment[] {
  const segments: Segment[] = []
  for (const line of csv.split(/\r?\n/)) {
    const parts = line.trim().split(',')
    if (parts.length < 3) continue
    const start = Number(parts[parts.length - 2])
    const end = Number(parts[parts.length - 1])
    const file = parts.slice(0, -2).join(',')
    if (file && Number.isFinite(start) && Number.isFinite(end) && end > start) segments.push({ file, start, end })
  }
  return segments
}

export interface ClipCut {
  /** the segments to join, in order */
  segments: Segment[]
  /** where the clip begins inside the joined segments, in whole seconds (a keyframe) */
  offset: number
  duration: number
  /** what the clip really covers, in seconds since the recording began */
  start: number
  end: number
}

/**
 * The segments a clip [start, end] needs and where to cut inside them. Recordings have a keyframe
 * every second, so the cut is moved outwards to whole seconds and nothing has to be encoded again.
 * A range that reaches beyond what was recorded is shortened to what is there; null when nothing
 * of it was recorded.
 */
export function segmentsFor(range: { start: number; end: number }, segments: readonly Segment[]): ClipCut | null {
  if (!segments.length || !(range.end > range.start)) return null
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const first = sorted[0].start
  const last = sorted[sorted.length - 1].end
  const from = Math.max(range.start, first)
  const to = Math.min(range.end, last)
  if (!(to > from)) return null
  const needed = sorted.filter((segment) => segment.end > from && segment.start < to)
  if (!needed.length) return null
  const base = needed[0].start
  const offset = Math.max(0, Math.floor(from - base + 1e-6))
  const available = needed[needed.length - 1].end - base
  const duration = Math.max(1, Math.min(Math.ceil(to - base - 1e-6) - offset, Math.ceil(available - offset - 1e-6)))
  return { segments: needed, offset, duration, start: base + offset, end: Math.min(base + offset + duration, needed[needed.length - 1].end) }
}

/** The list file of FFmpeg's concat demuxer. */
export function concatList(files: readonly string[]): string {
  return files.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n'
}

/** Joins segments and cuts them without encoding again (stream copy: instant, no load on the GPU or CPU). */
export function ffmpegClipArgs(listFile: string, offset: number, duration: number | null, out: string): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile]
  if (offset > 0) args.push('-ss', String(offset))
  if (duration !== null) args.push('-t', String(duration))
  args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', out)
  return args
}

/** One frame of a video as a small JPEG (seeks to a keyframe, so only one frame is decoded). */
export function ffmpegThumbArgs(video: string, atSeconds: number, out: string, width = 480): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, Math.floor(atSeconds))), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out]
}

/** The newest frame of a segment as a PNG (screenshot hotkey). */
export function ffmpegScreenshotArgs(segment: string, out: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-sseof', '-0.25', '-i', segment, '-frames:v', '1', '-update', '1', out]
}

/** Extra seconds the ring keeps beyond the replay length, so a clip never starts in a deleted segment. */
export const RING_BUFFER_SECONDS = 12

/**
 * Replay mode: the segments that fell out of the ring and can be deleted. `protect` are ranges
 * (seconds since the recording began) that must stay: bookmarks and automatic clips still waiting.
 */
export function ringExpired(
  segments: readonly Segment[],
  replaySeconds: number,
  protect: readonly { start: number; end: number }[] = []
): Segment[] {
  if (!segments.length) return []
  const newest = Math.max(...segments.map((segment) => segment.end))
  const keepFrom = newest - replaySeconds - RING_BUFFER_SECONDS
  return segments.filter(
    (segment) => segment.end <= keepFrom && !protect.some((range) => segment.end > range.start && segment.start < range.end)
  )
}

// ---------------------------------------------------------------------------
// Automatic clips
// ---------------------------------------------------------------------------

/** One event of the Live Client Data feed (127.0.0.1:2999), with the fields the clips use. */
export interface FeedEvent {
  EventID: number
  EventName: string
  /** game time in seconds */
  EventTime: number
  KillerName?: string
  VictimName?: string
  Assisters?: string[]
  KillStreak?: number
  Acer?: string
  AcingTeam?: string
  Recipient?: string
  Result?: string
}

/** A stretch of the game that becomes a clip, in game seconds. */
export interface ClipWindow {
  kind: AutoClipKind
  start: number
  end: number
  title: string
}

/** Seconds before and after the moment that go into the clip. */
export const AUTO_CLIP_TIMING: Record<AutoClipKind, { pre: number; post: number }> = {
  penta: { pre: 25, post: 6 },
  quadra: { pre: 20, post: 5 },
  triple: { pre: 15, post: 5 },
  firstBlood: { pre: 12, post: 4 },
  ace: { pre: 18, post: 5 },
  death: { pre: 20, post: 3 },
  gameEnd: { pre: 20, post: 3 }
}

/** The more important kind names a clip made of several moments. */
const AUTO_CLIP_PRIORITY: Record<AutoClipKind, number> = { penta: 7, quadra: 6, ace: 5, triple: 4, firstBlood: 3, gameEnd: 2, death: 1 }

const AUTO_CLIP_TITLES: Record<AutoClipKind, string> = {
  penta: 'Pentakill',
  quadra: 'Quadra kill',
  triple: 'Triple kill',
  firstBlood: 'First blood',
  ace: 'Ace',
  death: 'Died in a team fight',
  gameEnd: 'End of the game'
}

/** Your death only counts as "after a fight" when at least this many other kills happened shortly before. */
export const FIGHT_KILLS = 2
export const FIGHT_SECONDS = 15

/** The feed names players by game name, sometimes with the tag line; compare without it, case and spaces. */
export function samePlayer(a: string | undefined | null, b: string | undefined | null): boolean {
  const clean = (value: string | undefined | null): string => (value ?? '').split('#')[0].replace(/\s+/g, '').toLowerCase()
  return !!clean(a) && clean(a) === clean(b)
}

export interface AutoClipContext {
  /** your Riot ID or name */
  me: string
  /** 'ORDER' or 'CHAOS' */
  myTeam: string | null
  /** id of the newest event already looked at; null = first look at this game */
  lastEventId: number | null
  enabled: Partial<Record<AutoClipKind, boolean>>
}

/**
 * Overlapping windows become one clip: from the earliest start to the latest end, named after the
 * most important moment in it (a triple that turns into a penta is one pentakill clip).
 */
export function mergeClipWindows(windows: readonly ClipWindow[]): ClipWindow[] {
  const merged: ClipWindow[] = []
  for (const window of [...windows].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged[merged.length - 1]
    if (last && window.start <= last.end) {
      last.end = Math.max(last.end, window.end)
      if (AUTO_CLIP_PRIORITY[window.kind] > AUTO_CLIP_PRIORITY[last.kind]) {
        last.kind = window.kind
        last.title = window.title
      }
    } else merged.push({ ...window })
  }
  return merged
}

/**
 * The clips the events after `lastEventId` ask for: your triple, quadra and pentakills, your first
 * blood, an ace of your team, your death at the end of a team fight (optional) and the end of the
 * game. On the first look at a game (`lastEventId` null, e.g. the app was started mid-game) nothing
 * is made up for the past; only the newest id is remembered. Returns merged windows, oldest first.
 */
export function autoClipWindows(events: readonly FeedEvent[], ctx: AutoClipContext): { windows: ClipWindow[]; lastEventId: number | null } {
  const sorted = [...events].filter((event) => Number.isFinite(event.EventID)).sort((a, b) => a.EventID - b.EventID)
  const newest = sorted.length ? sorted[sorted.length - 1].EventID : ctx.lastEventId
  if (ctx.lastEventId === null) return { windows: [], lastEventId: newest }
  const isMe = (name?: string): boolean => samePlayer(name, ctx.me)
  const windows: ClipWindow[] = []
  const add = (kind: AutoClipKind, event: FeedEvent): void => {
    if (!ctx.enabled[kind]) return
    const { pre, post } = AUTO_CLIP_TIMING[kind]
    windows.push({ kind, start: Math.max(0, event.EventTime - pre), end: event.EventTime + post, title: AUTO_CLIP_TITLES[kind] })
  }
  for (const event of sorted) {
    if (event.EventID <= ctx.lastEventId) continue
    switch (event.EventName) {
      case 'Multikill': {
        if (!isMe(event.KillerName)) break
        const streak = event.KillStreak ?? 0
        if (streak >= 5) add('penta', event)
        else if (streak === 4) add('quadra', event)
        else if (streak === 3) add('triple', event)
        break
      }
      case 'FirstBlood':
        if (isMe(event.Recipient)) add('firstBlood', event)
        break
      case 'Ace':
        if (ctx.myTeam && event.AcingTeam === ctx.myTeam) add('ace', event)
        break
      case 'ChampionKill': {
        if (!isMe(event.VictimName)) break
        // a fight, not a lonely death: other kills shortly before (older events count too)
        const kills = sorted.filter(
          (other) =>
            other.EventName === 'ChampionKill' &&
            other.EventID !== event.EventID &&
            other.EventTime <= event.EventTime &&
            other.EventTime >= event.EventTime - FIGHT_SECONDS
        ).length
        if (kills >= FIGHT_KILLS) add('death', event)
        break
      }
      case 'GameEnd':
        add('gameEnd', event)
        break
    }
  }
  return { windows: mergeClipWindows(windows), lastEventId: newest }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Something in the clips folder that takes space. */
export interface StoredItem {
  /** path of the file or folder */
  path: string
  bytes: number
  /** when it was made (ms) */
  at: number
  /**
   * replay = what an instant-replay recording left behind, session = a whole-game recording,
   * clip = a saved clip, screenshot or export
   */
  type: 'replay' | 'session' | 'clip'
  /** session: marked "keep" */
  kept?: boolean
  favorite?: boolean
  /** belongs to the recording that is running right now */
  active?: boolean
}

export interface CleanupPlan {
  /** what to delete, in this order */
  delete: StoredItem[]
  freedBytes: number
  /** bytes in use once the plan ran */
  usedAfter: number
  /** still above the limit afterwards: only clips are left, and those are never deleted on their own */
  overQuota: boolean
}

/**
 * What gets deleted to make room. First the leftovers of instant-replay recordings (oldest first),
 * then whole-game recordings older than `keepSessionsDays` that were not marked "keep". Clips and
 * favorites are never deleted on their own, and neither is anything of the running recording.
 */
export function cleanupPlan(
  items: readonly StoredItem[],
  quota: { maxBytes: number; keepSessionsDays: number },
  now: number
): CleanupPlan {
  const oldestFirst = (a: StoredItem, b: StoredItem): number => a.at - b.at
  const expiredBefore = now - quota.keepSessionsDays * 86_400_000
  const doomed = [
    ...items.filter((item) => item.type === 'replay' && !item.active).sort(oldestFirst),
    ...items.filter((item) => item.type === 'session' && !item.active && !item.kept && !item.favorite && item.at < expiredBefore).sort(oldestFirst)
  ]
  const used = items.reduce((sum, item) => sum + item.bytes, 0)
  const freedBytes = doomed.reduce((sum, item) => sum + item.bytes, 0)
  return { delete: doomed, freedBytes, usedAfter: used - freedBytes, overQuota: used - freedBytes > quota.maxBytes }
}

// ---------------------------------------------------------------------------
// Playing clips in the window (rcclip://)
// ---------------------------------------------------------------------------

/**
 * The byte range a `Range: bytes=…` header asks for in a file of `size` bytes, so the player can
 * seek. null = no (usable) range, send the whole file; 'invalid' = cannot be satisfied (HTTP 416).
 */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim())
  if (!match || (!match[1] && !match[2])) return null
  let start: number
  let end: number
  if (!match[1]) {
    // "bytes=-500": the last 500 bytes
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  }
  if (!(size > 0) || start >= size || start > end) return 'invalid'
  return { start, end }
}

/** rcclip://clip/12 → what to serve. Only ids, never paths: the file is looked up in the database. */
export function parseClipUrl(url: string): { kind: 'clip' | 'thumb' | 'recording' | 'media'; id: string } | null {
  const match = /^rcclip:\/\/(clip|thumb|recording|media)\/([A-Za-z0-9_-]{1,64})(?:[?#].*)?$/.exec(url)
  return match ? { kind: match[1] as 'clip' | 'thumb' | 'recording' | 'media', id: match[2] } : null
}
