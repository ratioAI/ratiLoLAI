/**
 * The Clips editor's project and what FFmpeg makes of it. A project is plain data: parts of clips
 * in a row (cut, slowed down, joined with transitions), a picture format with a crop, texts,
 * stickers, an optional stats overlay and music. `ffmpegExportArgs` turns it into one FFmpeg call.
 * Pure; the main process (main/recorder/exporter.ts) supplies the files and runs it.
 */
import type { EncoderInfo, RecorderQuality } from './recorder'
import { encoderArgs } from './recorder'

export type Aspect = '16:9' | '9:16' | '1:1'
export type Transition = 'cut' | 'fade' | 'glitch'
export const SPEEDS = [1, 0.5, 0.25] as const

/** One stretch of a clip on the timeline. */
export interface ProjectClip {
  clipId: number
  /** seconds inside the clip */
  in: number
  out: number
  /** 1, 0.5 or 0.25 (slow motion) */
  speed: number
}

export interface TextItem {
  id: string
  /** top / bottom = classic meme text (white, black outline, upper case), box = free text */
  kind: 'top' | 'bottom' | 'box'
  text: string
  /** centre of a box, as fractions of the picture (ignored for top and bottom) */
  x: number
  y: number
  /** font size as a fraction of the picture's height */
  size: number
  color: string
  /** when it shows, in timeline seconds (end null = to the end) */
  start: number
  end: number | null
  /** seconds to fade in and out (0 = none) */
  fade: number
}

export interface StickerItem {
  id: string
  /** an emoji of the built-in set ("emoji:1f451") or an imported picture (its path) */
  src: string
  x: number
  y: number
  /** width as a fraction of the picture's width */
  scale: number
  start: number
  end: number | null
}

/** Champion icon, K/D/A and result in a corner. */
export interface StatsOverlay {
  championId: number
  kda: [number, number, number]
  win: boolean
  corner: 'tl' | 'tr' | 'bl' | 'br'
}

export interface ProjectMusic {
  /** "builtin:nebula-drift" or the path of a file the user imported */
  file: string
  name: string
  /** where in the song to start, seconds */
  offset: number
  /** 0 to 1 */
  volume: number
  /** turn the game's sound down while the music plays */
  duck: boolean
  fadeIn: number
  fadeOut: number
}

export type ExportPresetId = 'discord' | 'hq' | 'short' | 'gif' | 'webm'

export interface ExportOptions {
  preset: ExportPresetId
  /** Discord and GIF: stay below this size */
  targetMb: number
  gifFps: 10 | 15 | 20
  gifWidth: 480 | 640
}

export interface EditProject {
  version: 1
  clips: ProjectClip[]
  crop: {
    aspect: Aspect
    /** where the crop window sits in the source, 0 (left / top) to 1 (right / bottom) */
    x: number
    y: number
  }
  texts: TextItem[]
  stickers: StickerItem[]
  overlays: { stats: StatsOverlay | null }
  music: ProjectMusic | null
  /** how part i + 1 follows part i (one entry less than clips) */
  transitions: Transition[]
  output: ExportOptions
}

/** Discord's upload limit for everyone since August 2026 (boosted servers allow more). */
export const DISCORD_FREE_MB = 20
export const DEFAULT_EXPORT: ExportOptions = { preset: 'discord', targetMb: DISCORD_FREE_MB, gifFps: 15, gifWidth: 480 }

/** Seconds two parts overlap in a fade / a glitch. */
export const TRANSITION_SECONDS: Record<Transition, number> = { cut: 0, fade: 0.4, glitch: 0.25 }

export const BUILTIN_MUSIC = [
  { id: 'builtin:nebula-drift', name: 'Nebula Drift', file: 'music/nebula-drift.m4a', seconds: 24 },
  { id: 'builtin:pentakill-rush', name: 'Pentakill Rush', file: 'music/pentakill-rush.m4a', seconds: 27.4 },
  { id: 'builtin:victory-lap', name: 'Victory Lap', file: 'music/victory-lap.m4a', seconds: 17.5 }
] as const

/** The emoji stickers that come with the app (Twemoji, CC-BY 4.0); the name is the code point. */
export const EMOJI_STICKERS = [
  '1f451', '1f921', '1f525', '1f480', '1f602', '1f62d', '1f92f', '1f60e', '1fae1', '1f91d', '1f4af', '2b50',
  '1f3c6', '1f3af', '1f440', '1f9e0', '1f410', '1f691', '274c', '2705', '2753', '1f4a4', '1f37f', '1f4c9'
] as const

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2)
/** numbers in filter graphs: short, no exponent */
const n = (value: number): string => String(Math.round(value * 1000) / 1000)

/** A new project for one clip: the whole clip, 16:9, nothing on top. */
export function newProject(clipId: number, durationS: number): EditProject {
  return {
    version: 1,
    clips: [{ clipId, in: 0, out: Math.max(0.1, durationS), speed: 1 }],
    crop: { aspect: '16:9', x: 0.5, y: 0.5 },
    texts: [],
    stickers: [],
    overlays: { stats: null },
    music: null,
    transitions: [],
    output: { ...DEFAULT_EXPORT }
  }
}

/**
 * Makes a stored project safe to use: bounds, a transition between every two parts, no parts of
 * zero length. Returns null when it is not a project at all.
 */
export function normalizeProject(raw: unknown): EditProject | null {
  const project = raw as Partial<EditProject> | null
  if (!project || typeof project !== 'object' || !Array.isArray(project.clips)) return null
  const clips = project.clips
    .filter((part) => part && Number.isFinite(part.clipId) && Number.isFinite(part.in) && Number.isFinite(part.out))
    .map((part) => ({
      clipId: Number(part.clipId),
      in: Math.max(0, part.in),
      out: Math.max(0, part.out),
      speed: (SPEEDS as readonly number[]).includes(part.speed) ? part.speed : 1
    }))
    .filter((part) => part.out - part.in >= 0.05)
  if (!clips.length) return null
  const aspect: Aspect = project.crop?.aspect === '9:16' || project.crop?.aspect === '1:1' ? project.crop.aspect : '16:9'
  const transitions = Array.from({ length: clips.length - 1 }, (_, i): Transition => {
    const wanted = project.transitions?.[i]
    return wanted === 'fade' || wanted === 'glitch' ? wanted : 'cut'
  })
  const output = { ...DEFAULT_EXPORT, ...project.output }
  return {
    version: 1,
    clips,
    crop: { aspect, x: clamp(Number(project.crop?.x ?? 0.5), 0, 1), y: clamp(Number(project.crop?.y ?? 0.5), 0, 1) },
    texts: Array.isArray(project.texts) ? project.texts.filter((text) => text && typeof text.text === 'string') : [],
    stickers: Array.isArray(project.stickers) ? project.stickers.filter((sticker) => sticker && typeof sticker.src === 'string') : [],
    overlays: { stats: project.overlays?.stats ?? null },
    music: project.music && typeof project.music.file === 'string' ? project.music : null,
    transitions,
    output: {
      preset: (['discord', 'hq', 'short', 'gif', 'webm'] as const).includes(output.preset) ? output.preset : 'discord',
      targetMb: clamp(Number(output.targetMb) || DISCORD_FREE_MB, 1, 500),
      gifFps: output.gifFps === 10 || output.gifFps === 20 ? output.gifFps : 15,
      gifWidth: output.gifWidth === 640 ? 640 : 480
    }
  }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/** How long a part runs on the timeline (slow motion makes it longer). */
export const partDuration = (part: ProjectClip): number => Math.max(0, part.out - part.in) / (part.speed || 1)

export interface TimelinePart {
  index: number
  part: ProjectClip
  /** when it starts and ends on the timeline; it overlaps the part before by `overlap` seconds */
  start: number
  end: number
  overlap: number
  transition: Transition
}

/** Where every part sits on the timeline. Fades and glitches overlap the two parts they join. */
export function timeline(project: Pick<EditProject, 'clips' | 'transitions'>): TimelinePart[] {
  const parts: TimelinePart[] = []
  let cursor = 0
  project.clips.forEach((part, index) => {
    const transition: Transition = index === 0 ? 'cut' : (project.transitions[index - 1] ?? 'cut')
    const length = partDuration(part)
    const previous = parts[index - 1]
    // never overlap more than half of either part
    const overlap = index === 0 ? 0 : Math.min(TRANSITION_SECONDS[transition], length / 2, (previous.end - previous.start) / 2)
    const start = cursor - overlap
    parts.push({ index, part, start, end: start + length, overlap, transition })
    cursor = start + length
  })
  return parts
}

export function projectDuration(project: Pick<EditProject, 'clips' | 'transitions'>): number {
  const parts = timeline(project)
  return parts.length ? parts[parts.length - 1].end : 0
}

/** The part under a timeline position and the position inside its clip (the later part during an overlap). */
export function partAt(project: Pick<EditProject, 'clips' | 'transitions'>, time: number): { part: TimelinePart; clipTime: number } | null {
  const parts = timeline(project)
  if (!parts.length) return null
  const found = [...parts].reverse().find((entry) => time >= entry.start) ?? parts[0]
  const local = clamp(time - found.start, 0, found.end - found.start)
  return { part: found, clipTime: found.part.in + local * found.part.speed }
}

/** Cuts the part under `time` in two. Returns the project unchanged when the cut would leave a sliver. */
export function splitAt(project: EditProject, time: number): EditProject {
  const hit = partAt(project, time)
  if (!hit) return project
  const { part, clipTime } = hit
  if (clipTime - part.part.in < 0.1 || part.part.out - clipTime < 0.1) return project
  const clips = [...project.clips]
  clips.splice(part.index, 1, { ...part.part, out: clipTime }, { ...part.part, in: clipTime })
  const transitions = [...project.transitions]
  transitions.splice(part.index, 0, 'cut')
  return { ...project, clips, transitions }
}

/** Removes a part (the last one stays) and the transition that led into it. */
export function removePart(project: EditProject, index: number): EditProject {
  if (project.clips.length <= 1 || !project.clips[index]) return project
  const clips = project.clips.filter((_, i) => i !== index)
  const transitions = project.transitions.filter((_, i) => i !== Math.max(0, index - 1))
  return { ...project, clips, transitions: transitions.slice(0, clips.length - 1) }
}

/** Appends a whole clip to the end (montage). */
export function appendClip(project: EditProject, clipId: number, durationS: number, transition: Transition = 'cut'): EditProject {
  return {
    ...project,
    clips: [...project.clips, { clipId, in: 0, out: Math.max(0.1, durationS), speed: 1 }],
    transitions: [...project.transitions, transition]
  }
}

/** Moves a part one place to the left (-1) or right (+1). */
export function movePart(project: EditProject, index: number, direction: -1 | 1): EditProject {
  const target = index + direction
  if (!project.clips[index] || !project.clips[target]) return project
  const clips = [...project.clips]
  ;[clips[index], clips[target]] = [clips[target], clips[index]]
  return { ...project, clips }
}

// ---------------------------------------------------------------------------
// Picture
// ---------------------------------------------------------------------------

const ASPECT_RATIO: Record<Aspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }

/** Output picture of a format with the given height of the short … long side. */
export function frameSize(aspect: Aspect, base: number): { width: number; height: number } {
  if (aspect === '16:9') return { width: even((base * 16) / 9), height: even(base) }
  if (aspect === '9:16') return { width: even(base), height: even((base * 16) / 9) }
  return { width: even(base), height: even(base) }
}

/**
 * The window of a source picture that a format shows: as large as fits, moved by the crop position.
 * Used by the preview (canvas) with real sizes; the export uses the same formula as an expression.
 */
export function cropRect(
  source: { width: number; height: number },
  crop: EditProject['crop']
): { x: number; y: number; width: number; height: number } {
  const ratio = ASPECT_RATIO[crop.aspect]
  const width = Math.min(source.width, source.height * ratio)
  const height = Math.min(source.height, source.width / ratio)
  return { x: (source.width - width) * clamp(crop.x, 0, 1), y: (source.height - height) * clamp(crop.y, 0, 1), width, height }
}

/**
 * Breaks a text into lines that fit: at most `maxChars` characters per line, at spaces where
 * possible. The preview and the export both use this, so they wrap the same way.
 */
export function wrapText(text: string, maxChars: number): string[] {
  const limit = Math.max(4, Math.floor(maxChars))
  const lines: string[] = []
  for (const paragraph of text.split(/\r?\n/)) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let rest = word
      // a word longer than a line is broken hard
      while (rest.length > limit) {
        if (line) lines.push(line)
        lines.push(rest.slice(0, limit))
        rest = rest.slice(limit)
        line = ''
      }
      if (!line) line = rest
      else if (line.length + 1 + rest.length <= limit) line += ` ${rest}`
      else {
        lines.push(line)
        line = rest
      }
    }
    lines.push(line)
  }
  return lines.length ? lines : ['']
}

/** Anton is a narrow face: a character is about 0.44 of the font size wide on average. */
export const FONT_CHAR_WIDTH = 0.44

export interface TextLayout {
  lines: string[]
  /** font size, outline width and line height in pixels */
  fontSize: number
  outline: number
  lineHeight: number
  /** centre of the block */
  centerX: number
  /** top edge of the block */
  top: number
  upper: boolean
}

/** Where a text goes in a picture of the given size. Shared by the preview and the export. */
export function layoutText(item: TextItem, frame: { width: number; height: number }): TextLayout {
  const meme = item.kind !== 'box'
  const fontSize = Math.max(8, Math.round(frame.height * clamp(item.size, 0.02, 0.3)))
  const text = meme ? item.text.toUpperCase() : item.text
  const lines = wrapText(text, (frame.width * 0.92) / (fontSize * FONT_CHAR_WIDTH))
  const lineHeight = Math.round(fontSize * 1.12)
  const block = lines.length * lineHeight
  const margin = Math.round(frame.height * 0.04)
  const top =
    item.kind === 'top'
      ? margin
      : item.kind === 'bottom'
        ? frame.height - margin - block
        : Math.round(clamp(item.y, 0, 1) * frame.height - block / 2)
  return {
    lines,
    fontSize,
    outline: Math.max(2, Math.round(fontSize * 0.07)),
    lineHeight,
    centerX: meme ? frame.width / 2 : Math.round(clamp(item.x, 0, 1) * frame.width),
    top: clamp(top, 0, Math.max(0, frame.height - block)),
    upper: meme
  }
}

/** Opacity of something that shows from `start` to `end` with a fade of `fade` seconds at both ends. */
export function fadeAlpha(time: number, start: number, end: number, fade: number): number {
  if (time < start || time > end) return 0
  if (!(fade > 0)) return 1
  return clamp(Math.min((time - start) / fade, (end - time) / fade), 0, 1)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Video bitrate in kbit/s so a file of `durationS` seconds stays below `targetMB` megabytes
 * (1 MB = 1024 × 1024 bytes, like Discord counts), with the sound at `audioKbps` and 4 % kept back
 * for the container. Never below 150 kbit/s.
 */
export function bitrateForSize(durationS: number, targetMB: number, audioKbps: number): number {
  const seconds = Math.max(1, durationS)
  const totalKbps = (targetMB * 1024 * 1024 * 8 * 0.96) / seconds / 1000
  return Math.max(150, Math.floor(totalKbps - audioKbps))
}

/** Upper bound for the Discord preset's video bitrate (kbit/s). */
export const MAX_SIZED_KBPS = 12_000

export interface ExportPlan {
  preset: ExportPresetId
  width: number
  height: number
  fps: number
  container: 'mp4' | 'webm' | 'gif'
  /** kbit/s when the file must fit a size, null for constant quality */
  videoKbps: number | null
  audioKbps: number
  aspect: Aspect
}

/**
 * Size, frame rate and bitrate of an export. The Discord preset works the bitrate out from the
 * length and drops to 720p (then 480p) when there are too few bits for 1080p.
 */
export function planExport(project: EditProject, options: ExportOptions = project.output): ExportPlan {
  const duration = projectDuration(project)
  const aspect: Aspect = options.preset === 'short' ? '9:16' : project.crop.aspect
  if (options.preset === 'gif') {
    const size = frameSize(aspect, aspect === '16:9' ? (options.gifWidth * 9) / 16 : options.gifWidth)
    return { preset: 'gif', ...size, fps: options.gifFps, container: 'gif', videoKbps: null, audioKbps: 0, aspect }
  }
  if (options.preset === 'discord') {
    const audioKbps = 128
    // short clips do not need the whole allowance: more than this is wasted on 1080p60
    const videoKbps = Math.min(MAX_SIZED_KBPS, bitrateForSize(duration, options.targetMb, audioKbps))
    const base = videoKbps >= 4500 ? 1080 : videoKbps >= 1800 ? 720 : 480
    return { preset: 'discord', ...frameSize(aspect, base), fps: videoKbps >= 1800 ? 60 : 30, container: 'mp4', videoKbps, audioKbps, aspect }
  }
  return {
    preset: options.preset,
    ...frameSize(aspect, 1080),
    fps: 60,
    container: options.preset === 'webm' ? 'webm' : 'mp4',
    videoKbps: null,
    audioKbps: 192,
    aspect
  }
}

/** Megabytes an export will have, roughly (null when it cannot be said, e.g. constant quality). */
export function estimateExportMb(project: EditProject, plan: ExportPlan): number | null {
  if (plan.videoKbps === null) return null
  return Math.round((((plan.videoKbps + plan.audioKbps) * 1000 * projectDuration(project)) / 8 / 1024 / 1024 / 0.96) * 10) / 10
}

/** What the exporter knows about the files a project uses. */
export interface ExportFiles {
  /** clip id → video file */
  clips: Record<number, string>
  /** clip ids whose file has a sound track */
  withAudio: number[]
  /** text id → UTF-8 file with the wrapped lines (drawtext reads it, so nothing has to be escaped) */
  texts: Record<string, string>
  /** sticker id → PNG; 'stats' → the stats overlay as a PNG at output size */
  images: Record<string, string>
  /** the music file (already resolved for built-in tracks), null without music */
  music: string | null
  /** Anton-Regular.ttf */
  font: string
  out: string
}

/** A path inside a filter description: forward slashes, drive colon and quotes escaped. */
export const filterPath = (path: string): string => `'${path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`

const atempo = (speed: number): string => (speed === 0.25 ? 'atempo=0.5,atempo=0.5' : speed === 0.5 ? 'atempo=0.5' : `atempo=${n(speed)}`)

/**
 * The filter graph of a project: every part trimmed, slowed, cropped and scaled, the parts joined
 * (concat for cuts, xfade for fades and glitches), texts drawn, stickers and the stats overlay laid
 * on top, the music mixed in. Returns the graph, the inputs it reads and the labels of its outputs.
 */
export function buildFilterGraph(
  project: EditProject,
  plan: ExportPlan,
  files: ExportFiles
): { inputs: string[][]; graph: string[]; video: string; audio: string | null; duration: number } {
  const parts = timeline(project)
  const duration = projectDuration(project)
  const inputs: string[][] = []
  const graph: string[] = []
  const crop = { ...project.crop, aspect: plan.aspect }
  const ratio = n(ASPECT_RATIO[crop.aspect])
  const wantAudio = plan.container !== 'gif'

  // --- every part: its own input, cut by seeking, then trimmed exactly ---
  parts.forEach(({ part }, i) => {
    const length = part.out - part.in
    inputs.push(['-ss', n(part.in), '-t', n(length + 0.5), '-i', files.clips[part.clipId]])
    graph.push(
      `[${i}:v]trim=duration=${n(length)},setpts=(PTS-STARTPTS)/${n(part.speed)},fps=${plan.fps},` +
        `crop=w='min(iw,ih*${ratio})':h='min(ih,iw/${ratio})':x='(iw-ow)*${n(crop.x)}':y='(ih-oh)*${n(crop.y)}',` +
        `scale=${plan.width}:${plan.height}:flags=bicubic,setsar=1,format=yuv420p,settb=AVTB[v${i}]`
    )
    if (!wantAudio) return
    if (files.withAudio.includes(part.clipId))
      graph.push(`[${i}:a]atrim=duration=${n(length)},asetpts=PTS-STARTPTS,${atempo(part.speed)},aresample=48000,aformat=channel_layouts=stereo[a${i}]`)
    else graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n(length / part.speed)}[a${i}]`)
  })

  // --- join the parts ---
  let video = 'v0'
  let audio = wantAudio ? 'a0' : null
  for (let i = 1; i < parts.length; i++) {
    const { transition, overlap, start } = parts[i]
    if (transition === 'cut' || overlap <= 0) {
      graph.push(`[${video}][v${i}]concat=n=2:v=1:a=0[vj${i}]`)
      if (audio) graph.push(`[${audio}][a${i}]concat=n=2:v=0:a=1[aj${i}]`)
    } else {
      // xfade starts `overlap` before the end of what was joined so far
      graph.push(`[${video}][v${i}]xfade=transition=${transition === 'fade' ? 'fade' : 'pixelize'}:duration=${n(overlap)}:offset=${n(start)}[vj${i}]`)
      if (audio) graph.push(`[${audio}][a${i}]acrossfade=d=${n(overlap)}:c1=tri:c2=tri[aj${i}]`)
    }
    video = `vj${i}`
    if (audio) audio = `aj${i}`
  }

  // --- texts (drawtext reads the wrapped lines from a file) ---
  const frame = { width: plan.width, height: plan.height }
  project.texts.forEach((item, i) => {
    const file = files.texts[item.id]
    if (!file || !item.text.trim()) return
    const layout = layoutText(item, frame)
    const start = Math.max(0, item.start)
    const end = Math.min(duration, item.end ?? duration)
    const fade = Math.min(Math.max(0, item.fade), (end - start) / 2)
    const alpha = fade > 0 ? `:alpha='max(0,min(1,min((t-${n(start)})/${n(fade)},(${n(end)}-t)/${n(fade)})))'` : ''
    graph.push(
      `[${video}]drawtext=fontfile=${filterPath(files.font)}:textfile=${filterPath(file)}:fontsize=${layout.fontSize}:` +
        `fontcolor=${item.kind === 'box' ? item.color.replace('#', '0x') : 'white'}:borderw=${layout.outline}:bordercolor=black:` +
        `line_spacing=${layout.lineHeight - layout.fontSize}:text_align=C:x=${Math.round(layout.centerX)}-text_w/2:y=${layout.top}:` +
        `enable='between(t,${n(start)},${n(end)})'${alpha}[vt${i}]`
    )
    video = `vt${i}`
  })

  // --- stickers and the stats overlay: pictures on top ---
  let next = parts.length
  const overlay = (id: string, x: string, y: string, scale: string | null, start: number, end: number): void => {
    const file = files.images[id]
    if (!file) return
    const index = next++
    inputs.push(['-loop', '1', '-t', n(duration), '-i', file])
    const source = scale ? `ov${index}` : `${index}:v`
    if (scale) graph.push(`[${index}:v]scale=${scale}:-1[ov${index}]`)
    graph.push(`[${video}][${source}]overlay=x=${x}:y=${y}:enable='between(t,${n(start)},${n(end)})'[vo${index}]`)
    video = `vo${index}`
  }
  for (const sticker of project.stickers) {
    const width = even(plan.width * clamp(sticker.scale, 0.02, 1))
    overlay(
      sticker.id,
      `${Math.round(clamp(sticker.x, 0, 1) * plan.width)}-w/2`,
      `${Math.round(clamp(sticker.y, 0, 1) * plan.height)}-h/2`,
      String(width),
      Math.max(0, sticker.start),
      Math.min(duration, sticker.end ?? duration)
    )
  }
  // the stats overlay is drawn by the window at output size, so it only has to be laid on top
  if (project.overlays.stats) overlay('stats', '0', '0', null, 0, duration)

  // --- music ---
  if (audio && project.music && files.music) {
    const music = project.music
    const index = next++
    inputs.push(['-stream_loop', '-1', '-ss', n(Math.max(0, music.offset)), '-i', files.music])
    const fadeOut = Math.min(Math.max(0, music.fadeOut), duration / 2)
    const fadeIn = Math.min(Math.max(0, music.fadeIn), duration / 2)
    graph.push(
      `[${index}:a]atrim=duration=${n(duration)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${n(clamp(music.volume, 0, 1))}` +
        (fadeIn > 0 ? `,afade=t=in:st=0:d=${n(fadeIn)}` : '') +
        (fadeOut > 0 ? `,afade=t=out:st=${n(duration - fadeOut)}:d=${n(fadeOut)}` : '') +
        '[mus]'
    )
    if (music.duck) {
      // the music is the side chain: while it plays, the game's sound is turned down
      graph.push('[mus]asplit=2[musmix][muskey]')
      graph.push(`[${audio}][muskey]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=350[game]`)
      graph.push('[game][musmix]amix=inputs=2:duration=first:normalize=0[amix]')
    } else graph.push(`[${audio}][mus]amix=inputs=2:duration=first:normalize=0[amix]`)
    audio = 'amix'
  }
  return { inputs, graph, video, audio, duration }
}

/** Bitrate options of each vendor's encoder for a file that must fit a size. */
function bitrateArgs(encoder: EncoderInfo, kbps: number, fps: number): string[] {
  const rate = [`-b:v`, `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`, '-g', String(fps * 2)]
  switch (encoder.vendor) {
    case 'nvenc':
      return ['-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', ...rate]
    case 'amf':
      return ['-usage', 'transcoding', '-quality', 'quality', '-rc', 'vbr_peak', ...rate]
    case 'qsv':
      return ['-preset', 'slow', ...rate]
  }
}

/**
 * The FFmpeg call that exports a project as a video. `encoder` is the hardware encoder to use
 * (H.264 for Discord so it plays everywhere, the best one otherwise); for WebM without an AV1
 * hardware encoder pass null and VP9 is used. For GIFs see ffmpegGifArgs.
 */
export function ffmpegExportArgs(project: EditProject, plan: ExportPlan, files: ExportFiles, encoder: EncoderInfo | null): string[] {
  const { inputs, graph, video, audio } = buildFilterGraph(project, plan, files)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats', ...inputs.flat()]
  args.push('-filter_complex', graph.join(';'), '-map', `[${video}]`)
  if (audio) args.push('-map', `[${audio}]`)
  if (plan.container === 'webm' && (!encoder || encoder.codec !== 'av1')) {
    // no AV1 hardware encoder: VP9 on the CPU (exports never run during a game)
    args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-cpu-used', '4', '-g', String(plan.fps * 2))
  } else if (encoder) {
    const quality: RecorderQuality = 'original'
    args.push('-c:v', encoder.id, ...(plan.videoKbps !== null ? bitrateArgs(encoder, plan.videoKbps, plan.fps) : encoderArgs(encoder, quality, plan.fps * 2)))
  } else throw new Error('No hardware encoder for the export.')
  if (audio) args.push('-c:a', plan.container === 'webm' ? 'libopus' : 'aac', '-b:a', `${plan.audioKbps}k`, '-ac', '2')
  if (plan.container === 'mp4') args.push('-movflags', '+faststart')
  args.push('-shortest', files.out)
  return args
}

/**
 * A GIF in two passes: the first works out the best 256 colours for this clip (palettegen), the
 * second draws the GIF with them (paletteuse). `palette` is where the palette picture goes.
 */
export function ffmpegGifArgs(project: EditProject, plan: ExportPlan, files: ExportFiles, palette: string): { palette: string[]; encode: string[] } {
  const { inputs, graph, video } = buildFilterGraph(project, plan, files)
  const head = ['-hide_banner', '-loglevel', 'error', '-y']
  return {
    palette: [...head, ...inputs.flat(), '-filter_complex', [...graph, `[${video}]palettegen=stats_mode=diff[pal]`].join(';'), '-map', '[pal]', '-frames:v', '1', '-update', '1', palette],
    encode: [
      ...head,
      '-progress',
      'pipe:1',
      '-nostats',
      ...inputs.flat(),
      '-i',
      palette,
      '-filter_complex',
      [...graph, `[${video}][${inputs.length}:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[gif]`].join(';'),
      '-map',
      '[gif]',
      '-loop',
      '0',
      files.out
    ]
  }
}

/** A GIF that came out too large: the next smaller setting to try (narrower first, then fewer frames), null when there is none. */
export function smallerGif(options: ExportOptions): ExportOptions | null {
  if (options.gifWidth === 640) return { ...options, gifWidth: 480 }
  if (options.gifFps === 20) return { ...options, gifFps: 15 }
  if (options.gifFps === 15) return { ...options, gifFps: 10 }
  return null
}

/** Seconds done so far from a block of FFmpeg's `-progress` output. */
export function parseProgress(chunk: string): number | null {
  const matches = [...chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)]
  return matches.length ? Number(matches[matches.length - 1][1]) / 1_000_000 : null
}
