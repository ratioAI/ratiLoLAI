import { useEffect, useRef } from 'react'
import type { Settings } from '@shared/types'
import { useIdleRef } from '@/lib/useIdle'

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

// Slowly flowing, domain-warped fractal noise – an oil-on-water / mushroom-trip look. Kept dark
// and very slow (one colour drift takes minutes), so text stays readable and nothing flickers.
// Nothing but this background ever moves.
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
// four trip colours (magenta, violet, deep cyan, acid mint) blended along the noise value –
// no reds, oranges or muddy yellows
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
  p *= 1.6 + 0.06 * sin(t * 0.21);                       // slow breathing
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.030)), fbm(p + vec2(5.2, 1.3) - t * 0.024));
  vec2 r = vec2(fbm(p + 3.5 * q + vec2(1.7, 9.2) + t * 0.018), fbm(p + 3.5 * q + vec2(8.3, 2.8) - t * 0.021));
  float f = fbm(p + 3.8 * r);
  vec3 col = palette(f * 0.9 + length(q) * 0.35 + t * 0.004);
  float glow = smoothstep(0.35, 1.0, f * f * 1.8 + 0.25 * length(r));
  col = mix(vec3(0.030, 0.018, 0.070), col, 0.10 + 0.34 * glow);   // stay dark: UI sits on top
  float vig = smoothstep(1.25, 0.25, length(uv - 0.5) * 1.6);       // darker edges
  gl_FragColor = vec4(col * (0.55 + 0.45 * vig), 1.0);
}`

/** Frame rate per mode; `static` draws one frame. While a game runs, animation is capped low. */
const FPS = { animated: 24, calm: 10, static: 0 } as const

/**
 * Full-window animated background (main window only). Rendered at a quarter of the resolution
 * and upscaled – the noise is soft anyway – so it costs next to nothing; pauses when the window is
 * hidden and honours "reduce motion".
 */
export function TripBackground({ mode, inGame }: { mode: Settings['ui']['background']; inGame: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const effective: keyof typeof FPS = reduced ? 'static' : inGame && mode === 'animated' ? 'calm' : mode
  const idle = useIdleRef(inGame)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    if (!gl) return
    const sh = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
    gl.useProgram(prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const uRes = gl.getUniformLocation(prog, 'u_res')
    const uTime = gl.getUniformLocation(prog, 'u_time')

    const SCALE = 0.25
    const resize = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    // start somewhere different each launch, so the colours aren't always the same
    const offset = Math.random() * 500
    const draw = (sec: number) => {
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, offset + sec)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    resize()
    const fps = FPS[effective]
    let raf = 0
    let last = 0
    const t0 = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < 1000 / fps - 2) return
      if (idle.current && last) return // behind the game or hidden: keep the last frame
      last = now
      draw((now - t0) / 1000)
    }
    const onResize = () => {
      resize()
      if (!fps) draw(0)
    }
    window.addEventListener('resize', onResize)
    if (fps) raf = requestAnimationFrame(loop)
    else draw(0)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [effective])

  return (
    <>
      {/* a fresh canvas per mode: a context that was released can never draw again */}
      <canvas key={effective} ref={ref} aria-hidden className="trip-bg pointer-events-none fixed inset-0 -z-10 h-full w-full" />
      <div aria-hidden className="trip-grain pointer-events-none fixed inset-0 -z-10" />
    </>
  )
}
