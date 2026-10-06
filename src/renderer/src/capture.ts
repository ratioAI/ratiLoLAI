/**
 * Hidden capture page. Keeps one low-frame-rate desktop stream per screen open while the main
 * process needs frames (augment choice, minimap), and hands out cropped and scaled frames on request.
 *
 * Why not desktopCapturer.getSources()? Every call spins up a new screen capturer (DXGI duplication
 * on Windows), copies every screen at full size and scales it on the CPU, and the game stutters each
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
  const current = streams.get(displayId)
  if (current && current.sourceId === sourceId) {
    // only the frame rate changed, no need to restart the capturer
    await current.stream
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
  const entry = streams.get(displayId)
  if (!entry) return
  entry.stream.getTracks().forEach((track) => track.stop())
  entry.video.srcObject = null
  streams.delete(displayId)
}

async function waitForFrame(video: HTMLVideoElement): Promise<void> {
  const start = performance.now()
  // readyState 2 = HAVE_CURRENT_DATA
  while (video.readyState < 2 || !video.videoWidth) {
    if (performance.now() - start > 3000) throw new Error('no frame from the screen stream')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function grab(displayId: number, regions: CaptureRegion[]): Promise<CaptureReply> {
  const entry = streams.get(displayId)
  if (!entry) throw new Error(`no stream for display ${displayId}`)
  await waitForFrame(entry.video)
  const W = entry.video.videoWidth
  const H = entry.video.videoHeight
  const frames = regions.map((region) => {
    // source rect in video pixels (sx/sy/sw/sh as in drawImage)
    const sx = region.x * W
    const sy = region.y * H
    const sw = region.w * W
    const sh = region.h * H
    // output size, height follows the aspect ratio when only outW is given
    const outW = Math.max(1, Math.round(region.outW ?? sw))
    const outH = Math.max(1, Math.round(region.outH ?? (sh * outW) / sw))
    canvas.width = outW
    canvas.height = outH
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'medium'
    ctx.drawImage(entry.video, sx, sy, sw, sh, 0, 0, outW, outH)
    const imageData = ctx.getImageData(0, 0, outW, outH)
    return { width: outW, height: outH, data: new Uint8Array(imageData.data.buffer) }
  })
  return { ok: true, frameWidth: W, frameHeight: H, frames }
}

async function handle(command: CaptureCommand): Promise<CaptureReply> {
  switch (command.type) {
    case 'open':
      for (const id of [...streams.keys()]) if (!command.streams.some((wanted) => wanted.displayId === id)) close(id)
      for (const wanted of command.streams) await open(wanted.displayId, wanted.sourceId, wanted.width, wanted.height, wanted.fps)
      return { ok: true }
    case 'close':
      for (const id of [...streams.keys()]) close(id)
      return { ok: true }
    case 'grab':
      return grab(command.displayId, command.regions)
  }
}

window.rcCapture?.onCommand((id, command) => {
  handle(command)
    .then((reply) => window.rcCapture!.reply(id, reply))
    .catch((err: unknown) => window.rcCapture!.reply(id, { ok: false, error: err instanceof Error ? err.message : String(err) }))
})
