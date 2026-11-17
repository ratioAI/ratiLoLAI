import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPORT,
  appendClip,
  bitrateForSize,
  buildFilterGraph,
  cropRect,
  estimateExportMb,
  fadeAlpha,
  ffmpegExportArgs,
  ffmpegGifArgs,
  filterPath,
  frameSize,
  layoutText,
  movePart,
  newProject,
  normalizeProject,
  parseProgress,
  partAt,
  planExport,
  projectDuration,
  removePart,
  smallerGif,
  splitAt,
  timeline,
  wrapText,
  type EditProject,
  type ExportFiles
} from '../src/shared/editProject'
import { encoderById } from '../src/shared/recorder'

const files: ExportFiles = {
  clips: { 1: 'C:/clips/a.mp4', 2: 'C:/clips/b.mp4' },
  withAudio: [1],
  texts: { top: 'C:/tmp/top.txt', box: 'C:/tmp/box.txt' },
  images: { crown: 'C:/tmp/crown.png', stats: 'C:/tmp/stats.png' },
  music: 'C:/music/song.mp3',
  font: 'C:\\Program Files\\ratioAI\\resources\\fonts\\Anton-Regular.ttf',
  out: 'C:/clips/exports/out.mp4'
}

/** Two parts of clip 1 (the second in slow motion), then clip 2 with a fade; text, sticker, stats, music. */
function montage(): EditProject {
  let project = newProject(1, 20)
  project = splitAt(project, 8)
  project.clips[1] = { ...project.clips[1], out: 12, speed: 0.5 }
  project = appendClip(project, 2, 10, 'fade')
  project.texts = [
    { id: 'top', kind: 'top', text: 'pentakill', x: 0.5, y: 0.5, size: 0.09, color: '#ffffff', start: 0, end: null, fade: 0 },
    { id: 'box', kind: 'box', text: 'watch the Lux', x: 0.25, y: 0.7, size: 0.05, color: '#ffe66d', start: 2, end: 9, fade: 0.5 }
  ]
  project.stickers = [{ id: 'crown', src: 'emoji:1f451', x: 0.8, y: 0.2, scale: 0.12, start: 1, end: 6 }]
  project.overlays.stats = { championId: 99, kda: [12, 3, 9], win: true, corner: 'tl' }
  project.music = { file: 'C:/music/song.mp3', name: 'song', offset: 12, volume: 0.6, duck: true, fadeIn: 1, fadeOut: 2 }
  return project
}

describe('timeline', () => {
  it('starts as the whole clip', () => {
    const project = newProject(7, 30)
    expect(project.clips).toEqual([{ clipId: 7, in: 0, out: 30, speed: 1 }])
    expect(projectDuration(project)).toBe(30)
    expect(project.output).toEqual(DEFAULT_EXPORT)
  })

  it('slow motion makes a part longer and fades overlap', () => {
    const project = montage()
    const parts = timeline(project)
    // 8 s, then 4 s at half speed = 8 s, then 10 s that overlaps 0.4 s
    expect(parts.map((entry) => [entry.start, entry.end])).toEqual([
      [0, 8],
      [8, 16],
      [15.6, 25.6]
    ])
    expect(projectDuration(project)).toBeCloseTo(25.6)
    expect(partAt(project, 10)).toMatchObject({ clipTime: 9, part: { index: 1 } })
    expect(partAt(project, 15.8)?.part.index).toBe(2)
    expect(partAt(project, 999)?.part.index).toBe(2)
  })

  it('splits, removes and moves parts and keeps one transition between every two', () => {
    let project = newProject(1, 20)
    project = splitAt(project, 5)
    project = splitAt(project, 12)
    expect(project.clips.map((part) => [part.in, part.out])).toEqual([
      [0, 5],
      [5, 12],
      [12, 20]
    ])
    expect(project.transitions).toEqual(['cut', 'cut'])
    // a cut that would leave a sliver does nothing
    expect(splitAt(project, 5.05)).toBe(project)
    project.transitions = ['fade', 'glitch']
    const removed = removePart(project, 1)
    expect(removed.clips.map((part) => part.in)).toEqual([0, 12])
    expect(removed.transitions).toEqual(['glitch'])
    expect(removePart(newProject(1, 5), 0).clips).toHaveLength(1)
    expect(movePart(project, 0, 1).clips.map((part) => part.in)).toEqual([5, 0, 12])
    expect(movePart(project, 0, -1)).toBe(project)
  })

  it('repairs stored projects', () => {
    expect(normalizeProject(null)).toBeNull()
    expect(normalizeProject({ clips: [] })).toBeNull()
    const repaired = normalizeProject({
      clips: [
        { clipId: 1, in: 0, out: 5, speed: 3 },
        { clipId: 1, in: 5, out: 5.01, speed: 1 },
        { clipId: 2, in: 0, out: 4, speed: 0.25 }
      ],
      crop: { aspect: 'cinema', x: 7, y: -1 },
      transitions: ['wipe'],
      output: { preset: 'tiktok', targetMb: 0, gifFps: 99 }
    })!
    expect(repaired.clips).toEqual([
      { clipId: 1, in: 0, out: 5, speed: 1 },
      { clipId: 2, in: 0, out: 4, speed: 0.25 }
    ])
    expect(repaired.crop).toEqual({ aspect: '16:9', x: 1, y: 0 })
    expect(repaired.transitions).toEqual(['cut'])
    expect(repaired.output).toEqual({ preset: 'discord', targetMb: 20, gifFps: 15, gifWidth: 480 })
    expect(normalizeProject(JSON.parse(JSON.stringify(montage())))).toEqual(montage())
  })
})

describe('picture', () => {
  it('sizes the three formats', () => {
    expect(frameSize('16:9', 1080)).toEqual({ width: 1920, height: 1080 })
    expect(frameSize('9:16', 1080)).toEqual({ width: 1080, height: 1920 })
    expect(frameSize('1:1', 1080)).toEqual({ width: 1080, height: 1080 })
  })

  it('crops the largest window of the format and moves it', () => {
    const source = { width: 1920, height: 1080 }
    expect(cropRect(source, { aspect: '16:9', x: 0.5, y: 0.5 })).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
    expect(cropRect(source, { aspect: '9:16', x: 0.5, y: 0.5 })).toEqual({ x: 656.25, y: 0, width: 607.5, height: 1080 })
    expect(cropRect(source, { aspect: '9:16', x: 1, y: 0 }).x).toBe(1312.5)
    expect(cropRect(source, { aspect: '1:1', x: 0, y: 0.5 })).toEqual({ x: 0, y: 0, width: 1080, height: 1080 })
  })

  it('wraps text at spaces and breaks words that are too long', () => {
    expect(wrapText('zero ten powerspike incoming', 12)).toEqual(['zero ten', 'powerspike', 'incoming'])
    expect(wrapText('aaaaaaaaaaaaaaaaaaaa b', 8)).toEqual(['aaaaaaaa', 'aaaaaaaa', 'aaaa b'])
    expect(wrapText('one\ntwo', 20)).toEqual(['one', 'two'])
    expect(wrapText('', 10)).toEqual([''])
  })

  it('lays out meme text at the top and bottom in upper case and boxes where they were put', () => {
    const frame = { width: 1920, height: 1080 }
    const base = { id: 't', text: 'pentakill', x: 0.25, y: 0.5, size: 0.1, color: '#fff', start: 0, end: null, fade: 0 }
    const top = layoutText({ ...base, kind: 'top' }, frame)
    expect(top).toMatchObject({ lines: ['PENTAKILL'], fontSize: 108, centerX: 960, top: 43, upper: true })
    const bottom = layoutText({ ...base, kind: 'bottom' }, frame)
    expect(bottom.top).toBe(1080 - 43 - bottom.lineHeight)
    const box = layoutText({ ...base, kind: 'box' }, frame)
    expect(box).toMatchObject({ lines: ['pentakill'], centerX: 480, upper: false })
    expect(box.top).toBe(Math.round(540 - box.lineHeight / 2))
  })

  it('fades in and out', () => {
    expect(fadeAlpha(1, 2, 8, 1)).toBe(0)
    expect(fadeAlpha(2.5, 2, 8, 1)).toBe(0.5)
    expect(fadeAlpha(5, 2, 8, 1)).toBe(1)
    expect(fadeAlpha(7.75, 2, 8, 1)).toBe(0.25)
    expect(fadeAlpha(5, 2, 8, 0)).toBe(1)
  })
})

describe('bitrateForSize', () => {
  it('fits the file into the size with the sound and a reserve', () => {
    // 30 s into 20 MB: 20 MiB * 8 * 0.96 / 30 s = 5368 kbit/s in total
    expect(bitrateForSize(30, 20, 128)).toBe(5240)
    const kbps = bitrateForSize(90, 20, 128)
    expect(((kbps + 128) * 1000 * 90) / 8).toBeLessThan(20 * 1024 * 1024)
    expect(bitrateForSize(60, 100, 128)).toBeGreaterThan(bitrateForSize(60, 20, 128) * 4)
  })

  it('never goes below a floor, even for very long clips', () => {
    expect(bitrateForSize(3600, 20, 128)).toBe(150)
    expect(bitrateForSize(0, 20, 128)).toBeGreaterThan(100_000)
  })
})

describe('export plans', () => {
  it('Discord: 1080p60 for short clips, 720p and 480p as the bits get fewer', () => {
    const plan = (seconds: number, targetMb = 20) => planExport(newProject(1, seconds), { ...DEFAULT_EXPORT, targetMb })
    expect(plan(20)).toMatchObject({ width: 1920, height: 1080, fps: 60, container: 'mp4' })
    // a very short clip does not use the whole 20 MB
    expect(plan(5).videoKbps).toBe(12_000)
    expect(estimateExportMb(newProject(1, 5), plan(5))).toBeLessThan(8)
    expect(plan(60)).toMatchObject({ width: 1280, height: 720, fps: 60 })
    expect(plan(180)).toMatchObject({ width: 854, height: 480, fps: 30 })
    // a boosted server: 100 MB keeps 1080p for a minute
    expect(plan(60, 100)).toMatchObject({ width: 1920, height: 1080 })
    const project = newProject(1, 60)
    expect(estimateExportMb(project, plan(60))).toBeLessThanOrEqual(20)
    expect(estimateExportMb(project, plan(60))).toBeGreaterThan(19)
  })

  it('the other presets', () => {
    const project = newProject(1, 30)
    expect(planExport(project, { ...DEFAULT_EXPORT, preset: 'hq' })).toMatchObject({ width: 1920, height: 1080, videoKbps: null, container: 'mp4' })
    expect(planExport(project, { ...DEFAULT_EXPORT, preset: 'short' })).toMatchObject({ width: 1080, height: 1920, aspect: '9:16' })
    expect(planExport(project, { ...DEFAULT_EXPORT, preset: 'webm' })).toMatchObject({ container: 'webm' })
    expect(planExport(project, { ...DEFAULT_EXPORT, preset: 'gif', gifWidth: 640, gifFps: 20 })).toMatchObject({ width: 640, height: 360, fps: 20, container: 'gif', audioKbps: 0 })
    expect(planExport({ ...project, crop: { aspect: '1:1', x: 0.5, y: 0.5 } }, { ...DEFAULT_EXPORT, preset: 'gif' })).toMatchObject({ width: 480, height: 480 })
    expect(smallerGif({ ...DEFAULT_EXPORT, preset: 'gif', gifWidth: 640, gifFps: 20 })).toMatchObject({ gifWidth: 480, gifFps: 20 })
    expect(smallerGif({ ...DEFAULT_EXPORT, preset: 'gif', gifWidth: 480, gifFps: 10 })).toBeNull()
  })
})

describe('ffmpegExportArgs', () => {
  it('builds the filter graph of a montage with text, sticker, stats and ducked music', () => {
    const project = montage()
    const plan = planExport(project, { ...DEFAULT_EXPORT, preset: 'hq' })
    expect(buildFilterGraph(project, plan, files)).toMatchSnapshot()
  })

  it('Discord preset: H.264 hardware encoder at the worked-out bitrate', () => {
    const project = montage()
    const plan = planExport(project)
    const args = ffmpegExportArgs(project, plan, files, encoderById('h264_nvenc'))
    expect(args).toMatchSnapshot()
    expect(args.join(' ')).toContain(`-b:v ${plan.videoKbps}k`)
    expect(args.join(' ')).toContain('-movflags +faststart')
  })

  it('9:16 short: crops instead of squeezing', () => {
    const project = { ...newProject(1, 10), crop: { aspect: '16:9' as const, x: 0.3, y: 0.5 } }
    const args = ffmpegExportArgs(project, planExport(project, { ...DEFAULT_EXPORT, preset: 'short' }), files, encoderById('hevc_amf')).join(' ')
    expect(args).toContain("crop=w='min(iw,ih*0.563)':h='min(ih,iw/0.563)':x='(iw-ow)*0.3'")
    expect(args).toContain('scale=1080:1920')
    expect(args).toContain('-c:v hevc_amf')
  })

  it('a clip without sound gets silence, so the parts still join', () => {
    const project = appendClip(newProject(1, 5), 2, 5)
    const { graph } = buildFilterGraph(project, planExport(project, { ...DEFAULT_EXPORT, preset: 'hq' }), files)
    expect(graph.some((line) => line.startsWith('[0:a]atrim'))).toBe(true)
    expect(graph.some((line) => line.startsWith('anullsrc') && line.endsWith('[a1]'))).toBe(true)
  })

  it('WebM: AV1 on the GPU when there is one, VP9 otherwise', () => {
    const project = newProject(1, 10)
    const plan = planExport(project, { ...DEFAULT_EXPORT, preset: 'webm' })
    const out = { ...files, out: 'out.webm' }
    expect(ffmpegExportArgs(project, plan, out, encoderById('av1_nvenc')).join(' ')).toContain('-c:v av1_nvenc')
    const vp9 = ffmpegExportArgs(project, plan, out, encoderById('h264_nvenc')).join(' ')
    expect(vp9).toContain('-c:v libvpx-vp9')
    expect(vp9).toContain('-c:a libopus')
    expect(() => ffmpegExportArgs(project, planExport(project, { ...DEFAULT_EXPORT, preset: 'hq' }), files, null)).toThrow(/hardware encoder/)
  })

  it('GIF: two passes with palettegen and paletteuse, no sound', () => {
    const project = montage()
    const plan = planExport(project, { ...DEFAULT_EXPORT, preset: 'gif' })
    const gif = ffmpegGifArgs(project, plan, { ...files, out: 'out.gif' }, 'palette.png')
    expect(gif.palette.join(' ')).toContain('palettegen=stats_mode=diff[pal]')
    expect(gif.palette[gif.palette.length - 1]).toBe('palette.png')
    expect(gif.encode.join(' ')).toMatch(/\[\d+:v\]paletteuse=dither=bayer/)
    expect(gif.encode.join(' ')).toContain('fps=15')
    expect(gif.encode.join(' ')).not.toMatch(/amix|aac|\[0:a\]/)
    expect(gif.encode).toMatchSnapshot()
  })

  it('escapes paths for filters and reads progress', () => {
    expect(filterPath("C:\\it's\\font.ttf")).toBe("'C\\:/it\\'s/font.ttf'")
    expect(parseProgress('frame=10\nout_time_us=1500000\nprogress=continue\nout_time_us=2250000\n')).toBe(2.25)
    expect(parseProgress('frame=10\n')).toBeNull()
  })
})
