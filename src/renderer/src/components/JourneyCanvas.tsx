import { useEffect, useRef } from 'react'
import { JOURNEY_S, flightPlan, type CameraPose, type FlightVariant } from '@shared/journey'
import { add, cross, dot, normalize, scale, sub } from '@shared/universe'
import { FlightRenderer } from './flightGl'

/** Duration of the flight from one planet to the next. */
export const JOURNEY_MS = JOURNEY_S * 1000

/*
 * The flight to the next game, played like a short film: through a wormhole or past a black hole
 * (shared/journey.ts has the camera path, flightGl.ts draws it).
 *
 * The film has its own clock. It only moves on while frames are actually drawn, and by at most a
 * thirtieth of a second per frame. So when the window is hidden behind the game client, or a frame
 * stalls because the app is busy (champ select loading), the film waits instead of skipping ahead,
 * and it always plays to the end. When it is done it calls onDone and keeps its last frame.
 */
const MAX_STEP = 1 / 30
/** Average frame time (ms) above which the picture is rendered at a lower resolution. */
const SLOW_FRAME_MS = 26

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
  className?: string
}

/** Plays the flight once, filling its parent. */
export function JourneyCanvas({ from, to, variant, onDone, onFrame, className = 'h-full w-full' }: JourneyCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onDone, onFrame })
  callbacks.current = { onDone, onFrame }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // a fresh canvas per run: a context released with loseContext() can't be used again
    const canvas = document.createElement('canvas')
    canvas.className = 'block h-full w-full'
    host.append(canvas)
    let finished = false
    const done = (): void => {
      if (finished) return
      finished = true
      callbacks.current.onDone()
    }
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' })
    const plan = flightPlan(from, to, variant)
    const renderer = gl && FlightRenderer.create(gl, plan, from, to)
    if (!gl || !renderer) {
      done()
      return () => canvas.remove()
    }

    // three quarters of the device resolution: single stars stay crisp, the lens passes stay affordable
    const SCALE = Math.min(1, (window.devicePixelRatio || 1) * 0.75)
    let quality = 1
    const resize = (): void => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
      renderer.resize(canvas.width, canvas.height, quality)
    }
    resize()

    let T = 0
    let last = 0
    let rafId = 0
    let held = { at: NaN, frames: 0 }
    let average = 0
    let frames = 0
    const frame = (now: number): void => {
      if (last) {
        const step = now - last
        T = Math.min(JOURNEY_S, T + Math.min(MAX_STEP, step / 1000))
        // if this machine can't keep up, render the next frames smaller (twice at most)
        if (step < 100) {
          average = frames ? average * 0.92 + step * 0.08 : step
          if (++frames > 45 && average > SLOW_FRAME_MS && quality > 0.6) {
            quality *= 0.8
            frames = 0
            renderer.resize(canvas.width, canvas.height, quality)
          }
        }
      }
      last = now
      // dev helper: set window.__journeyT to hold the flight at that second (for screenshots)
      const frozen = (window as { __journeyT?: number }).__journeyT
      const seconds = frozen ?? T
      const time = now / 1000
      // a held frame is drawn a few times and then left alone
      if (frozen !== undefined) held = held.at === frozen ? { at: frozen, frames: held.frames + 1 } : { at: frozen, frames: 0 }
      if (frozen === undefined || held.frames < 4) renderer.render(seconds, time, shaken(plan.cameraAt(seconds), time))
      callbacks.current.onFrame?.(seconds)
      if (seconds >= JOURNEY_S && frozen === undefined) {
        done()
        return
      }
      rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)

    const lost = (event: Event): void => {
      event.preventDefault()
      done()
    }
    canvas.addEventListener('webglcontextlost', lost)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('webglcontextlost', lost)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
  }, [from, to, variant])

  return <div ref={hostRef} aria-hidden className={className} />
}
