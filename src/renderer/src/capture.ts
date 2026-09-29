/**
 * Hidden capture page. Keeps one low-frame-rate desktop stream per screen open while the main
 * process needs pictures (augment choice, minimap), and hands out cropped / scaled frames on request.
 *
 * Why not desktopCapturer.getSources()? Every call spins up a new screen capturer (DXGI duplication
 * on Windows), copies every screen at full size and scales it on the CPU – the game stutters each
 * time. A running stream keeps the capturer alive and only delivers `fps` frames per second.
 */
import type { CaptureCommand, CaptureRegion, CaptureReply } from '@shared/capture'

interface Stream {
  sourceId: string
  video: HTMLVideoElement
  stream: MediaStream
}

const streams = new Map<number, Stream>()
const canvas = new OffscreenCanvas(1, 1)
const ctx = canvas.getContext('2d', { willReadFrequently: true })!

async function open(displayId: number, sourceId: string, width: number, height: number, fps: number): Promise<void> {
  const cur = streams.get(displayId)
  if (cur && cur.sourceId === sourceId) {
    // only the frame rate changes → no need to restart the capturer
    await cur.stream
      .getVideoTracks()[0]
      ?.applyConstraints({ frameRate: { max: fps } } as MediaTrackConstraints)
      .catch(() => undefined)
    return
  }
  close(displayId)
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: width,
        maxHeight: height,
        maxFrameRate: fps
      }
    } as unknown as MediaTrackConstraints
  })
  const video = document.createElement('video')
  video.muted = true
  video.srcObject = stream
  await video.play()
  streams.set(displayId, { sourceId, video, stream })
}

function close(displayId: number): void {
  const s = streams.get(displayId)
  if (!s) return
  s.stream.getTracks().forEach((t) => t.stop())
  s.video.srcObject = null
  streams.delete(displayId)
}

async function waitForFrame(video: HTMLVideoElement): Promise<void> {
  const start = performance.now()
  while (video.readyState < 2 || !video.videoWidth) {
    if (performance.now() - start > 3000) throw new Error('no frame from the screen stream')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function grab(displayId: number, regions: CaptureRegion[]): Promise<CaptureReply> {
  const s = streams.get(displayId)
  if (!s) throw new Error(`no stream for display ${displayId}`)
  await waitForFrame(s.video)
  const W = s.video.videoWidth
  const H = s.video.videoHeight
  const frames = regions.map((r) => {
    const sx = r.x * W
    const sy = r.y * H
    const sw = r.w * W
    const sh = r.h * H
    const ow = Math.max(1, Math.round(r.outW ?? sw))
    const oh = Math.max(1, Math.round(r.outH ?? (sh * ow) / sw))
    canvas.width = ow
    canvas.height = oh
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'medium'
    ctx.drawImage(s.video, sx, sy, sw, sh, 0, 0, ow, oh)
    const img = ctx.getImageData(0, 0, ow, oh)
    return { width: ow, height: oh, data: new Uint8Array(img.data.buffer) }
  })
  return { ok: true, frameWidth: W, frameHeight: H, frames }
}

async function handle(cmd: CaptureCommand): Promise<CaptureReply> {
  switch (cmd.type) {
    case 'open':
      for (const id of [...streams.keys()]) if (!cmd.streams.some((s) => s.displayId === id)) close(id)
      for (const s of cmd.streams) await open(s.displayId, s.sourceId, s.width, s.height, s.fps)
      return { ok: true }
    case 'close':
      for (const id of [...streams.keys()]) close(id)
      return { ok: true }
    case 'grab':
      return grab(cmd.displayId, cmd.regions)
  }
}

window.rcCapture?.onCommand((id, cmd) => {
  handle(cmd)
    .then((r) => window.rcCapture!.reply(id, r))
    .catch((e: unknown) => window.rcCapture!.reply(id, { ok: false, error: e instanceof Error ? e.message : String(e) }))
})
