import { useEffect, useRef } from 'react'
import { JOURNEY_S, flightPlan, type CameraPose, type FlightVariant } from '@shared/journey'
import { add, cross, dot, normalize, scale, sub } from '@shared/universe'
import { api } from '@/lib/api'
import { freshCanvas, gpuName, isSoftwareGpu } from '@/lib/glCanvas'
import { FlightRenderer, flightContext, isWebGL2, knownBadShader, playableVariant } from './flightGl'

/** Duration of the flight from one planet to the next. */
export const JOURNEY_MS = JOURNEY_S * 1000

/*
 * The flight to the next game, played like a short film: through a wormhole or around a black hole
 * (shared/journey.ts has the camera path, flightGl.ts draws it).
 *
 * The film has its own clock. It runs in real time as long as frames come at least ten times a
 * second; when the window is hidden behind the game client, or a frame stalls because the app is
 * busy (champ select loading), the film waits instead of skipping ahead, and it always plays to the
 * end. When it is done it calls onDone and keeps its last frame.
 *
 * Before the first frame the shaders are compiled without blocking the page and everything the film
 * needs is set up (see FlightRenderer.prepare), so that every frame afterwards is the same small
 * amount of work. A kind of flight whose shader hung the GPU on this machine before is replaced by
 * another kind.
 * Machines that can't play it at a watchable speed skip it: software rendering (no GPU, or Chromium
 * fell back after a GPU crash), shaders that don't finish in time, or frames that stay far too slow.
 */
const MAX_STEP = 0.1
/** Average frame time (ms) above which the picture is rendered at a lower resolution. */
const SLOW_FRAME_MS = 26
/** Average frame time (ms) that is too slow to watch even at the lowest resolution. */
const UNWATCHABLE_FRAME_MS = 90
/** How long compiling the shaders may take before the flight is skipped. */
const PREPARE_TIMEOUT_MS = 45_000

const log = (message: string): void => api.logDiag(`flight: ${message}`)

/** A little hand-held shake where the pose asks for it (in the wormhole's throat, close to the black hole). */
function shaken(pose: CameraPose, time: number): CameraPose {
  if (pose.shake <= 0) return pose
  const amount = pose.shake * 0.0055
  const yaw = amount * (Math.sin(time * 23.1) + 0.6 * Math.sin(time * 41.7 + 1.3))
  const pitch = amount * (Math.sin(time * 19.3 + 0.7) + 0.6 * Math.sin(time * 37.9 + 2.1))
  const right = normalize(cross(pose.forward, pose.up))
  const forward = normalize(add(pose.forward, add(scale(right, yaw), scale(pose.up, pitch))))
  const up = normalize(sub(pose.up, scale(forward, dot(pose.up, forward))))
  return { ...pose, forward, up }
}

export interface JourneyCanvasProps {
  from: number
  to: number
  variant: FlightVariant
  /** called once when the film has played to the end, or right away if this machine can't play it */
  onDone: () => void
  /** called every frame with the film time in seconds (for captions on top) */
  onFrame?: (seconds: number) => void
  /** called when the first frame is on screen (before that the shaders are being compiled) */
  onReady?: () => void
  className?: string
}

/** Plays the flight once, filling its parent. */
export function JourneyCanvas({ from, to, variant, onDone, onFrame, onReady, className = 'h-full w-full' }: JourneyCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onDone, onFrame, onReady })
  callbacks.current = { onDone, onFrame, onReady }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const canvas = freshCanvas(host)
    // invisible until the first frame, so nothing black shows while the shaders compile
    canvas.style.opacity = '0'
    canvas.style.transition = 'opacity 0.45s ease-out'
    let finished = false
    const done = (): void => {
      if (finished) return
      finished = true
      callbacks.current.onDone()
    }
    const gl = flightContext(canvas)
    if (!gl) {
      log('skipped – no WebGL')
      done()
      return () => canvas.remove()
    }
    const release = (): void => void gl.getExtension('WEBGL_lose_context')?.loseContext()
    const gpu = gpuName(gl)
    // (screenshots set __journeyT and run on software rendering, so they still get the film)
    if (isSoftwareGpu(gpu) && (window as { __journeyT?: number }).__journeyT === undefined) {
      log(`skipped – no hardware acceleration (${gpu})`)
      done()
      return () => {
        release()
        canvas.remove()
      }
    }

    const playable = playableVariant(gl, variant)
    if (!playable) {
      log(`skipped – the "${knownBadShader(gl, variant)}" shader hung the GPU on this PC before, and so did the other flights`)
      done()
      return () => {
        release()
        canvas.remove()
      }
    }
    if (playable !== variant)
      log(`${playable} instead of ${variant} – its "${knownBadShader(gl, variant)}" shader hung the GPU on this PC before`)

    let disposed = false
    let compiling: Promise<boolean> = Promise.resolve(true)
    let stop = (): void => undefined
    // the device resolution: single stars stay crisp; slow machines step down while playing (see quality)
    const SCALE = Math.min(1, window.devicePixelRatio || 1)
    const fit = (): void => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
    }
    fit()
    // dev helpers: window.__journeyT holds the film at that second, __journeyClock fixes the
    // animation clock (twinkling, swirling), so screenshots can be compared pixel by pixel
    const dev = window as { __journeyT?: number; __journeyClock?: number }
    const preparing = performance.now()
    let stuck: string[] = []
    const plan = flightPlan(from, to, playable)
    void FlightRenderer.prepare(gl, plan, from, to, {
      timeoutMs: PREPARE_TIMEOUT_MS,
      width: canvas.width,
      height: canvas.height,
      time: dev.__journeyClock ?? preparing / 1000,
      onCompile: (compiled) => (compiling = compiled),
      onStuck: (names) => (stuck = names)
    }).then((renderer) => {
      if (disposed) return
      const seconds = ((performance.now() - preparing) / 1000).toFixed(1)
      const context = isWebGL2(gl) ? 'WebGL2' : 'WebGL1'
      if (!renderer) {
        const why = gl.isContextLost()
          ? 'lost with the context'
          : `not ready after ${seconds} s${stuck.length ? ` (still compiling: ${stuck.join(', ')})` : ''}`
        log(`skipped – shaders ${why} (${context}, ${gpu})`)
        done()
        return
      }
      log(`${playable} ready after ${seconds} s (${context}, ${gpu})`)
      stop = play(renderer)
    })

    function play(renderer: FlightRenderer): () => void {
      let quality = 1
      const resize = (): void => {
        fit()
        renderer.resize(canvas.width, canvas.height, quality)
      }
      resize()

      let T = 0
      let last = 0
      let rafId = 0
      let held = { at: NaN, frames: 0 }
      // frame times are judged in windows of at least 12 frames and 0.75 s
      let windowFrames = 0
      let windowTime = 0
      let drawn = 0
      let drawTime = 0
      const summary = (): string =>
        `${drawn} frames, ${drawn ? (drawTime / drawn).toFixed(1) : '–'} ms each, ${Math.round(quality * SCALE * 100)} % resolution`
      const frame = (now: number): void => {
        if (last) {
          const step = now - last
          T = Math.min(JOURNEY_S, T + Math.min(MAX_STEP, step / 1000))
          // longer gaps are a hidden window or a busy app, not this machine's speed
          if (step < 250) {
            drawn++
            drawTime += step
            windowFrames++
            windowTime += step
          }
          if (windowFrames >= 12 && windowTime >= 750) {
            const average = windowTime / windowFrames
            windowFrames = 0
            windowTime = 0
            if (average > SLOW_FRAME_MS && quality > 0.7) {
              // this machine can't keep up: render the next frames smaller (twice at most; those
              // pictures are set up already, so switching costs nothing) …
              quality *= 0.8
              renderer.resize(canvas.width, canvas.height, quality)
            } else if (average > UNWATCHABLE_FRAME_MS) {
              // … and stop when even that is far too slow to watch
              log(`stopped – too slow (${summary()}, ${gpu})`)
              done()
              return
            }
          }
        } else {
          canvas.style.opacity = '1'
          callbacks.current.onReady?.()
        }
        last = now
        const frozen = dev.__journeyT
        const seconds = frozen ?? T
        const time = dev.__journeyClock ?? now / 1000
        // a held frame is drawn a few times and then left alone
        if (frozen !== undefined) held = held.at === frozen ? { at: frozen, frames: held.frames + 1 } : { at: frozen, frames: 0 }
        if (frozen === undefined || held.frames < 4) renderer.render(seconds, time, shaken(plan.cameraAt(seconds), time))
        callbacks.current.onFrame?.(seconds)
        if (seconds >= JOURNEY_S && frozen === undefined) {
          log(`played (${summary()})`)
          done()
          return
        }
        rafId = requestAnimationFrame(frame)
      }
      rafId = requestAnimationFrame(frame)
      window.addEventListener('resize', resize)
      return () => {
        cancelAnimationFrame(rafId)
        window.removeEventListener('resize', resize)
        if (!finished) log(`skipped after ${T.toFixed(1)} s (${summary()})`)
      }
    }

    const lost = (event: Event): void => {
      event.preventDefault()
      log(`WebGL context lost (${gpu})`)
      done()
    }
    canvas.addEventListener('webglcontextlost', lost)
    return () => {
      disposed = true
      stop()
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.remove()
      // a compile that is still running is finished first, so its shaders end up in the cache
      void compiling.finally(release)
    }
  }, [from, to, variant])

  return <div ref={hostRef} aria-hidden className={className} />
}
