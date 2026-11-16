import { ARRIVAL_SHIFT, JOURNEY_S, type CameraPose, type FlightPlan } from '@shared/journey'
import { length, neighbourhoodStars, sub, type Galaxy, type Vec3 } from '@shared/universe'
import { SPACE_LIB, VERT, galaxyUniforms } from './spaceGlsl'
import { UniverseGl, basisOf, createProgram, type Camera, type Program, type RenderTarget, type StarCloud } from './universeGl'

/*
 * GPU side of the flight between two games (the camera path is shared/journey.ts).
 *
 * Every frame the universe is drawn into a texture with the flight camera. A full-screen lens pass
 * then bends that picture: around the wormhole (and through it, where you see the other side),
 * into the tunnel of its throat, or around the black hole, which is ray-marched along real photon
 * paths with its accretion disk. Light bent so far that it comes from outside the screen is looked
 * up in a small cube map of the surroundings, rendered from the camera while the lens is strong.
 * The take-off and landing planets are painted over that (PLANET_FRAG), then bloom, a letterbox,
 * a little vignette and film grain make it look like a film. Each of those cinema touches is zero
 * at the very start and end, so the flight begins and ends on exactly the picture CosmosBackground
 * shows while you stand on the planet.
 */

// ---- the planets at both ends of the trip, in screen space -------------------------------------
// Take-off uses the flight time T, everything about the arrival `aT`, which keeps the timings of
// the 12-second flight of 1.0 (the arrival just starts ARRIVAL_SHIFT seconds later).
const PLANET_FRAG = `${SPACE_LIB}
uniform vec2 u_res;
uniform float u_time;
uniform float u_T;
uniform float u_arrive;
uniform float u_from;
uniform float u_to;
uniform vec4 u_galFrom;
uniform vec4 u_galFrom2;
uniform vec4 u_galTo;
uniform vec4 u_galTo2;

float ease(float x){ x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }

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

// Layers are composited front to back into a premultiplied colour: "cover" paints over what is
// below (and over the 3D scene), "glow" is added on top.
vec3 g_col = vec3(0.0);
float g_alpha = 0.0;
void cover(vec3 c, float a){ g_col = g_col * (1.0 - a) + c * a; g_alpha = g_alpha * (1.0 - a) + a; }

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float T = u_T;
  float aT = u_T - u_arrive;
  float t = u_time;
  vec3 glow = vec3(0.0);

  // ---- take-off from the old planet
  float aHome = 1.0 - smoothstep(1.0, 2.4, T);
  if (aHome > 0.0) {
    g_seed = u_from;
    g_gal = u_galFrom;
    g_gal2 = u_galFrom2;
    float e = ease(T / 2.2);
    cover(planetView(p * (1.0 + e * 1.6), t, u_from, e * 0.9), aHome);
  }

  g_gal = u_galTo;
  g_gal2 = u_galTo2;
  // ---- target solar system, in screen space around its sun (the star the camera flies at)
  float S = 0.05 * exp(max(aT - 8.2, 0.0) * 1.3);
  float a2 = h11(u_to + 41.0) * 6.28;
  vec2 target = vec2(cos(a2), sin(a2) * 0.3) * 1.6 * S;
  float pan = ease((aT - 9.0) / 1.4);
  vec2 sunPos = -target * pan;
  float L = ease((aT - 10.7) / 1.3);
  float aIn = smoothstep(7.4, 8.4, aT) * (1.0 - smoothstep(11.0, 11.8, aT));
  if (aIn > 0.0) {
    float sr = min(0.003 * exp(max(aT - 7.8, 0.0) * 1.5), 0.06);
    glow += sunGlow(p - sunPos, sr) * smoothstep(7.6, 8.4, aT) * (1.0 - L) * aIn;
    float aSys = smoothstep(8.4, 9.2, aT) * (1.0 - L) * aIn;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float ri = (0.55 + fi * 0.52) * S;
      vec2 d = p - sunPos;
      float orbit = abs(length(vec2(d.x, d.y / 0.3)) - ri);
      glow += neb(0.1 + fi * 0.2) * exp(-orbit / 0.0018) * 0.18 * aSys;
      if (i == 2) continue;
      float ai = h11(u_to + 50.0 + fi) * 6.28;
      vec2 pp = sunPos + vec2(cos(ai), sin(ai) * 0.3) * ri;
      float pr = 0.004 + 0.002 * h11(u_to + 60.0 + fi);
      glow += neb(h11(u_to + 70.0 + fi)) * smoothstep(pr, pr * 0.6, length(p - pp)) * 1.4 * aSys;
    }
  }

  // ---- target planet: a dot, then a disk, then the ground we stand on
  if (aT > 8.4) {
    float grow = 0.005 * exp(max(aT - 9.4, 0.0) * 3.0);
    vec2 pc = mix(sunPos + target, vec2(0.0, -3.42), L);
    float R = mix(min(grow, 0.26), 3.0, L);
    vec2 sunDir = normalize(sunPos - pc + 1e-4);
    vec3 rim;
    vec4 disk = planetDisk(p, pc, R, sunDir, u_to, L, rim);
    float a = smoothstep(8.4, 9.2, aT);
    g_seed = u_to;
    if (L > 0.0) {
      float aSky = L * (1.0 - disk.a);
      cover(sky(p, t, u_to), aSky);
      glow *= 1.0 - aSky;
    }
    cover(disk.rgb, disk.a * a);
    glow = glow * (1.0 - disk.a * a) + rim * a;
  }

  // ---- arrived: cross-fade to the regular view from the new planet
  float fin = smoothstep(11.3, 12.0, aT);
  if (fin > 0.0) {
    g_seed = u_to;
    cover(planetView(p, t, u_to, 0.0), fin);
    glow *= 1.0 - fin;
  }
  vec3 covered = g_alpha > 0.0 ? finish(g_col / g_alpha, p) * g_alpha : vec3(0.0);
  gl_FragColor = vec4(covered + finish(glow, p), g_alpha);
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
 * Inside the throat. The far side shows through an opening ahead that closes down as we dive in
 * and opens up again until it is the whole view. Around it the walls of the tunnel: light of both
 * sides smeared into swirling bands by the way the throat bends it, plus a flash on the way out.
 */
const TRANSIT_FRAG = `${LENS_HEAD}
uniform float u_tau;
uniform float u_time;
uniform mat3 u_turn;
uniform samplerCube u_other;
uniform samplerCube u_home;
void main(){
  vec3 d = rayDir();
  float cs = clamp(dot(d, u_forward), -1.0, 1.0);
  float th = acos(cs);
  float ph = atan(dot(d, u_up), dot(d, u_right));
  float tau = u_tau;
  float twist = sin(3.14159265 * tau) * 0.9;                     // the view turns on the way through, and back
  float ap = mix(1.25, 0.16, smoothstep(0.0, 0.35, tau));
  ap = mix(ap, 2.4, smoothstep(0.55, 1.0, tau));
  float edgePsi = mix(3.0, ap, smoothstep(0.72, 1.0, tau));
  vec3 col = vec3(0.0);
  if (th < ap * 1.08) {
    float psiIn = 3.14159265 * pow(min(1.0, 1.15 * sin(th)), 1.15);   // how the sphere looked from just outside
    float psi = mix(psiIn, th * edgePsi / ap, smoothstep(0.0, 0.25, tau));
    float a = ph + twist;
    vec3 dirC = cos(psi) * u_forward + sin(psi) * (cos(a) * u_right + sin(a) * u_up);
    col = textureCube(u_other, u_turn * dirC).rgb;
  }
  float wall = smoothstep(ap * 0.92, ap * 1.08, th);
  if (wall > 0.0) {
    float z = cs / max(sqrt(1.0 - cs * cs), 0.03);                 // where along the throat this ray meets the wall
    float travel = tau * 10.0;
    vec3 w = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float k = float(i) / 5.0;
      float zz = z + travel - k * 0.6;                             // smeared along the way we move
      float pol = 3.14159265 * (0.5 + 0.5 * sin(zz * 0.5));
      float az = ph + zz * 0.35 + twist;
      vec3 dw = cos(pol) * u_forward + sin(pol) * (cos(az) * u_right + sin(az) * u_up);
      w += mix(textureCube(u_home, dw).rgb, textureCube(u_other, u_turn * dw).rgb, smoothstep(0.25, 0.75, tau));
    }
    w *= 0.2;
    float swirl = ph * 3.0 + z * 1.2 + travel * 2.0 + twist;
    float filament = pow(0.5 + 0.5 * sin(swirl * 2.0 + 1.7 * sin(z * 0.7 + ph * 2.0)), 6.0) * (0.4 + 0.6 * lfbm(vec2(ph * 2.0, z * 0.8 + travel)));
    vec3 tint = mix(vec3(0.55, 0.7, 1.0), vec3(1.0, 0.8, 0.62), 0.5 + 0.5 * sin(z * 0.3 + 1.0));
    w += tint * filament * 0.28 * exp(-abs(z) * 0.15);
    w *= exp(-max(z, 0.0) * 0.08);
    col = mix(col, w, wall);
  }
  col += vec3(0.75, 0.86, 1.0) * exp(-pow((th - ap) / 0.02, 2.0)) * 0.3 * (1.0 - smoothstep(0.8, 1.0, tau));
  col += vec3(0.92, 0.95, 1.0) * smoothstep(0.86, 0.95, tau) * (1.0 - smoothstep(0.95, 1.0, tau)) * 0.4;
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
          vec4 e = disk(hit, rh, vn);
          col += trans * e.rgb * e.a;
          trans *= 1.0 - e.a;
        }
      }
      x = xn;
      v = vn;
      if (dot(x, x) < 1.0) { captured = true; break; }
      if (dot(x, x) > R * R && dot(x, v) > 0.0) break;
      if (trans < 0.03) break;
      if (i == 179) captured = true;                               // still circling the photon sphere
    }
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

/** The inverse of a rotation is its transpose (column-major 3x3). */
const transpose3 = (m: number[]): number[] => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]

const STARS_PER_GALAXY = 36_000
const STARS_NEARBY = 4500
const CUBE_SIZE = 256
const FAR_CUBE_SIZE = 512

type Lens = 'none' | 'wormhole' | 'transit' | 'wormhole-out' | 'blackhole'

/**
 * Compiles every shader of the flight once, in a throwaway context. The browser keeps compiled
 * programs in its cache, so the real flight later starts without a pause (on Windows a large shader
 * can take a second or more to compile the first time). Meant for an idle moment after start-up.
 */
export function prewarmFlightShaders(): void {
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 16
  // same attributes as JourneyCanvas, so it is the same GPU and the same cache entries
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' })
  if (!gl) return
  UniverseGl.create(gl)
  for (const frag of [PLANET_FRAG, COPY_FRAG, WORMHOLE_FRAG, TRANSIT_FRAG, BLACKHOLE_FRAG, BRIGHT_FRAG, BLUR_FRAG, FINAL_FRAG])
    createProgram(gl, VERT, frag)
  gl.getExtension('WEBGL_lose_context')?.loseContext()
}

/** Renders one flight. Create it once per flight; call render() every frame. */
export class FlightRenderer {
  private readonly universe: UniverseGl
  private readonly programs: Record<'planet' | 'copy' | 'wormhole' | 'transit' | 'blackhole' | 'bright' | 'blur' | 'final', Program>
  private readonly starsFrom: StarCloud
  private readonly starsTo: StarCloud
  private readonly nearFrom: StarCloud
  private readonly nearTo: StarCloud
  private readonly galFrom: [Float32Array, Float32Array]
  private readonly galTo: [Float32Array, Float32Array]
  private scene!: Target2D
  private color!: Target2D
  private bloom: Target2D[] = []
  private readonly near: TargetCube
  /** wormhole only: the far side seen from the exit mouth, and our side seen from the entry */
  private readonly other: TargetCube | null
  private readonly home: TargetCube | null
  private homeReady = false
  private size: [number, number] = [0, 0]
  private canvasSize: [number, number] = [0, 0]

  private constructor(
    private readonly gl: WebGLRenderingContext,
    universe: UniverseGl,
    programs: FlightRenderer['programs'],
    private readonly plan: FlightPlan,
    private readonly fromSeed: number,
    private readonly toSeed: number
  ) {
    this.universe = universe
    this.programs = programs
    this.starsFrom = universe.createStars(plan.from, STARS_PER_GALAXY)
    this.starsTo = plan.to.id === plan.from.id ? this.starsFrom : universe.createStars(plan.to, STARS_PER_GALAXY)
    this.nearFrom = universe.createStars(plan.from, neighbourhoodStars(fromSeed, STARS_NEARBY))
    this.nearTo = universe.createStars(plan.to, neighbourhoodStars(toSeed, STARS_NEARBY))
    this.galFrom = galaxyUniforms(fromSeed)
    this.galTo = galaxyUniforms(toSeed)
    this.near = targetCube(gl, CUBE_SIZE)
    this.other = plan.wormhole ? targetCube(gl, FAR_CUBE_SIZE) : null
    this.home = plan.wormhole ? targetCube(gl, CUBE_SIZE) : null
    // the far side doesn't move: render it once (T of the exit, so its galaxy's stars are drawn)
    if (plan.wormhole && this.other) this.drawCube(this.other, plan.wormhole.exit, plan.wormhole.transit[1], 0)
  }

  /** Null when the shaders can't be built on this machine. */
  static create(gl: WebGLRenderingContext, plan: FlightPlan, fromSeed: number, toSeed: number): FlightRenderer | null {
    const universe = UniverseGl.create(gl)
    const programs = {
      planet: createProgram(gl, VERT, PLANET_FRAG),
      copy: createProgram(gl, VERT, COPY_FRAG),
      wormhole: createProgram(gl, VERT, WORMHOLE_FRAG),
      transit: createProgram(gl, VERT, TRANSIT_FRAG),
      blackhole: createProgram(gl, VERT, BLACKHOLE_FRAG),
      bright: createProgram(gl, VERT, BRIGHT_FRAG),
      blur: createProgram(gl, VERT, BLUR_FRAG),
      final: createProgram(gl, VERT, FINAL_FRAG)
    }
    if (!universe || Object.values(programs).some((program) => !program)) return null
    return new FlightRenderer(gl, universe, programs as FlightRenderer['programs'], plan, fromSeed, toSeed)
  }

  /** Size of the canvas and of the offscreen pictures (smaller when the machine can't keep up). */
  resize(canvasWidth: number, canvasHeight: number, quality: number): void {
    const width = Math.max(64, Math.round(canvasWidth * quality))
    const height = Math.max(64, Math.round(canvasHeight * quality))
    this.canvasSize = [canvasWidth, canvasHeight]
    if (width === this.size[0] && height === this.size[1]) return
    const gl = this.gl
    if (this.scene) [this.scene, this.color, ...this.bloom].forEach((target) => freeTarget(gl, target))
    this.size = [width, height]
    this.scene = target2D(gl, width, height)
    this.color = target2D(gl, width, height)
    const quarter: [number, number] = [Math.max(16, width >> 2), Math.max(16, height >> 2)]
    const eighth: [number, number] = [Math.max(8, width >> 3), Math.max(8, height >> 3)]
    this.bloom = [target2D(gl, ...quarter), target2D(gl, ...quarter), target2D(gl, ...eighth), target2D(gl, ...eighth)]
  }

  /** Which lens the frame at flight time T needs. */
  private lensAt(T: number): Lens {
    const { wormhole, blackHole } = this.plan
    if (wormhole) {
      const [enter, exit] = wormhole.transit
      if (T >= enter && T < exit) return 'transit'
      if (T >= 1.6 && T < enter) return 'wormhole'
      if (T >= exit && T < exit + 1.6) return 'wormhole-out'
    }
    if (blackHole && T >= 2.4 && T < 12.6) return 'blackhole'
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
    // before 1 s the old planet still covers everything, at the end the new one does
    if (T <= 0.95 || T >= JOURNEY_S - 0.05) return
    const pointScale = Math.max(1, target.height / 720)
    universe.drawGalaxies(time)
    universe.drawStars(this.starsFrom, this.starAlpha(this.plan.from, camera.eye), pointScale)
    if (this.starsTo !== this.starsFrom) universe.drawStars(this.starsTo, this.starAlpha(this.plan.to, camera.eye), pointScale)
    // the dense neighbourhood of a planet only around that planet, so a hop within one galaxy doesn't draw both at once
    const nearFrom = length(sub(camera.eye, this.nearFrom.galaxy.pos)) < length(sub(camera.eye, this.nearTo.galaxy.pos)) || T < 4
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
  private useLens(program: Program, camera: Camera, near: TargetCube | null): void {
    const gl = this.gl
    const basis = basisOf(camera)
    const f = Math.tan(camera.fovY / 2)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.color.framebuffer)
    gl.viewport(0, 0, this.size[0], this.size[1])
    gl.disable(gl.BLEND)
    gl.useProgram(program.program)
    this.universe.bindQuad(program)
    gl.uniform2f(program.uniform('u_res'), this.size[0], this.size[1])
    gl.uniform3fv(program.uniform('u_right'), basis.right)
    gl.uniform3fv(program.uniform('u_up'), basis.up)
    gl.uniform3fv(program.uniform('u_forward'), basis.forward)
    gl.uniform2f(program.uniform('u_tan'), f * (this.size[0] / this.size[1]), f)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.scene.texture)
    gl.uniform1i(program.uniform('u_scene'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, (near ?? this.near).texture)
    gl.uniform1i(program.uniform('u_near'), 1)
    gl.uniform1f(program.uniform('u_hasNear'), near ? 1 : 0)
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

  /** One frame of the flight at flight time T (seconds since take-off); `time` drives twinkling and swirling. */
  render(T: number, time: number, pose: CameraPose): void {
    const gl = this.gl
    const { wormhole, blackHole } = this.plan
    const lens = this.lensAt(T)
    const camera: Camera = pose

    // ---- the universe, and the lens over it
    if (lens === 'none') {
      this.drawScene(camera, this.color, T, time)
    } else if (lens === 'transit' && wormhole && this.other && this.home) {
      if (!this.homeReady) {
        this.drawCube(this.home, this.plan.cameraAt(wormhole.transit[0]).eye, wormhole.transit[0], time)
        this.homeReady = true
      }
      const program = this.programs.transit
      this.useLens(program, camera, null)
      gl.uniform1f(program.uniform('u_tau'), (T - wormhole.transit[0]) / (wormhole.transit[1] - wormhole.transit[0]))
      gl.uniform1f(program.uniform('u_time'), time)
      gl.uniformMatrix3fv(program.uniform('u_turn'), false, wormhole.turn)
      this.bindCube(program, 'u_other', this.other, 2)
      this.bindCube(program, 'u_home', this.home, 3)
      this.fullScreen()
    } else if ((lens === 'wormhole' || lens === 'wormhole-out') && wormhole && this.other && this.home) {
      this.drawScene(camera, this.scene, T, time)
      const into = lens === 'wormhole'
      const mouth = into ? wormhole.entry : wormhole.exit
      const rho = into ? wormhole.entryRadius : wormhole.exitRadius
      // light bent around the mouth comes from all around: the cube of the surroundings is always needed going in
      const close = into || length(sub(mouth, camera.eye)) < 3 * rho
      if (close) this.drawCube(this.near, camera.eye, T, time)
      if (!into && !this.homeReady) {
        this.drawCube(this.home, this.plan.cameraAt(wormhole.transit[0]).eye, wormhole.transit[0], time)
        this.homeReady = true
      }
      const program = this.programs.wormhole
      this.useLens(program, camera, close ? this.near : null)
      gl.uniform3fv(program.uniform('u_mouth'), sub(mouth, camera.eye))
      gl.uniform1f(program.uniform('u_rho'), rho)
      gl.uniformMatrix3fv(program.uniform('u_turn'), false, into ? wormhole.turn : transpose3(wormhole.turn))
      this.bindCube(program, 'u_other', into ? this.other : this.home, 2)
      this.fullScreen()
    } else if (lens === 'blackhole' && blackHole) {
      this.drawScene(camera, this.scene, T, time)
      const close = length(sub(blackHole.pos, camera.eye)) < 160 * blackHole.rs
      if (close) this.drawCube(this.near, camera.eye, T, time)
      const program = this.programs.blackhole
      this.useLens(program, camera, close ? this.near : null)
      gl.uniform3fv(program.uniform('u_hole'), sub(blackHole.pos, camera.eye))
      gl.uniform1f(program.uniform('u_rs'), blackHole.rs)
      gl.uniform3fv(program.uniform('u_bx'), blackHole.axisX)
      gl.uniform3fv(program.uniform('u_by'), blackHole.normal)
      gl.uniform3fv(program.uniform('u_bz'), blackHole.axisZ)
      gl.uniform1f(program.uniform('u_time'), time)
      gl.uniform1f(program.uniform('u_rIn'), blackHole.diskInner)
      gl.uniform1f(program.uniform('u_rOut'), blackHole.diskOuter)
      this.fullScreen()
    } else {
      this.drawScene(camera, this.scene, T, time)
      this.useLens(this.programs.copy, camera, null)
      this.fullScreen()
    }

    // ---- planets on top (into the same picture, so they get the film look too)
    if (T < 2.4 || T > 7.4 + ARRIVAL_SHIFT) {
      const program = this.programs.planet
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.color.framebuffer)
      gl.viewport(0, 0, this.size[0], this.size[1])
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.useProgram(program.program)
      this.universe.bindQuad(program)
      gl.uniform2f(program.uniform('u_res'), this.size[0], this.size[1])
      gl.uniform1f(program.uniform('u_time'), time)
      gl.uniform1f(program.uniform('u_T'), T)
      gl.uniform1f(program.uniform('u_arrive'), ARRIVAL_SHIFT)
      gl.uniform1f(program.uniform('u_from'), this.fromSeed)
      gl.uniform1f(program.uniform('u_to'), this.toSeed)
      gl.uniform4fv(program.uniform('u_galFrom'), this.galFrom[0])
      gl.uniform4fv(program.uniform('u_galFrom2'), this.galFrom[1])
      gl.uniform4fv(program.uniform('u_galTo'), this.galTo[0])
      gl.uniform4fv(program.uniform('u_galTo2'), this.galTo[1])
      this.fullScreen()
    }
    gl.disable(gl.BLEND)

    // ---- bloom: bright parts, a quarter and an eighth of the size, blurred
    const cinema = smooth(0.4, 2.0, T) * (1 - smooth(JOURNEY_S - 1.8, JOURNEY_S - 0.6, T))
    if (cinema > 0) {
      const [q1, q2, e1, e2] = this.bloom
      this.pass(this.programs.bright, q1, this.color, { u_texel: [1 / this.size[0], 1 / this.size[1]] })
      this.pass(this.programs.blur, q2, q1, { u_dir: [1 / q1.width, 0] })
      this.pass(this.programs.blur, q1, q2, { u_dir: [0, 1 / q1.height] })
      this.pass(this.programs.blur, e1, q1, { u_dir: [1.5 / e1.width, 0] })
      this.pass(this.programs.blur, e2, e1, { u_dir: [0, 1.5 / e1.height] })
    }

    // ---- final picture on the canvas
    const program = this.programs.final
    const [width, height] = this.canvasSize
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)
    gl.useProgram(program.program)
    this.universe.bindQuad(program)
    const textures = [this.color, this.bloom[0], this.bloom[3]]
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
