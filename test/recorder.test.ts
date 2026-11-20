import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECORDER,
  ENCODERS,
  captureFilter,
  encoderById,
  encoderProbeArgs,
  estimateMbPerMinute,
  ffmpegRecordArgs,
  hotkeyConflicts,
  mergeRecorderSettings,
  outputSize,
  pickCompatEncoder,
  pickEncoder,
  resolveProfile
} from '../src/shared/recorder'
import { parseCaptureFilter, parseFfmpegVersion, probeEncoders } from '../src/main/recorder/encoders'
import { windowsSupported } from '../src/main/recorder/setup'

const nvencAv1 = encoderById('av1_nvenc')!
const amfHevc = encoderById('hevc_amf')!
const qsvH264 = encoderById('h264_qsv')!

describe('recorder settings', () => {
  it('is off by default', () => {
    expect(DEFAULT_RECORDER.enabled).toBe(false)
    // the whole PC sound by default: game, Discord voice and music, like the moment sounded
    expect(DEFAULT_RECORDER.audio).toEqual({ game: true, source: 'all', mic: false, micVolume: 0.8 })
    expect(DEFAULT_RECORDER.clipSound).toBe(false)
  })

  it('merges nested blocks and keeps values in bounds', () => {
    const merged = mergeRecorderSettings(DEFAULT_RECORDER, {
      enabled: true,
      replaySeconds: 9999,
      fps: 45 as 60,
      quality: 'ultra' as 'high',
      audio: { mic: true },
      autoClips: { death: true },
      storage: { maxGb: 0 }
    })
    expect(merged.enabled).toBe(true)
    expect(merged.replaySeconds).toBe(300)
    expect(merged.fps).toBe(60)
    expect(merged.quality).toBe('compact')
    expect(merged.audio).toEqual({ game: true, source: 'all', mic: true, micVolume: 0.8 })
    expect(merged.autoClips.death).toBe(true)
    expect(merged.autoClips.penta).toBe(true)
    expect(merged.storage).toEqual({ folder: '', maxGb: 30, keepSessionsDays: 7 })
    expect(mergeRecorderSettings(DEFAULT_RECORDER, undefined)).toEqual(DEFAULT_RECORDER)
  })

  it('keeps the sound source valid and moves stored 1.3 settings (no source yet) to the whole PC sound', () => {
    const stored = { audio: { game: true, mic: false, micVolume: 0.5 } } as Parameters<typeof mergeRecorderSettings>[1]
    expect(mergeRecorderSettings(DEFAULT_RECORDER, stored).audio).toEqual({ game: true, source: 'all', mic: false, micVolume: 0.5 })
    expect(mergeRecorderSettings(DEFAULT_RECORDER, { audio: { source: 'game' } }).audio.source).toBe('game')
    expect(mergeRecorderSettings(DEFAULT_RECORDER, { audio: { source: 'desktop' as 'all' } }).audio.source).toBe('all')
  })

  it('finds hotkey conflicts with the augment hotkey and among themselves', () => {
    expect(hotkeyConflicts(DEFAULT_RECORDER.hotkeys, { augment: 'Alt+Shift+A' })).toEqual([])
    expect(hotkeyConflicts({ clip: 'Shift+Alt+a', bookmark: 'Alt+F10', screenshot: '' }, { augment: 'Alt+Shift+A' })).toHaveLength(1)
    expect(hotkeyConflicts({ clip: 'Alt+F9', bookmark: 'alt+f9', screenshot: 'Alt+F11' }, {})).toHaveLength(1)
  })
})

describe('encoders', () => {
  it('prefers AV1, then HEVC, then H.264', () => {
    expect(ENCODERS.map((encoder) => encoder.codec).slice(0, 3)).toEqual(['av1', 'av1', 'av1'])
    expect(pickEncoder(['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'])?.id).toBe('av1_nvenc')
    expect(pickEncoder(['h264_amf', 'hevc_amf'])?.label).toBe('AMD HEVC')
    expect(pickEncoder(['h264_qsv'], 'hevc_nvenc')?.id).toBe('h264_qsv')
    expect(pickEncoder(['h264_nvenc', 'av1_nvenc'], 'h264_nvenc')?.id).toBe('h264_nvenc')
  })

  it('has no software fallback', () => {
    expect(pickEncoder([])).toBeNull()
    expect(pickEncoder(['libx264'])).toBeNull()
    expect(ENCODERS.every((encoder) => /_(nvenc|amf|qsv)$/.test(encoder.id))).toBe(true)
  })

  it('picks H.264 for files that must play everywhere', () => {
    expect(pickCompatEncoder(['av1_nvenc', 'hevc_nvenc', 'h264_nvenc'])?.id).toBe('h264_nvenc')
    expect(pickCompatEncoder(['av1_amf'])?.id).toBe('av1_amf')
  })

  it('probes every encoder and reads version and capture filter', async () => {
    const calls: string[][] = []
    const probe = await probeEncoders(
      'ffmpeg',
      async (_file, args) => {
        calls.push(args)
        if (args.includes('-version')) return { code: 0, stdout: 'ffmpeg version n8.1-12-gabc Copyright', stderr: '' }
        if (args.includes('-filters')) return { code: 0, stdout: ' ... ddagrab           |->V       Grab desktop\n ... gfxcapture        |->V       Capture\n', stderr: '' }
        return { code: args.includes('hevc_nvenc') || args.includes('h264_nvenc') ? 0 : 1, stdout: '', stderr: '' }
      },
      1234
    )
    expect(probe).toEqual({ available: ['hevc_nvenc', 'h264_nvenc'], capture: 'gfxcapture', ffmpegVersion: 'n8.1-12-gabc', testedAt: 1234 })
    expect(calls).toHaveLength(2 + ENCODERS.length)
    expect(encoderProbeArgs('av1_amf')).toContain('testsrc=size=1280x720:rate=30')
  })

  it('falls back to desktop duplication, or nothing', () => {
    expect(parseCaptureFilter(' ... ddagrab           |->V       Grab')).toBe('ddagrab')
    expect(parseCaptureFilter(' ... gdigrab-ish  |->V x')).toBeNull()
    expect(parseFfmpegVersion('nothing')).toBeNull()
  })
})

describe('quality profiles', () => {
  it('scales down to the profile height and keeps sizes even', () => {
    expect(outputSize('compact', { width: 2560, height: 1440 })).toEqual({ width: 1920, height: 1080 })
    expect(outputSize('compact', { width: 1600, height: 900 })).toEqual({ width: 1600, height: 900 })
    expect(outputSize('high', { width: 3840, height: 2160 })).toEqual({ width: 2560, height: 1440 })
    expect(outputSize('original', { width: 3441, height: 1441 })).toEqual({ width: 3442, height: 1442 })
    expect(outputSize('compact', null)).toBeNull()
  })

  it('estimates 45 to 60 MB per minute for compact 1080p60 with AV1 or HEVC', () => {
    const size = { width: 1920, height: 1080 }
    expect(estimateMbPerMinute('compact', 'av1', 60, size)).toBeGreaterThanOrEqual(45)
    expect(estimateMbPerMinute('compact', 'hevc', 60, size)).toBeLessThanOrEqual(60)
    // 1440p60 "High": 12 to 16 Mbit/s
    const high = estimateMbPerMinute('high', 'hevc', 60, { width: 2560, height: 1440 })
    expect((high * 8) / 60).toBeGreaterThan(12)
    expect((high * 8) / 60).toBeLessThan(16.5)
    expect(estimateMbPerMinute('compact', 'hevc', 30, size)).toBeLessThan(estimateMbPerMinute('compact', 'hevc', 60, size))
  })

  it('uses constant quality and a keyframe every second for each vendor', () => {
    expect(resolveProfile('compact', 60, nvencAv1, null).videoArgs).toEqual(['-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '34', '-b:v', '0', '-g', '60'])
    expect(resolveProfile('high', 30, amfHevc, null).videoArgs).toEqual([
      '-usage',
      'transcoding',
      '-quality',
      'balanced',
      '-rc',
      'qvbr',
      '-qvbr_quality_level',
      '25',
      '-g',
      '30'
    ])
    expect(resolveProfile('original', 60, qsvH264, null).videoArgs).toEqual(['-preset', 'medium', '-global_quality', '20', '-g', '60'])
  })
})

describe('ffmpegRecordArgs', () => {
  const profile = resolveProfile('compact', 60, nvencAv1, { width: 2560, height: 1440 })

  it('records the game window by its handle with the sound from the pipe', () => {
    expect(ffmpegRecordArgs(profile, { kind: 'gfxcapture', hwnd: 132456 }, '\\\\.\\pipe\\ratio-audio-1', 'C:\\Videos\\ratioAI\\rec\\42')).toMatchSnapshot()
  })

  it('finds the window by its executable without the helper, and records no sound', () => {
    const args = ffmpegRecordArgs(resolveProfile('original', 30, amfHevc, null), { kind: 'gfxcapture' }, null, '/tmp/rec')
    expect(args).toMatchSnapshot()
    expect(args).not.toContain('aac')
  })

  it('maps GPU frames for Quick Sync and crops the desktop duplication to the window', () => {
    expect(
      ffmpegRecordArgs(resolveProfile('high', 60, qsvH264, null), { kind: 'ddagrab', outputIdx: 1, crop: { x: 320, y: 180, width: 1281, height: 721 } }, 'pipe', 'D:/rec')
    ).toMatchSnapshot()
  })

  it('records a test picture for a limited time (admin tool)', () => {
    expect(ffmpegRecordArgs(profile, { kind: 'testsrc', width: 1920, height: 1080 }, null, '/tmp/t', 20)).toMatchSnapshot()
  })

  it('never downloads frames to the CPU and never uses a software encoder', () => {
    for (const source of [{ kind: 'gfxcapture' as const, hwnd: 1 }, { kind: 'ddagrab' as const, outputIdx: 0, crop: null }]) {
      for (const encoder of ENCODERS) {
        const args = ffmpegRecordArgs(resolveProfile('compact', 60, encoder, null), source, 'pipe', '/r').join(' ')
        expect(args).not.toMatch(/hwdownload|libx26|libsvt|libaom/)
        expect(args).toContain(`-c:v ${encoder.id}`)
      }
    }
    expect(captureFilter({ kind: 'gfxcapture', exe: "it's.exe" }, profile)).toContain("window_exe='^it\\'s\\\\.exe$'")
  })
})

describe('windowsSupported', () => {
  it('needs Windows 10 2004 (build 19041)', () => {
    expect(windowsSupported('win32', '10.0.19041')).toBe(true)
    expect(windowsSupported('win32', '10.0.26100')).toBe(true)
    expect(windowsSupported('win32', '10.0.18363')).toBe(false)
    expect(windowsSupported('linux', '6.8.0')).toBe(false)
  })
})

import {
  autoClipWindows,
  cleanupPlan,
  concatList,
  ffmpegClipArgs,
  mergeClipWindows,
  parseClipUrl,
  parseRange,
  parseSegmentList,
  ringExpired,
  segmentsFor,
  type FeedEvent,
  type Segment,
  type StoredItem
} from '../src/shared/recorder'

/** 2-second segments from 0 s on, like FFmpeg lists them. */
const segs = (count: number, from = 0): Segment[] =>
  Array.from({ length: count }, (_, i) => ({ file: `seg_${String(from + i).padStart(6, '0')}.mp4`, start: (from + i) * 2, end: (from + i + 1) * 2 }))

describe('segments', () => {
  it('parses segments.csv', () => {
    expect(parseSegmentList('seg_000000.mp4,0.000000,2.021354\nseg_000001.mp4,2.021354,4.021354\n\nbroken\n')).toEqual([
      { file: 'seg_000000.mp4', start: 0, end: 2.021354 },
      { file: 'seg_000001.mp4', start: 2.021354, end: 4.021354 }
    ])
    expect(parseSegmentList('')).toEqual([])
  })

  it('picks the segments of a clip and cuts on whole seconds', () => {
    const cut = segmentsFor({ start: 5, end: 11 }, segs(10))!
    expect(cut.segments.map((segment) => segment.file)).toEqual(['seg_000002.mp4', 'seg_000003.mp4', 'seg_000004.mp4', 'seg_000005.mp4'])
    expect(cut).toMatchObject({ offset: 1, duration: 6, start: 5, end: 11 })
  })

  it('handles the edges: exact segment borders', () => {
    const cut = segmentsFor({ start: 4, end: 8 }, segs(10))!
    expect(cut.segments.map((segment) => segment.start)).toEqual([4, 6])
    expect(cut).toMatchObject({ offset: 0, duration: 4, start: 4, end: 8 })
  })

  it('handles the edges: a range that starts before the ring or ends after it', () => {
    // the ring starts at 20 s (older segments are gone)
    const ring = segs(5, 10)
    const early = segmentsFor({ start: 3, end: 23 }, ring)!
    expect(early).toMatchObject({ offset: 0, duration: 3, start: 20, end: 23 })
    const late = segmentsFor({ start: 27, end: 99 }, ring)!
    expect(late.segments.map((segment) => segment.start)).toEqual([26, 28])
    expect(late).toMatchObject({ offset: 1, duration: 3, start: 27, end: 30 })
  })

  it('handles the edges: nothing recorded for the range', () => {
    expect(segmentsFor({ start: 0, end: 10 }, [])).toBeNull()
    expect(segmentsFor({ start: 40, end: 50 }, segs(5))).toBeNull()
    expect(segmentsFor({ start: 5, end: 5 }, segs(5))).toBeNull()
  })

  it('moves a cut inside a second outwards, never inwards', () => {
    const cut = segmentsFor({ start: 5.4, end: 9.2 }, segs(10))!
    expect(cut.start).toBeLessThanOrEqual(5.4)
    expect(cut.end).toBeGreaterThanOrEqual(9.2)
    expect(cut).toMatchObject({ offset: 1, duration: 5 })
  })

  it('builds the concat list and the stream-copy arguments', () => {
    expect(concatList(["C:\\rec\\it's\\seg_1.mp4", 'D:/b.mp4'])).toBe("file 'C:/rec/it'\\''s/seg_1.mp4'\nfile 'D:/b.mp4'\n")
    expect(ffmpegClipArgs('list.txt', 1, 6, 'out.mp4')).toMatchSnapshot()
    const args = ffmpegClipArgs('list.txt', 0, null, 'out.mp4')
    expect(args).not.toContain('-ss')
    expect(args.join(' ')).toContain('-c copy')
  })

  it('drops segments that fell out of the ring but keeps protected ranges', () => {
    const all = segs(40) // 80 s
    const expired = ringExpired(all, 30)
    // newest end 80 → keep from 80 - 30 - 12 = 38
    expect(expired.map((segment) => segment.end)).toEqual(all.filter((segment) => segment.end <= 38).map((segment) => segment.end))
    const guarded = ringExpired(all, 30, [{ start: 9, end: 13 }])
    expect(guarded.some((segment) => segment.start === 8 || segment.start === 10 || segment.start === 12)).toBe(false)
    expect(guarded).toHaveLength(expired.length - 3)
    expect(ringExpired([], 30)).toEqual([])
  })
})

describe('autoClipWindows', () => {
  const ctx = {
    me: 'You#DEV',
    myTeam: 'ORDER',
    lastEventId: 0 as number | null,
    enabled: { penta: true, quadra: true, triple: true, firstBlood: true, ace: true, death: true, gameEnd: true }
  }
  let id = 0
  const event = (name: string, time: number, extra: Partial<FeedEvent> = {}): FeedEvent => ({ EventID: ++id, EventName: name, EventTime: time, ...extra })

  it('clips your multikills with lead-in and lead-out', () => {
    const { windows } = autoClipWindows([event('Multikill', 300, { KillerName: 'You', KillStreak: 3 })], ctx)
    // a triple can still become a quadra for 10 s, so it waits until then
    expect(windows).toEqual([{ kind: 'triple', start: 285, end: 305, title: 'Triple kill', ready: 310 }])
  })

  it('waits for the quadra a triple can still become, so the fight is one clip', () => {
    const first = autoClipWindows([event('Multikill', 300, { KillerName: 'You', KillStreak: 3 })], ctx)
    // the next poll, 8 s later: the triple's lead-out is over, but it isn't ready yet
    const quadra = event('Multikill', 308, { KillerName: 'You', KillStreak: 4 })
    const second = autoClipWindows([quadra], { ...ctx, lastEventId: first.lastEventId })
    const pending = mergeClipWindows([...first.windows, ...second.windows])
    // a quadra may still become a penta for 30 s
    expect(pending).toEqual([{ kind: 'quadra', start: 285, end: 313, title: 'Quadra kill', ready: 338 }])
  })

  it('merges a triple that becomes a quadra and a penta into one pentakill clip', () => {
    const { windows } = autoClipWindows(
      [
        event('Multikill', 400, { KillerName: 'You', KillStreak: 3 }),
        event('Multikill', 404, { KillerName: 'You', KillStreak: 4 }),
        event('Multikill', 409, { KillerName: 'You', KillStreak: 5 }),
        event('Ace', 409, { AcingTeam: 'ORDER' })
      ],
      ctx
    )
    expect(windows).toEqual([{ kind: 'penta', start: 384, end: 415, title: 'Pentakill', ready: 434 }])
  })

  it('keeps moments that are far apart as separate clips', () => {
    const { windows } = autoClipWindows(
      [event('FirstBlood', 95, { Recipient: 'You' }), event('Ace', 600, { AcingTeam: 'ORDER' })],
      ctx
    )
    expect(windows.map((window) => window.kind)).toEqual(['firstBlood', 'ace'])
    expect(mergeClipWindows(windows)).toHaveLength(2)
  })

  it("ignores other players' multikills, enemy aces and switched-off kinds", () => {
    const events = [
      event('Multikill', 500, { KillerName: 'blackbird', KillStreak: 5 }),
      event('Ace', 520, { AcingTeam: 'CHAOS' }),
      event('FirstBlood', 60, { Recipient: 'Guido' }),
      event('Multikill', 700, { KillerName: 'You', KillStreak: 2 }),
      event('Multikill', 800, { KillerName: 'You', KillStreak: 3 })
    ]
    expect(autoClipWindows(events, { ...ctx, enabled: { ...ctx.enabled, triple: false } }).windows).toEqual([])
  })

  it('catches nothing up when the app starts in the middle of a game', () => {
    const events = [event('Multikill', 300, { KillerName: 'You', KillStreak: 5 }), event('Ace', 310, { AcingTeam: 'ORDER' })]
    const first = autoClipWindows(events, { ...ctx, lastEventId: null })
    expect(first.windows).toEqual([])
    expect(first.lastEventId).toBe(events[1].EventID)
    // the next poll only sees what is new
    const later = [...events, event('Multikill', 500, { KillerName: 'You', KillStreak: 4 })]
    const second = autoClipWindows(later, { ...ctx, lastEventId: first.lastEventId })
    expect(second.windows.map((window) => window.kind)).toEqual(['quadra'])
    expect(autoClipWindows(later, { ...ctx, lastEventId: second.lastEventId }).windows).toEqual([])
  })

  it('clips your death only at the end of a team fight, and the end of the game', () => {
    const lonely = [event('ChampionKill', 200, { KillerName: 'Guido', VictimName: 'You' })]
    expect(autoClipWindows(lonely, ctx).windows).toEqual([])
    const fight = [
      event('ChampionKill', 300, { KillerName: 'You', VictimName: 'Guido' }),
      event('ChampionKill', 305, { KillerName: 'simwai', VictimName: 'Toni' }),
      event('ChampionKill', 310, { KillerName: 'simwai', VictimName: 'You' }),
      event('GameEnd', 1500, { Result: 'Win' })
    ]
    expect(autoClipWindows(fight, ctx).windows).toEqual([
      { kind: 'death', start: 290, end: 313, title: 'Died in a team fight', ready: 313 },
      { kind: 'gameEnd', start: 1480, end: 1503, title: 'End of the game', ready: 1503 }
    ])
  })
})

describe('cleanupPlan', () => {
  const day = 86_400_000
  const now = 100 * day
  const item = (path: string, type: StoredItem['type'], ageDays: number, extra: Partial<StoredItem> = {}): StoredItem => ({
    path,
    type,
    bytes: 1e9,
    at: now - ageDays * day,
    ...extra
  })
  const items = [
    item('clip-old', 'clip', 300),
    item('clip-fav', 'clip', 200, { favorite: true }),
    item('session-new', 'session', 2),
    item('session-old', 'session', 10),
    item('session-older', 'session', 20),
    item('session-kept', 'session', 50, { kept: true }),
    item('ring-b', 'replay', 1),
    item('ring-a', 'replay', 3),
    item('ring-running', 'replay', 0, { active: true })
  ]

  it('deletes replay leftovers first, then expired sessions, oldest first', () => {
    const plan = cleanupPlan(items, { maxBytes: 30e9, keepSessionsDays: 7 }, now)
    expect(plan.delete.map((entry) => entry.path)).toEqual(['ring-a', 'ring-b', 'session-older', 'session-old'])
    expect(plan.freedBytes).toBe(4e9)
    expect(plan.usedAfter).toBe(5e9)
    expect(plan.overQuota).toBe(false)
  })

  it('never deletes clips, favorites, kept sessions or the running recording, even above the limit', () => {
    const plan = cleanupPlan(items, { maxBytes: 1e9, keepSessionsDays: 7 }, now)
    const paths = plan.delete.map((entry) => entry.path)
    for (const safe of ['clip-old', 'clip-fav', 'session-kept', 'session-new', 'ring-running']) expect(paths).not.toContain(safe)
    expect(plan.overQuota).toBe(true)
  })

  it('has nothing to do in an empty folder', () => {
    expect(cleanupPlan([], { maxBytes: 1, keepSessionsDays: 7 }, now)).toEqual({ delete: [], freedBytes: 0, usedAfter: 0, overQuota: false })
  })
})

describe('rcclip protocol helpers', () => {
  it('parses byte ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseRange('bytes=5-2', 1000)).toBe('invalid')
  })

  it('accepts ids only, never paths', () => {
    expect(parseClipUrl('rcclip://clip/12')).toEqual({ kind: 'clip', id: '12' })
    expect(parseClipUrl('rcclip://thumb/7?v=3')).toEqual({ kind: 'thumb', id: '7' })
    expect(parseClipUrl('rcclip://clip/../../windows/system32')).toBeNull()
    expect(parseClipUrl('rcclip://clip/C:%5Csecret.mp4')).toBeNull()
    expect(parseClipUrl('rcclip://file/1')).toBeNull()
    expect(parseClipUrl('file:///C:/a.mp4')).toBeNull()
  })
})
