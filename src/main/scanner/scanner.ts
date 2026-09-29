import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopCapturer, nativeImage, screen, type Display } from 'electron'
import type { AugmentOffer, ScanTestResult } from '@shared/types'
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
  type NameCandidate,
  type PlayerTick
} from './detect'
import { TitleOcr } from './ocr'
import type { CaptureService } from '../capture/captureService'

/** Bounding box of the cheap preview capture used to check whether the augment cards are open. */
const PREVIEW = 640

export interface ScanState {
  /** augment cards are on screen (frame detection) */
  visible: boolean
  /** recognised cards (null while unreadable) */
  offer: AugmentOffer | null
  displayId: number | null
}

interface Shot {
  display: Display
  image: Electron.NativeImage
}

const toBitmap = (img: Electron.NativeImage): Bitmap => {
  const { width, height } = img.getSize()
  return { width, height, data: img.toBitmap(), order: 'bgra' }
}

/**
 * Takes one screenshot of every screen (a single desktopCapturer call – Windows captures all
 * screens per call anyway) and pairs each with its display. `display_id` is empty on some Windows
 * setups, so fall back to the enumeration order / aspect ratio.
 */
async function captureAll(box: { width: number; height: number }): Promise<Shot[]> {
  const displays = screen.getAllDisplays()
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: box })
  return sources
    .map((s, i) => {
      const size = s.thumbnail.getSize()
      const display =
        displays.find((d) => String(d.id) === s.display_id) ??
        (sources.length === displays.length ? displays[i] : undefined) ??
        displays.find((d) => Math.abs(d.size.width / d.size.height - size.width / Math.max(1, size.height)) < 0.02) ??
        screen.getPrimaryDisplay()
      return { display, image: s.thumbnail }
    })
    .filter((s) => !s.image.isEmpty())
}

/**
 * Recognises the ARAM: Mayhem augment choice on screen. It only looks while an augment is pending
 * *and* the choice can actually be open (dead / fountain, see AugmentSchedule) – the rest of the
 * game no screenshot is taken. The check itself uses a small preview capture; a full-resolution
 * capture + OCR only happens when new cards appear (first time or reroll). No game memory is read.
 */
export class AugmentScanner {
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private active = false
  private lastKey = ''
  private state: ScanState = { visible: false, offer: null, displayId: null }
  /** signature of the last cards we ran OCR on (successful or not) */
  private signature: number[] | null = null
  private gameDisplay: number | null = null
  private lastRead = 0
  private readonly ocr: TitleOcr
  readonly schedule = new AugmentSchedule()

  constructor(
    cacheDir: string,
    private readonly candidates: () => NameCandidate[],
    private readonly emit: (state: ScanState) => void,
    private readonly log: (msg: string) => void = () => undefined,
    private readonly capture: CaptureService | null = null,
    /** screen the game ran on last time (persisted), so only that one needs to be watched */
    private readonly knownDisplay: { get(): number | null; set(id: number): void } = { get: () => null, set: () => undefined }
  ) {
    this.ocr = new TitleOcr(cacheDir)
  }

  /** Loads the OCR engine ahead of time (champion select), so the first augment choice doesn't stutter. */
  warmup(): void {
    void this.ocr.warmup().then(
      (ms) => ms && this.log(`OCR engine ready (${ms} ms)`),
      (e) => this.log(`OCR warm-up failed: ${String(e)}`)
    )
  }

  /** Screens to watch: the known game screen if it still exists, otherwise all of them. */
  private watchedDisplays(): Display[] {
    const all = screen.getAllDisplays()
    const id = this.gameDisplay ?? this.knownDisplay.get()
    const known = all.find((d) => d.id === id)
    return known ? [known] : all
  }

  get running(): boolean {
    return this.active
  }

  get scanning(): boolean {
    return this.timer !== null || this.busy
  }

  /** Called with every live-game update (every ~2 s). */
  update(tick: PlayerTick): void {
    const before = this.schedule.pending
    this.schedule.update(tick)
    if (!before && this.schedule.pending) this.log(`augment pending (level ${tick.level})`)
    this.reschedule()
  }

  /** Hotkey: look right now and for the next seconds, even while alive. */
  lookNow(ms: number): void {
    this.schedule.openWindow(ms)
    if (this.active && !this.busy) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      void this.tick()
    }
  }

  start(): void {
    this.active = true
    this.log('scanner started')
    this.reschedule()
  }

  stop(): void {
    if (this.active) this.log('scanner stopped')
    this.active = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.schedule.reset()
    this.capture?.demand('augments', null)
    this.signature = null
    this.publish({ visible: false, offer: null, displayId: null })
    void this.ocr.dispose()
  }

  private reschedule(): void {
    if (!this.active) return
    const interval = this.schedule.interval()
    this.capture?.demand('augments', interval === null ? null : { displays: this.watchedDisplays().map((d) => d.id), fps: 2 })
    if (interval === null) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      if (this.state.visible) this.publish({ visible: false, offer: null, displayId: null })
      return
    }
    if (!this.timer && !this.busy) this.timer = setTimeout(() => void this.tick(), interval)
  }

  private publish(state: ScanState): void {
    this.state = state
    const key = JSON.stringify(state)
    if (key === this.lastKey) return
    this.lastKey = key
    this.emit(state)
  }

  private async tick(): Promise<void> {
    this.timer = null
    if (this.busy || !this.active) return this.reschedule()
    this.busy = true
    try {
      const state = await this.look()
      if (this.schedule.observe(state.visible) === 'picked') {
        this.signature = null
        this.log('cards gone → augment picked')
      }
      this.publish(state)
    } catch (e) {
      this.log(`scan failed: ${e instanceof Error ? e.message : String(e)}`)
      this.publish({ visible: false, offer: null, displayId: null })
    } finally {
      this.busy = false
      this.reschedule()
    }
  }

  /** Small previews of the watched screens – from the running stream, or getSources() as fallback. */
  private async previews(): Promise<{ display: Display; bitmap: Bitmap }[]> {
    if (this.capture && !this.capture.failed) {
      const out: { display: Display; bitmap: Bitmap }[] = []
      for (const display of this.watchedDisplays()) {
        const f = await this.capture.grab(display, [{ x: 0, y: 0, w: 1, h: 1, outW: PREVIEW }])
        if (f?.[0]) out.push({ display, bitmap: { ...f[0], order: 'rgba' } })
      }
      if (out.length || !this.capture.failed) return out
    }
    const shots = await captureAll({ width: PREVIEW, height: PREVIEW })
    return shots.map((s) => ({ display: s.display, bitmap: toBitmap(s.image) }))
  }

  private async look(): Promise<ScanState> {
    const t0 = Date.now()
    const shots = await this.previews()
    const ms = Date.now() - t0
    if (!shots.length) {
      this.log(`preview capture returned no screens (${ms} ms)`)
      return { visible: false, offer: null, displayId: null }
    }
    for (const shot of shots) {
      const small = shot.bitmap
      if (!cardsVisible(small)) continue
      const displayId = shot.display.id
      const sig = titleSignature(small)
      const same = this.state.visible && this.state.displayId === displayId && !signatureChanged(this.signature, sig)
      if (same) return this.state // same cards as last time → nothing to read again
      // a reroll takes a moment to animate – don't OCR the same cards over and over
      if (this.state.visible && this.state.displayId === displayId && Date.now() - this.lastRead < 2500) return this.state

      this.log(`cards visible on display ${displayId} (preview ${ms} ms) – reading titles`)
      if (this.gameDisplay !== displayId) {
        this.gameDisplay = displayId
        this.knownDisplay.set(displayId)
        this.reschedule() // watch only this screen from now on
      }
      this.signature = sig
      this.lastRead = Date.now()
      const offer = await this.readDisplay(shot.display)
      return { visible: true, offer, displayId }
    }
    return { visible: false, offer: null, displayId: null }
  }

  private async fullFrame(display: Display): Promise<Bitmap | null> {
    if (this.capture && !this.capture.failed) {
      const f = await this.capture.grab(display, [{ x: 0, y: 0, w: 1, h: 1 }])
      if (f?.[0]) return { ...f[0], order: 'rgba' }
    }
    const all = screen.getAllDisplays()
    const box = {
      width: Math.max(...all.map((d) => Math.round(d.size.width * d.scaleFactor))),
      height: Math.max(...all.map((d) => Math.round(d.size.height * d.scaleFactor)))
    }
    const shot = (await captureAll(box)).find((s) => s.display.id === display.id)
    return shot ? toBitmap(shot.image) : null
  }

  private async readDisplay(display: Display): Promise<AugmentOffer | null> {
    const t0 = Date.now()
    const bitmap = await this.fullFrame(display)
    if (!bitmap) {
      this.log('full capture: display not found')
      return null
    }
    const offer = await this.read(bitmap, display)
    this.log(
      `OCR ${Date.now() - t0} ms: ${offer ? offer.cards.map((c) => `"${c.text}"→${c.augmentId ?? '?'}`).join(', ') : 'unreadable'}`
    )
    return offer
  }

  private async readTitles(bitmap: Bitmap): Promise<string[]> {
    const texts: string[] = []
    for (const r of titleRects(bitmap.width, bitmap.height)) {
      const p = prepareTitle(bitmap, r)
      texts.push(await this.ocr.read(nativeImage.createFromBitmap(p.data, { width: p.width, height: p.height }).toPNG()))
    }
    return texts
  }

  private async read(bitmap: Bitmap, display: Display): Promise<AugmentOffer | null> {
    const candidates = this.candidates()
    const texts = await this.readTitles(bitmap)
    const cards = cardRects(bitmap.width, bitmap.height)
    const scale = bitmap.height / display.size.height // capture pixels → DIP
    const result: AugmentOffer['cards'] = texts.map((text, i) => {
      const match = matchAugment(text, candidates)
      const r = cards[i]
      return {
        augmentId: match?.id ?? null,
        text,
        score: match?.score ?? 0,
        rect: { x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale }
      }
    })
    if (result.filter((c) => c.augmentId !== null).length < 2) return null
    return { displayId: display.id, cards: result }
  }

  /** Settings → "Test screen recognition": capture every screen now, save it and report. */
  async testScan(dir: string): Promise<ScanTestResult> {
    await mkdir(dir, { recursive: true })
    const t0 = Date.now()
    const all = screen.getAllDisplays()
    const box = {
      width: Math.max(...all.map((d) => Math.round(d.size.width * d.scaleFactor))),
      height: Math.max(...all.map((d) => Math.round(d.size.height * d.scaleFactor)))
    }
    const shots = await captureAll(box)
    const captureMs = Date.now() - t0
    const screens: ScanTestResult['screens'] = []
    for (const [i, shot] of shots.entries()) {
      const bitmap = toBitmap(shot.image)
      const file = join(dir, `screen-${i + 1}.png`)
      await writeFile(file, shot.image.toPNG())
      const visible = cardsVisible(bitmap)
      const titles = visible ? await this.readTitles(bitmap).catch((e) => [`OCR error: ${String(e)}`]) : []
      const black = !bitmap.data.some((v, j) => j % 4 !== 3 && v > 12)
      screens.push({
        displayId: shot.display.id,
        size: `${bitmap.width}×${bitmap.height}`,
        visible,
        black,
        titles,
        matches: titles.map((t) => matchAugment(t, this.candidates())?.id ?? null),
        file
      })
    }
    const res = { captureMs, screens }
    this.log(`test scan: ${JSON.stringify(res)}`)
    return res
  }

  /** Diagnostics: OCR the three title areas of a screenshot (RC_OCR_SELFTEST=<png>). */
  async selfTest(img: Electron.NativeImage): Promise<{ visible: boolean; titles: string[] }> {
    const bitmap = toBitmap(img)
    return { visible: cardsVisible(bitmap), titles: await this.readTitles(bitmap) }
  }
}
