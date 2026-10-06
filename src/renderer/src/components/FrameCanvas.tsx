import { useEffect, useRef } from 'react'
import type { Tier } from '@shared/types'

export interface FrameSpec {
  rect: { x: number; y: number; width: number; height: number }
  tier: Tier
  best: boolean
  /** builds a combo with an augment we already own (drawn mint/gold with extra glow) */
  combo?: boolean
}

/**
 * Per tier: two base colours, `psy` (0 = only the tier colours, 1 = full rainbow flow), border
 * wobble in px, and glow strength.
 */
const STYLE: Record<Tier, { a: string; b: string; psy: number; wobble: number; glow: number }> = {
  'S+': { a: '#ffe27a', b: '#36e3ff', psy: 1, wobble: 4.5, glow: 1 },
  S: { a: '#c47bff', b: '#ff4fd8', psy: 0.6, wobble: 3.8, glow: 0.9 },
  A: { a: '#4e8dff', b: '#36e3ff', psy: 0.35, wobble: 3, glow: 0.7 },
  B: { a: '#2fd68c', b: '#36e3c0', psy: 0.2, wobble: 2.2, glow: 0.5 },
  C: { a: '#b4c2d1', b: '#8da0b3', psy: 0.05, wobble: 1.2, glow: 0.25 },
  D: { a: '#c0896b', b: '#8a3f2c', psy: 0, wobble: 0.8, glow: 0.2 }
}

const COMBO_STYLE = { a: '#5dffb0', b: '#ffd36b', psy: 0.9, wobble: 5, glow: 1.1 }

const rgb = (hex: string): [number, number, number] => {
  const value = parseInt(hex.slice(1), 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

// Single full-window pass. For each card we take the signed distance to its rounded rectangle, push
// it around with travelling waves plus value noise (the wobble) and colour it with a hue that flows
// around the frame.
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
  vec2 frag = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y) / u_scale;   // CSS px, y down like the card rects
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 r = u_rect[i];
    vec4 prm = u_p[i];
    if (prm.w < 0.5) continue;   // w = 0 means this slot has no card
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
  // fade out near the window edge so the glow doesn't get cut off in a hard line
  vec2 css = u_res / u_scale;
  float edge = min(min(frag.x, css.x - frag.x), min(frag.y, css.y - frag.y));
  float fade = smoothstep(0.0, 22.0, edge);
  gl_FragColor = vec4(min(col, vec3(alpha)) * fade, alpha * fade);
}`

/** Frame rate per animation setting (0 = draw once). */
const FPS = { smooth: 30, low: 15, off: 0 } as const

/**
 * Animated tier frames around the augment cards, drawn with a small WebGL shader at a capped frame
 * rate. Everything else in the overlay is static, so the window only repaints when this canvas does.
 */
export function FrameCanvas({ frames, animation }: { frames: FrameSpec[]; animation: keyof typeof FPS }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const framesRef = useRef(frames)
  framesRef.current = frames
  // with animation off we only draw once, so a change in the cards has to restart the effect
  const staticKey = animation === 'off' ? JSON.stringify(frames) : ''

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, alpha: true, powerPreference: 'low-power' })
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
    const quadBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    const posAttrib = gl.getAttribLocation(program, 'p')
    gl.enableVertexAttribArray(posAttrib)
    gl.vertexAttribPointer(posAttrib, 2, gl.FLOAT, false, 0, 0)
    const uniform = (name: string) => gl.getUniformLocation(program, name)
    const uRes = uniform('u_res')
    const uTime = uniform('u_time')
    const uScale = uniform('u_scale')
    const uRect = uniform('u_rect')
    const uA = uniform('u_a')
    const uB = uniform('u_b')
    const uP = uniform('u_p')

    // 75% of device resolution (capped at 2x) is plenty for soft glowing borders
    const scale = Math.min(2, (window.devicePixelRatio || 1) * 0.75)
    const resize = () => {
      canvas.width = Math.round(canvas.clientWidth * scale)
      canvas.height = Math.round(canvas.clientHeight * scale)
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = (time: number) => {
      // the shader has three fixed slots; unused ones keep w = 0 in u_p and are skipped
      const rects = new Float32Array(12)
      const colorsA = new Float32Array(9)
      const colorsB = new Float32Array(9)
      const params = new Float32Array(12)
      framesRef.current.slice(0, 3).forEach((frame, i) => {
        const style = frame.combo ? COMBO_STYLE : STYLE[frame.tier]
        rects.set([frame.rect.x, frame.rect.y, frame.rect.width, frame.rect.height], i * 4)
        colorsA.set(rgb(style.a), i * 3)
        colorsB.set(rgb(style.b), i * 3)
        params.set([style.psy, style.wobble, style.glow + (frame.best || frame.combo ? 0.35 : 0), 1], i * 4)
      })
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, time)
      gl.uniform1f(uScale, scale)
      gl.uniform4fv(uRect, rects)
      gl.uniform3fv(uA, colorsA)
      gl.uniform3fv(uB, colorsB)
      gl.uniform4fv(uP, params)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    const fps = FPS[animation]
    let rafId = 0
    let lastDraw = 0
    const startTime = performance.now()
    const loop = (now: number) => {
      rafId = requestAnimationFrame(loop)
      // 2 ms slack so rAF jitter doesn't make us skip every other frame
      if (now - lastDraw < 1000 / fps - 2) return
      lastDraw = now
      draw((now - startTime) / 1000)
    }
    if (fps) rafId = requestAnimationFrame(loop)
    else draw(1.3) // still image: any fixed point in time will do
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [animation, staticKey])

  return <canvas key={`${animation}:${staticKey}`} ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
}
