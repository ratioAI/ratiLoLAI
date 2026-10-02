import { useEffect, useRef } from 'react'
import type { Settings } from '@shared/types'

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

/*
 * "Standing on a planet at night, looking at a galaxy."
 *
 * Every seed is a different place: galaxy position, size, tilt, number of arms, twist, colours,
 * the planet's atmosphere and – sometimes – a supermassive black hole with photon ring and
 * accretion disk in the galactic core, bending the starlight around it. The sky turns very slowly.
 *
 * u_warp (0 → 1) is the jump to the next star: the view dives into a wormhole – star streaks
 * rushing past, a lensing ring, a flash – and the new seed is swapped in at the peak.
 */
const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_seed;
uniform float u_warp;

float h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float noise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1.0,0.0)), f.x), mix(h21(i+vec2(0.0,1.0)), h21(i+vec2(1.0,1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }
  return v;
}
mat2 rot(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
// nebula palette: blue, violet, pink, teal – never the muddy greens/yellows of a full hue wheel
vec3 neb(float h){
  h = fract(h) * 4.0;
  vec3 c0 = vec3(0.30, 0.52, 1.00); vec3 c1 = vec3(0.62, 0.40, 1.00);
  vec3 c2 = vec3(1.00, 0.42, 0.74); vec3 c3 = vec3(0.22, 0.85, 0.92);
  vec3 c = mix(c0, c1, smoothstep(0.0, 1.0, h));
  c = mix(c, c2, smoothstep(1.0, 2.0, h));
  c = mix(c, c3, smoothstep(2.0, 3.0, h));
  return mix(c, c0, smoothstep(3.0, 4.0, h));
}
float ridge(float x){ return 1.0 - abs(2.0 * noise(vec2(x, 0.5)) - 1.0); }

// one layer of stars: a jittered grid, most cells empty, a few bright ones with a soft halo
vec3 starLayer(vec2 uv, float scale, float keep, float t, float salt){
  vec2 g = uv * scale;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float b = h21(id + salt + u_seed);
  if (b < keep) return vec3(0.0);
  vec2 o = h22(id + salt * 1.7 + u_seed) - 0.5;
  float d = length(f - o * 0.7);
  float tw = 0.65 + 0.35 * sin(t * (0.6 + b * 2.5) + b * 60.0);
  float core = smoothstep(0.09, 0.0, d);
  float halo = 0.015 / (d * d + 0.015) * 0.08;
  vec3 c = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.86, 0.68), h21(id + 7.3 + salt));
  return c * (core + halo) * tw * (0.5 + 2.5 * (b - keep) / (1.0 - keep));
}

vec3 stars(vec2 uv, float t){
  return starLayer(uv, 34.0, 0.93, t, 1.0) + starLayer(uv, 70.0, 0.86, t, 2.0) * 0.8 + starLayer(uv, 140.0, 0.8, t, 3.0) * 0.55;
}

vec3 sky(vec2 p, float t, float seed){
  // ---- this place's parameters
  vec2 gc = vec2(mix(-0.45, 0.45, h11(seed + 1.0)), mix(0.02, 0.22, h11(seed + 2.0)));
  float grot = h11(seed + 3.0) * 6.283 + t * 0.006;
  float tilt = mix(0.28, 0.85, h11(seed + 4.0));
  float gscale = mix(0.24, 0.42, h11(seed + 5.0));
  float arms = floor(mix(2.0, 4.99, h11(seed + 6.0)));
  float twist = mix(2.4, 5.2, h11(seed + 7.0));
  vec3 armCol = neb(h11(seed + 8.0));                           // outer arms
  vec3 armIn = neb(h11(seed + 8.0) + 0.25 + 0.5 * h11(seed + 18.0)); // inner arms, a second tone
  bool hole = h11(seed + 9.0) > 0.55;                           // sometimes a black hole in the core
  float rb = gscale * 0.085;

  // ---- gravitational lensing of the starfield around the black hole
  vec2 d = p - gc;
  float dl = length(d);
  vec2 sp = p;
  if (hole) sp = p - normalize(d) * rb * rb * 1.6 / max(dl, rb * 0.6);
  vec3 col = stars(sp + vec2(t * 0.002, 0.0), t);

  // ---- faint milky band across the sky
  vec2 bp = rot(h11(seed + 10.0) * 3.14) * p;
  float band = exp(-pow(bp.y * 3.2, 2.0)) * fbm(bp * 3.0 + seed);
  col += neb(h11(seed + 11.0)) * band * 0.10;

  // ---- the galaxy (in its own tilted, rotated plane)
  vec2 q = rot(grot) * d;
  q.y /= tilt;
  q /= gscale;
  float r = length(q);
  float a = atan(q.y, q.x);
  // arms with a ragged phase so they are not perfect spirals, plus a few spurs
  float wob = (fbm(q * 1.4 + seed * 0.7) - 0.5) * 1.6;
  float spiral = pow(0.5 + 0.5 * cos(arms * (a - twist * log(r + 0.06)) + wob - t * 0.015), 2.6);
  spiral += 0.35 * pow(0.5 + 0.5 * cos((arms * 2.0 + 1.0) * (a - twist * 1.15 * log(r + 0.06)) + wob * 2.0), 6.0) * smoothstep(0.2, 0.7, r);
  float disk = exp(-r * 2.1);
  float clumps = fbm(q * 3.4 + seed);
  float arm = spiral * disk * (0.45 + 1.0 * clumps);
  float dust = smoothstep(0.42, 0.78, fbm(q * 7.0 - seed * 1.3)) * spiral * exp(-r * 1.2);
  float core = exp(-r * 8.0) * 1.7 + exp(-r * 2.8) * 0.28;
  vec3 g = mix(armIn, armCol, smoothstep(0.2, 1.1, r)) * arm * 1.35 + vec3(1.0, 0.86, 0.62) * core;
  g += neb(h11(seed + 19.0)) * smoothstep(0.62, 0.9, clumps) * disk * spiral * 0.9;   // HII knots
  g += starLayer(q * 0.35, 90.0, 0.7, t, 9.0) * spiral * disk * 1.6; // star clusters in the arms
  g *= 1.0 - dust * 0.75;
  g *= smoothstep(2.8, 1.3, r);
  col += g;

  if (hole) {
    // "Gargantua": a black shadow, a thin edge-on accretion disk crossing it, the far side of the
    // disk lensed up and over (and faintly under) the shadow, a photon ring, Doppler-brightened
    // on the side moving towards us
    float edge = rb * 1.0;
    float shadow = smoothstep(edge * 0.94, edge * 1.06, dl);
    vec2 dq = rot(grot * 0.15) * d;                             // nearly level, like the film
    float doppler = 1.0 + 0.55 * clamp(-dq.x / (rb * 3.0), -1.0, 1.0);
    float thick = rb * 0.16;
    float flow = 0.75 + 0.25 * fbm(vec2(dq.x / rb * 3.0 - t * 0.6, dq.y / rb * 20.0));
    float adisk = exp(-pow(dq.y / thick, 2.0)) * smoothstep(rb * 3.4, rb * 1.1, abs(dq.x)) * flow;
    float yy = dq.y / max(dl, 1e-4);
    float halo = exp(-pow((dl - rb * 1.32) / (rb * 0.24), 2.0));
    float upper = halo * smoothstep(-0.35, 0.5, yy) * 1.6;            // lensed far side above
    float lower = exp(-pow((dl - rb * 1.22) / (rb * 0.12), 2.0)) * smoothstep(0.2, -0.7, yy) * 0.55;
    float ring = exp(-pow((dl - rb * 1.06) / (rb * 0.045), 2.0));
    vec3 hot = vec3(1.0, 0.80, 0.55);
    vec3 white = vec3(1.0, 0.95, 0.88);
    vec3 light = hot * (upper * 1.3 + lower) * doppler + white * ring * 1.5 + mix(hot, white, adisk) * adisk * 2.2 * doppler;
    light += hot * exp(-dl / (rb * 2.2)) * 0.18;                // glow of the inner disk
    col = col * shadow + light;                                  // the disk passes in front of the shadow
  }
  return col;
}

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;     // y in [-0.5, 0.5]
  float t = u_time;
  float w = u_warp;
  float k = sin(3.14159 * w);                             // 0 → 1 → 0 over the jump

  // flying into the centre while the jump builds up
  vec2 sp = p / (1.0 + k * 2.5);
  vec3 col = sky(sp, t, u_seed);

  // ---- planet: a dark horizon with a thin atmosphere glow at the bottom of the window
  vec2 pc = vec2(0.0, -3.42);
  vec3 atmo = neb(h11(u_seed + 12.0)) * 0.9;
  float ground = length(p - pc) - 3.0;
  float rough = mix(0.4, 1.4, h11(u_seed + 13.0));            // flat plains … jagged peaks
  // two ranges of mountains: far ones hazy in the atmosphere, near ones a black silhouette
  float farR = ground - rough * (0.035 * ridge(p.x * 3.0 + u_seed) + 0.018 * ridge(p.x * 9.0 - u_seed)) - 0.006;
  float nearR = ground - rough * (0.028 * ridge(p.x * 1.7 - u_seed * 1.3) * ridge(p.x * 4.3 + 3.0) + 0.008 * noise(vec2(p.x * 30.0, u_seed)));
  float glow = exp(-max(farR, 0.0) * 26.0) * step(0.0, farR);
  col += atmo * glow * 0.32 * (1.0 - k);
  col = mix(col, atmo * 0.07 + vec3(0.01, 0.008, 0.02), smoothstep(0.002, -0.002, farR) * (1.0 - k));
  col = mix(col, vec3(0.004, 0.003, 0.009), smoothstep(0.002, -0.002, nearR) * (1.0 - k));

  // ---- wormhole jump: light streaks rushing outward, a lensing ring, a flash at the peak
  if (w > 0.0) {
    // inside the wormhole: a twisting tube of lensed starlight, streaks rushing past, the light of
    // the other side growing at the end of the tube
    float r = length(p);
    float z = 0.22 / (r + 0.02);                                // depth along the tube
    float ang = atan(p.y, p.x) + z * 0.35 * k + t * 0.4;       // the tube twists
    float u = ang / 6.28318;
    float v = z - t * 6.0;
    float lane = floor(u * 140.0);
    float rnd = h11(lane + 3.0);
    float sv = fract((z - t * 9.0 * (0.4 + rnd)) * 0.35 + rnd * 11.0);
    float streak = smoothstep(0.0, 0.08, sv) * smoothstep(0.5, 0.08, sv) * step(0.55, h11(lane + 17.0));
    vec3 sc = mix(vec3(0.5, 0.68, 1.0), vec3(1.0, 0.86, 0.72), rnd);
    float wall = fbm(vec2(u * 10.0, v * 0.5)) * fbm(vec2(u * 23.0 + 4.0, v * 1.3));
    vec3 tube = mix(neb(u + 0.2 * v * 0.05), vec3(0.9, 0.95, 1.0), 0.25) * wall * 1.4 * smoothstep(0.0, 0.3, r);
    vec3 tunnel = tube + sc * streak * smoothstep(0.03, 0.3, r) * 0.9;
    tunnel += vec3(0.75, 0.85, 1.0) * exp(-r * 9.0) * (0.4 + 1.2 * w);   // the exit
    float ringR = 0.05 + 0.6 * w * w;                            // lensing ring sweeping outward
    tunnel += vec3(0.8, 0.9, 1.0) * exp(-pow((r - ringR) / 0.01, 2.0)) * (1.0 - w) * 0.8;
    col = mix(col, col * 0.2 + tunnel, smoothstep(0.05, 0.45, k));
    col += vec3(0.80, 0.88, 1.0) * exp(-pow((w - 0.5) / 0.06, 2.0)) * 0.45;  // soft flash, not blinding
  }

  col = 1.0 - exp(-col * 1.25);                           // soft tone mapping
  col *= 0.75 + 0.25 * smoothstep(1.1, 0.2, length(p));   // vignette
  gl_FragColor = vec4(col, 1.0);
}`

const FPS = { animated: 24, calm: 10, static: 0 } as const
const JUMP_MS = 4200

/** Numeric seed from any value (game id, string …). */
export const cosmicSeed = (v: number | string): number => {
  let h = 2166136261
  for (const c of String(v)) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return ((h >>> 0) % 100000) / 7.31
}

/**
 * Full-window space background (Games pages, loading screen). When `seed` changes, the view
 * jumps through a wormhole to the next galaxy. Half resolution so the stars stay crisp.
 */
export function CosmosBackground({
  seed,
  mode,
  inGame,
  jumpOnMount = false
}: {
  seed: number
  mode: Settings['ui']['background']
  inGame: boolean
  /** start with the wormhole jump (loading screen: arriving at the next game) */
  jumpOnMount?: boolean
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const effective: keyof typeof FPS = reduced ? 'static' : inGame && mode === 'animated' ? 'calm' : mode
  const target = useRef(seed)
  const jump = useRef<{ from: number; to: number; start: number } | null>(null)
  const shown = useRef(jumpOnMount ? seed + 13.7 : seed)

  // a new seed → jump (unless everything is still)
  useEffect(() => {
    if (seed === target.current && !jumpOnMount) return
    target.current = seed
    if (effective === 'static') shown.current = seed
    else jump.current = { from: shown.current, to: seed, start: performance.now() }
  }, [seed, effective, jumpOnMount])

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
    const uSeed = gl.getUniformLocation(prog, 'u_seed')
    const uWarp = gl.getUniformLocation(prog, 'u_warp')

    const SCALE = Math.min(1, (window.devicePixelRatio || 1) * 0.5)
    const resize = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    const draw = (now: number) => {
      let warp = 0
      const j = jump.current
      if (j) {
        const x = Math.min(1, (now - j.start) / JUMP_MS)
        warp = x
        shown.current = x < 0.5 ? j.from : j.to
        if (x >= 1) jump.current = null
      }
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, now / 1000)
      gl.uniform1f(uSeed, shown.current)
      gl.uniform1f(uWarp, warp)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
    resize()
    const fps = FPS[effective]
    let raf = 0
    let last = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      // the jump always runs smoothly, the idle sky at the chosen rate
      if (!jump.current && now - last < 1000 / (fps || 1) - 2) return
      if (!jump.current && !fps && last) return
      last = now
      draw(now)
    }
    const onResize = () => {
      resize()
      draw(performance.now())
    }
    window.addEventListener('resize', onResize)
    raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [effective])

  return <canvas key={effective} ref={ref} aria-hidden className="pointer-events-none fixed inset-0 -z-10 h-full w-full" />
}
