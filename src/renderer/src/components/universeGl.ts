import { STAR_STRIDE, UNIVERSE, cross, dot, galaxyStars, normalize, sub, type Galaxy, type Vec3 } from '@shared/universe'
import { SPACE_LIB } from './spaceGlsl'

/*
 * WebGL renderer for the universe catalogue (shared/universe.ts), used by the flight between two
 * games and by the star map. Everything is drawn in 3D with one perspective camera:
 *
 *   galaxies  a flat spiral disk per galaxy, oriented in space, so disks tilt as you pass them
 *   cores     a glowing point per galaxy, keeps far galaxies visible when the disk is a few pixels
 *   stars     the individual stars of one galaxy, drawn when the camera is close to or inside it
 *   streaks   dust along the flight path, drawn as short lines from where each grain was a moment ago
 *   route     a line through a list of positions (the star map's path from game to game)
 *
 * Nothing writes depth; all layers are added on top of each other.
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

function basisOf(camera: Camera): Basis {
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
`
const TONE = `
uniform vec2 u_res;
vec3 tone(vec3 col){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  col = 1.0 - exp(-col * 1.25);
  return col * (0.75 + 0.25 * smoothstep(1.1, 0.2, length(p)));
}
`

const GALAXY_VERT = `
attribute vec3 a_center;
attribute vec3 a_u;
attribute vec3 a_v;
attribute vec2 a_corner;
attribute vec4 a_par;
attribute float a_rad;
uniform vec3 u_eye;
varying vec2 v_q;
varying vec4 v_par;
varying float v_alpha;
${CAMERA}
void main(){
  vec3 rel = a_center - u_eye;
  float d = length(rel);
  float h = abs(dot(rel, cross(a_u, a_v)));                       // height of the camera above the disk
  // a disk seen edge-on is a hard line, and from inside it there is no disk to see: fade both out
  v_alpha = smoothstep(0.02, 0.14, h / d) * smoothstep(0.03, 0.3, h / a_rad);
  v_q = a_corner * 1.7;
  v_par = a_par;
  gl_Position = project(rel + (a_corner.x * a_u + a_corner.y * a_v) * a_rad * 1.7);
}`
const GALAXY_FRAG = `${SPACE_LIB}
varying vec2 v_q;
varying vec4 v_par;
varying float v_alpha;
uniform float u_time;
uniform float u_gain;
${TONE}
void main(){
  float r = length(v_q);
  if (v_alpha <= 0.0 || r > 1.7) discard;
  g_seed = v_par.w;
  vec3 c = galaxyShapeP(v_q, u_time, v_par.x, v_par.y, v_par.z, v_par.w) * smoothstep(1.7, 1.15, r);
  gl_FragColor = vec4(tone(c * v_alpha * u_gain), 1.0);
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
varying vec3 v_col;
${CAMERA}
void main(){
  vec3 rel = u_rel + u_rad * (a_local.x * u_gu + a_local.y * u_gv + a_local.z * u_gn);
  gl_Position = project(rel);
  float dn = length(rel) / u_rad;
  gl_PointSize = clamp(1.3 + 0.2 * (0.3 + a_mag) / dn, 1.3, 9.0) * u_dpr;
  float bright = clamp(0.2 + 0.035 * (0.25 + a_mag) / (dn * dn), 0.0, 1.7) * smoothstep(0.0015, 0.008, dn);
  vec3 c = mix(vec3(0.62, 0.76, 1.0), vec3(1.0, 0.84, 0.64), a_warm);
  v_col = mix(c, u_tint, 0.25 * (1.0 - a_warm)) * bright * u_alpha;
}`

const STREAK_VERT = `
attribute vec3 a_pos;
attribute float a_end;
uniform vec3 u_eye;
uniform vec3 u_eyePrev;
uniform vec3 u_rightPrev;
uniform vec3 u_upPrev;
uniform vec3 u_forwardPrev;
uniform float u_range;
uniform float u_alpha;
varying vec3 v_col;
${CAMERA}
void main(){
  vec3 rel = a_pos - u_eye;
  float d = length(rel);
  if (a_end < 0.5) {
    gl_Position = project(rel);
  } else {
    vec3 prev = a_pos - u_eyePrev;
    float depth = dot(prev, u_forwardPrev);
    gl_Position = vec4(dot(prev, u_rightPrev) * u_proj.x, dot(prev, u_upPrev) * u_proj.y, depth - 0.0002, depth);
  }
  float a = u_alpha * smoothstep(u_range, u_range * 0.25, d) * smoothstep(0.0, u_range * 0.04, d);
  v_col = vec3(0.7, 0.82, 1.0) * a * (1.0 - a_end);                // the tail fades out
}`
const ROUTE_VERT = `
attribute vec3 a_pos;
uniform vec3 u_eye;
uniform vec3 u_colour;
varying vec3 v_col;
${CAMERA}
void main(){
  gl_Position = project(a_pos - u_eye);
  v_col = u_colour;
}`
const FLAT_FRAG = `
precision highp float;
varying vec3 v_col;
void main(){ gl_FragColor = vec4(v_col, 1.0); }`

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

export function createProgram(gl: WebGLRenderingContext, vert: string, frag: string): Program | null {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) console.warn('universe shader:', gl.getShaderInfoLog(shader))
    return shader
  }
  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vert))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, frag))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('universe shader:', gl.getProgramInfoLog(program))
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

/** The stars of one galaxy, uploaded to the GPU. */
export interface StarCloud {
  galaxy: Galaxy
  buffer: WebGLBuffer
  count: number
}

export class UniverseGl {
  private readonly galaxyProgram: Program
  private readonly coreProgram: Program
  private readonly starProgram: Program
  private readonly streakProgram: Program
  private readonly routeProgram: Program
  private readonly galaxyBuffer: WebGLBuffer
  private readonly coreBuffer: WebGLBuffer
  private readonly scratch: WebGLBuffer
  private basis: Basis = { eye: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, -1] }
  private proj: [number, number] = [1, 1]
  /** focal length in pixels: a length l at distance d covers l / d * focalPx pixels */
  private focalPx = 1
  private enabledAttribs: number[] = []

  private constructor(
    private readonly gl: WebGLRenderingContext,
    programs: Program[]
  ) {
    ;[this.galaxyProgram, this.coreProgram, this.starProgram, this.streakProgram, this.routeProgram] = programs
    // one quad (two triangles) per galaxy
    const corners = [-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]
    const quads = new Float32Array(UNIVERSE.length * 6 * 16)
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
            galaxy.radius
          ],
          (index * 6 + vertex) * 16
        )
      }
      const tint = nebula(galaxy.hue)
      cores.set([...galaxy.pos, 0.65 + 0.35 * tint[0], 0.57 + 0.3 * tint[1], 0.46 + 0.3 * tint[2], galaxy.radius], index * 7)
    })
    this.galaxyBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.galaxyBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, quads, gl.STATIC_DRAW)
    this.coreBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coreBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, cores, gl.STATIC_DRAW)
    this.scratch = gl.createBuffer()!
  }

  /** Null when WebGL shaders can't be built on this machine. */
  static create(gl: WebGLRenderingContext): UniverseGl | null {
    const programs = [
      createProgram(gl, GALAXY_VERT, GALAXY_FRAG),
      createProgram(gl, CORE_VERT, SOFT_POINT_FRAG),
      createProgram(gl, STARS_VERT, SOFT_POINT_FRAG),
      createProgram(gl, STREAK_VERT, FLAT_FRAG),
      createProgram(gl, ROUTE_VERT, FLAT_FRAG)
    ]
    if (programs.some((program) => !program)) return null
    return new UniverseGl(gl, programs as Program[])
  }

  /** Clears the frame and sets the camera for the draw calls that follow. */
  begin(camera: Camera): void {
    const gl = this.gl
    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    this.basis = basisOf(camera)
    const f = 1 / Math.tan(camera.fovY / 2)
    this.proj = [f / (width / height), f]
    this.focalPx = (f * height) / 2
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
    gl.uniform2f(program.uniform('u_res'), gl.drawingBufferWidth, gl.drawingBufferHeight)
  }

  /** Binds a full-screen quad (x, y pairs) to the attribute `p` of a program of your own. */
  bindQuad(program: Program, quad: WebGLBuffer): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    for (const location of this.enabledAttribs) gl.disableVertexAttribArray(location)
    const location = program.attrib('p')
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0)
    this.enabledAttribs = [location]
  }

  /** All galaxies of the catalogue: their disks and core glows. */
  drawGalaxies(time: number, gain = 1): void {
    const gl = this.gl
    this.use(this.galaxyProgram, this.galaxyBuffer, 16, [
      ['a_center', 3],
      ['a_u', 3],
      ['a_v', 3],
      ['a_corner', 2],
      ['a_par', 4],
      ['a_rad', 1]
    ])
    gl.uniform1f(this.galaxyProgram.uniform('u_time'), time)
    gl.uniform1f(this.galaxyProgram.uniform('u_gain'), gain)
    gl.drawArrays(gl.TRIANGLES, 0, UNIVERSE.length * 6)

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

  /** The stars of one galaxy. `pointScale` makes the points bigger on low-resolution canvases. */
  drawStars(cloud: StarCloud, alpha: number, pointScale = 1): void {
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
    gl.drawArrays(gl.POINTS, 0, cloud.count)
  }

  /** Uploads line data once; returns the buffer for drawStreaks / drawRoute. */
  createBuffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl
    const buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    return buffer
  }

  /**
   * Dust grains as motion streaks. The buffer holds two vertices per grain (x, y, z, end) with
   * end = 0 and 1; the second one is projected with the camera of a moment ago.
   */
  drawStreaks(buffer: WebGLBuffer, grains: number, previous: Camera, range: number, alpha: number): void {
    if (alpha <= 0.003) return
    const gl = this.gl
    const program = this.streakProgram
    this.use(program, buffer, 4, [
      ['a_pos', 3],
      ['a_end', 1]
    ])
    const prev = basisOf(previous)
    gl.uniform3fv(program.uniform('u_eyePrev'), prev.eye)
    gl.uniform3fv(program.uniform('u_rightPrev'), prev.right)
    gl.uniform3fv(program.uniform('u_upPrev'), prev.up)
    gl.uniform3fv(program.uniform('u_forwardPrev'), prev.forward)
    gl.uniform1f(program.uniform('u_range'), range)
    gl.uniform1f(program.uniform('u_alpha'), alpha)
    gl.drawArrays(gl.LINES, 0, grains * 2)
  }

  /** A line through the given positions, in order. */
  drawRoute(points: Vec3[], colour: Vec3): void {
    if (points.length < 2) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.scratch)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points.flat()), gl.DYNAMIC_DRAW)
    this.use(this.routeProgram, this.scratch, 3, [['a_pos', 3]])
    gl.uniform3fv(this.routeProgram.uniform('u_colour'), colour)
    gl.drawArrays(gl.LINE_STRIP, 0, points.length)
  }
}
