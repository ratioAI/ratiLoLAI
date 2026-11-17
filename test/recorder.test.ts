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
    expect(DEFAULT_RECORDER.audio).toEqual({ game: true, mic: false, micVolume: 0.8 })
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
    expect(merged.audio).toEqual({ game: true, mic: true, micVolume: 0.8 })
    expect(merged.autoClips.death).toBe(true)
    expect(merged.autoClips.penta).toBe(true)
    expect(merged.storage).toEqual({ folder: '', maxGb: 30, keepSessionsDays: 7 })
    expect(mergeRecorderSettings(DEFAULT_RECORDER, undefined)).toEqual(DEFAULT_RECORDER)
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
