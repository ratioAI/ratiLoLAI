import { desktopCapturer, nativeImage, screen, type Display } from 'electron'
import type { AugmentOffer } from '@shared/types'
import { cardRects, cardsVisible, matchAugment, prepareTitle, titleRects, type Bitmap, type NameCandidate } from './detect'
import { TitleOcr } from './ocr'

const INTERVAL_MS = 1000

/**
 * Watches the screen(s) during ARAM: Mayhem and recognises the three offered augment cards
 * (frame check + OCR of the card titles). Only reads pixels that are visible on the monitor –
 * no game memory, no injection.
 */
export class AugmentScanner {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private last = ''
  private readonly ocr: TitleOcr
  private titleCache = new Map<string, string>()

  constructor(
    cacheDir: string,
    private readonly candidates: () => NameCandidate[],
    private readonly emit: (offer: AugmentOffer | null) => void,
    /** display the game runs on (null = check every display) */
    private readonly preferredDisplay: () => number | null
  ) {
    this.ocr = new TitleOcr(cacheDir)
  }

  get running(): boolean {
    return !!this.timer
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.publish(null)
    void this.ocr.dispose()
  }

  private publish(offer: AugmentOffer | null): void {
    const key = JSON.stringify(offer)
    if (key === this.last) return
    this.last = key
    this.emit(offer)
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const displays = screen.getAllDisplays()
      const preferred = this.preferredDisplay()
      const ordered = preferred ? [...displays].sort((a) => (a.id === preferred ? -1 : 1)) : displays
      const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)))
      const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)))
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } })
      for (const display of ordered) {
        const src = sources.find((s) => s.display_id === String(display.id)) ?? (displays.length === 1 ? sources[0] : undefined)
        if (!src) continue
        const offer = await this.scan(src.thumbnail, display)
        if (offer) return this.publish(offer)
      }
      this.publish(null)
    } catch {
      this.publish(null)
    } finally {
      this.busy = false
    }
  }

  /** Diagnostics: OCR the three title areas of a screenshot (RC_OCR_SELFTEST=<png>). */
  async selfTest(img: Electron.NativeImage): Promise<{ visible: boolean; titles: string[] }> {
    const size = img.getSize()
    const bitmap: Bitmap = { width: size.width, height: size.height, data: img.toBitmap(), order: 'bgra' }
    const titles: string[] = []
    for (const r of titleRects(size.width, size.height)) {
      const p = prepareTitle(bitmap, r)
      titles.push(await this.ocr.read(nativeImage.createFromBitmap(p.data, { width: p.width, height: p.height }).toPNG()))
    }
    return { visible: cardsVisible(bitmap), titles }
  }

  private async scan(img: Electron.NativeImage, display: Display): Promise<AugmentOffer | null> {
    const size = img.getSize()
    if (!size.width || !size.height) return null
    const bitmap: Bitmap = { width: size.width, height: size.height, data: img.toBitmap(), order: 'bgra' }
    if (!cardsVisible(bitmap)) return null

    const candidates = this.candidates()
    const titles = titleRects(size.width, size.height)
    const cards = cardRects(size.width, size.height)
    // thumbnail pixels → DIP of the display
    const scale = size.height / display.size.height

    const result: AugmentOffer['cards'] = []
    for (let i = 0; i < 3; i++) {
      const prepared = prepareTitle(bitmap, titles[i])
      const png = nativeImage.createFromBitmap(rgbaToBgra(prepared.data), { width: prepared.width, height: prepared.height }).toPNG()
      const cacheKey = png.length + ':' + png.subarray(png.length - 64).toString('base64')
      let text = this.titleCache.get(cacheKey)
      if (text === undefined) {
        text = await this.ocr.read(png)
        if (this.titleCache.size > 200) this.titleCache.clear()
        this.titleCache.set(cacheKey, text)
      }
      const match = matchAugment(text, candidates)
      const r = cards[i]
      result.push({
        augmentId: match?.id ?? null,
        text,
        score: match?.score ?? 0,
        rect: { x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale }
      })
    }
    if (result.filter((c) => c.augmentId !== null).length < 2) return null
    return { displayId: display.id, cards: result }
  }
}

function rgbaToBgra(data: Buffer): Buffer {
  const out = Buffer.from(data)
  for (let i = 0; i < out.length; i += 4) {
    out[i] = data[i + 2]
    out[i + 2] = data[i]
  }
  return out
}
