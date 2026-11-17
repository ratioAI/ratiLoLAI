/**
 * Drawing for the Clips editor: texts, stickers and the stats overlay on a canvas. The live preview
 * uses these on top of the video; for the export the same functions draw each sticker and the
 * stats overlay into their own transparent picture, which FFmpeg then lays over the video.
 */
import type { StaticData } from '@shared/types'
import { fadeAlpha, layoutText, type EditProject, type StatsOverlay, type StickerItem, type TextItem } from '@shared/editProject'
import { api } from './api'
import { img } from './img'

/** The emoji stickers that come with the app (Twemoji), by code point. */
const EMOJI_URLS = import.meta.glob<string>('../assets/stickers/*.svg', { eager: true, query: '?url', import: 'default' })
export const emojiUrl = (code: string): string | null => EMOJI_URLS[`../assets/stickers/${code}.svg`] ?? null

const images = new Map<string, HTMLImageElement | 'loading' | 'failed'>()

/** A picture by URL, loaded once. Returns null until it is there; `onLoad` fires when it arrives. */
export function loadImage(url: string, onLoad?: () => void): HTMLImageElement | null {
  const known = images.get(url)
  if (known instanceof HTMLImageElement) return known
  if (known) return null
  images.set(url, 'loading')
  const image = new Image()
  // so the canvas stays readable when the picture goes into an export
  image.crossOrigin = 'anonymous'
  image.onload = () => {
    images.set(url, image)
    onLoad?.()
  }
  image.onerror = () => images.set(url, 'failed')
  image.src = url
  return null
}

const stickerUrls = new Map<string, string | null>()

/** The URL of a sticker: a built-in emoji or a picture the user imported (resolved once through the main process). */
export function stickerUrl(src: string, onReady?: () => void): string | null {
  if (src.startsWith('emoji:')) return emojiUrl(src.slice(6))
  if (/^(blob:|data:|https?:|rcclip:|\.?\/?demo\/)/.test(src)) return src
  if (stickerUrls.has(src)) return stickerUrls.get(src) ?? null
  stickerUrls.set(src, null)
  void api.mediaUrl(src).then((url) => {
    stickerUrls.set(src, url)
    onReady?.()
  })
  return null
}

export function drawText(ctx: CanvasRenderingContext2D, item: TextItem, frame: { width: number; height: number }, alpha = 1): void {
  if (!item.text.trim() || alpha <= 0) return
  const layout = layoutText(item, frame)
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `${layout.fontSize}px Anton, Impact, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#000'
  ctx.lineWidth = layout.outline * 2
  ctx.fillStyle = item.kind === 'box' ? item.color : '#fff'
  layout.lines.forEach((line, index) => {
    const y = layout.top + index * layout.lineHeight
    ctx.strokeText(line, layout.centerX, y)
    ctx.fillText(line, layout.centerX, y)
  })
  ctx.restore()
}

/** Where a sticker sits in a frame: centre at (x, y), `scale` of the frame's width wide. */
export function stickerRect(sticker: StickerItem, image: HTMLImageElement, frame: { width: number; height: number }) {
  const width = frame.width * Math.min(1, Math.max(0.02, sticker.scale))
  const height = (width * (image.naturalHeight || 1)) / (image.naturalWidth || 1)
  return { x: sticker.x * frame.width - width / 2, y: sticker.y * frame.height - height / 2, width, height }
}

export function drawSticker(ctx: CanvasRenderingContext2D, sticker: StickerItem, frame: { width: number; height: number }, onLoad?: () => void): void {
  const url = stickerUrl(sticker.src, onLoad)
  const image = url ? loadImage(url, onLoad) : null
  if (!image) return
  const rect = stickerRect(sticker, image, frame)
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height)
}

/** Champion icon, K/D/A and result in a corner of the picture. */
export function drawStats(ctx: CanvasRenderingContext2D, stats: StatsOverlay, frame: { width: number; height: number }, icon: HTMLImageElement | null): void {
  const unit = Math.min(frame.width, frame.height) / 1080
  const height = 108 * unit
  const pad = 14 * unit
  ctx.save()
  ctx.font = `${52 * unit}px Anton, Impact, sans-serif`
  const kda = `${stats.kda[0]} / ${stats.kda[1]} / ${stats.kda[2]}`
  const textWidth = Math.max(ctx.measureText(kda).width, 150 * unit)
  const width = pad * 3 + (height - pad * 2) + textWidth
  const margin = 28 * unit
  const x = stats.corner.endsWith('l') ? margin : frame.width - margin - width
  const y = stats.corner.startsWith('t') ? margin : frame.height - margin - height
  ctx.beginPath()
  ctx.roundRect(x, y, width, height, 18 * unit)
  ctx.fillStyle = 'rgba(12, 8, 24, 0.82)'
  ctx.fill()
  ctx.lineWidth = 3 * unit
  ctx.strokeStyle = stats.win ? '#5fb4ff' : '#ff7a62'
  ctx.stroke()
  const size = height - pad * 2
  if (icon) {
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x + pad, y + pad, size, size, 12 * unit)
    ctx.clip()
    ctx.drawImage(icon, x + pad, y + pad, size, size)
    ctx.restore()
  }
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#fff'
  ctx.fillText(kda, x + pad * 2 + size, y + pad - 4 * unit)
  ctx.font = `${24 * unit}px Anton, Impact, sans-serif`
  ctx.fillStyle = stats.win ? '#5fb4ff' : '#ff7a62'
  ctx.fillText(stats.win ? 'VICTORY' : 'DEFEAT', x + pad * 2 + size, y + pad + 54 * unit)
  ctx.restore()
}

export const championIconUrl = (data: StaticData | null, championId: number): string | null => (data ? img.champion(data, championId) || null : null)

/** Everything that lies over the video at `time`: stats, stickers, texts (in this order, like the export). */
export function drawOverlays(
  ctx: CanvasRenderingContext2D,
  project: EditProject,
  frame: { width: number; height: number },
  time: number,
  duration: number,
  data: StaticData | null,
  onLoad?: () => void
): void {
  for (const sticker of project.stickers) {
    if (time >= sticker.start && time <= (sticker.end ?? duration)) drawSticker(ctx, sticker, frame, onLoad)
  }
  if (project.overlays.stats) {
    const url = championIconUrl(data, project.overlays.stats.championId)
    drawStats(ctx, project.overlays.stats, frame, url ? loadImage(url, onLoad) : null)
  }
  for (const text of project.texts) drawText(ctx, text, frame, fadeAlpha(time, text.start, text.end ?? duration, text.fade))
}

function waitForImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const ready = loadImage(url, () => resolve(loadImage(url)))
    if (ready) resolve(ready)
    // a picture that cannot be loaded (offline, gone) is left out
    setTimeout(() => resolve(loadImage(url)), 6000)
  })
}

/**
 * The pictures an export needs, as PNG data URLs: every sticker at the size it has in the output,
 * and the stats overlay as a whole transparent frame. A picture the canvas may not read back (no
 * CORS) is skipped rather than failing the export.
 */
export async function renderExportImages(project: EditProject, frame: { width: number; height: number }, data: StaticData | null): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await document.fonts.load('40px Anton').catch(() => undefined)
  for (const sticker of project.stickers) {
    const url = await new Promise<string | null>((resolve) => {
      const known = stickerUrl(sticker.src, () => resolve(stickerUrl(sticker.src)))
      if (known || sticker.src.startsWith('emoji:')) resolve(known)
      setTimeout(() => resolve(stickerUrl(sticker.src)), 3000)
    })
    const image = url ? await waitForImage(url) : null
    if (!image) continue
    const rect = stickerRect(sticker, image, frame)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.round(rect.width))
    canvas.height = Math.max(2, Math.round(rect.height))
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
    try {
      out[sticker.id] = canvas.toDataURL('image/png')
    } catch {
      // tainted canvas
    }
  }
  if (project.overlays.stats) {
    const url = championIconUrl(data, project.overlays.stats.championId)
    const canvas = document.createElement('canvas')
    canvas.width = frame.width
    canvas.height = frame.height
    const draw = (icon: HTMLImageElement | null): string => {
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      drawStats(ctx, project.overlays.stats!, frame, icon)
      return canvas.toDataURL('image/png')
    }
    try {
      out.stats = draw(url ? await waitForImage(url) : null)
    } catch {
      out.stats = draw(null)
    }
  }
  return out
}

/** Loudness over time of a media file, `buckets` values from 0 to 1, for the waveform on the timeline. */
export async function loadPeaks(url: string, buckets = 600): Promise<number[] | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const context = new AudioContext()
    const buffer = await context.decodeAudioData(await response.arrayBuffer())
    void context.close()
    const samples = buffer.getChannelData(0)
    const step = Math.max(1, Math.floor(samples.length / buckets))
    const peaks: number[] = []
    for (let i = 0; i < buckets; i++) {
      let peak = 0
      for (let j = i * step; j < Math.min(samples.length, (i + 1) * step); j += 8) peak = Math.max(peak, Math.abs(samples[j]))
      peaks.push(peak)
    }
    const max = Math.max(0.05, ...peaks)
    return peaks.map((peak) => peak / max)
  } catch {
    return null
  }
}
