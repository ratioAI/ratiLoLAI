import { useEffect, useRef } from 'react'
import type { Tier } from '@shared/types'

export interface FrameSpec {
  rect: { x: number; y: number; width: number; height: number }
  tier: Tier
  best: boolean
}

/**
 * Per tier: two base colours, how psychedelic (0 = tier colours only, 1 = full colour flow),
 * how much the border wobbles (px) and how strong the glow is.
 */
const STYLE: Record<Tier, { a: string; b: string; psy: number; wobble: number; glow: number }> = {
  'S+': { a: '#ffe27a', b: '#36e3ff', psy: 1, wobble: 4.5, glow: 1 },
  S: { a: '#c47bff', b: '#ff4fd8', psy: 0.6, wobble: 3.8, glow: 0.9 },
  A: { a: '#4e8dff', b: '#36e3ff', psy: 0.35, wobble: 3, glow: 0.7 },
  B: { a: '#2fd68c', b: '#36e3c0', psy: 0.2, wobble: 2.2, glow: 0.5 },
  C: { a: '#b4c2d1', b: '#8da0b3', psy: 0.05, wobble: 1.2, glow: 0.25 },
  D: { a: '#c0896b', b: '#8a3f2c', psy: 0, wobble: 0.8, glow: 0.2 }
}

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

// One full-window pass: signed distance to each card's rounded rectangle, displaced by travelling
// waves + value noise (the "wobble"), coloured by a hue that flows around the frame.
const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_scale;
uniform vec4 u_rect[3];
uniform vec3 u_a[3];
uniform vec3 u_b[3];
uniform vec4 u_p[3];

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1.0,0.0)), f.x), mix(hash(i+vec2(0.0,1.0)), hash(i+vec2(1.0,1.0)), f.x), f.y);
}
vec3 hsv(float h, float s, float v){
  vec3 k = clamp(abs(mod(h*6.0 + vec3(0.0,4.0,2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return v * mix(vec3(1.0), k, s);
}
float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }

void main(){
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_scale;
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 r = u_rect[i];
    vec4 prm = u_p[i];
    if (prm.w < 0.5) continue;
    vec2 d = frag - (r.xy + r.zw * 0.5);
    float ang = atan(d.y, d.x);
    float t = u_time + float(i) * 1.7;
    float wob = prm.y * (0.55*sin(ang*5.0 + t*1.6) + 0.35*sin(ang*11.0 - t*2.4) + 0.9*(noise(d*0.035 + vec2(t*0.45, -t*0.3)) - 0.5));
    float sd = sdRound(d, r.zw * 0.5, 18.0) + wob;
    float ring = 1.0 - smoothstep(1.6, 3.6, abs(sd - 1.0));
    float outside = step(0.0, sd);
    float glow = exp(-max(sd, 0.0) / (6.0 + prm.z * 10.0)) * outside;
    float rim = exp(-max(-sd, 0.0) / 4.0) * (1.0 - outside) * 0.45;
    float h = fract(ang / 6.28318 + t * 0.07 + sd * 0.006 + noise(d * 0.012 - t * 0.15) * 0.35);
    vec3 flow = hsv(h, 0.72, 1.0);
    vec3 base = mix(u_a[i], u_b[i], 0.5 + 0.5 * sin(ang * 3.0 + t * 1.2 + sd * 0.06));
    vec3 c = mix(base, flow, prm.x);
    float pulse = 0.8 + 0.2 * sin(t * 2.3);
    float a = clamp(ring + glow * 0.6 * prm.z * pulse + rim, 0.0, 1.0);
    col += c * a;
    alpha = max(alpha, a);
  }
  // fade out towards the window edge, so the glow never ends in a hard line
  vec2 css = u_res / u_scale;
  float edge = min(min(frag.x, css.x - frag.x), min(frag.y, css.y - frag.y));
  float fade = smoothstep(0.0, 22.0, edge);
  gl_FragColor = vec4(min(col, vec3(alpha)) * fade, alpha * fade);
}`

/** Frame rate per animation setting (0 = draw once). */
const FPS = { smooth: 30, low: 15, off: 0 } as const

/**
 * Animated, wobbling tier frames around the augment cards, drawn by a tiny WebGL shader at a capped
 * frame rate and 75 % resolution. Everything else in the overlay is static, so the window only
 * repaints when this canvas does.
 */
export function FrameCanvas({ frames, animation }: { frames: FrameSpec[]; animation: keyof typeof FPS }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const framesRef = useRef(frames)
  framesRef.current = frames
  // static frames are drawn once, so they are redrawn when the cards change
  const staticKey = animation === 'off' ? JSON.stringify(frames) : ''

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true, powerPreference: 'low-power' })
    if (!gl) return
    const shader = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'p')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    const u = (n: string) => gl.getUniformLocation(prog, n)
    const uRes = u('u_res')
    const uTime = u('u_time')
    const uScale = u('u_scale')
    const uRect = u('u_rect')
    const uA = u('u_a')
    const uB = u('u_b')
    const uP = u('u_p')

    const scale = Math.min(2, (window.devicePixelRatio || 1) * 0.75)
    const resize = () => {
      canvas.width = Math.round(canvas.clientWidth * scale)
      canvas.height = Math.round(canvas.clientHeight * scale)
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = (time: number) => {
      const f = framesRef.current
      const rect = new Float32Array(12)
      const a = new Float32Array(9)
      const b = new Float32Array(9)
      const p = new Float32Array(12)
      f.slice(0, 3).forEach((fr, i) => {
        const st = STYLE[fr.tier]
        rect.set([fr.rect.x, fr.rect.y, fr.rect.width, fr.rect.height], i * 4)
        a.set(rgb(st.a), i * 3)
        b.set(rgb(st.b), i * 3)
        p.set([st.psy, st.wobble, st.glow + (fr.best ? 0.3 : 0), 1], i * 4)
      })
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, time)
      gl.uniform1f(uScale, scale)
      gl.uniform4fv(uRect, rect)
      gl.uniform3fv(uA, a)
      gl.uniform3fv(uB, b)
      gl.uniform4fv(uP, p)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    const fps = FPS[animation]
    let raf = 0
    let last = 0
    const t0 = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < 1000 / fps - 2) return
      last = now
      draw((now - t0) / 1000)
    }
    if (fps) raf = requestAnimationFrame(loop)
    else draw(1.3)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [animation, staticKey])

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />
}
