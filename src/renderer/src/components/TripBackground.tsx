import { useEffect, useRef } from 'react'
import type { Settings } from '@shared/types'
import { useIdleRef } from '@/lib/useIdle'

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

// Slowly flowing domain-warped fractal noise, sort of an oil-on-water look. It's kept dark and very
// slow (one colour cycle takes minutes) so text on top stays readable and nothing flickers.
const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), f.x), mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0; float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
// cycles through magenta, violet, cyan and mint. Reds, oranges and yellows looked muddy, so they're left out.
vec3 palette(float t){
  vec3 c0 = vec3(0.95, 0.30, 0.85);
  vec3 c1 = vec3(0.45, 0.32, 1.00);
  vec3 c2 = vec3(0.16, 0.80, 0.95);
  vec3 c3 = vec3(0.45, 1.00, 0.70);
  t = fract(t) * 4.0;
  vec3 a = t < 1.0 ? c0 : t < 2.0 ? c1 : t < 3.0 ? c2 : c3;
  vec3 b = t < 1.0 ? c1 : t < 2.0 ? c2 : t < 3.0 ? c3 : c0;
  return mix(a, b, smoothstep(0.0, 1.0, fract(t)));
}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float t = u_time;
  p *= 1.6 + 0.06 * sin(t * 0.21);                       // slow zoom in and out
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.030)), fbm(p + vec2(5.2, 1.3) - t * 0.024));
  vec2 r = vec2(fbm(p + 3.5 * q + vec2(1.7, 9.2) + t * 0.018), fbm(p + 3.5 * q + vec2(8.3, 2.8) - t * 0.021));
  float f = fbm(p + 3.8 * r);
  vec3 col = palette(f * 0.9 + length(q) * 0.35 + t * 0.004);
  float glow = smoothstep(0.35, 1.0, f * f * 1.8 + 0.25 * length(r));
  col = mix(vec3(0.030, 0.018, 0.070), col, 0.10 + 0.34 * glow);   // stay dark: UI sits on top
  float vig = smoothstep(1.25, 0.25, length(uv - 0.5) * 1.6);       // darker edges
  gl_FragColor = vec4(col * (0.55 + 0.45 * vig), 1.0);
}`

/** Frame rate per mode. `static` draws a single frame, `calm` is used while a game is running. */
const FPS = { animated: 24, calm: 10, static: 0 } as const

/**
 * Animated full-window background for the main window. Pauses while hidden and respects
 * "reduce motion".
 */
export function TripBackground({ mode, inGame }: { mode: Settings['ui']['background']; inGame: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const effectiveMode: keyof typeof FPS = reducedMotion ? 'static' : inGame && mode === 'animated' ? 'calm' : mode
  const idleRef = useIdleRef(inGame)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    if (!gl) return
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source)
      gl.compileShader(shader)
      return shader
    }
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return
    gl.useProgram(program)
    // two triangles covering the whole viewport
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const posAttrib = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(posAttrib)
    gl.vertexAttribPointer(posAttrib, 2, gl.FLOAT, false, 0, 0)
    const uRes = gl.getUniformLocation(program, 'u_res')
    const uTime = gl.getUniformLocation(program, 'u_time')

    // quarter resolution, upscaled by CSS. The noise is soft anyway, so this costs almost nothing.
    const SCALE = 0.25
    const resize = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    // start somewhere different each launch, so the colours aren't always the same
    const timeOffset = Math.random() * 500
    const draw = (seconds: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, timeOffset + seconds)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    resize()
    const fps = FPS[effectiveMode]
    let rafId = 0
    let lastDraw = 0
    const startTime = performance.now()
    const loop = (now: number) => {
      rafId = requestAnimationFrame(loop)
      // 2 ms slack so rAF jitter doesn't make us skip every other frame
      if (now - lastDraw < 1000 / fps - 2) return
      if (idleRef.current && lastDraw) return // hidden or behind the game: keep the last frame
      lastDraw = now
      draw((now - startTime) / 1000)
    }
    const onResize = () => {
      resize()
      if (!fps) draw(0)
    }
    window.addEventListener('resize', onResize)
    if (fps) rafId = requestAnimationFrame(loop)
    else draw(0)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', onResize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [effectiveMode])

  return (
    <>
      {/* new canvas per mode, a context we released with loseContext() can't be reused */}
      <canvas key={effectiveMode} ref={canvasRef} aria-hidden className="trip-bg pointer-events-none fixed inset-0 -z-10 h-full w-full" />
      <div aria-hidden className="trip-grain pointer-events-none fixed inset-0 -z-10" />
    </>
  )
}
