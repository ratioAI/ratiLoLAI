import { useEffect, useRef } from 'react'
import type { Settings } from '@shared/types'
import { useIdleRef } from '@/lib/useIdle'
import { SPACE_LIB, quadProgram } from './spaceGlsl'

export { cosmicSeed } from './spaceGlsl'
export { JOURNEY_MS as JUMP_MS } from './JourneyCanvas'

/*
 * "Standing on a planet at night, looking up into the galaxy you live in."
 *
 * Every seed is a different planet somewhere in a different galaxy: the angle and arc of the
 * galactic band, its colours, dust rifts and nebulae, how far the planet is from the galactic
 * core (a thin faint band … a core filling half the sky … the supermassive black hole itself),
 * far-away galaxies, and the planet's mountains and atmosphere. The sky turns very slowly.
 */
const FRAG = `${SPACE_LIB}
uniform vec2 u_res;
uniform float u_time;
uniform float u_seed;

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;     // y in [-0.5, 0.5]
  g_seed = u_seed;
  gl_FragColor = vec4(finish(planetView(p, u_time, u_seed, 0.0), p), 1.0);
}`

const FPS = { animated: 24, calm: 10, static: 0 } as const

/**
 * Full-window night sky (Games pages, loading screen). The travel between two places is the
 * JourneyCanvas; this one just shows where you are. Half resolution so the stars stay crisp.
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
  const ref = useRef<HTMLCanvasElement>(null)
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const effective: keyof typeof FPS = reduced ? 'static' : inGame && mode === 'animated' ? 'calm' : mode
  const idle = useIdleRef(inGame)
  const seedRef = useRef(seed)
  const redraw = useRef<(() => void) | null>(null)
  seedRef.current = seed

  // a new place: draw it right away (also when the sky is static)
  useEffect(() => redraw.current?.(), [seed])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    if (!gl) return
    const prog = quadProgram(gl, FRAG)
    if (!prog) return
    const uRes = gl.getUniformLocation(prog, 'u_res')
    const uTime = gl.getUniformLocation(prog, 'u_time')
    const uSeed = gl.getUniformLocation(prog, 'u_seed')

    const SCALE = Math.min(1, (window.devicePixelRatio || 1) * 0.5)
    const resize = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    const draw = (now: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, now / 1000)
      gl.uniform1f(uSeed, seedRef.current)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    resize()
    const fps = FPS[effective]
    let raf = 0
    let last = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < 1000 / fps - 2) return
      if (idle.current && last) return // behind the game or hidden: keep the last frame
      last = now
      draw(now)
    }
    const onResize = () => {
      resize()
      draw(performance.now())
    }
    redraw.current = () => draw(performance.now())
    window.addEventListener('resize', onResize)
    if (fps) raf = requestAnimationFrame(loop)
    else draw(performance.now())
    return () => {
      cancelAnimationFrame(raf)
      redraw.current = null
      window.removeEventListener('resize', onResize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [effective, idle])

  return <canvas key={effective} ref={ref} aria-hidden className={className} />
}
