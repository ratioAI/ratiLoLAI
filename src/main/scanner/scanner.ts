import { desktopCapturer, nativeImage, screen, type Display } from 'electron'
import type { AugmentOffer } from '@shared/types'
import {
  AugmentSchedule,
  cardRects,
  cardsVisible,
  matchAugment,
  prepareTitle,
  signatureChanged,
  titleRects,
  titleSignature,
  type Bitmap,
  type NameCandidate
} from './detect'
import { TitleOcr } from './ocr'

/** Width of the cheap preview capture used to check whether the augment cards are open. */
const PREVIEW_WIDTH = 640

/**
 * Recognises the ARAM: Mayhem augment choice on screen. To stay light on the game it only looks
 * while an augment is actually pending (levels 1/7/11/15 until it has been picked), uses a small
 * preview capture for the check and takes a full-resolution capture only when the cards are open
 * and their titles changed (first appearance or reroll). No game memory is read.
 */
export class AugmentScanner {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private active = false
  private lastKey = ''
  private offer: AugmentOffer | null = null
  private signature: number[] | null = null
  private readonly ocr: TitleOcr
  readonly schedule = new AugmentSchedule()

  constructor(
    cacheDir: string,
    private readonly candidates: () => NameCandidate[],
    private readonly emit: (offer: AugmentOffer | null) => void,
    /** display the game runs on (null = unknown, check every display) */
    private readonly preferredDisplay: () => number | null,
    private readonly onPicked: () => void = () => undefined
  ) {
    this.ocr = new TitleOcr(cacheDir)
  }

  get running(): boolean {
    return this.active
  }

  /** Called with every live-game update (every ~2 s). */
  update(level: number, dead: boolean): void {
    this.schedule.update(level, dead)
    this.reschedule()
  }

  start(): void {
    this.active = true
    this.reschedule()
  }

  stop(): void {
    this.active = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.schedule.reset()
    this.signature = null
    this.publish(null)
    void this.ocr.dispose()
  }

  private reschedule(): void {
    if (!this.active) return
    const interval = this.schedule.interval
    if (interval === null) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      if (this.offer) this.publish(null)
      return
    }
    if (!this.timer) this.timer = setTimeout(() => void this.tick(), interval)
  }

  private publish(offer: AugmentOffer | null): void {
    this.offer = offer
    const key = JSON.stringify(offer)
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit(offer)
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.busy || !this.active) return this.reschedule()
    this.busy = true
    try {
      const found = await this.look()
      if (this.schedule.observe(!!found) === 'picked') {
        this.signature = null
        this.onPicked()
      }
      this.publish(found)
    } catch {
      this.publish(null)
    } finally {
      this.busy = false
      this.reschedule()
    }
  }

  private async capture(display: Display, width: number): Promise<Electron.NativeImage | null> {
    const height = Math.round((width * display.size.height) / display.size.width)
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
    return src?.thumbnail ?? null
  }

  private async look(): Promise<AugmentOffer | null> {
    const displays = screen.getAllDisplays()
    const preferred = this.preferredDisplay()
    const ordered = preferred ? [...displays].sort((a) => (a.id === preferred ? -1 : 1)) : displays

    for (const display of ordered) {
      const preview = await this.capture(display, PREVIEW_WIDTH)
      if (!preview) continue
      const size = preview.getSize()
      const small: Bitmap = { width: size.width, height: size.height, data: preview.toBitmap(), order: 'bgra' }
      if (!cardsVisible(small)) continue

      // same cards as last time → nothing to read again
      const sig = titleSignature(small)
      if (this.offer?.displayId === display.id && !signatureChanged(this.signature, sig)) return this.offer

      const full = await this.capture(display, Math.round(display.size.width * display.scaleFactor))
      if (!full) continue
      const offer = await this.read(full, display)
      if (offer) {
        this.signature = sig
        return offer
      }
    }
    return null
  }

  private async read(img: Electron.NativeImage, display: Display): Promise<AugmentOffer | null> {
    const size = img.getSize()
    const bitmap: Bitmap = { width: size.width, height: size.height, data: img.toBitmap(), order: 'bgra' }
    const candidates = this.candidates()
    const titles = titleRects(size.width, size.height)
    const cards = cardRects(size.width, size.height)
    const scale = size.height / display.size.height // capture pixels → DIP

    const result: AugmentOffer['cards'] = []
    for (let i = 0; i < 3; i++) {
      const p = prepareTitle(bitmap, titles[i])
      const text = await this.ocr.read(nativeImage.createFromBitmap(p.data, { width: p.width, height: p.height }).toPNG())
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
}
