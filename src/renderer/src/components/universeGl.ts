import { STAR_STRIDE, UNIVERSE, cross, dot, galaxyStars, normalize, sub, typeCode, type Galaxy, type Vec3 } from '@shared/universe'
import { SPACE_LIB } from './spaceGlsl'

/*
 * WebGL renderer for the universe catalogue (shared/universe.ts), used by the flight between two
 * games and by the star map. Everything is drawn in 3D with one perspective camera:
 *
 *   backdrop  faint far-away galaxies and a hint of nebula behind everything, one full-screen pass
 *   galaxies  per galaxy a disk in its own plane (spirals, bars, rings, ...) plus a camera-facing
 *             ellipse: the whole galaxy for ellipticals, the thin streak of a disk seen edge-on
 *   cores     a glowing point per galaxy, keeps far galaxies visible when the disk is a few pixels
 *   stars     the individual stars of one galaxy, drawn when the camera is close to or inside it
 *   route     a line through a list of positions with light flowing along it (the star map's path)
 *
 * Nothing writes depth; all layers are added on top of each other. `begin` can target an offscreen
 * framebuffer (the flight renders into textures and lenses them afterwards).
 */

export interface Camera {
  eye: Vec3
  forward: Vec3
  up: Vec3
  /** vertical field of view in radians */
  fovY: number
}

interface Basis {
  eye: Vec3
  right: Vec3
  up: Vec3
  forward: Vec3
}

export function basisOf(camera: Camera): Basis {
  const forward = normalize(camera.forward)
  const right = normalize(cross(forward, camera.up))
  return { eye: camera.eye, right, up: cross(right, forward), forward }
}

/** Screen position of a world point: x and y in 0..1 from the top left, or null if it is behind the camera. */
export function projectPoint(camera: Camera, aspect: number, point: Vec3): { x: number; y: number; depth: number } | null {
  const basis = basisOf(camera)
  const rel = sub(point, basis.eye)
  const depth = dot(rel, basis.forward)
  if (depth <= 1e-4) return null
  const f = 1 / Math.tan(camera.fovY / 2)
  return { x: 0.5 + (0.5 * dot(rel, basis.right) * f) / aspect / depth, y: 0.5 - (0.5 * dot(rel, basis.up) * f) / depth, depth }
}

// camera uniforms and projection shared by all vertex shaders. Positions are handed in relative
// to the camera, which keeps full precision close to the eye.
const CAMERA = `
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_forward;
uniform vec2 u_proj;
vec4 project(vec3 rel){
  float depth = dot(rel, u_forward);
  return vec4(dot(rel, u_right) * u_proj.x, dot(rel, u_up) * u_proj.y, depth - 0.0002, depth);
}
mat2 rot2(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
`
// u_vig is 0 when rendering into a texture that is composited later (no vignette, it would show seams)
const TONE = `
uniform vec2 u_res;
uniform float u_vig;
vec3 tone(vec3 col){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  col = 1.0 - exp(-col * 1.25);
  return col * mix(1.0, 0.75 + 0.25 * smoothstep(1.1, 0.2, length(p)), u_vig);
}
`

// shared by both galaxy passes
const GALAXY_ATTRIBS = `
attribute vec3 a_center;
attribute vec3 a_u;
attribute vec3 a_v;
attribute vec2 a_corner;
attribute vec4 a_par;
attribute vec4 a_par2;
attribute float a_rad;
uniform vec3 u_eye;
uniform float u_time;
uniform float u_spin;     // 1 lets the galaxies turn (star map), 0 keeps them still (flight)
varying vec4 v_par;
varying vec4 v_par2;
bool spheroid(){ return abs(a_par2.x - 2.0) < 0.5 || (abs(a_par2.x - 5.0) < 0.5 && a_par2.y < 0.5); }
`

const DISK_VERT = `
${GALAXY_ATTRIBS}
varying vec2 v_q;
varying float v_alpha;
${CAMERA}
void main(){
  vec3 rel = a_center - u_eye;
  float d = length(rel);
  float h = abs(dot(rel, cross(a_u, a_v)));                       // height of the camera above the disk
  // a disk seen edge-on is a hard line (the halo pass draws the streak instead), and from inside
  // it there is no disk to see: fade both out
  v_alpha = spheroid() ? 0.0 : smoothstep(0.02, 0.14, h / d) * smoothstep(0.03, 0.3, h / a_rad);
  if (v_alpha <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // turning the texture coordinates turns the painted galaxy (same rotation as the stars get)
  v_q = rot2(a_par2.w * u_time * u_spin) * (a_corner * 1.7);
  v_par = a_par;
  v_par2 = a_par2;
  gl_Position = project(rel + (a_corner.x * a_u + a_corner.y * a_v) * a_rad * 1.7);
}`
const DISK_FRAG = `${SPACE_LIB}
varying vec2 v_q;
varying vec4 v_par;
varying vec4 v_par2;
varying float v_alpha;
uniform float u_time;
uniform float u_gain;
${TONE}
void main(){
  float r = length(v_q);
  if (r > 1.7) discard;
  g_seed = v_par.w;
  vec3 c = galaxyDisk(v_q, u_time, v_par, v_par2) * smoothstep(1.7, 1.15, r);
  gl_FragColor = vec4(tone(c * v_alpha * u_gain), 1.0);
}`

const HALO_VERT = `
${GALAXY_ATTRIBS}
varying vec2 v_b;
varying float v_ratio;
varying float v_edge;
${CAMERA}
void main(){
  vec3 rel = a_center - u_eye;
  float d = length(rel);
  vec3 w = rel / d;
  vec3 n = cross(a_u, a_v);
  float c = abs(dot(n, w));
  bool ball = spheroid();
  // ellipticals: E0 to E7; dwarf spheroidals a little flattened; disks are thin
  float q = abs(a_par2.x - 2.0) < 0.5 ? 1.0 - floor(a_par2.y * 7.0 + 0.5) / 10.0 : ball ? 0.75 : 0.1;
  v_ratio = sqrt(c * c + q * q * (1.0 - c * c));
  // disks only show up here when seen edge-on; up close the single stars take over
  v_edge = (ball ? 1.0 : 1.0 - smoothstep(0.02, 0.14, c)) * smoothstep(0.8, 2.2, d / a_rad);
  if (v_edge <= 0.001) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 pn = n - dot(n, w) * w;                                     // the normal as seen on screen = minor axis
  vec3 minor = length(pn) > 1e-4 ? normalize(pn) : normalize(cross(w, a_u));
  vec3 major = cross(minor, w);
  v_b = a_corner * 1.7;
  v_par = a_par;
  v_par2 = a_par2;
  gl_Position = project(rel + (a_corner.x * major + a_corner.y * minor) * a_rad * 1.7);
}`
const HALO_FRAG = `${SPACE_LIB}
varying vec2 v_b;
varying vec4 v_par;
varying vec4 v_par2;
varying float v_ratio;
varying float v_edge;
uniform float u_time;
uniform float u_gain;
${TONE}
void main(){
  float r = length(v_b);
  if (r > 1.7) discard;
  g_seed = v_par.w;
  vec3 c = galaxyHalo(v_b, u_time, v_par, v_par2, v_ratio, 1.0) * smoothstep(1.7, 1.3, r);
  gl_FragColor = vec4(tone(c * v_edge * u_gain), 1.0);
}`

const CORE_VERT = `
attribute vec3 a_center;
attribute vec3 a_col;
attribute float a_rad;
uniform vec3 u_eye;
uniform float u_px;
uniform float u_gain;
varying vec3 v_col;
${CAMERA}
void main(){
  vec3 rel = a_center - u_eye;
  float d = length(rel);
  gl_Position = project(rel);
  float px = a_rad / d * u_px;                                     // radius of the disk on screen
  gl_PointSize = clamp(px * 0.7, 2.5, 48.0);
  float far = clamp(px * 0.28, 0.0, 1.0);                          // galaxies smaller than the dot get dimmer instead
  float inside = smoothstep(0.6, 2.0, d / a_rad);                  // no core glow from within the galaxy
  v_col = a_col * (0.22 + 0.78 * far) * mix(1.0, 0.4, smoothstep(6.0, 30.0, px)) * inside * u_gain;
}`
const SOFT_POINT_FRAG = `
precision highp float;
varying vec3 v_col;
${TONE}
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float a = max(0.0, exp(-dot(d, d) * 20.0) - 0.0067);
  gl_FragColor = vec4(tone(v_col * a), 1.0);
}`

const STARS_VERT = `
attribute vec3 a_local;
attribute float a_mag;
attribute float a_warm;
uniform vec3 u_rel;       // galaxy centre relative to the camera
uniform vec3 u_gu;
uniform vec3 u_gv;
uniform vec3 u_gn;
uniform float u_rad;
uniform vec3 u_tint;
uniform float u_alpha;
uniform float u_dpr;
uniform float u_turn;     // how far the galaxy has turned (star map)
uniform float u_time;
varying vec3 v_col;
${CAMERA}
void main(){
  vec2 xy = rot2(-u_turn) * a_local.xy;
  vec3 rel = u_rel + u_rad * (xy.x * u_gu + xy.y * u_gv + a_local.z * u_gn);
  gl_Position = project(rel);
  float dn = length(rel) / u_rad;
  gl_PointSize = clamp(1.3 + 0.2 * (0.3 + a_mag) / dn, 1.3, 9.0) * u_dpr;
  float bright = clamp(0.2 + 0.035 * (0.25 + a_mag) / (dn * dn), 0.0, 1.7) * smoothstep(0.0015, 0.008, dn);
  // the brighter stars twinkle a little
  bright *= 1.0 - a_mag * 0.35 * (0.5 + 0.5 * sin(u_time * (1.3 + 4.0 * fract(a_local.x * 91.7)) + a_local.y * 300.0));
  vec3 c = mix(vec3(0.62, 0.76, 1.0), vec3(1.0, 0.84, 0.64), a_warm);
  v_col = mix(c, u_tint, 0.25 * (1.0 - a_warm)) * bright * u_alpha;
}`

const ROUTE_VERT = `
attribute vec3 a_pos;
attribute float a_t;
uniform vec3 u_eye;
varying float v_t;
${CAMERA}
void main(){
  gl_Position = project(a_pos - u_eye);
  v_t = a_t;
}`
// light pulses run along the route from the oldest game to the newest
const ROUTE_FRAG = `
precision highp float;
varying float v_t;
uniform vec3 u_colour;
uniform float u_time;
void main(){
  float p = fract((v_t - u_time * 14.0) / 46.0);
  float head = pow(p, 14.0) * 2.6 + pow(p, 3.0) * 0.5;
  gl_FragColor = vec4(u_colour * (0.6 + head) + vec3(0.9, 0.95, 1.0) * pow(p, 40.0) * 0.8, 1.0);
}`

// Constellations of the achievements (star map): soft points for the stars, plain lines between them.
// From outside the sky sphere (zoomed far out) the ones on the near side fade, so they don't cover the universe.
const CONSTELLATION_VERT = `
attribute vec3 a_pos;
attribute vec3 a_col;
attribute float a_size;
uniform vec3 u_eye;
uniform float u_dpr;
uniform float u_time;
uniform float u_sky;
varying vec3 v_col;
${CAMERA}
void main(){
  gl_Position = project(a_pos - u_eye);
  float twinkle = 1.0 + 0.22 * sin(u_time * (1.7 + fract(a_pos.x * 0.173) * 2.0) + a_pos.y * 0.71);
  gl_PointSize = a_size * u_dpr * twinkle;
  float outside = smoothstep(0.9, 1.15, length(u_eye) / u_sky);
  float facing = dot(normalize(a_pos), normalize(u_eye + vec3(1e-4)));
  v_col = a_col * twinkle * mix(1.0, 1.0 - 0.8 * smoothstep(-0.1, 0.5, facing), outside);
}`
const CONSTELLATION_FRAG = `
precision highp float;
varying vec3 v_col;
uniform float u_point;
${TONE}
void main(){
  float a = 1.0;
  if (u_point > 0.5) {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    a = max(0.0, exp(-r2 * 16.0) + 0.9 * exp(-r2 * 110.0) - 0.02);
  }
  gl_FragColor = vec4(tone(v_col * a), 1.0);
}`

/** Stars and lines of the constellations, uploaded once per change: x, y, z, r, g, b, size per vertex. */
export interface ConstellationMesh {
  points: WebGLBuffer
  pointCount: number
  lines: WebGLBuffer
  lineCount: number
}

// Faint background: far galaxies too small to be more than a point, and a whisper of nebula. Its
// stars sit on a sphere around the camera, so they turn with the view but never come closer.
const BACKDROP_VERT = `attribute vec2 p; varying vec2 v_p; void main(){ v_p = p; gl_Position = vec4(p, 0.0, 1.0); }`
const BACKDROP_FRAG = `
precision highp float;
varying vec2 v_p;
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_forward;
uniform vec2 u_tan;
uniform float u_time;
uniform float u_gain;
uniform float u_pix;      // angular size of a pixel
float h31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 h33(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float vnoise(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec3 points(vec3 d, float scale, float keep, float salt){
  vec3 g = d * scale + salt;
  vec3 id = floor(g);
  float b = h31(id);
  if (b < keep) return vec3(0.0);
  vec3 o = (h33(id + 7.1) - 0.5) * 0.7;
  vec3 delta = fract(g) - 0.5 - o;
  delta -= dot(delta, d) * d;
  float px = u_pix * scale;
  float a = smoothstep(px * 1.6, 0.0, length(delta)) * (0.35 + 0.65 * (b - keep) / (1.0 - keep));
  float tw = 0.75 + 0.25 * sin(u_time * (0.4 + 2.0 * b) + b * 70.0);
  return mix(vec3(0.7, 0.78, 1.0), vec3(1.0, 0.88, 0.75), h31(id + 3.3)) * a * tw;
}
vec3 nebPal(float h){
  h = fract(h) * 4.0;
  vec3 c = mix(vec3(0.30, 0.52, 1.00), vec3(0.62, 0.40, 1.00), smoothstep(0.0, 1.0, h));
  c = mix(c, vec3(1.00, 0.42, 0.74), smoothstep(1.0, 2.0, h));
  c = mix(c, vec3(0.22, 0.85, 0.92), smoothstep(2.0, 3.0, h));
  return mix(c, vec3(0.30, 0.52, 1.00), smoothstep(3.0, 4.0, h));
}
void main(){
  vec3 d = normalize(u_forward + v_p.x * u_tan.x * u_right + v_p.y * u_tan.y * u_up);
  vec3 col = points(d, 150.0, 0.95, 0.0) * 0.3 + points(d, 320.0, 0.93, 17.0) * 0.16;
  vec3 q = d * 2.2 + vec3(0.0, u_time * 0.004, 0.0);
  float n = vnoise(q) * 0.5 + vnoise(q * 2.1) * 0.3 + vnoise(q * 4.3) * 0.2;
  float m = vnoise(d * 1.3 - 4.0);
  col += nebPal(m * 1.3 + 0.1) * smoothstep(0.45, 0.85, n) * 0.05;
  gl_FragColor = vec4((1.0 - exp(-col * 1.25)) * u_gain, 1.0);
}`

/** The nebula palette of the shaders (see `neb` in spaceGlsl), for colours computed in JS. */
export function nebula(hue: number): Vec3 {
  const stops: Vec3[] = [
    [0.3, 0.52, 1.0],
    [0.62, 0.4, 1.0],
    [1.0, 0.42, 0.74],
    [0.22, 0.85, 0.92]
  ]
  const h = (hue - Math.floor(hue)) * 4
  const i = Math.floor(h) % 4
  const t = h - Math.floor(h)
  const s = t * t * (3 - 2 * t)
  const a = stops[i]
  const b = stops[(i + 1) % 4]
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s]
}

export interface Program {
  program: WebGLProgram
  uniform: (name: string) => WebGLUniformLocation | null
  attrib: (name: string) => number
}

/** Vertex and fragment shader of every program UniverseGl uses, in the order of its `programs`. */
export const UNIVERSE_SHADERS: readonly [string, string][] = [
  [DISK_VERT, DISK_FRAG],
  [HALO_VERT, HALO_FRAG],
  [CORE_VERT, SOFT_POINT_FRAG],
  [STARS_VERT, SOFT_POINT_FRAG],
  [ROUTE_VERT, ROUTE_FRAG],
  [BACKDROP_VERT, BACKDROP_FRAG]
]

/**
 * Starts compiling and linking a program without waiting for the result. Asking for a compile or
 * link status makes the page wait until the GPU driver is done, which can take seconds on Windows
 * for the big flight shaders; finishProgram does that later, ideally once whenLinked says it's done.
 */
export function startProgram(gl: WebGLRenderingContext, vert: string, frag: string): WebGLProgram {
  const program = gl.createProgram()!
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vert],
    [gl.FRAGMENT_SHADER, frag]
  ] as const) {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  return program
}

/** Checks a started program (waits for it if it isn't done) and wraps it; null if it didn't link. */
export function finishProgram(gl: WebGLRenderingContext, program: WebGLProgram): Program | null {
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (!gl.isContextLost()) {
      const log = [gl.getProgramInfoLog(program), ...(gl.getAttachedShaders(program) ?? []).map((shader) => gl.getShaderInfoLog(shader))]
      console.warn('shader:', log.filter(Boolean).join('\n'))
    }
    return null
  }
  const uniforms = new Map<string, WebGLUniformLocation | null>()
  const attribs = new Map<string, number>()
  return {
    program,
    uniform: (name) => {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name))
      return uniforms.get(name)!
    },
    attrib: (name) => {
      if (!attribs.has(name)) attribs.set(name, gl.getAttribLocation(program, name))
      return attribs.get(name)!
    }
  }
}

export function createProgram(gl: WebGLRenderingContext, vert: string, frag: string): Program | null {
  return finishProgram(gl, startProgram(gl, vert, frag))
}

/**
 * Resolves once the GPU has finished the started programs, without blocking the page meanwhile
 * (KHR_parallel_shader_compile; Chromium has it on Windows). True when done, false after `timeoutMs`
 * or a lost context. Without the extension it resolves right away and finishProgram has to wait.
 */
export function whenLinked(gl: WebGLRenderingContext, programs: WebGLProgram[], timeoutMs: number): Promise<boolean> {
  const parallel = gl.getExtension('KHR_parallel_shader_compile')
  if (!parallel) return Promise.resolve(true)
  const started = performance.now()
  return new Promise((resolve) => {
    const poll = (): void => {
      if (gl.isContextLost()) return resolve(false)
      if (programs.every((program) => gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR) === true)) return resolve(true)
      if (performance.now() - started > timeoutMs) return resolve(false)
      setTimeout(poll, 50)
    }
    poll()
  })
}

/** The stars of one galaxy, uploaded to the GPU. */
export interface StarCloud {
  galaxy: Galaxy
  buffer: WebGLBuffer
  count: number
}

/** Where `begin` draws to: the canvas (null) or an offscreen framebuffer of the given size. */
export interface RenderTarget {
  framebuffer: WebGLFramebuffer | null
  width: number
  height: number
}

const GALAXY_STRIDE = 20

export class UniverseGl {
  private readonly diskProgram: Program
  private readonly haloProgram: Program
  private readonly coreProgram: Program
  private readonly starProgram: Program
  private readonly routeProgram: Program
  private readonly backdropProgram: Program
  private readonly galaxyBuffer: WebGLBuffer
  private readonly coreBuffer: WebGLBuffer
  private readonly scratch: WebGLBuffer
  readonly quad: WebGLBuffer
  private basis: Basis = { eye: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] }
  private proj: [number, number] = [1, 1]
  private tan: [number, number] = [1, 1]
  private size: [number, number] = [1, 1]
  /** focal length in pixels: a length l at distance d covers l / d * focalPx pixels */
  private focalPx = 1
  private vignette = 1
  private enabledAttribs: number[] = []

  private constructor(
    private readonly gl: WebGLRenderingContext,
    programs: Program[]
  ) {
    ;[this.diskProgram, this.haloProgram, this.coreProgram, this.starProgram, this.routeProgram, this.backdropProgram] = programs
    // one quad (two triangles) per galaxy, shared by the disk and the halo pass
    const corners = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]
    const quads = new Float32Array(UNIVERSE.length * 6 * GALAXY_STRIDE)
    const cores = new Float32Array(UNIVERSE.length * 7)
    UNIVERSE.forEach((galaxy, index) => {
      for (let vertex = 0; vertex < 6; vertex++) {
        quads.set(
          [
            ...galaxy.pos,
            ...galaxy.axisU,
            ...galaxy.axisV,
            corners[vertex * 2],
            corners[vertex * 2 + 1],
            galaxy.arms,
            galaxy.twist,
            galaxy.hue,
            galaxy.seed,
            typeCode(galaxy.type),
            galaxy.shape,
            galaxy.shape2,
            galaxy.spin,
            galaxy.radius
          ],
          (index * 6 + vertex) * GALAXY_STRIDE
        )
      }
      const tint = nebula(galaxy.hue)
      // old galaxies (ellipticals, lenticulars) glow warmer
      const warm = galaxy.type === 'elliptical' || galaxy.type === 'lenticular' ? 0.6 : 0
      cores.set(
        [
          ...galaxy.pos,
          0.65 + 0.35 * (tint[0] + (1 - tint[0]) * warm),
          0.57 + 0.3 * (tint[1] + (0.75 - tint[1]) * warm),
          0.46 + 0.3 * (tint[2] + (0.45 - tint[2]) * warm),
          galaxy.radius
        ],
        index * 7
      )
    })
    this.galaxyBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.galaxyBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, quads, gl.STATIC_DRAW)
    this.coreBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coreBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, cores, gl.STATIC_DRAW)
    this.scratch = gl.createBuffer()!
    this.quad = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  }

  /** Null when WebGL shaders can't be built on this machine. */
  static create(gl: WebGLRenderingContext): UniverseGl | null {
    return UniverseGl.fromPrograms(
      gl,
      UNIVERSE_SHADERS.map(([vert, frag]) => createProgram(gl, vert, frag))
    )
  }

  /** From programs built from UNIVERSE_SHADERS (in that order), null if one of them failed. */
  static fromPrograms(gl: WebGLRenderingContext, programs: (Program | null)[]): UniverseGl | null {
    if (programs.some((program) => !program)) return null
    return new UniverseGl(gl, programs as Program[])
  }

  /**
   * Sets the camera and target for the draw calls that follow and clears the target. Offscreen
   * targets get no vignette, since they are composited (and vignetted) later.
   */
  begin(camera: Camera, target: RenderTarget | null = null): void {
    const gl = this.gl
    const width = target ? target.width : gl.drawingBufferWidth
    const height = target ? target.height : gl.drawingBufferHeight
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null)
    this.basis = basisOf(camera)
    const f = 1 / Math.tan(camera.fovY / 2)
    this.proj = [f / (width / height), f]
    this.tan = [width / height / f, 1 / f]
    this.size = [width, height]
    this.focalPx = (f * height) / 2
    this.vignette = target ? 0 : 1
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
  }

  private use(program: Program, buffer: WebGLBuffer, stride: number, layout: [string, number][]): void {
    const gl = this.gl
    gl.useProgram(program.program)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    for (const location of this.enabledAttribs) gl.disableVertexAttribArray(location)
    this.enabledAttribs = []
    let offset = 0
    for (const [name, size] of layout) {
      const location = program.attrib(name)
      if (location >= 0) {
        gl.enableVertexAttribArray(location)
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride * 4, offset * 4)
        this.enabledAttribs.push(location)
      }
      offset += size
    }
    gl.uniform3fv(program.uniform('u_right'), this.basis.right)
    gl.uniform3fv(program.uniform('u_up'), this.basis.up)
    gl.uniform3fv(program.uniform('u_forward'), this.basis.forward)
    gl.uniform2fv(program.uniform('u_proj'), this.proj)
    gl.uniform3fv(program.uniform('u_eye'), this.basis.eye)
    gl.uniform2f(program.uniform('u_res'), this.size[0], this.size[1])
    gl.uniform1f(program.uniform('u_vig'), this.vignette)
  }

  /** Binds a full-screen quad (x, y pairs) to the attribute `p` of a program of your own. */
  bindQuad(program: Program, quad: WebGLBuffer = this.quad): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    for (const location of this.enabledAttribs) gl.disableVertexAttribArray(location)
    const location = program.attrib('p')
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    this.enabledAttribs = [location]
  }

  /** Far-away galaxies as faint points plus a trace of nebula, behind everything else. */
  drawBackdrop(time: number, gain = 1): void {
    const gl = this.gl
    const program = this.backdropProgram
    gl.useProgram(program.program)
    this.bindQuad(program)
    gl.uniform3fv(program.uniform('u_right'), this.basis.right)
    gl.uniform3fv(program.uniform('u_up'), this.basis.up)
    gl.uniform3fv(program.uniform('u_forward'), this.basis.forward)
    gl.uniform2fv(program.uniform('u_tan'), this.tan)
    gl.uniform1f(program.uniform('u_time'), time)
    gl.uniform1f(program.uniform('u_gain'), gain)
    gl.uniform1f(program.uniform('u_pix'), (2 * this.tan[1]) / this.size[1])
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /**
   * All galaxies of the catalogue: disks, edge-on streaks and ellipticals, and the core glows.
   * `spin` 1 lets each galaxy turn with time (star map); 0 keeps them still (flight).
   */
  drawGalaxies(time: number, gain = 1, spin = 0): void {
    const gl = this.gl
    const layout: [string, number][] = [
      ['a_center', 3],
      ['a_u', 3],
      ['a_v', 3],
      ['a_corner', 2],
      ['a_par', 4],
      ['a_par2', 4],
      ['a_rad', 1]
    ]
    for (const program of [this.diskProgram, this.haloProgram]) {
      this.use(program, this.galaxyBuffer, GALAXY_STRIDE, layout)
      gl.uniform1f(program.uniform('u_time'), time)
      gl.uniform1f(program.uniform('u_gain'), gain)
      gl.uniform1f(program.uniform('u_spin'), spin)
      gl.drawArrays(gl.TRIANGLES, 0, UNIVERSE.length * 6)
    }

    this.use(this.coreProgram, this.coreBuffer, 7, [
      ['a_center', 3],
      ['a_col', 3],
      ['a_rad', 1]
    ])
    gl.uniform1f(this.coreProgram.uniform('u_px'), this.focalPx)
    gl.uniform1f(this.coreProgram.uniform('u_gain'), gain)
    gl.drawArrays(gl.POINTS, 0, UNIVERSE.length)
  }

  /** Uploads stars of a galaxy: `count` stars of the whole galaxy, or your own star data in its frame. */
  createStars(galaxy: Galaxy, stars: number | Float32Array): StarCloud {
    const gl = this.gl
    const data = typeof stars === 'number' ? galaxyStars(galaxy, stars) : stars
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    return { galaxy, buffer, count: data.length / STAR_STRIDE }
  }

  /**
   * The stars of one galaxy. `pointScale` makes the points bigger on low-resolution canvases; `turn`
   * is how far the galaxy has turned (pass galaxy.spin * time on the star map to match its disk).
   */
  drawStars(cloud: StarCloud, alpha: number, pointScale = 1, turn = 0, time = 0): void {
    if (alpha <= 0.003) return
    const gl = this.gl
    const { galaxy } = cloud
    this.use(this.starProgram, cloud.buffer, STAR_STRIDE, [
      ['a_local', 3],
      ['a_mag', 1],
      ['a_warm', 1]
    ])
    const program = this.starProgram
    // subtracted here in double precision; in the shader it would jitter close to the stars
    gl.uniform3fv(program.uniform('u_rel'), sub(galaxy.pos, this.basis.eye))
    gl.uniform3fv(program.uniform('u_gu'), galaxy.axisU)
    gl.uniform3fv(program.uniform('u_gv'), galaxy.axisV)
    gl.uniform3fv(program.uniform('u_gn'), galaxy.normal)
    gl.uniform1f(program.uniform('u_rad'), galaxy.radius)
    gl.uniform3fv(program.uniform('u_tint'), nebula(galaxy.hue))
    gl.uniform1f(program.uniform('u_alpha'), alpha)
    gl.uniform1f(program.uniform('u_dpr'), pointScale)
    gl.uniform1f(program.uniform('u_turn'), turn)
    gl.uniform1f(program.uniform('u_time'), time)
    gl.drawArrays(gl.POINTS, 0, cloud.count)
  }

  /** Uploads data once and returns the buffer. */
  createBuffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    return buffer
  }

  private constellationProgram: Program | null | undefined

  /** Uploads the constellations' stars (points) and lines (pairs of vertices), 7 floats each. */
  createConstellations(points: Float32Array, lines: Float32Array, old?: ConstellationMesh | null): ConstellationMesh {
    const gl = this.gl
    if (old) {
      gl.deleteBuffer(old.points)
      gl.deleteBuffer(old.lines)
    }
    return {
      points: this.createBuffer(points),
      pointCount: points.length / 7,
      lines: this.createBuffer(lines),
      lineCount: lines.length / 7
    }
  }

  /** The constellations of the achievements (built the first time it is needed). */
  drawConstellations(mesh: ConstellationMesh, skyRadius: number, time = 0, pointScale = 1): void {
    if (this.constellationProgram === undefined) this.constellationProgram = createProgram(this.gl, CONSTELLATION_VERT, CONSTELLATION_FRAG)
    const program = this.constellationProgram
    if (!program) return
    const gl = this.gl
    const layout: [string, number][] = [
      ['a_pos', 3],
      ['a_col', 3],
      ['a_size', 1]
    ]
    const uniforms = (point: number) => {
      gl.uniform1f(program.uniform('u_point'), point)
      gl.uniform1f(program.uniform('u_time'), time)
      gl.uniform1f(program.uniform('u_dpr'), pointScale)
      gl.uniform1f(program.uniform('u_sky'), skyRadius)
    }
    if (mesh.lineCount) {
      this.use(program, mesh.lines, 7, layout)
      uniforms(0)
      gl.drawArrays(gl.LINES, 0, mesh.lineCount)
    }
    if (mesh.pointCount) {
      this.use(program, mesh.points, 7, layout)
      uniforms(1)
      gl.drawArrays(gl.POINTS, 0, mesh.pointCount)
    }
  }

  /** A line through the given positions, in order, with light pulses flowing from the first to the last. */
  drawRoute(points: Vec3[], colour: Vec3, time = 0): void {
    if (points.length < 2) return
    const gl = this.gl
    const data = new Float32Array(points.length * 4)
    let travelled = 0
    points.forEach((point, index) => {
      if (index > 0)
        travelled += Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1], point[2] - points[index - 1][2])
      data.set([...point, travelled], index * 4)
    })
    gl.bindBuffer(gl.ARRAY_BUFFER, this.scratch)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    this.use(this.routeProgram, this.scratch, 4, [
      ['a_pos', 3],
      ['a_t', 1]
    ])
    gl.uniform3fv(this.routeProgram.uniform('u_colour'), colour)
    gl.uniform1f(this.routeProgram.uniform('u_time'), time)
    gl.drawArrays(gl.LINE_STRIP, 0, points.length)
  }
}
