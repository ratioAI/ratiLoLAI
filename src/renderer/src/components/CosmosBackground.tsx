import { useEffect, useRef } from 'react'
import type { Settings } from '@shared/types'
import { useIdleRef } from '@/lib/useIdle'
import { freshCanvas, gpuName, isSoftwareGpu } from '@/lib/glCanvas'
import { SPACE_LIB, galaxyUniforms, quadProgram } from './spaceGlsl'

export { cosmicSeed } from './spaceGlsl'

/*
 * Night sky seen from the surface of a planet, looking up at its own galaxy.
 *
 * The seed decides everything: the kind of galaxy we are in (a band of light in a spiral, a sky
 * full of stars in an elliptical, ...), angle and curve of the galactic band, its colours, dust
 * lanes and nebulae, how close we are to the core (from a faint thin band up to the central black
 * hole filling the sky), distant galaxies, and the planet's mountains and atmosphere. The sky
 * rotates very slowly.
 */
/** The night sky (exported for the shader test of the admin tool). */
export const NIGHT_SKY_FRAG = `${SPACE_LIB}
uniform vec2 u_res;
uniform float u_time;
uniform float u_seed;
uniform vec4 u_gal;
uniform vec4 u_gal2;

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;     // centred, y in [-0.5, 0.5]
  g_seed = u_seed;
  g_gal = u_gal;
  g_gal2 = u_gal2;
  gl_FragColor = vec4(finish(planetView(p, u_time, u_seed, 0.0), p), 1.0);
}`

const FPS = { animated: 24, calm: 10, static: 0 } as const

/**
 * Full-window night sky for the Games pages and the loading screen. Shows where you are; the flight
 * between two skies is JourneyCanvas.
 */
export function CosmosBackground({
  seed,
  mode,
  inGame,
  className = 'pointer-events-none fixed inset-0 -z-10 h-full w-full'
}: {
  seed: number
  mode: Settings['ui']['background']
  inGame: boolean
  className?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  // during a game the animation drops to the calm frame rate
  const effectiveMode: keyof typeof FPS = reducedMotion ? 'static' : inGame && mode === 'animated' ? 'calm' : mode
  const idleRef = useIdleRef(inGame)
  const seedRef = useRef(seed)
  const redrawRef = useRef<(() => void) | null>(null)
  seedRef.current = seed

  // redraw immediately on a new seed, otherwise a static sky would never update
  useEffect(() => redrawRef.current?.(), [seed])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const canvas = freshCanvas(host)
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    const program = gl && quadProgram(gl, NIGHT_SKY_FRAG)
    if (!gl || !program) return () => canvas.remove()
    const uRes = gl.getUniformLocation(program, 'u_res')
    const uTime = gl.getUniformLocation(program, 'u_time')
    const uSeed = gl.getUniformLocation(program, 'u_seed')
    const uGal = gl.getUniformLocation(program, 'u_gal')
    const uGal2 = gl.getUniformLocation(program, 'u_gal2')
    let galaxy = { seed: NaN, uniforms: galaxyUniforms(seedRef.current) }

    // half the device resolution: cheap enough, and the stars still look sharp
    const SCALE = Math.min(1, (window.devicePixelRatio || 1) * 0.5)
    const resize = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    const draw = (now: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, now / 1000)
      if (galaxy.seed !== seedRef.current) galaxy = { seed: seedRef.current, uniforms: galaxyUniforms(seedRef.current) }
      gl.uniform1f(uSeed, seedRef.current)
      gl.uniform4fv(uGal, galaxy.uniforms[0])
      gl.uniform4fv(uGal2, galaxy.uniforms[1])
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    resize()
    // without a GPU (software rendering) a still picture, the animation would eat the CPU
    const fps = isSoftwareGpu(gpuName(gl)) ? 0 : FPS[effectiveMode]
    let rafId = 0
    let lastDraw = 0
    const loop = (now: number) => {
      rafId = requestAnimationFrame(loop)
      // 2 ms slack so rAF jitter doesn't make us skip every other frame
      if (now - lastDraw < 1000 / fps - 2) return
      if (idleRef.current && lastDraw) return // hidden or behind the game: keep the last frame
      lastDraw = now
      draw(now)
    }
    const onResize = () => {
      resize()
      draw(performance.now())
    }
    redrawRef.current = () => draw(performance.now())
    window.addEventListener('resize', onResize)
    if (fps) rafId = requestAnimationFrame(loop)
    else draw(performance.now())
    return () => {
      cancelAnimationFrame(rafId)
      redrawRef.current = null
      window.removeEventListener('resize', onResize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
  }, [effectiveMode, idleRef])

  // the effect puts a new canvas in here for every mode (see freshCanvas)
  return <div ref={hostRef} aria-hidden className={className} />
}
