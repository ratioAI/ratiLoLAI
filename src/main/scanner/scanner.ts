import { writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { desktopCapturer, nativeImage, screen, type Display } from 'electron'
import type { AugmentOffer, ScanTestResult } from '@shared/types'
import {
  AugmentSchedule,
  cardRects,
  cardMetrics,
  cardsVisible,
  meanBrightness,
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

/** Size of the cheap preview capture we use to check whether the augment cards are open. */
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

const toBitmap = (image: Electron.NativeImage): Bitmap => {
  const { width, height } = image.getSize()
  return { width, height, data: image.toBitmap(), order: 'bgra' }
}

/**
 * Takes one screenshot of every screen and pairs each with its display. A single desktopCapturer
 * call is enough because Windows captures all screens per call anyway.
 */
async function captureAll(box: { width: number; height: number }): Promise<Shot[]> {
  const displays = screen.getAllDisplays()
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: box })
  return sources
    .map((source, i) => {
      const size = source.thumbnail.getSize()
      // display_id is empty on some Windows setups, so fall back to enumeration order, then aspect ratio
      const display =
        displays.find((candidate) => String(candidate.id) === source.display_id) ??
        (sources.length === displays.length ? displays[i] : undefined) ??
        displays.find(
          (candidate) => Math.abs(candidate.size.width / candidate.size.height - size.width / Math.max(1, size.height)) < 0.02
        ) ??
        screen.getPrimaryDisplay()
      return { display, image: source.thumbnail }
    })
    .filter((shot) => !shot.image.isEmpty())
}

/**
 * Recognises the ARAM: Mayhem augment choice on screen, using screenshots and OCR only (no game
 * memory is read). It only looks while the choice can actually be open, see AugmentSchedule.
 */
export class AugmentScanner {
  // The regular check uses a small preview capture. A full-resolution capture plus OCR only runs
  // when new cards show up (first time or after a reroll).
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private active = false
  private lastKey = ''
  private state: ScanState = { visible: false, offer: null, displayId: null }
  /** signature of the last cards we ran OCR on (successful or not) */
  private signature: number[][] | null = null
  private gameDisplay: number | null = null
  private lastRead = 0
  /** unreadable reads in a row for the selection that's currently open */
  private misreads = 0
  private readonly ocr: TitleOcr
  readonly schedule = new AugmentSchedule()

  constructor(
    cacheDir: string,
    private readonly candidates: () => NameCandidate[],
    private readonly emit: (state: ScanState) => void,
    private readonly log: (message: string) => void = () => undefined,
    private readonly capture: CaptureService | null = null,
    /** screen the game was on last time (persisted), so we only need to watch that one */
    private readonly knownDisplay: { get(): number | null; set(id: number): void } = { get: () => null, set: () => undefined }
  ) {
    this.ocr = new TitleOcr(cacheDir)
  }

  /** Loads the OCR engine ahead of time (champion select), so the first augment choice doesn't stutter. */
  warmup(): void {
    void this.ocr.warmup().then(
      (startupMs) => startupMs && this.log(`OCR engine ready (${startupMs} ms)`),
      (err) => this.log(`OCR warm-up failed: ${String(err)}`)
    )
  }

  /** Consecutive looks at the known game screen without finding cards while an augment is pending. */
  private knownMisses = 0

  /**
   * Screens to watch: the known game screen if it still exists, otherwise all of them. If the known
   * screen keeps coming up empty while an augment is waiting (game moved to the other monitor, wrong
   * screen remembered), we go back to watching all of them.
   */
  private watchedDisplays(): Display[] {
    const all = screen.getAllDisplays()
    if (this.knownMisses >= 6) return all
    const id = this.gameDisplay ?? this.knownDisplay.get()
    const known = all.find((display) => display.id === id)
    return known ? [known] : all
  }

  get running(): boolean {
    return this.active
  }

  get scanning(): boolean {
    return this.timer !== null || this.busy
  }

  /** Called with every live-game update (roughly every 2 s). */
  update(tick: PlayerTick): void {
    const wasPending = this.schedule.pending
    this.schedule.update(tick)
    if (!wasPending && this.schedule.pending) this.log(`augment pending (level ${tick.level})`)
    this.reschedule()
  }

  /** Hotkey: look right now and for the next few seconds, even while alive. */
  lookNow(ms: number): void {
    this.schedule.openWindow(ms)
    if (this.active && !this.busy) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      void this.tick()
    }
  }

  start(): void {
    this.snapshots = 0
    this.missStreak = 0
    void this.clearSnapshots()
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
    // 5 fps while the cards are open, so the frames follow a reroll or close within a second
    this.capture?.demand(
      'augments',
      interval === null ? null : { displays: this.watchedDisplays().map((display) => display.id), fps: this.schedule.cardsSeen ? 5 : 2 }
    )
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
      void this.maybeSnapshot(state.visible)
      if (state.visible) this.knownMisses = 0
      else if (this.schedule.pending && ++this.knownMisses === 6 && screen.getAllDisplays().length > 1) {
        this.log('no cards on the remembered screen – watching all screens')
        this.reschedule()
      }
      this.trackPick(state)
      if (this.schedule.observe(state.visible) === 'gone') {
        this.signature = null
        const picked = this.resolvePick()
        const name = picked !== null ? (this.candidates().find((candidate) => candidate.id === picked)?.names[1] ?? picked) : null
        this.log(picked !== null ? `augment picked: ${name}` : 'cards minimised (no card under the cursor) – keep watching')
        if (picked !== null) this.onPicked(picked)
        // Minimised to go shopping. It can be reopened any time in the fountain, so keep looking
        // for a while even without a respawn or purchase to trigger it.
        else this.schedule.openWindow(90_000)
      }
      this.publish(state)
    } catch (err) {
      this.log(`scan failed: ${err instanceof Error ? err.message : String(err)}`)
      this.publish({ visible: false, offer: null, displayId: null })
    } finally {
      this.busy = false
      this.reschedule()
    }
  }

  /** true when the overlay windows show up in screen captures (and so in our own screenshots) */
  overlayInCapture: () => boolean = () => false

  /** called with the augment the player clicked */
  onPicked: (augmentId: number) => void = () => undefined
  private lastOffer: AugmentOffer | null = null
  private cursorVisible: Electron.Point | null = null
  private cursorAtMiss: Electron.Point | null = null

  // The Live Client API doesn't report picked augments, so we infer the pick. Clicking a card picks
  // it and closes the selection right away, so the card under the cursor when the cards disappear is
  // the one that was picked. Closing with the button below (cursor not on a card) or rerolling (cards
  // stay) doesn't count.
  /** called when a pick turns out to be wrong (the same cards came back) */
  onUnpicked: (augmentId: number) => void = () => undefined
  private lastPick: { id: number; offered: number[] } | null = null

  private trackPick(state: ScanState): void {
    if (state.visible) {
      if (state.offer) {
        // the cards we thought were picked from are back (the shop covered them, for example), so it wasn't a pick
        const ids = state.offer.cards.map((card) => card.augmentId).filter((id): id is number => id !== null)
        const lastPick = this.lastPick
        if (lastPick && ids.includes(lastPick.id) && ids.filter((id) => lastPick.offered.includes(id)).length >= 2) {
          this.log(`cards are back – ${lastPick.id} was not picked`)
          this.onUnpicked(lastPick.id)
          this.lastPick = null
        }
        this.lastOffer = state.offer
      }
      this.cursorVisible = screen.getCursorScreenPoint()
      this.cursorAtMiss = null
    } else if (this.schedule.cardsSeen && !this.cursorAtMiss) {
      this.cursorAtMiss = screen.getCursorScreenPoint()
    }
  }

  private resolvePick(): number | null {
    const offer = this.lastOffer
    const points = [this.cursorAtMiss, this.cursorVisible].filter((point): point is Electron.Point => !!point)
    this.lastOffer = null
    this.cursorAtMiss = null
    this.cursorVisible = null
    if (!offer) return null
    const display = screen.getAllDisplays().find((candidate) => candidate.id === offer.displayId)
    if (!display) return null
    for (const point of points) {
      const x = point.x - display.bounds.x
      const y = point.y - display.bounds.y
      const card = offer.cards.find(
        (candidate) =>
          x >= candidate.rect.x &&
          x <= candidate.rect.x + candidate.rect.width &&
          y >= candidate.rect.y &&
          y <= candidate.rect.y + candidate.rect.height
      )
      if (card?.augmentId != null) {
        this.lastPick = {
          id: card.augmentId,
          offered: offer.cards.map((offered) => offered.augmentId).filter((id): id is number => id !== null)
        }
        return card.augmentId
      }
    }
    return null
  }

  /** folder for diagnostic snapshots (Settings > Diagnostics > Open log folder) */
  snapshotDir: string | null = null
  private missStreak = 0
  private snapshots = 0
  private lastSnapshot = 0
  private lastPreviews: { display: Display; bitmap: Bitmap }[] = []

  /**
   * An augment is waiting and the choice should be open, but no cards were found for a while. Saves
   * what the recognition saw (a few 1280 px JPEGs per game) and logs what it measured, so failures
   * can be diagnosed from the log folder.
   */
  private async maybeSnapshot(visible: boolean): Promise<void> {
    if (visible || !this.schedule.pending || !this.snapshotDir) {
      this.missStreak = 0
      return
    }
    if (++this.missStreak < 5 || this.snapshots >= 4 || Date.now() - this.lastSnapshot < 25_000) return
    this.snapshots++
    this.lastSnapshot = Date.now()
    try {
      await mkdir(this.snapshotDir, { recursive: true })
      for (const { display, bitmap } of this.lastPreviews) {
        const metrics = cardMetrics(bitmap)
          .map((card) => `${Math.round(card.edges * 100)}/${Math.round(card.dark * 100)}`)
          .join(' ')
        const name = `miss-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-${display.id}.jpg`
        let image: Bitmap | null = null
        if (this.capture && !this.capture.failed) {
          const frames = await this.capture.grab(display, [{ x: 0, y: 0, w: 1, h: 1, outW: 1280 }])
          if (frames?.[0]) image = { ...frames[0], order: 'rgba' }
        }
        image ??= bitmap
        // nativeImage wants BGRA, so swap red and blue for RGBA frames
        const bgra = Buffer.from(image.data)
        if (image.order === 'rgba')
          for (let i = 0; i < bgra.length; i += 4) {
            const red = bgra[i]
            bgra[i] = bgra[i + 2]
            bgra[i + 2] = red
          }
        await writeFile(
          join(this.snapshotDir, name),
          nativeImage.createFromBitmap(bgra, { width: image.width, height: image.height }).toJPEG(80)
        )
        this.log(
          `no cards found for ${this.missStreak} looks – saved ${name} (${bitmap.width}×${bitmap.height}, brightness ${Math.round(meanBrightness(bitmap))}, frame/body % per card: ${metrics})`
        )
      }
    } catch (err) {
      this.log(`snapshot failed: ${String(err)}`)
    }
  }

  /** Removes the snapshots of earlier games. */
  private async clearSnapshots(): Promise<void> {
    if (!this.snapshotDir) return
    const files = await readdir(this.snapshotDir).catch(() => [] as string[])
    await Promise.all(
      files.filter((file) => /^miss-.*\.jpg$/.test(file)).map((file) => unlink(join(this.snapshotDir!, file)).catch(() => undefined))
    )
  }

  /** Small previews of the watched screens, from the running stream or getSources() as a fallback. */
  private async previews(): Promise<{ display: Display; bitmap: Bitmap }[]> {
    if (this.capture && !this.capture.failed) {
      const previews: { display: Display; bitmap: Bitmap }[] = []
      for (const display of this.watchedDisplays()) {
        const frames = await this.capture.grab(display, [{ x: 0, y: 0, w: 1, h: 1, outW: PREVIEW }])
        if (frames?.[0]) previews.push({ display, bitmap: { ...frames[0], order: 'rgba' } })
      }
      // the stream may have failed during the grab, in that case fall through to getSources()
      if (previews.length || !this.capture.failed) return previews
    }
    const shots = await captureAll({ width: PREVIEW, height: PREVIEW })
    return shots.map((shot) => ({ display: shot.display, bitmap: toBitmap(shot.image) }))
  }

  private async look(): Promise<ScanState> {
    const startedAt = Date.now()
    const shots = await this.previews()
    this.lastPreviews = shots
    const previewMs = Date.now() - startedAt
    if (!shots.length) {
      this.log(`preview capture returned no screens (${previewMs} ms)`)
      return { visible: false, offer: null, displayId: null }
    }
    for (const shot of shots) {
      const preview = shot.bitmap
      if (!cardsVisible(preview)) continue
      const displayId = shot.display.id
      const signature = titleSignature(preview)
      const sameCards = this.state.visible && this.state.displayId === displayId && !signatureChanged(this.signature, signature)
      // Same cards as last time, nothing to read again. If the last read failed, retry once a second.
      // When our own frames show up in the capture (overlay visible in screen shares) we re-read every
      // 1.5 s, otherwise frames left over a closed selection would keep themselves alive.
      const recheck = this.overlayInCapture() && Date.now() - this.lastRead > 1500
      if (sameCards && !recheck && (this.state.offer || Date.now() - this.lastRead < 1000)) return this.state
      // a reroll animates for a moment, so read at most every 400 ms while the titles change
      if (this.state.visible && this.state.displayId === displayId && Date.now() - this.lastRead < 400) return this.state

      this.log(`cards visible on display ${displayId} (preview ${previewMs} ms) – reading titles`)
      if (this.gameDisplay !== displayId) {
        this.gameDisplay = displayId
        this.knownDisplay.set(displayId)
        this.reschedule() // watch only this screen from now on
      }
      this.signature = signature
      this.lastRead = Date.now()
      const offer = await this.readDisplay(shot.display)
      // One unreadable read while the same selection is open (tooltip, cursor or animation over a
      // title) keeps the frames. Only a second one in a row drops them, which avoids flicker.
      if (!offer && this.state.offer && this.state.displayId === displayId && this.misreads++ < 1)
        return { visible: true, offer: this.state.offer, displayId }
      if (offer) this.misreads = 0
      return { visible: true, offer, displayId }
    }
    this.misreads = 0
    return { visible: false, offer: null, displayId: null }
  }

  private async fullFrame(display: Display): Promise<Bitmap | null> {
    if (this.capture && !this.capture.failed) {
      const frames = await this.capture.grab(display, [{ x: 0, y: 0, w: 1, h: 1 }])
      if (frames?.[0]) return { ...frames[0], order: 'rgba' }
    }
    const all = screen.getAllDisplays()
    const box = {
      width: Math.max(...all.map((display) => Math.round(display.size.width * display.scaleFactor))),
      height: Math.max(...all.map((display) => Math.round(display.size.height * display.scaleFactor)))
    }
    const shot = (await captureAll(box)).find((candidate) => candidate.display.id === display.id)
    return shot ? toBitmap(shot.image) : null
  }

  private async readDisplay(display: Display): Promise<AugmentOffer | null> {
    const startedAt = Date.now()
    const bitmap = await this.fullFrame(display)
    if (!bitmap) {
      this.log('full capture: display not found')
      return null
    }
    const offer = await this.read(bitmap, display)
    this.log(
      `OCR ${Date.now() - startedAt} ms: ${offer ? offer.cards.map((card) => `"${card.text}"→${card.augmentId ?? '?'}`).join(', ') : 'unreadable'}`
    )
    return offer
  }

  private async readTitles(bitmap: Bitmap): Promise<string[]> {
    const texts: string[] = []
    for (const rect of titleRects(bitmap.width, bitmap.height)) {
      const title = prepareTitle(bitmap, rect)
      texts.push(await this.ocr.read(nativeImage.createFromBitmap(title.data, { width: title.width, height: title.height }).toPNG()))
    }
    return texts
  }

  private async read(bitmap: Bitmap, display: Display): Promise<AugmentOffer | null> {
    const candidates = this.candidates()
    const texts = await this.readTitles(bitmap)
    const cards = cardRects(bitmap.width, bitmap.height)
    const scale = bitmap.height / display.size.height // capture pixels to DIP
    const result: AugmentOffer['cards'] = texts.map((text, i) => {
      const match = matchAugment(text, candidates)
      const rect = cards[i]
      return {
        augmentId: match?.id ?? null,
        text,
        score: match?.score ?? 0,
        rect: { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale }
      }
    })
    if (!result.some((card) => card.augmentId !== null)) return null
    return { displayId: display.id, cards: result }
  }

  /** Settings > "Test screen recognition": captures every screen now, saves the images and reports. */
  async testScan(dir: string): Promise<ScanTestResult> {
    await mkdir(dir, { recursive: true })
    const startedAt = Date.now()
    const all = screen.getAllDisplays()
    const box = {
      width: Math.max(...all.map((display) => Math.round(display.size.width * display.scaleFactor))),
      height: Math.max(...all.map((display) => Math.round(display.size.height * display.scaleFactor)))
    }
    const shots = await captureAll(box)
    const captureMs = Date.now() - startedAt
    const screens: ScanTestResult['screens'] = []
    for (const [i, shot] of shots.entries()) {
      const bitmap = toBitmap(shot.image)
      const file = join(dir, `screen-${i + 1}.png`)
      await writeFile(file, shot.image.toPNG())
      const visible = cardsVisible(bitmap)
      const titles = visible ? await this.readTitles(bitmap).catch((err) => [`OCR error: ${String(err)}`]) : []
      // black = every colour channel (alpha skipped) is close to 0
      const black = !bitmap.data.some((value, j) => j % 4 !== 3 && value > 12)
      screens.push({
        displayId: shot.display.id,
        size: `${bitmap.width}×${bitmap.height}`,
        visible,
        black,
        titles,
        matches: titles.map((title) => matchAugment(title, this.candidates())?.id ?? null),
        file
      })
    }
    const result = { captureMs, screens }
    this.log(`test scan: ${JSON.stringify(result)}`)
    return result
  }

  /** Diagnostics: OCR the three title areas of a screenshot (RC_OCR_SELFTEST=<png>). */
  async selfTest(image: Electron.NativeImage): Promise<{ visible: boolean; titles: string[] }> {
    const bitmap = toBitmap(image)
    return { visible: cardsVisible(bitmap), titles: await this.readTitles(bitmap) }
  }
}
