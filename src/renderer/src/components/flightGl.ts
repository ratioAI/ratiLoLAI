import {
  FLIGHT_S,
  FLIGHT_VARIANTS,
  PLANET_OFFSET,
  cinemaAt,
  destPlanetAt,
  homePlanetAt,
  sunGlowAt,
  type CameraPose,
  type FlightPlan,
  type FlightVariant,
  type PlanetView
} from '@shared/journey'
import { dot, length, neighbourhoodStars, normalize, sub, type Galaxy, type Vec3 } from '@shared/universe'
import { SPACE_LIB, VERT, galaxyUniforms } from './spaceGlsl'
import {
  UNIVERSE_SHADERS,
  UniverseGl,
  basisOf,
  finishProgram,
  startProgram,
  whenLinked,
  type Camera,
  type Program,
  type RenderTarget,
  type StarCloud
} from './universeGl'

/*
 * GPU side of the flight between two games (the camera path is shared/journey.ts).
 *
 * Every frame the universe is drawn once into a texture with the flight camera. A full-screen lens
 * pass then bends that picture: around the wormhole (and through it, where you see the other
 * side), on the way through its throat, or around the black hole, which is ray-marched along real
 * photon paths with its accretion disk. Light bent so far that it comes from outside the screen is
 * looked up in a cube map of the surroundings. The planet we leave and the one we land on are
 * painted over that (PLANET_FRAG), then bloom, a letterbox, a little vignette and film grain make
 * it look like a film.
 *
 * Everything that isn't the frame itself is made before the first frame: the stars, the cube maps
 * (they don't change during a flight), the pictures for every resolution the film may step down
 * to, and one draw with every program, so the driver has nothing left to do while the film plays.
 * Every frame is then the same small amount of work.
 *
 * While we stand on a planet the planet shader draws exactly the night sky's picture, and the film
 * look is zero on the first and last frames, so the flight begins and ends on what CosmosBackground
 * shows.
 *
 * Rules for these shaders (Direct3D's shader compiler on Windows copies every function call into
 * the shader and unrolls loops; shaders that compile in milliseconds elsewhere have hung it for
 * minutes, until Chromium killed the GPU process):
 *   - sky() is by far the biggest function: at most one call per shader.
 *   - Long loops only in GLSL ES 3.00 with a start the compiler can't know (see BLACKHOLE_LOOP),
 *     and nothing expensive inside them.
 */

// ---- the planets at both ends of the trip ----------------------------------------------------------
// One planet at a time: the old one until we have left it behind, then the new one (and its sun).
// On the ground it is the night sky's own picture; from above it is a globe (see PlanetView).
const PLANET_FRAG = `${SPACE_LIB}
uniform vec2 u_res;
uniform float u_time;
uniform float u_seed;
uniform vec4 u_gal;
uniform vec4 u_gal2;
uniform vec4 u_view;       // on the ground (1 or 0), pitch, drop, night
uniform vec3 u_globe;      // centre x, y and radius of the globe (radius 0 = none)
uniform vec2 u_light;      // direction on screen from the globe to its sun
uniform vec4 u_sun;        // the sun: x, y, size, brightness (0 = none)

vec3 sunGlow(vec2 d, float R){
  float r = length(d);
  return vec3(1.0, 0.88, 0.7) * (smoothstep(R, R * 0.85, r) * 2.5 + exp(-r / (R * 2.5)) * 0.9 + R * 0.02 / (r + 0.002));
}

// planet seen from space, lit by the sun, with an atmosphere glow at the rim. .a is coverage.
vec4 planetDisk(vec2 p, vec2 c, float R, vec2 sunDir, float seed, float night, out vec3 rim){
  vec2 d = (p - c) / R;
  float r = length(d);
  float px = 1.5 / (u_res.y * R);
  float cover = smoothstep(1.0, 1.0 - px, r);
  vec3 atmo = neb(h11(seed + 12.0)) * 0.9;
  float z = sqrt(max(0.0, 1.0 - r * r));
  vec3 n = vec3(d, z);
  float lit = clamp(dot(n, normalize(vec3(sunDir, 0.35))), 0.0, 1.0);
  float f = fbm(d * 2.5 / (z + 0.35) + seed);
  vec3 surf = mix(vec3(0.10, 0.09, 0.14), neb(h11(seed + 14.0)) * 0.8, smoothstep(0.3, 0.75, f));
  surf += atmo * pow(1.0 - z, 3.0) * 0.6;
  vec3 col = mix(surf * (0.06 + lit * 1.8), vec3(0.004, 0.003, 0.009), night);
  float ds = length(p - c) - R;
  rim = atmo * exp(-max(ds, 0.0) / (0.006 + 0.02 * min(R, 1.0))) * step(0.0, ds) * mix(0.5, 0.32, night);
  return vec4(col, cover);
}

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  g_seed = u_seed;
  g_gal = u_gal;
  g_gal2 = u_gal2;
  if (u_view.x > 0.5) {
    // standing on the planet, or just above it: the night sky's picture, tipped down by the pitch
    vec2 q = p - vec2(0.0, u_view.y);
    gl_FragColor = vec4(finish(planetGround(sky(q, u_time, u_seed), q, u_seed, u_view.z), p), 1.0);
    return;
  }
  // from above: premultiplied over the universe behind
  vec3 glow = vec3(0.0);
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  if (u_sun.w > 0.0) glow = sunGlow(p - u_sun.xy, u_sun.z) * u_sun.w;
  if (u_globe.z > 0.0) {
    vec3 rim;
    vec4 disk = planetDisk(p, u_globe.xy, u_globe.z, u_light, u_seed, u_view.w, rim);
    col = disk.rgb;
    alpha = disk.a;
    glow = glow * (1.0 - alpha) + rim;
  }
  gl_FragColor = vec4(finish(col, p) * alpha + finish(glow, p), alpha);
}`

// ---- lens passes ---------------------------------------------------------------------------------
const LENS_HEAD = `
precision highp float;
uniform vec2 u_res;
uniform vec3 u_right;
uniform vec3 u_up;
uniform vec3 u_forward;
uniform vec2 u_tan;
uniform sampler2D u_scene;
uniform samplerCube u_near;
uniform float u_hasNear;
vec3 rayDir(){
  vec2 ndc = gl_FragCoord.xy / u_res * 2.0 - 1.0;
  return normalize(u_forward + ndc.x * u_tan.x * u_right + ndc.y * u_tan.y * u_up);
}
// what the universe looks like in direction d: the sharp frame where it covers d, else the cube map
vec3 sceneAt(vec3 d){
  float z = dot(d, u_forward);
  vec2 uv = 0.5 + 0.5 * vec2(dot(d, u_right) / (max(z, 1e-4) * u_tan.x), dot(d, u_up) / (max(z, 1e-4) * u_tan.y));
  vec3 framed = texture2D(u_scene, clamp(uv, 0.0, 1.0)).rgb;
  if (u_hasNear < 0.5) return framed;
  vec3 cube = textureCube(u_near, d).rgb;
  if (z <= 1e-4) return cube;
  float inside = smoothstep(0.0, 0.025, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
  return mix(cube, framed, inside);
}
float lh(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float lnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(lh(i), lh(i + vec2(1.0, 0.0)), f.x), mix(lh(i + vec2(0.0, 1.0)), lh(i + vec2(1.0, 1.0)), f.x), f.y);
}
float lfbm(vec2 p){ float v = 0.0; float a = 0.5; for (int i = 0; i < 4; i++) { v += a * lnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; } return v; }
mat2 lrot(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
`

const COPY_FRAG = `${LENS_HEAD}
void main(){ gl_FragColor = vec4(texture2D(u_scene, gl_FragCoord.xy / u_res).rgb, 1.0); }`

/*
 * A wormhole mouth as seen from outside. Rays that pass closer to its centre than the throat
 * radius go through: inside the sphere the whole sky of the other side is squeezed in (straight
 * through in the middle, looking back at the rim). Rays passing outside are bent around it, more
 * the closer they pass, so our own side shows up again as rings around the sphere.
 */
const WORMHOLE_FRAG = `${LENS_HEAD}
uniform vec3 u_mouth;     // centre relative to the camera
uniform float u_rho;
uniform mat3 u_turn;      // our side -> other side
uniform samplerCube u_other;
void main(){
  vec3 d = rayDir();
  float r = length(u_mouth);
  vec3 toW = u_mouth / r;
  float cs = dot(d, toW);
  float sn = sqrt(max(0.0, 1.0 - cs * cs));
  float b = r * sn;
  vec3 col;
  if (cs > 0.0 && b < u_rho) {
    vec3 side = sn > 1e-5 ? (d - cs * toW) / sn : u_right;
    float beta = b / u_rho;
    float psi = 3.14159265 * pow(beta, 1.15);
    vec3 through = cos(psi) * toW + sin(psi) * side;
    col = textureCube(u_other, u_turn * through).rgb * (1.0 - 0.45 * smoothstep(0.75, 1.0, beta));
  } else {
    // deflection: grows like (rho / b)^2.3, and only the part of the path still ahead of the camera counts
    float f = 0.5 * (1.0 + cs);
    float alpha = min(3.1, 3.14159265 * pow(u_rho / max(b, 1e-5), 2.3) * f * f);
    vec3 toward = toW - cs * d;
    float tl = length(toward);
    toward = tl > 1e-6 ? toward / tl : u_up;
    vec3 bent = cos(alpha) * d + sin(alpha) * toward;
    col = sceneAt(bent) * mix(0.55, 1.0, smoothstep(0.0, 0.25, (b - u_rho) / u_rho));
  }
  // a thin bright rim where both pictures are squeezed together
  float edge = (b - u_rho) / u_rho;
  col += vec3(0.7, 0.82, 1.0) * exp(-pow(edge / 0.012, 2.0)) * step(0.0, cs) * 0.3;
  // a faint glow around the sphere, so it reads even against empty space
  col += vec3(0.55, 0.65, 1.0) * exp(-max(edge, 0.0) / 0.12) * step(0.0, edge) * step(0.0, cs) * 0.07;
  gl_FragColor = vec4(col, 1.0);
}`

/*
 * Through the throat. Going in, the whole sky of the far side is squeezed into the sphere ahead:
 * what lies straight ahead over there is small in the middle, everything else crowds towards the
 * rim. On the way through that picture opens up, evenly and in one direction only, until it is
 * simply the view out of the far mouth. What streams outwards past us meanwhile is smeared into
 * streaks, with a few bands of stray light swirling in between. For the last stretch the far side
 * is the live picture (u_scene, drawn with the camera we come out with) instead of the cube map,
 * so the first frame outside is the very same picture.
 */
const TRANSIT_FRAG = `${LENS_HEAD}
uniform float u_tau;      // 0 going in, 1 coming out
uniform float u_time;
uniform float u_live;     // 0 to 1: how much of the far side is the live picture already
uniform mat3 u_turn;
uniform samplerCube u_other;
void main(){
  vec3 d = rayDir();
  float cs = clamp(dot(d, u_forward), -1.0, 1.0);
  float th = acos(cs);
  float ph = atan(dot(d, u_up), dot(d, u_right));
  vec3 across = cos(ph) * u_right + sin(ph) * u_up;
  // how the sphere looked from just outside (as in WORMHOLE_FRAG), and how far it has opened up
  float beta = min(1.0, 1.15 * sqrt(1.0 - cs * cs));
  float psiIn = cs > 0.0 ? 3.14159265 * pow(beta, 1.15) : 3.14159265;
  float e = smoothstep(0.0, 0.86, u_tau);
  e = e * e * (3.0 - 2.0 * e) * 0.5 + e * 0.5;
  float psi = mix(psiIn, th, e);
  // streaks: the far side sampled along the way it streams outwards
  float rush = sin(3.14159265 * e);
  float smear = 0.3 * (psiIn - th) * rush;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float a = psi + (float(i) / 8.0 - 0.5) * smear;
    col += textureCube(u_other, u_turn * (cos(a) * u_forward + sin(a) * across)).rgb;
  }
  col /= 9.0;
  col *= 1.0 - 0.45 * smoothstep(0.75, 1.0, beta) * (1.0 - e);          // the sphere's dark rim, as outside
  col = mix(col, texture2D(u_scene, gl_FragCoord.xy / u_res).rgb, u_live);
  // bands of stray light, swirling outwards
  float flow = u_tau * 7.0;
  float swirl = ph * 3.0 - th * 4.0 + flow * 1.5;
  float band = pow(0.5 + 0.5 * sin(swirl + 1.7 * sin(th * 3.0 - flow + ph * 2.0)), 6.0) * (0.35 + 0.65 * lfbm(vec2(ph * 2.0, th * 3.0 - flow)));
  vec3 tint = mix(vec3(0.55, 0.7, 1.0), vec3(1.0, 0.8, 0.62), 0.5 + 0.5 * sin(th * 2.0 + flow * 0.3));
  col += tint * band * 0.22 * rush * smoothstep(0.15, 0.9, th);
  gl_FragColor = vec4(col, 1.0);
}`

/*
 * The black hole. Within 45 Schwarzschild radii every ray is traced along its real photon path
 * (x'' = -1.5 h^2 x / r^5 in units of rs), crossing the thin accretion disk where it may. Rays that
 * fall below the horizon are black, the others pick up the universe behind in the direction they
 * leave in. Further out the weak bending is added in one go, so the edge of the traced sphere
 * doesn't show. The disk turns faster inside, is brighter and bluer on the side coming at us
 * (Doppler) and dimmer close to the horizon (gravitational redshift).
 */
const BLACKHOLE_FRAG = `${LENS_HEAD}
uniform vec3 u_hole;
uniform float u_rs;
uniform vec3 u_bx;
uniform vec3 u_by;
uniform vec3 u_bz;
uniform float u_time;
uniform float u_rIn;
uniform float u_rOut;
vec3 toWorld(vec3 v){ return v.x * u_bx + v.y * u_by + v.z * u_bz; }
vec4 disk(vec3 hit, float r, vec3 dir){
  vec2 p = lrot(u_time * 1.4 * pow(3.0 / r, 1.5)) * hit.xz;       // inner parts turn faster
  float n = lfbm(p * 0.9);
  float n2 = lfbm(p * 2.6 + 3.0) * 0.6 + lfbm(vec2(r * 4.0, 0.0) + p * 0.35) * 0.4;
  float lanes = 0.78 + 0.22 * sin(r * 3.1 + n * 6.0);
  float heat = pow(u_rIn / r, 2.2) * (1.0 - sqrt(u_rIn / r)) * 20.0;
  vec3 col = mix(vec3(1.0, 0.5, 0.18), vec3(1.0, 0.93, 0.8), smoothstep(10.0, 3.5, r));
  vec3 orbit = normalize(vec3(-hit.z, 0.0, hit.x));
  float beta = sqrt(0.5 / r);
  float dop = sqrt(1.0 - beta * beta) / (1.0 - beta * dot(orbit, -normalize(dir)));
  col *= mix(vec3(1.0, 0.85, 0.7), vec3(0.85, 0.95, 1.15), smoothstep(0.9, 1.4, dop));
  float light = heat * (0.45 + 0.75 * n2) * lanes * mix(1.0, pow(dop, 3.0), 0.65) * sqrt(max(0.0, 1.0 - 1.0 / r));
  float a = 0.92 * smoothstep(u_rIn, u_rIn + 0.6, r) * smoothstep(u_rOut, u_rOut - 5.0, r) * (0.55 + 0.45 * n);
  return vec4(col * light * 2.2, a);
}
// one disk crossing, composited front to back
void addDisk(vec4 hit, vec3 dir, inout vec3 col, inout float trans){
  vec4 e = disk(hit.xyz, hit.w, dir);
  col += trans * e.rgb * e.a;
  trans *= 1.0 - e.a;
}
void main(){
  vec3 dw = rayDir();
  vec3 c = -u_hole / u_rs;
  vec3 x = vec3(dot(c, u_bx), dot(c, u_by), dot(c, u_bz));
  vec3 v = vec3(dot(dw, u_bx), dot(dw, u_by), dot(dw, u_bz));
  const float R = 45.0;
  float camR = length(x);
  float toward = -dot(x, v) / camR;
  float b = length(cross(x, v));
  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool captured = false;
  float bq = dot(x, v);
  float cq = dot(x, x) - R * R;
  float disc = bq * bq - cq;
  float outside;
  if (cq > 0.0 && (disc <= 0.0 || bq >= 0.0)) {
    outside = (1.0 + toward) / max(b, 1.0);
  } else {
    float s = sqrt(max(0.0, 1.0 - b * b / (R * R)));
    if (cq > 0.0) {
      x += v * (-bq - sqrt(max(disc, 0.0)));
      outside = (1.0 + toward - 2.0 * s) / max(b, 1.0);
    } else {
      outside = (1.0 - s) / max(b, 1.0);
    }
    vec3 hv = cross(x, v);
    float h2 = dot(hv, hv);
    // The loop only follows the ray and notes where it crosses the disk; the disk itself (the
    // expensive noise) is drawn afterwards. With disk() inside, Direct3D's shader compiler on Windows
    // inlined it into every one of the 180 unrolled steps and took so long that the GPU was reset.
    vec4 hit0 = vec4(0.0); vec4 hit1 = vec4(0.0); vec4 hit2 = vec4(0.0); vec4 hit3 = vec4(0.0);
    vec3 dir0 = vec3(0.0); vec3 dir1 = vec3(0.0); vec3 dir2 = vec3(0.0); vec3 dir3 = vec3(0.0);
    int hits = 0;
    for (int i = 0; i < 180; i++) {
      float r2 = dot(x, x);
      float r = sqrt(r2);
      float dt = clamp(0.08 * r, 0.02, 3.0);
      vec3 vn = v - 1.5 * h2 * x / (r2 * r2 * r) * dt;
      vec3 xn = x + vn * dt;
      if (x.y * xn.y <= 0.0) {
        float f = x.y / (x.y - xn.y + 1e-9);
        vec3 hit = mix(x, xn, f);
        float rh = length(hit.xz);
        if (rh > u_rIn && rh < u_rOut) {
          if (hits == 0) { hit0 = vec4(hit, rh); dir0 = vn; }
          else if (hits == 1) { hit1 = vec4(hit, rh); dir1 = vn; }
          else if (hits == 2) { hit2 = vec4(hit, rh); dir2 = vn; }
          else if (hits == 3) { hit3 = vec4(hit, rh); dir3 = vn; }
          hits++;
        }
      }
      x = xn;
      v = vn;
      if (dot(x, x) < 1.0) { captured = true; break; }
      if (dot(x, x) > R * R && dot(x, v) > 0.0) break;
      if (i == 179) captured = true;                               // still circling the photon sphere
    }
    if (hits > 0) addDisk(hit0, dir0, col, trans);
    if (hits > 1) addDisk(hit1, dir1, col, trans);
    if (hits > 2) addDisk(hit2, dir2, col, trans);
    if (hits > 3) addDisk(hit3, dir3, col, trans);
  }
  vec3 bg = vec3(0.0);
  if (!captured) {
    vec3 leave = normalize(v);
    vec3 tw = -x - dot(-x, leave) * leave;
    float tl = length(tw);
    if (tl > 1e-6 && outside > 0.0) leave = normalize(leave + tw / tl * outside);
    bg = sceneAt(toWorld(leave));
  }
  col = 1.0 - exp(-col * 1.1);
  gl_FragColor = vec4(col + trans * bg, 1.0);
}`

// ---- bloom and the final picture -----------------------------------------------------------------
const BRIGHT_FRAG = `
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_res;
uniform vec2 u_texel;
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 c = texture2D(u_src, uv + u_texel * vec2(-1.0, -1.0)).rgb + texture2D(u_src, uv + u_texel * vec2(1.0, -1.0)).rgb
         + texture2D(u_src, uv + u_texel * vec2(-1.0, 1.0)).rgb + texture2D(u_src, uv + u_texel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  gl_FragColor = vec4(max(c - 0.45, 0.0) * 1.6, 1.0);
}`
const BLUR_FRAG = `
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_res;
uniform vec2 u_dir;
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 c = texture2D(u_src, uv).rgb * 0.227;
  c += (texture2D(u_src, uv + u_dir * 1.385).rgb + texture2D(u_src, uv - u_dir * 1.385).rgb) * 0.316;
  c += (texture2D(u_src, uv + u_dir * 3.231).rgb + texture2D(u_src, uv - u_dir * 3.231).rgb) * 0.070;
  gl_FragColor = vec4(c, 1.0);
}`
const FINAL_FRAG = `
precision highp float;
uniform sampler2D u_color;
uniform sampler2D u_bloom1;
uniform sampler2D u_bloom2;
uniform vec2 u_res;
uniform float u_cinema;    // 0 at the very start and end, 1 in between
uniform float u_bar;       // letterbox bar height, as a fraction of the screen height
uniform float u_time;
void main(){
  vec2 uv = gl_FragCoord.xy / u_res;
  vec3 col = texture2D(u_color, uv).rgb;
  col += (texture2D(u_bloom1, uv).rgb * 0.6 + texture2D(u_bloom2, uv).rgb * 0.5) * u_cinema;
  vec2 p = uv - 0.5;
  p.x *= u_res.x / u_res.y;
  col *= mix(1.0, 0.8 + 0.2 * smoothstep(0.95, 0.25, length(p)), u_cinema);
  float grain = fract(sin(dot(gl_FragCoord.xy + fract(u_time * 7.13) * 400.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  col += grain * 0.03 * u_cinema;
  float bar = u_bar * u_cinema;
  col *= smoothstep(bar - 0.0015, bar + 0.0015, min(uv.y, 1.0 - uv.y));
  gl_FragColor = vec4(col, 1.0);
}`

// ---- helpers --------------------------------------------------------------------------------------
interface Target2D extends RenderTarget {
  texture: WebGLTexture
}
interface TargetCube {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  size: number
}

function makeTexture(gl: WebGLRenderingContext, kind: number): WebGLTexture {
  const texture = gl.createTexture()!
  gl.bindTexture(kind, texture)
  gl.texParameteri(kind, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(kind, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(kind, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(kind, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return texture
}

function target2D(gl: WebGLRenderingContext, width: number, height: number): Target2D {
  const texture = makeTexture(gl, gl.TEXTURE_2D)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  const framebuffer = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
  return { texture, framebuffer, width, height }
}

function targetCube(gl: WebGLRenderingContext, size: number): TargetCube {
  const texture = makeTexture(gl, gl.TEXTURE_CUBE_MAP)
  for (let face = 0; face < 6; face++)
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
  return { texture, framebuffer: gl.createFramebuffer()!, size }
}

function freeTarget(gl: WebGLRenderingContext, target: Target2D | TargetCube): void {
  gl.deleteTexture(target.texture)
  gl.deleteFramebuffer(target.framebuffer)
}

// camera orientation for each cube face, in the order of TEXTURE_CUBE_MAP_POSITIVE_X + i
const CUBE_FACES: { forward: Vec3; up: Vec3 }[] = [
  { forward: [1, 0, 0], up: [0, -1, 0] },
  { forward: [-1, 0, 0], up: [0, -1, 0] },
  { forward: [0, 1, 0], up: [0, 0, 1] },
  { forward: [0, -1, 0], up: [0, 0, -1] },
  { forward: [0, 0, 1], up: [0, -1, 0] },
  { forward: [0, 0, -1], up: [0, -1, 0] }
]

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

const STARS_PER_GALAXY = 36_000
const STARS_NEARBY = 4500
const CUBE_SIZE = 512
/** The far side of the wormhole fills the whole screen on the way through, so it gets more pixels. */
const FAR_CUBE_SIZE = 1024

// ---- the programs ---------------------------------------------------------------------------------
const FLIGHT_FRAGS = {
  planet: PLANET_FRAG,
  copy: COPY_FRAG,
  wormhole: WORMHOLE_FRAG,
  transit: TRANSIT_FRAG,
  blackhole: BLACKHOLE_FRAG,
  bright: BRIGHT_FRAG,
  blur: BLUR_FRAG,
  final: FINAL_FRAG
} as const
type FlightProgram = keyof typeof FLIGHT_FRAGS

/** The lens shaders of each kind of flight; every flight also needs the universe's shaders and SHARED_PROGRAMS. */
const VARIANT_PROGRAMS: Record<FlightVariant, FlightProgram[]> = {
  wormhole: ['wormhole', 'transit'],
  slingshot: ['blackhole']
}
const SHARED_PROGRAMS: FlightProgram[] = ['planet', 'copy', 'bright', 'blur', 'final']

/** A fragment shader of ours as GLSL ES 3.00 (WebGL2), plus the vertex shader to go with it. */
function es300(frag: string): string {
  return `#version 300 es\n${frag}`
    .replace('precision highp float;', 'precision highp float;\nout vec4 fragColor;')
    .replace(/\bgl_FragColor\b/g, 'fragColor')
    .replace(/\btexture2D\(/g, 'texture(')
    .replace(/\btextureCube\(/g, 'texture(')
}
const VERT_300 = `#version 300 es
in vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

/**
 * The black hole for WebGL2. Its ray loop starts at a uniform (always 0) instead of a constant, so
 * Direct3D's shader compiler on Windows can't unroll the 180 steps. Unrolled, they took it minutes,
 * until Chromium killed the hung GPU process (seen on an RTX 4070 SUPER). GLSL ES 1.00 (WebGL1)
 * only allows constant loop starts, so that version stays as it is.
 */
const BLACKHOLE_LOOP = 'for (int i = 0; i < 180; i++) {'
const BLACKHOLE_FRAG_300 = es300(
  BLACKHOLE_FRAG.replace(BLACKHOLE_LOOP, 'for (int i = u_zero; i < 180; i++) {').replace(
    'uniform float u_rOut;',
    'uniform float u_rOut;\nuniform int u_zero;'
  )
)
if (!BLACKHOLE_FRAG.includes(BLACKHOLE_LOOP)) throw new Error('flightGl: the black hole loop changed, update BLACKHOLE_LOOP')

export const isWebGL2 = (gl: WebGLRenderingContext): boolean =>
  typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext

/**
 * Context for the flight: WebGL2 where there is one (for the black hole above), else WebGL1. All
 * the other shaders are GLSL ES 1.00, which WebGL2 runs as well.
 */
export function flightContext(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  const attributes: WebGLContextAttributes = { antialias: false, alpha: false, powerPreference: 'high-performance' }
  // dev helper: window.__flightWebGL1 = true compares against the WebGL1 path
  const webgl2 = (window as { __flightWebGL1?: boolean }).__flightWebGL1 ? null : canvas.getContext('webgl2', attributes)
  return (webgl2 as unknown as WebGLRenderingContext | null) ?? canvas.getContext('webgl', attributes)
}

interface FlightShader {
  name: string
  vert: string
  frag: string
}

/**
 * The programs of the flights, by name: all of them, or just those one kind of flight needs (in
 * the order FlightRenderer.prepare builds them: the universe's first). Every new or changed shader
 * has to be in here, so that prewarming, the guard against hanging shaders and the admin tool's
 * shader test know it.
 */
export function flightShaders(gl: WebGLRenderingContext, variant?: FlightVariant): FlightShader[] {
  return shaderList(isWebGL2(gl), variant)
}

function ownPrograms(variant?: FlightVariant): FlightProgram[] {
  return variant ? [...SHARED_PROGRAMS, ...VARIANT_PROGRAMS[variant]] : (Object.keys(FLIGHT_FRAGS) as FlightProgram[])
}

function shaderList(webgl2: boolean, variant?: FlightVariant): FlightShader[] {
  return [
    ...UNIVERSE_SHADERS.map(([vert, frag], i) => ({ name: `universe-${i}`, vert, frag })),
    ...ownPrograms(variant).map((name) =>
      name === 'blackhole' && webgl2 ? { name, vert: VERT_300, frag: BLACKHOLE_FRAG_300 } : { name, vert: VERT, frag: FLIGHT_FRAGS[name] }
    )
  ]
}

// ---- shaders that hung or crashed this machine's GPU --------------------------------------------
//
// On Windows a shader that Direct3D's compiler can't cope with hangs the whole GPU process until
// Chromium kills it, after which everything is drawn in software and the app gets slow. Such a shader
// is remembered (by name and a hash of its source, so a changed shader gets another chance) and the
// flights that need it are skipped from then on, so it can't happen again on every start.

const BAD_KEY = 'rc.badShaders'

/** Name plus FNV-1a hash of the sources. */
export function shaderKey(shader: { name: string; vert: string; frag: string }): string {
  let hash = 2166136261
  for (const char of shader.vert + shader.frag) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `${shader.name}:${(hash >>> 0).toString(36)}`
}

/** Keys of the shaders that hung or crashed the GPU here. */
export function badShaders(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(BAD_KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

function markBad(shader: { name: string; vert: string; frag: string }): void {
  try {
    localStorage.setItem(BAD_KEY, JSON.stringify([...new Set([...badShaders(), shaderKey(shader)])]))
  } catch {
    /* private mode */
  }
}

/** Admin tool: forget them, so the flight is tried again. */
export function clearBadShaders(): void {
  try {
    localStorage.removeItem(BAD_KEY)
  } catch {
    /* private mode */
  }
}

/** Names of today's shaders that hung the GPU here (entries for shaders since changed don't count). */
export function currentBadShaders(): string[] {
  const bad = new Set(badShaders())
  const names = [...shaderList(false), ...shaderList(true)].filter((shader) => bad.has(shaderKey(shader))).map(({ name }) => name)
  return [...new Set(names)]
}

/** Name of a shader of this kind of flight that hung the GPU on this machine before, or null. */
export function knownBadShader(gl: WebGLRenderingContext, variant: FlightVariant): string | null {
  const bad = new Set(badShaders())
  return flightShaders(gl, variant).find((shader) => bad.has(shaderKey(shader)))?.name ?? null
}

/**
 * The kind of flight to play: the wanted one, or another one if a shader of the wanted one hung
 * the GPU here before. Null if none is left (then there is no flight on this machine).
 */
export function playableVariant(gl: WebGLRenderingContext, wanted: FlightVariant): FlightVariant | null {
  return [wanted, ...FLIGHT_VARIANTS.filter((variant) => variant !== wanted)].find((variant) => !knownBadShader(gl, variant)) ?? null
}

/**
 * Compiles every shader of the flight once, in a throwaway context. The browser keeps compiled
 * programs in its cache, so the real flight later starts without a pause (on Windows a large shader
 * can take a second or more to compile the first time). Meant for an idle moment after start-up.
 *
 * One shader at a time, so a shader that hangs or crashes the GPU is known by name (see markBad),
 * and without waiting on the GPU where KHR_parallel_shader_compile allows it (Chromium has it).
 * `log` gets a line when it's done, for each shader that took long, and for one that failed.
 */
export function prewarmFlightShaders(log: (message: string) => void = () => undefined): void {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  // the same kind of context as JourneyCanvas, so it is the same GPU and the same cache entries
  const gl = flightContext(canvas)
  if (!gl) return
  const bad = new Set(badShaders())
  const shaders = flightShaders(gl).filter((shader) => !bad.has(shaderKey(shader)))
  let current: (typeof shaders)[number] | null = null
  canvas.addEventListener('webglcontextlost', () => {
    if (!current) return
    markBad(current)
    log(
      `flight shaders: the GPU crashed while compiling "${current.name}" – flights that need it are off on this PC until that shader changes`
    )
    current = null
  })
  const parallel = gl.getExtension('KHR_parallel_shader_compile')
  const begun = performance.now()
  void (async () => {
    for (const shader of shaders) {
      current = shader
      const started = performance.now()
      const program = startProgram(gl, shader.vert, shader.frag)
      if (!(await whenLinked(gl, [program], 60_000))) {
        if (!gl.isContextLost() && current) {
          markBad(shader)
          log(
            `flight shaders: "${shader.name}" still not compiled after 60 s – flights that need it are off on this PC until that shader changes`
          )
        }
        current = null
        return
      }
      if (!parallel) gl.getProgramParameter(program, gl.LINK_STATUS) // waits for this one only
      if (gl.isContextLost()) return
      current = null
      const seconds = (performance.now() - started) / 1000
      if (seconds > 2) log(`flight shaders: "${shader.name}" took ${seconds.toFixed(1)} s`)
      // without the extension each compile blocks the page, so leave it some room in between
      if (!parallel) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    current = null
    log(`flight shaders ready after ${((performance.now() - begun) / 1000).toFixed(1)} s (${isWebGL2(gl) ? 'WebGL2' : 'WebGL1'})`)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  })()
}

/**
 * Admin tool: compiles the flight's shaders one by one in a fresh context and reports how long each
 * took (a comment with a random number makes sure none comes from the cache). `null` = not done
 * within `timeoutMs`, after which the rest is skipped.
 */
export async function testFlightShaders(
  onResult: (name: string, ms: number | null, linked: boolean) => void,
  extra: { name: string; vert: string; frag: string }[] = [],
  timeoutMs = 60_000
): Promise<string> {
  const canvas = document.createElement('canvas')
  const gl = flightContext(canvas)
  if (!gl) return 'no WebGL'
  const gpu = String(gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER))
  const salt = `\n// shader test ${Date.now()}\n`
  const own = flightShaders(gl)
  for (const shader of [...extra, ...own]) {
    const started = performance.now()
    const program = startProgram(gl, shader.vert, shader.frag + salt)
    const done = await whenLinked(gl, [program], timeoutMs)
    if (!done || gl.isContextLost()) {
      if (own.includes(shader)) markBad(shader)
      onResult(shader.name, null, false)
      break
    }
    // without KHR_parallel_shader_compile this is where the waiting happens
    const linked = gl.getProgramParameter(program, gl.LINK_STATUS) === true
    onResult(shader.name, Math.round(performance.now() - started), linked)
  }
  gl.getExtension('WEBGL_lose_context')?.loseContext()
  return `${isWebGL2(gl) ? 'WebGL2' : 'WebGL1'} on ${gpu}`
}

/** The pictures of one frame, at one resolution. */
interface FrameTargets {
  quality: number
  /** the universe as the camera sees it, before the lens */
  scene: Target2D
  /** the frame: lens, planets */
  color: Target2D
  /** bloom: quarter size twice, eighth size twice */
  bloom: Target2D[]
}

/** The resolutions a flight can play at, as a fraction of the canvas. All are set up before the first frame. */
export const FLIGHT_QUALITIES = [1, 0.8, 0.64] as const

type Lens = 'none' | 'wormhole' | 'transit' | 'blackhole'

/** Where a point in space is on screen, in the shaders' p (centred, y from -0.5 to 0.5); null if it is behind the camera. */
function onScreen(camera: Camera, point: Vec3): [number, number] | null {
  const basis = basisOf(camera)
  const rel = sub(point, basis.eye)
  const depth = dot(rel, basis.forward)
  if (depth <= 1e-12) return null
  const k = 0.5 / (depth * Math.tan(camera.fovY / 2))
  return [dot(rel, basis.right) * k, dot(rel, basis.up) * k]
}

/** Renders one flight. Create it once per flight with prepare(); call render() every frame. */
export class FlightRenderer {
  private readonly starsFrom: StarCloud
  private readonly starsTo: StarCloud
  private readonly nearFrom: StarCloud
  private readonly nearTo: StarCloud
  private readonly galFrom: [Float32Array, Float32Array]
  private readonly galTo: [Float32Array, Float32Array]
  private frames: FrameTargets[] = []
  private current = 0
  private canvasSize: [number, number] = [0, 0]
  /**
   * The surroundings of the lens, for light bent in from outside the screen. They don't change
   * while the lens is in the picture, so they are painted once: around the wormhole's near mouth,
   * or around the black hole.
   */
  private readonly near: TargetCube
  /** wormhole only: the far side, seen from where we come out */
  private readonly other: TargetCube | null

  private constructor(
    private readonly gl: WebGLRenderingContext,
    private readonly universe: UniverseGl,
    private readonly programs: Partial<Record<FlightProgram, Program>>,
    private readonly plan: FlightPlan,
    private readonly fromSeed: number,
    private readonly toSeed: number,
    time: number
  ) {
    this.starsFrom = universe.createStars(plan.from, STARS_PER_GALAXY)
    this.starsTo = plan.to.id === plan.from.id ? this.starsFrom : universe.createStars(plan.to, STARS_PER_GALAXY)
    this.nearFrom = universe.createStars(plan.from, neighbourhoodStars(fromSeed, STARS_NEARBY))
    this.nearTo = universe.createStars(plan.to, neighbourhoodStars(toSeed, STARS_NEARBY))
    this.galFrom = galaxyUniforms(fromSeed)
    this.galTo = galaxyUniforms(toSeed)
    this.near = targetCube(gl, CUBE_SIZE)
    this.other = plan.wormhole ? targetCube(gl, FAR_CUBE_SIZE) : null
    const { wormhole, blackHole } = plan
    if (wormhole && this.other) {
      const [enter, exit] = wormhole.transit
      this.drawCube(this.near, plan.cameraAt(enter).eye, enter, time)
      this.drawCube(this.other, wormhole.exitEye, exit, time)
    } else if (blackHole) {
      this.drawCube(this.near, blackHole.pos, (blackHole.flyby[0] + blackHole.flyby[1]) / 2, time)
    }
  }

  /**
   * Builds the renderer once its shaders are compiled, without blocking the page while the GPU
   * works on them, then makes everything the film needs and draws once with every program, so
   * that nothing is left to set up while it plays. Null when the shaders can't be built on this
   * machine or aren't done after `timeoutMs` (`onStuck` then gets the names of the programs that
   * weren't). `onCompile` is told about the compile, so whoever releases the context can wait for
   * it first (an aborted compile would never reach the browser's shader cache).
   */
  static async prepare(
    gl: WebGLRenderingContext,
    plan: FlightPlan,
    fromSeed: number,
    toSeed: number,
    options: {
      timeoutMs: number
      /** size of the canvas in pixels */
      width: number
      height: number
      /** the animation clock right now, in seconds */
      time: number
      onCompile?: (compiled: Promise<boolean>) => void
      onStuck?: (names: string[]) => void
    }
  ): Promise<FlightRenderer | null> {
    const shaders = flightShaders(gl, plan.variant)
    const started = shaders.map(({ vert, frag }) => startProgram(gl, vert, frag))
    const compiled = whenLinked(gl, started, options.timeoutMs)
    options.onCompile?.(compiled)
    if (!(await compiled) || gl.isContextLost()) {
      const parallel = gl.getExtension('KHR_parallel_shader_compile')
      if (parallel && !gl.isContextLost())
        options.onStuck?.(
          shaders.filter((_, i) => gl.getProgramParameter(started[i], parallel.COMPLETION_STATUS_KHR) !== true).map(({ name }) => name)
        )
      return null
    }
    const programs = started.map((program) => finishProgram(gl, program))
    const universe = UniverseGl.fromPrograms(gl, programs.slice(0, UNIVERSE_SHADERS.length))
    const own = programs.slice(UNIVERSE_SHADERS.length)
    if (!universe || own.some((program) => !program)) return null
    const byName = Object.fromEntries(ownPrograms(plan.variant).map((name, i) => [name, own[i]])) as Partial<Record<FlightProgram, Program>>
    const renderer = new FlightRenderer(gl, universe, byName, plan, fromSeed, toSeed, options.time)
    renderer.resize(options.width, options.height, 1)
    renderer.warmUp(options.time)
    return gl.isContextLost() ? null : renderer
  }

  private program(name: FlightProgram): Program {
    return this.programs[name]!
  }

  /**
   * Size of the canvas, and which of the prepared resolutions to draw at (the nearest to `quality`).
   * The pictures for every resolution are made when the canvas size changes, so a new quality alone
   * costs nothing.
   */
  resize(canvasWidth: number, canvasHeight: number, quality: number): void {
    const gl = this.gl
    this.current = FLIGHT_QUALITIES.reduce(
      (best, q, i) => (Math.abs(q - quality) < Math.abs(FLIGHT_QUALITIES[best] - quality) ? i : best),
      0
    )
    if (canvasWidth === this.canvasSize[0] && canvasHeight === this.canvasSize[1]) return
    this.canvasSize = [canvasWidth, canvasHeight]
    for (const { scene, color, bloom } of this.frames) [scene, color, ...bloom].forEach((target) => freeTarget(gl, target))
    this.frames = FLIGHT_QUALITIES.map((q) => {
      const width = Math.max(64, Math.round(canvasWidth * q))
      const height = Math.max(64, Math.round(canvasHeight * q))
      const quarter: [number, number] = [Math.max(16, width >> 2), Math.max(16, height >> 2)]
      const eighth: [number, number] = [Math.max(8, width >> 3), Math.max(8, height >> 3)]
      return {
        quality: q,
        scene: target2D(gl, width, height),
        color: target2D(gl, width, height),
        bloom: [target2D(gl, ...quarter), target2D(gl, ...quarter), target2D(gl, ...eighth), target2D(gl, ...eighth)]
      }
    })
  }

  /**
   * Draws a frame of every part of the film into the smallest picture. The first draw with a
   * program is when the driver finishes its work on it, which would otherwise show as a hitch in
   * the middle of the film.
   */
  private warmUp(time: number): void {
    const before = this.current
    this.current = this.frames.length - 1
    const { wormhole, blackHole } = this.plan
    const moments = [0, 2.5, 6, wormhole ? (wormhole.transit[0] + wormhole.transit[1]) / 2 : 0, wormhole ? wormhole.transit[1] - 0.05 : 0]
    if (blackHole) moments.push((blackHole.flyby[0] + blackHole.flyby[1]) / 2)
    for (const seconds of [...moments, 17, 20, FLIGHT_S + 1, FLIGHT_S + 2.7]) this.render(seconds, time, this.plan.cameraAt(seconds), true)
    this.current = before
  }

  /** Which lens the frame at flight time T needs. */
  private lensAt(T: number): Lens {
    const { wormhole, blackHole } = this.plan
    if (wormhole) {
      const [enter, exit] = wormhole.transit
      if (T >= enter && T < exit) return 'transit'
      if (T < enter) return 'wormhole'
    }
    if (blackHole && T < blackHole.flyby[1] + 3) return 'blackhole'
    return 'none'
  }

  /** How visible a galaxy's single stars are: only from close up, from afar the disk does the job. */
  private starAlpha(galaxy: Galaxy, eye: Vec3): number {
    const radius = galaxy.radius
    return smooth(7 * radius, 2.5 * radius, length(sub(eye, galaxy.pos)))
  }

  private drawScene(camera: Camera, target: RenderTarget, T: number, time: number): void {
    const universe = this.universe
    universe.begin(camera, target)
    universe.drawBackdrop(time, 0.75)
    const pointScale = Math.max(1, target.height / 720)
    universe.drawGalaxies(time)
    universe.drawStars(this.starsFrom, this.starAlpha(this.plan.from, camera.eye), pointScale)
    if (this.starsTo !== this.starsFrom) universe.drawStars(this.starsTo, this.starAlpha(this.plan.to, camera.eye), pointScale)
    // the dense neighbourhood of a planet only around that planet, so a hop within one galaxy doesn't draw both at once
    const nearFrom = length(sub(camera.eye, this.nearFrom.galaxy.pos)) < length(sub(camera.eye, this.nearTo.galaxy.pos)) || T < 6
    universe.drawStars(
      nearFrom ? this.nearFrom : this.nearTo,
      this.starAlpha(nearFrom ? this.plan.from : this.plan.to, camera.eye),
      pointScale
    )
  }

  private drawCube(cube: TargetCube, eye: Vec3, T: number, time: number): void {
    const gl = this.gl
    for (let face = 0; face < 6; face++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, cube.framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, cube.texture, 0)
      const { forward, up } = CUBE_FACES[face]
      this.drawScene(
        { eye, forward, up, fovY: Math.PI / 2 },
        { framebuffer: cube.framebuffer, width: cube.size, height: cube.size },
        T,
        time
      )
    }
  }

  /** Binds a lens program with the camera, the frame and (optionally) the cube map of the surroundings. */
  private useLens(program: Program, camera: Camera, withNear: boolean): void {
    const gl = this.gl
    const { scene, color } = this.frames[this.current]
    const basis = basisOf(camera)
    const f = Math.tan(camera.fovY / 2)
    gl.bindFramebuffer(gl.FRAMEBUFFER, color.framebuffer)
    gl.viewport(0, 0, color.width, color.height)
    gl.disable(gl.BLEND)
    gl.useProgram(program.program)
    this.universe.bindQuad(program)
    gl.uniform2f(program.uniform('u_res'), color.width, color.height)
    gl.uniform3fv(program.uniform('u_right'), basis.right)
    gl.uniform3fv(program.uniform('u_up'), basis.up)
    gl.uniform3fv(program.uniform('u_forward'), basis.forward)
    gl.uniform2f(program.uniform('u_tan'), f * (color.width / color.height), f)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, scene.texture)
    gl.uniform1i(program.uniform('u_scene'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.near.texture)
    gl.uniform1i(program.uniform('u_near'), 1)
    gl.uniform1f(program.uniform('u_hasNear'), withNear ? 1 : 0)
  }

  private bindCube(program: Program, name: string, cube: TargetCube, unit: number): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, cube.texture)
    gl.uniform1i(program.uniform(name), unit)
  }

  private fullScreen(): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6)
  }

  /**
   * One frame of the flight at flight time T (seconds since take-off); `time` drives twinkling and
   * swirling. `offscreen` (warming up) leaves the canvas alone.
   */
  render(T: number, time: number, pose: CameraPose, offscreen = false): void {
    const gl = this.gl
    const { wormhole, blackHole } = this.plan
    const { scene, color, bloom } = this.frames[this.current]
    const camera: Camera = pose
    const home = homePlanetAt(T)
    const dest = destPlanetAt(T)
    const landing = T > FLIGHT_S

    // ---- the universe, and the lens over it. Not while a planet's own sky fills the picture.
    if (home.ground || dest.ground) {
      /* the planet shader paints every pixel */
    } else if (landing) {
      // the planet covers everything: nothing behind it to draw
      gl.bindFramebuffer(gl.FRAMEBUFFER, color.framebuffer)
      gl.viewport(0, 0, color.width, color.height)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    } else {
      const lens = this.lensAt(T)
      if (lens === 'transit' && wormhole && this.other) {
        const tau = (T - wormhole.transit[0]) / (wormhole.transit[1] - wormhole.transit[0])
        // towards the end the far side is drawn live, with the camera we come out with: the one we
        // have now, carried over to the far side
        const live = smooth(0.88, 1, tau)
        if (live > 0) {
          const turned = (v: Vec3): Vec3 => {
            const m = wormhole.turn
            return [
              m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
              m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
              m[2] * v[0] + m[5] * v[1] + m[8] * v[2]
            ]
          }
          this.drawScene({ eye: wormhole.exitEye, forward: turned(pose.forward), up: turned(pose.up), fovY: pose.fovY }, scene, T, time)
        }
        const program = this.program('transit')
        this.useLens(program, camera, false)
        gl.uniform1f(program.uniform('u_tau'), tau)
        gl.uniform1f(program.uniform('u_time'), time)
        gl.uniform1f(program.uniform('u_live'), live)
        gl.uniformMatrix3fv(program.uniform('u_turn'), false, wormhole.turn)
        this.bindCube(program, 'u_other', this.other, 2)
        this.fullScreen()
      } else if (lens === 'wormhole' && wormhole && this.other) {
        this.drawScene(camera, scene, T, time)
        const program = this.program('wormhole')
        this.useLens(program, camera, true)
        gl.uniform3fv(program.uniform('u_mouth'), sub(wormhole.entry, camera.eye))
        gl.uniform1f(program.uniform('u_rho'), wormhole.entryRadius)
        gl.uniformMatrix3fv(program.uniform('u_turn'), false, wormhole.turn)
        this.bindCube(program, 'u_other', this.other, 2)
        this.fullScreen()
      } else if (lens === 'blackhole' && blackHole) {
        this.drawScene(camera, scene, T, time)
        const program = this.program('blackhole')
        this.useLens(program, camera, length(sub(blackHole.pos, camera.eye)) < 160 * blackHole.rs)
        gl.uniform3fv(program.uniform('u_hole'), sub(blackHole.pos, camera.eye))
        gl.uniform1f(program.uniform('u_rs'), blackHole.rs)
        gl.uniform3fv(program.uniform('u_bx'), blackHole.axisX)
        gl.uniform3fv(program.uniform('u_by'), blackHole.normal)
        gl.uniform3fv(program.uniform('u_bz'), blackHole.axisZ)
        gl.uniform1f(program.uniform('u_time'), time)
        gl.uniform1f(program.uniform('u_rIn'), blackHole.diskInner)
        gl.uniform1f(program.uniform('u_rOut'), blackHole.diskOuter)
        gl.uniform1i(program.uniform('u_zero'), 0) // WebGL2 version only (null in WebGL1, which is fine)
        this.fullScreen()
      } else {
        this.drawScene(camera, scene, T, time)
        this.useLens(this.program('copy'), camera, false)
        this.fullScreen()
      }
    }

    // ---- the planet on top (into the same picture, so it gets the film look too)
    this.drawPlanet(T, time, camera, home, dest)

    // ---- bloom: bright parts, a quarter and an eighth of the size, blurred
    const cinema = cinemaAt(T)
    if (cinema > 0) {
      const [q1, q2, e1, e2] = bloom
      this.pass(this.program('bright'), q1, color, { u_texel: [1 / color.width, 1 / color.height] })
      this.pass(this.program('blur'), q2, q1, { u_dir: [1 / q1.width, 0] })
      this.pass(this.program('blur'), q1, q2, { u_dir: [0, 1 / q1.height] })
      this.pass(this.program('blur'), e1, q1, { u_dir: [1.5 / e1.width, 0] })
      this.pass(this.program('blur'), e2, e1, { u_dir: [0, 1.5 / e1.height] })
    }

    // ---- final picture on the canvas (while warming up: into a small picture nobody sees)
    const program = this.program('final')
    const [width, height] = offscreen ? [bloom[1].width, bloom[1].height] : this.canvasSize
    gl.bindFramebuffer(gl.FRAMEBUFFER, offscreen ? bloom[1].framebuffer : null)
    gl.viewport(0, 0, width, height)
    gl.useProgram(program.program)
    this.universe.bindQuad(program)
    const textures = [color, bloom[0], bloom[3]]
    ;['u_color', 'u_bloom1', 'u_bloom2'].forEach((name, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, textures[unit].texture)
      gl.uniform1i(program.uniform(name), unit)
    })
    gl.uniform2f(program.uniform('u_res'), width, height)
    gl.uniform1f(program.uniform('u_cinema'), cinema)
    // 2.39:1 like a film, if the window is less wide than that
    gl.uniform1f(program.uniform('u_bar'), Math.max(0, (1 - width / height / 2.39) / 2))
    gl.uniform1f(program.uniform('u_time'), time)
    this.fullScreen()
  }

  /** The planet we are leaving or the one we are coming to (and its sun), over the frame. */
  private drawPlanet(T: number, time: number, camera: Camera, home: PlanetView, dest: PlanetView): void {
    const gl = this.gl
    const { color } = this.frames[this.current]
    const leaving = T < 10
    const view = leaving ? home : dest
    // the globe: pinned to the middle of the screen while it is all we see, else where it is in space
    let globe: [number, number, number] = [0, 0, 0]
    if (!view.ground && view.radius > 0) {
      const place = view.pinned < 1 ? onScreen(camera, leaving ? this.plan.home : this.plan.planet) : null
      const pinnedY = view.pitch - PLANET_OFFSET - view.drop
      if (view.pinned >= 1) globe = [0, pinnedY, view.radius]
      else if (place) globe = [place[0] * (1 - view.pinned), place[1] * (1 - view.pinned) + pinnedY * view.pinned, view.radius]
    }
    // the sun of the planet we are coming to
    let sun: [number, number, number, number] = [0, 0, 0, 0]
    let light: [number, number] = [0.8, 0.6]
    if (!leaving && !view.ground) {
      const place = onScreen(camera, this.plan.sun)
      const brightness = sunGlowAt(T)
      if (place && brightness > 0) {
        const distance = Math.max(1e-12, length(sub(this.plan.sun, camera.eye)))
        // a star among the others first, then it grows into a sun as we close in
        const size = Math.min(
          0.075,
          0.0035 + 0.02 * smooth(17.2, 20.2, T) + (0.05 * length(sub(this.plan.sun, this.plan.planet))) / distance
        )
        sun = [place[0], place[1], size, brightness]
        const toSun = sub([place[0], place[1], 0], [globe[0], globe[1], 0])
        if (length(toSun) > 1e-6) light = [toSun[0] / length(toSun), toSun[1] / length(toSun)]
      } else {
        // the sun has left the picture: lit from where it went
        const basis = basisOf(camera)
        const rel = normalize(sub(this.plan.sun, this.plan.planet))
        const flat: Vec3 = [dot(rel, basis.right), dot(rel, basis.up), 0]
        if (length(flat) > 1e-6) light = [flat[0] / length(flat), flat[1] / length(flat)]
      }
    }
    if (!view.ground && globe[2] <= 0 && sun[3] <= 0) return
    const program = this.program('planet')
    const [gal, gal2] = leaving ? this.galFrom : this.galTo
    gl.bindFramebuffer(gl.FRAMEBUFFER, color.framebuffer)
    gl.viewport(0, 0, color.width, color.height)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(program.program)
    this.universe.bindQuad(program)
    gl.uniform2f(program.uniform('u_res'), color.width, color.height)
    gl.uniform1f(program.uniform('u_time'), time)
    gl.uniform1f(program.uniform('u_seed'), leaving ? this.fromSeed : this.toSeed)
    gl.uniform4fv(program.uniform('u_gal'), gal)
    gl.uniform4fv(program.uniform('u_gal2'), gal2)
    gl.uniform4f(program.uniform('u_view'), view.ground ? 1 : 0, view.pitch, view.drop, view.night)
    gl.uniform3fv(program.uniform('u_globe'), globe)
    gl.uniform2fv(program.uniform('u_light'), light)
    gl.uniform4fv(program.uniform('u_sun'), sun)
    this.fullScreen()
    gl.disable(gl.BLEND)
  }

  /** A full-screen pass from one texture into a target. */
  private pass(program: Program, target: Target2D, source: Target2D, uniforms: Record<string, [number, number]>): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    gl.useProgram(program.program)
    this.universe.bindQuad(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, source.texture)
    gl.uniform1i(program.uniform('u_src'), 0)
    gl.uniform2f(program.uniform('u_res'), target.width, target.height)
    for (const [name, value] of Object.entries(uniforms)) gl.uniform2f(program.uniform(name), value[0], value[1])
    this.fullScreen()
  }
}
