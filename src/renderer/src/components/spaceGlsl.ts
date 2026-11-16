import { galaxyOf, typeCode } from '@shared/universe'

/**
 * GLSL shared by the space backgrounds: hashes, noise, the nebula palette, star layers, galaxies,
 * the night sky from inside a galaxy (`sky`) and the view from a planet's surface (`planetView`).
 * Each seed is a different place.
 */
export const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

export const SPACE_LIB = `
precision highp float;
// seed for the star layers. main() sets it before each part because one frame can show several places.
float g_seed;
// the galaxy the sky belongs to: (arms, twist, hue, seed) and (type, shape, shape2, spin), see galaxyUniforms()
vec4 g_gal = vec4(3.0, 3.5, 0.5, 100.0);
vec4 g_gal2 = vec4(0.0);
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
// nebula palette: blue, violet, pink, teal. A full hue wheel gave muddy greens and yellows.
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

// one star layer on a jittered grid. keep is the fraction of empty cells; the rest get a star with a soft halo.
vec3 starLayer(vec2 uv, float scale, float keep, float t, float salt){
  vec2 g = uv * scale;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float b = h21(id + salt + g_seed);
  if (b < keep) return vec3(0.0);
  vec2 o = h22(id + salt * 1.7 + g_seed) - 0.5;
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

// spiral galaxy in its own plane. q is in galaxy units (1 is roughly the visible disk).
vec3 galaxyShapeP(vec2 q, float t, float arms, float twist, float hue, float seed){
  vec3 armCol = neb(hue);
  vec3 armIn = neb(hue + 0.3);
  float r = length(q);
  float a = atan(q.y, q.x);
  float wob = (fbm(q * 1.4 + seed * 0.7) - 0.5) * 1.6;
  float spiral = pow(0.5 + 0.5 * cos(arms * (a - twist * log(r + 0.06)) + wob), 2.6);
  float disk = exp(-r * 2.1);
  float clumps = fbm(q * 3.4 + seed);
  float dust = smoothstep(0.42, 0.78, fbm(q * 7.0 - seed * 1.3)) * spiral * exp(-r * 1.2);
  vec3 g = mix(armIn, armCol, smoothstep(0.2, 1.1, r)) * spiral * disk * (0.45 + clumps) * 1.3;
  g += vec3(1.0, 0.86, 0.62) * (exp(-r * 8.0) * 1.6 + exp(-r * 2.8) * 0.25);
  g += starLayer(q * 0.35, 90.0, 0.7, t, 9.0) * spiral * disk * 1.5;
  g *= 1.0 - dust * 0.75;
  return g * smoothstep(2.8, 1.3, r);
}
vec3 galaxyShape(vec2 q, float t, float seed){
  return galaxyShapeP(q, t, floor(mix(2.0, 4.99, h11(seed + 26.0))), mix(2.4, 5.2, h11(seed + 27.0)), h11(seed + 28.0), seed);
}

/*
 * Galaxy types (codes as in GALAXY_TYPES, shared/universe.ts). par = (arms, twist, hue, seed),
 * par2 = (type, shape, shape2, spin). The layouts (bar, ring, clumps, merger) use the same formulas
 * as the star generator in universe.ts, so painted galaxies and their single stars line up.
 */
bool isType(float type, float code){ return abs(type - code) < 0.5; }
// spheroids are drawn as camera-facing ellipses (galaxyHalo), not as a disk
bool isSpheroid(vec4 par2){ return isType(par2.x, 2.0) || (isType(par2.x, 5.0) && par2.y < 0.5); }
float extentOf(vec4 par2){ return isType(par2.x, 5.0) ? 0.5 + 0.25 * par2.z : 1.0; }

vec3 barredShape(vec2 q, float t, float twist, float hue, float seed, float shape, float shape2){
  float L = 0.22 + 0.16 * shape;
  vec3 armCol = neb(hue);
  vec3 armIn = neb(hue + 0.3);
  float r = length(q);
  float a = atan(q.y, q.x);
  float wob = (fbm(q * 1.4 + seed * 0.7) - 0.5) * 1.4;
  float spiral = pow(0.5 + 0.5 * cos(2.0 * (a - twist * 0.55 * log(max(r, 1e-3) / L)) + wob), 3.0) * smoothstep(L * 0.7, L * 1.3, r);
  float disk = exp(-r * 2.2);
  float clumps = fbm(q * 3.4 + seed);
  vec3 g = mix(armIn, armCol, smoothstep(0.3, 1.1, r)) * spiral * disk * (0.45 + clumps) * 1.5;
  float bar = exp(-pow(abs(q.x) / L, 3.0) - pow(q.y / (L * 0.2), 2.0));
  g += mix(vec3(1.0, 0.84, 0.6), armIn, 0.2) * bar * (1.0 + 0.5 * clumps) * 1.15;
  if (shape2 > 0.5) g += armIn * exp(-pow((r - L * 1.05) / 0.035, 2.0)) * (0.3 + clumps * 0.6) * (shape2 - 0.5) * 2.0;
  g += vec3(1.0, 0.86, 0.62) * (exp(-r * 12.0) * 1.1 + exp(-r * 3.0) * 0.15);
  g += starLayer(q * 0.35, 90.0, 0.7, t, 9.0) * spiral * disk * 1.5;
  float dust = smoothstep(0.42, 0.78, fbm(q * 7.0 - seed * 1.3)) * (spiral + bar * 0.5) * exp(-r * 1.2);
  g *= 1.0 - dust * 0.7;
  return g * smoothstep(2.8, 1.3, r);
}

vec3 lenticularShape(vec2 q, float t, float hue, float seed, float shape, float shape2){
  float r = length(q);
  vec3 warm = vec3(1.0, 0.86, 0.66);
  vec3 tint = mix(warm, neb(hue), 0.2);
  float grain = fbm(q * 5.0 + seed);
  vec3 g = warm * exp(-r * (10.0 - 4.0 * shape)) * 1.5;
  g += tint * (exp(-pow(r / 0.45, 2.0)) * 0.32 + exp(-r * 2.6) * 0.5) * (0.85 + 0.3 * grain);
  if (shape2 > 0.5) g *= 1.0 - 0.65 * exp(-pow((r - 0.55) / 0.05, 2.0)) * (shape2 - 0.5) * 2.0 * (0.6 + 0.4 * grain);
  g += starLayer(q * 0.35, 90.0, 0.8, t, 9.0) * exp(-r * 2.6) * 0.8;
  return g * smoothstep(2.4, 1.2, r);
}

vec3 irregularShape(vec2 q, float t, float hue, float seed, float shape, float shape2){
  float stretch = 1.0 + 0.45 * shape2;
  float r = length(vec2(q.x / stretch, q.y * stretch));
  float n = fbm(q * 2.3 + seed);
  float body = exp(-pow(r / 0.45, 2.0) * 1.1) * smoothstep(0.2, 0.6, fbm(q * 1.6 - seed));
  vec3 g = mix(vec3(0.75, 0.78, 0.95), neb(hue), 0.3) * body * (0.3 + 0.8 * n);
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float ang = seed * 0.37 + fi * 2.39996;
    float cr = 0.1 + 0.5 * fract(seed * 0.0731 + fi * 0.618034);
    vec2 c = vec2(cr * cos(ang) * stretch, cr * sin(ang) / stretch);
    float size = 0.07 + 0.11 * fract(seed * 0.0533 + fi * 0.381966);
    float bright = 0.45 + 0.55 * fract(seed * 0.0917 + fi * 0.7548777);
    vec2 rel = (q - c) / size;
    float rag = fbm(rel * 1.7 + seed + fi * 3.1);
    float d = length(rel) * (0.65 + 0.7 * rag);                         // ragged edges, no two knots alike
    float knot = exp(-d * d * 1.5) * bright * (0.4 + 0.55 * shape);
    g += mix(neb(hue + 0.55), vec3(0.75, 0.85, 1.0), 0.45) * knot * smoothstep(0.25, 0.75, fbm(q * 9.0 + fi));
    g += neb(0.5) * pow(knot, 3.0) * 0.5;                              // hot pink cores of the star-forming regions
  }
  g += starLayer(q * 0.35, 90.0, 0.75, t, 9.0) * body * 1.2;
  g *= 1.0 - 0.5 * smoothstep(0.55, 0.8, fbm(q * 6.0 - seed));
  return g * smoothstep(1.6, 0.9, r);
}

vec3 ringShape(vec2 q, float t, float hue, float seed, float shape, float shape2){
  float R = 0.5 + 0.28 * shape;
  float o = shape2 > 0.6 ? (shape2 - 0.6) * 0.4 : 0.0;
  vec2 rq = q - vec2(o, 0.0);
  float rr = length(rq);
  float a = atan(rq.y, rq.x);
  float width = 0.035 + o * 0.25 * (1.0 + cos(a));
  float ring = exp(-pow((rr - R) / width, 2.0));
  float knots = fbm(vec2(a * 4.0, rr * 9.0) + seed);
  ring *= 0.35 + 0.65 * smoothstep(0.25, 0.7, fbm(vec2(a * 2.0, 1.0) + seed * 0.3));    // brighter and fainter arcs
  vec3 ringCol = mix(neb(hue), vec3(0.75, 0.82, 1.0), 0.3);
  vec3 g = ringCol * ring * (0.2 + 1.5 * knots * knots) * 1.4;
  g += neb(hue + 0.5) * ring * smoothstep(0.55, 0.8, knots) * 1.1;
  float r = length(q);
  g += vec3(1.0, 0.85, 0.6) * (exp(-r * 14.0) * 1.8 + exp(-r * 5.0) * 0.25);
  if (o > 0.0) g += ringCol * pow(0.5 + 0.5 * cos(10.0 * (atan(q.y, q.x) - seed)), 8.0) * smoothstep(0.1, 0.3, r) * smoothstep(R + o, R * 0.6, r) * 0.12 * smoothstep(0.35, 0.75, knots);
  g += ringCol * exp(-r * 3.0) * 0.06;
  g += starLayer(q * 0.35, 90.0, 0.75, t, 9.0) * ring * 1.5;
  return g * smoothstep(1.7, 1.1, r);
}

vec3 mergerShape(vec2 q, float t, float twist, float hue, float seed, float shape, float shape2){
  float ang = shape2 * 6.2831853;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 c1 = -0.24 * dir;
  vec2 c2 = 0.46 * dir;
  float m2 = 0.3 + 0.18 * shape;
  vec3 g = galaxyShapeP((q - c1) / 0.58, t, 2.0, twist * 0.8, hue, seed);
  g += galaxyShapeP(rot(ang + 1.2) * (q - c2) / m2, t, 2.0, twist * 0.8, hue + 0.35, seed + 17.0) * 0.85;
  vec3 tailCol = mix(neb(hue + 0.1), vec3(0.75, 0.8, 0.95), 0.4);
  float clumps = fbm(q * 6.0 + seed);
  for (int k = 0; k < 2; k++) {
    vec2 c = k == 0 ? c1 : c2;
    float start = k == 0 ? 0.29 : m2 * 0.5;
    float len = k == 0 ? 0.8 : 0.65;
    float a0 = k == 0 ? ang + 3.14159265 : ang;
    vec2 v = q - c;
    float rr = length(v);
    float s = (rr - start) / len;
    if (s > 0.0 && s < 1.0) {
      float d = mod(atan(v.y, v.x) - (a0 + 1.7 * s) + 3.14159265, 6.2831853) - 3.14159265;
      float w = 0.03 + 0.07 * s;
      g += tailCol * exp(-pow(rr * d / w, 2.0)) * pow(1.0 - s, 0.7) * smoothstep(0.0, 0.1, s) * (0.4 + 0.8 * clumps) * 1.5;
    }
  }
  vec2 seg = c2 - c1;
  float h = clamp(dot(q - c1, seg) / dot(seg, seg), 0.0, 1.0);
  g += tailCol * exp(-pow(length(q - c1 - seg * h) / 0.05, 2.0)) * 0.3 * (0.4 + clumps);
  return g;
}

// a disk galaxy of any type, face-on in its own plane. q in disk radii; the drawn quad reaches 1.7.
vec3 galaxyDisk(vec2 q, float t, vec4 par, vec4 par2){
  float type = par2.x;
  if (isType(type, 1.0)) return barredShape(q, t, par.y, par.z, par.w, par2.y, par2.z);
  if (isType(type, 3.0)) return lenticularShape(q, t, par.z, par.w, par2.y, par2.z);
  if (isType(type, 4.0)) return irregularShape(q, t, par.z, par.w, par2.y, par2.z);
  if (isType(type, 5.0)) return irregularShape(q / extentOf(par2), t, par.z, par.w, par2.y, par2.z) * 0.6;
  if (isType(type, 6.0)) return ringShape(q, t, par.z, par.w, par2.y, par2.z);
  if (isType(type, 7.0)) return mergerShape(q, t, par.y, par.z, par.w, par2.y, par2.z);
  if (isType(type, 2.0)) return vec3(0.0);
  return galaxyShapeP(q, t, par.x, par.y, par.z, par.w);
}

/*
 * The part of a galaxy that is drawn facing the camera. b is in disk radii along the apparent major
 * (x) and minor (y) axis; ratio is the apparent axis ratio. For ellipticals and dwarf spheroidals
 * that is the whole galaxy. For disk galaxies it is the thin bright streak they become when seen
 * edge-on (with a dust lane for the dusty types); edge says how edge-on that is.
 */
vec3 galaxyHalo(vec2 b, float t, vec4 par, vec4 par2, float ratio, float edge){
  float type = par2.x;
  float hue = par.z;
  if (isType(type, 2.0)) {
    float r = length(vec2(b.x, b.y / ratio));
    vec3 col = mix(vec3(1.0, 0.78, 0.58), vec3(1.0, 0.9, 0.8), smoothstep(0.0, 0.7, r));
    col = mix(col, neb(hue), 0.1);
    float light = exp(-sqrt(r) * 5.5) * (3.0 + 2.5 * par2.z) + exp(-r * 3.0) * 0.32;
    vec3 g = col * light + starLayer(b * 0.35, 120.0, 0.86, t, 4.0) * exp(-r * 2.2) * 0.7;
    return g * smoothstep(1.6, 0.85, r);
  }
  if (isSpheroid(par2)) {
    float r = length(vec2(b.x, b.y / ratio)) / extentOf(par2);
    vec3 g = mix(vec3(0.95, 0.85, 0.75), neb(hue), 0.15) * exp(-r * 2.6) * 0.32;
    g += starLayer(b * 0.35, 150.0, 0.6, t, 6.0) * exp(-r * 1.8) * 1.4;   // a swarm of single stars
    return g * smoothstep(1.5, 0.7, r);
  }
  if (edge <= 0.0) return vec3(0.0);
  float ex = extentOf(par2);
  float dusty = isType(type, 0.0) || isType(type, 1.0) || isType(type, 7.0) ? 1.0 : 0.0;
  float bulge = isType(type, 3.0) ? 1.0 : isType(type, 4.0) || isType(type, 5.0) ? 0.0 : 0.55;
  float thick = ratio * 0.5 + (isType(type, 4.0) || isType(type, 5.0) ? 0.06 : 0.015);
  vec3 diskCol = mix(vec3(0.95, 0.9, 0.95), neb(hue), 0.35);
  vec3 g = diskCol * exp(-abs(b.x) * 2.3 / ex) * exp(-pow(b.y / thick, 2.0)) * (0.8 + 0.4 * fbm(vec2(b.x * 6.0, b.y * 30.0) + par.w));
  g += vec3(1.0, 0.85, 0.62) * exp(-length(vec2(b.x, b.y * 1.25)) * 8.0) * bulge * 1.6;
  float lane = exp(-pow((b.y - thick * 0.12) / (thick * 0.28 + 0.004), 2.0)) * smoothstep(0.95, 0.15, abs(b.x));
  g *= 1.0 - dusty * 0.8 * lane * (0.6 + 0.4 * fbm(vec2(b.x * 9.0, 3.0) + par.w));
  return g * edge * smoothstep(1.6, 1.0, abs(b.x) / ex);
}

// galaxy seen from outside (rare: a planet in the halo or in a satellite galaxy)
vec3 spiralGalaxy(vec2 p, float t, float seed){
  vec2 gc = vec2(mix(-0.5, 0.5, h11(seed + 21.0)), mix(0.05, 0.22, h11(seed + 22.0)));
  float grot = h11(seed + 23.0) * 6.283 + t * 0.004;
  float tilt = mix(0.3, 0.8, h11(seed + 24.0));
  float gscale = mix(0.3, 0.55, h11(seed + 25.0));
  vec2 q = rot(grot) * (p - gc);
  q.y /= tilt;
  return galaxyShape(q / gscale, t, seed);
}

// small faint galaxy far away: an elliptical smudge with a hint of arms
vec3 farGalaxy(vec2 p, vec2 c, float s, float ang, float tilt, float seed){
  vec2 q = rot(ang) * (p - c);
  q.y /= tilt;
  q /= s;
  float r = length(q);
  float a = atan(q.y, q.x);
  float sp = pow(0.5 + 0.5 * cos(2.0 * (a - 3.0 * log(r + 0.05))), 2.0);
  vec3 g = vec3(1.0, 0.9, 0.78) * exp(-r * 7.0) + neb(h11(seed)) * sp * exp(-r * 2.6) * 0.45;
  return g * smoothstep(2.2, 0.8, r);
}

/*
 * Night sky from a planet inside a galaxy, like the Milky Way from Earth. The disk is a glowing band
 * with dust rifts, star clouds and nebulae, and the core bulge sits somewhere along it.
 * Distance to the core drives most of the look. Far out the band is thin and faint, closer in the
 * bulge covers half the sky, and very close the central black hole shows up (from a lensed point of
 * light up to a disk filling the sky).
 *
 * The type of the galaxy (g_gal2.x) changes the picture: inside an elliptical there is no band,
 * just a sky full of old stars glowing towards the core (and maybe a jet from its black hole); a
 * lenticular's band is smooth and dust-free; a bar stretches the bulge; an irregular galaxy is a
 * patchwork of star clouds and pink nebulae; dwarfs see their big host galaxy; from inside a ring
 * the band breaks where you look across the empty gap at the core; in a collision a second galaxy
 * crosses the sky.
 */
vec3 outsideView(vec2 p, float t, float seed){
  vec2 gc = vec2(mix(-0.5, 0.5, h11(seed + 21.0)), mix(0.05, 0.22, h11(seed + 22.0)));
  float grot = h11(seed + 23.0) * 6.283 + t * 0.004;
  float tilt = mix(0.3, 0.8, h11(seed + 24.0));
  float gscale = mix(0.3, 0.55, h11(seed + 25.0));
  vec2 q = rot(grot) * (p - gc) / gscale;
  if (isSpheroid(g_gal2)) {
    float q2 = isType(g_gal2.x, 2.0) ? 1.0 - floor(g_gal2.y * 7.0 + 0.5) / 10.0 : 0.75;
    return galaxyHalo(q, t, g_gal, g_gal2, mix(q2, 1.0, tilt * 0.5), 1.0);
  }
  q.y /= tilt;
  return galaxyDisk(q, t, g_gal, g_gal2);
}

vec3 sky(vec2 p, float t, float seed){
  float type = g_gal2.x;
  bool spiralType = isType(type, 0.0);
  bool ball = isSpheroid(g_gal2);                                // inside an elliptical or a dwarf spheroidal
  bool patchy = isType(type, 4.0) || (isType(type, 5.0) && !ball);
  bool dwarf = isType(type, 5.0);
  bool smooth = isType(type, 3.0);
  bool barred = isType(type, 1.0);
  bool ringType = isType(type, 6.0);
  bool merger = isType(type, 7.0);

  float d = pow(h11(seed + 1.0), 0.85);                         // 0 = at the core, 1 = outer rim
  if (ringType) d = 0.55 + 0.4 * d;                              // the ring is far out, the core is across the gap
  float c = 1.0 - d;
  bool outside = h11(seed + 30.0) < 0.14 && !dwarf;              // rare: we're outside the galaxy
  float ba = (h11(seed + 2.0) - 0.5) * 1.3 + t * 0.003;        // band angle, slowly turning
  float curv = (h11(seed + 3.0) - 0.5) * 0.45;
  float off = mix(-0.02, 0.26, h11(seed + 4.0));
  float u0 = mix(-0.7, 0.7, h11(seed + 5.0));                  // where along the band the core is
  vec2 cs = rot(-ba) * vec2(u0, off + curv * u0 * u0);          // core position on screen
  bool hole = !outside && d < 0.36 && !patchy && !ringType;
  float closeness = smoothstep(0.36, 0.0, d);
  float rb = hole ? mix(0.0035, 0.2, pow(closeness, 2.4)) : 0.0;

  // gravitational lensing: bend everything behind the black hole around it
  vec2 dd = p - cs;
  float dl = length(dd);
  vec2 sp = p;
  if (hole) sp = p - normalize(dd) * rb * rb * 1.8 / max(dl, rb * 0.5);

  float starGain = outside ? 0.4 : 0.8 + 0.5 * c;
  if (ball) starGain = dwarf ? 0.45 : 1.3 + 0.6 * c;             // an elliptical's sky is full of stars
  vec3 col = stars(sp + vec2(t * 0.0015, 0.0), t) * starGain;
  if (ball && !dwarf) {
    col += starLayer(sp + vec2(t * 0.0015, 0.0), 210.0, 0.55, t, 11.0) * (0.6 + 0.8 * c);
    col += starLayer(sp + vec2(t * 0.0015, 0.0), 120.0, 0.8, t, 12.0) * 0.5;
  }

  vec3 bandCol = mix(vec3(0.86, 0.84, 0.92), neb(h11(seed + 6.0)), 0.35);
  if (smooth || ball) bandCol = mix(vec3(1.0, 0.86, 0.68), bandCol, 0.3);   // old, warm light

  if (ball && dwarf) {
    // ---- inside a dwarf spheroidal: a thin swarm of stars and a faint haze
    col += bandCol * exp(-length(sp - cs) / 0.6) * 0.07;
  } else if (ball) {
    // ---- inside an elliptical: no disk, a smooth glow that brightens towards the core
    float r = length(sp - cs);
    col += bandCol * (exp(-r / (0.22 + 0.6 * c)) * mix(0.18, 0.85, c) + 0.05 + 0.05 * c) * (0.85 + 0.3 * fbm(sp * 1.5 + seed));
    col += vec3(1.0, 0.82, 0.6) * exp(-r / (0.05 + 0.12 * c)) * mix(0.15, 1.0, c * c);
    for (int i = 0; i < 6; i++) {                                // globular clusters: fuzzy balls of stars
      float fi = float(i);
      vec2 gp = vec2(mix(-0.85, 0.85, h11(seed + 100.0 + fi)), mix(-0.4, 0.45, h11(seed + 110.0 + fi)));
      float gs = mix(0.004, 0.011, h11(seed + 120.0 + fi));
      col += vec3(1.0, 0.9, 0.78) * exp(-length(sp - gp) / gs) * 0.5;
    }
    if (hole) {
      // relativistic jet from the black hole, straight out of it
      vec2 jd = rot(-ba) * normalize(vec2(0.35, 1.0));
      float along = dot(dd, jd);
      float across = abs(dd.x * jd.y - dd.y * jd.x);
      float knots = 0.55 + 0.45 * sin(along * 60.0 - t * 1.5) * fbm(vec2(along * 20.0, seed));
      float ahead = max(along, 0.0);
      col += vec3(0.6, 0.78, 1.0) * exp(-across / (0.002 + ahead * 0.025)) * smoothstep(0.0, 0.02, along) * exp(-ahead * 2.2) * knots * mix(0.4, 1.6, closeness);
    }
  } else if (patchy) {
    // ---- irregular galaxy: no tidy band, star clouds and glowing nebulae all over
    vec2 cp = rot(ba * 0.6) * (sp - cs * 0.3);
    float region = exp(-dot(cp * vec2(0.9, 1.6), cp * vec2(0.9, 1.6)) * 1.4) * (dwarf ? 0.5 : 1.0);
    float clouds = fbm(sp * 2.4 + seed);
    float grain = fbm(sp * 8.0 - seed);
    col += bandCol * smoothstep(0.35, 0.8, clouds) * (0.25 + 0.9 * grain) * region * 0.7;
    col += neb(h11(seed + 7.0) + 0.5) * smoothstep(0.62, 0.85, fbm(sp * 4.5 + seed * 1.3)) * region * 0.6;
    col += neb(h11(seed + 8.0)) * smoothstep(0.6, 0.85, fbm(sp * 3.0 - seed * 0.7)) * region * 0.4;
    col += starLayer(sp, 200.0, 0.6, t, 5.0) * smoothstep(0.4, 0.8, clouds) * region * 1.2;
    col *= 1.0 - 0.6 * smoothstep(0.58, 0.82, fbm(sp * 5.5 + seed * 2.1)) * region;
  } else {
    // ---- galactic band
    vec2 bp = rot(ba) * sp;
    float u = bp.x;
    float v = bp.y - off - curv * u * u;
    float w = mix(0.055, 0.15, c) * (outside ? 0.6 : 1.0);
    // from inside a ring the band thins out where we look across the gap towards the core
    float gap = ringType ? smoothstep(0.05, 0.5, abs(u - u0)) : 1.0;
    w *= mix(0.45, 1.0, gap);
    float prof = exp(-pow(v / w, 2.0));
    float glow = exp(-pow(v / (w * 2.8), 2.0));
    float clouds = fbm(vec2(u * 2.2, v * 5.0) + seed);
    float grain = fbm(vec2(u * 9.0, v * 14.0) - seed);
    if (smooth) { clouds = mix(clouds, 0.55, 0.6); grain = mix(grain, 0.6, 0.6); }
    float bw = mix(0.1, 0.8, c * c);                               // bulge size grows near the core
    if (smooth) bw *= 1.35;
    float bu = barred ? bw * 2.0 : bw;                             // a bar stretches the bulge along the band
    float bv = barred ? bw * 0.3 : bw * 0.5;
    float bulge = exp(-(pow((u - u0) / bu, 2.0) + pow(v / bv, 2.0)));
    if (ringType) {                                                // the compact core, seen across the gap
      float rc = length(vec2(u - u0, v * 1.3));
      bulge = exp(-rc / 0.03) * 1.4 + exp(-rc / 0.11) * 0.35;
    }
    float lane = v - w * 0.18 * sin(u * 2.3 + seed);
    float rift = smoothstep(0.42, 0.7, fbm(vec2(u * 3.0, v * 9.0) + seed * 1.7)) * exp(-pow(lane / (w * 0.55), 2.0));
    rift = max(rift, exp(-pow(lane / (w * 0.3), 2.0)) * smoothstep(0.45, 0.7, fbm(vec2(u * 4.0, v * 6.0) + seed * 2.3)) * 0.85);
    if (smooth) rift *= 0.15;                                      // lenticulars have hardly any dust
    float bright = mix(0.32, 0.85, c) * (outside ? 0.3 : 1.0) * mix(0.35, 1.0, gap);
    vec3 g = bandCol * (prof * (0.3 + 1.5 * clouds * grain) + glow * 0.12) * bright;
    vec3 bulgeCol = mix(vec3(1.0, 0.8, 0.56), bandCol, 0.25 + 0.3 * clouds);
    if (!outside) g += bulgeCol * bulge * (0.25 + 1.3 * grain * clouds) * mix(0.35, 1.25, c) * mix(1.0, 0.7, closeness);
    if (ringType && !outside) g += vec3(1.0, 0.85, 0.62) * bulge * 0.8;
    float nebulae = smooth ? 0.0 : merger ? 1.8 : 1.0;             // collisions set off a lot of star formation
    g += neb(h11(seed + 7.0)) * smoothstep(0.6, 0.82, fbm(sp * 7.0 + seed)) * prof * 0.55 * nebulae;
    g += neb(h11(seed + 8.0) + 0.5) * smoothstep(0.66, 0.86, fbm(sp * 5.0 - seed)) * prof * 0.35 * nebulae;
    g += starLayer(sp, 230.0, 0.5, t, 5.0) * prof * (0.8 + c) * (smooth ? 0.6 : 1.0);
    // the ring is a chain of young blue clusters and pink nebulae
    if (ringType) g += mix(neb(h11(seed + 9.0)), vec3(0.7, 0.85, 1.0), 0.4) * smoothstep(0.55, 0.85, fbm(vec2(u * 6.0, v * 10.0) + seed * 3.1)) * prof * gap * 0.9;
    g *= 1.0 - rift * 0.88;
    col += g;

    if (merger) {
      // the other galaxy of the collision: a second, broader band at a steep angle, with its core
      float ba2 = ba + (h11(seed + 144.0) < 0.5 ? -1.0 : 1.0) * mix(0.45, 1.1, h11(seed + 140.0));
      vec2 bp2 = rot(ba2) * sp;
      float u2 = bp2.x;
      float v2 = bp2.y - mix(-0.15, 0.2, h11(seed + 141.0)) - 0.25 * u2 * u2;
      float w2 = 0.11;
      float prof2 = exp(-pow(v2 / w2, 2.0));
      float c2 = fbm(vec2(u2 * 2.2, v2 * 6.0) + seed * 1.9);
      vec3 col2 = mix(vec3(0.85, 0.85, 0.95), neb(h11(seed + 142.0)), 0.4);
      vec3 g2 = col2 * prof2 * (0.15 + 1.3 * c2 * fbm(vec2(u2 * 9.0, v2 * 14.0))) * 0.5;
      float k2 = mix(-0.6, 0.6, h11(seed + 143.0));
      g2 += vec3(1.0, 0.82, 0.6) * exp(-(pow((u2 - k2) / 0.16, 2.0) + pow(v2 / 0.08, 2.0))) * (0.3 + 0.6 * c2);
      g2 += starLayer(sp, 230.0, 0.55, t, 15.0) * prof2 * 0.8;
      g2 *= 1.0 - 0.8 * smoothstep(0.45, 0.7, fbm(vec2(u2 * 3.5, v2 * 9.0) - seed)) * exp(-pow((v2 - w2 * 0.15) / (w2 * 0.45), 2.0));
      // a tidal streamer arching across the sky
      float arc = abs(length(sp - vec2(k2, -0.9)) - 1.05);
      g2 += col2 * exp(-pow(arc / 0.03, 2.0)) * smoothstep(0.3, 0.75, fbm(sp * 4.0 + seed)) * 0.3;
      col += g2;
    }
  }

  // ---- a few distant galaxies
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    if (h11(seed + 40.0 + fi) < 0.45) continue;
    vec2 gp = vec2(mix(-0.8, 0.8, h11(seed + 50.0 + fi)), mix(-0.05, 0.45, h11(seed + 60.0 + fi)));
    col += farGalaxy(sp, gp, mix(0.008, 0.028, h11(seed + 70.0 + fi)), h11(seed + 80.0 + fi) * 6.3, mix(0.25, 0.9, h11(seed + 90.0 + fi)), seed + fi) * 0.55;
  }
  if (outside) col += spiralType ? spiralGalaxy(sp, t, seed) : outsideView(sp, t, seed);
  // dwarfs are satellites: their big host galaxy hangs in the sky
  if (dwarf) col += spiralGalaxy(sp, t, seed + 300.0) * 1.1;

  // ---- black hole in the core, accretion disk lies in the galactic plane
  if (hole) {
    float shadow = smoothstep(rb * 0.94, rb * 1.06, dl);
    vec2 dq = rot(ba) * dd;
    float doppler = 1.0 + 0.55 * clamp(-dq.x / (rb * 3.0), -1.0, 1.0);
    float thick = rb * 0.16 + 0.0015;
    float flow = 0.75 + 0.25 * fbm(vec2(dq.x / rb * 3.0 - t * 0.6, dq.y / rb * 20.0));
    float adisk = exp(-pow(dq.y / thick, 2.0)) * smoothstep(rb * 3.6, rb * 1.1, abs(dq.x)) * flow;
    float yy = dq.y / max(dl, 1e-4);
    float halo = exp(-pow((dl - rb * 1.32) / (rb * 0.24 + 0.001), 2.0));
    float upper = halo * smoothstep(-0.35, 0.5, yy) * 1.6;
    float lower = exp(-pow((dl - rb * 1.22) / (rb * 0.12 + 0.001), 2.0)) * smoothstep(0.2, -0.7, yy) * 0.55;
    float ring = exp(-pow((dl - rb * 1.06) / (rb * 0.045 + 0.0008), 2.0));
    vec3 hot = vec3(1.0, 0.80, 0.55);
    vec3 white = vec3(1.0, 0.95, 0.88);
    vec3 light = hot * (upper * 1.3 + lower) * doppler + white * ring * 1.5 + mix(hot, white, adisk) * adisk * 2.2 * doppler;
    light += hot * exp(-dl / (rb * 2.2 + 0.004)) * mix(0.5, 0.18, closeness) * shadow;   // from far away it's just a bright point
    col = col * shadow + light;
  }
  return col;
}

// view from the planet's surface: sky over a dark horizon with two mountain ranges and a thin
// atmosphere glow. drop > 0 lowers the horizon (used for take-off and landing).
// planetGround draws the ground over a sky computed before (sky is by far the biggest function here).
vec3 planetGround(vec3 col, vec2 p, float seed, float drop){
  vec2 pc = vec2(0.0, -3.42 - drop);
  vec3 atmo = neb(h11(seed + 12.0)) * 0.9;
  float ground = length(p - pc) - 3.0;
  float rough = mix(0.4, 1.4, h11(seed + 13.0));              // flat plains up to jagged peaks
  float farR = ground - rough * (0.035 * ridge(p.x * 3.0 + seed) + 0.018 * ridge(p.x * 9.0 - seed)) - 0.006;
  float nearR = ground - rough * (0.028 * ridge(p.x * 1.7 - seed * 1.3) * ridge(p.x * 4.3 + 3.0) + 0.008 * noise(vec2(p.x * 30.0, seed)));
  float glow = exp(-max(farR, 0.0) * 26.0) * step(0.0, farR);
  col += atmo * glow * 0.32;
  col = mix(col, atmo * 0.07 + vec3(0.01, 0.008, 0.02), smoothstep(0.002, -0.002, farR));
  col = mix(col, vec3(0.004, 0.003, 0.009), smoothstep(0.002, -0.002, nearR));
  return col;
}
vec3 planetView(vec2 p, float t, float seed, float drop){ return planetGround(sky(p, t, seed), p, seed, drop); }

vec3 finish(vec3 col, vec2 p){
  col = 1.0 - exp(-col * 1.25);                               // soft tone mapping
  return col * (0.75 + 0.25 * smoothstep(1.1, 0.2, length(p))); // vignette
}
`

/** Compiles `frag` into a full-screen quad program and binds it. Returns null if linking fails. */
export function quadProgram(gl: WebGLRenderingContext, frag: string): WebGLProgram | null {
  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    return shader
  }
  const program = gl.createProgram()!
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, frag))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('space shader:', gl.getProgramInfoLog(program))
    return null
  }
  gl.useProgram(program)
  // two triangles covering the whole viewport
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const posAttrib = gl.getAttribLocation(program, 'p')
  gl.enableVertexAttribArray(posAttrib)
  gl.vertexAttribPointer(posAttrib, 2, gl.FLOAT, false, 0, 0)
  return program
}

export { cosmicSeed } from '@shared/universe'

/**
 * The galaxy of a place as the two uniform vectors the sky shaders read into g_gal and g_gal2:
 * (arms, twist, hue, seed) and (type, shape, shape2, spin).
 */
export function galaxyUniforms(seed: number): [Float32Array, Float32Array] {
  const galaxy = galaxyOf(seed)
  return [
    new Float32Array([galaxy.arms, galaxy.twist, galaxy.hue, galaxy.seed]),
    new Float32Array([typeCode(galaxy.type), galaxy.shape, galaxy.shape2, galaxy.spin])
  ]
}
