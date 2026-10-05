import { useEffect, useRef } from 'react'
import type { Settings } from '@shared/types'
import { useIdleRef } from '@/lib/useIdle'

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

/*
 * "Standing on a planet at night, looking up into the galaxy you live in."
 *
 * Every seed is a different planet somewhere in a different galaxy: the angle and arc of the
 * galactic band, its colours, dust rifts and nebulae, how far the planet is from the galactic
 * core (a thin faint band … a core filling half the sky … the supermassive black hole itself),
 * far-away galaxies, and the planet's mountains and atmosphere. The sky turns very slowly.
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
uniform float u_trip;   // seconds inside the wormhole
uniform float u_tseed;  // which voyage (order of the scenes)

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

// A galaxy seen from far outside it (rare: a planet in the galactic halo or a satellite galaxy).
vec3 spiralGalaxy(vec2 p, float t, float seed){
  vec2 gc = vec2(mix(-0.5, 0.5, h11(seed + 21.0)), mix(0.05, 0.22, h11(seed + 22.0)));
  float grot = h11(seed + 23.0) * 6.283 + t * 0.004;
  float tilt = mix(0.3, 0.8, h11(seed + 24.0));
  float gscale = mix(0.3, 0.55, h11(seed + 25.0));
  float arms = floor(mix(2.0, 4.99, h11(seed + 26.0)));
  float twist = mix(2.4, 5.2, h11(seed + 27.0));
  vec3 armCol = neb(h11(seed + 28.0));
  vec3 armIn = neb(h11(seed + 28.0) + 0.3);
  vec2 q = rot(grot) * (p - gc);
  q.y /= tilt;
  q /= gscale;
  float r = length(q);
  float a = atan(q.y, q.x);
  float wob = (fbm(q * 1.4 + seed * 0.7) - 0.5) * 1.6;
  float spiral = pow(0.5 + 0.5 * cos(arms * (a - twist * log(r + 0.06)) + wob - t * 0.01), 2.6);
  float disk = exp(-r * 2.1);
  float clumps = fbm(q * 3.4 + seed);
  float dust = smoothstep(0.42, 0.78, fbm(q * 7.0 - seed * 1.3)) * spiral * exp(-r * 1.2);
  vec3 g = mix(armIn, armCol, smoothstep(0.2, 1.1, r)) * spiral * disk * (0.45 + clumps) * 1.3;
  g += vec3(1.0, 0.86, 0.62) * (exp(-r * 8.0) * 1.6 + exp(-r * 2.8) * 0.25);
  g += starLayer(q * 0.35, 90.0, 0.7, t, 9.0) * spiral * disk * 1.5;
  g *= 1.0 - dust * 0.75;
  return g * smoothstep(2.8, 1.3, r);
}

// A small, faint galaxy far away: an elliptical smudge with a hint of arms.
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
 * The night sky of a planet *inside* a galaxy – like the Milky Way seen from Earth: the galactic
 * disk is a glowing band across the sky with dark dust rifts, star clouds and pink/teal nebulae,
 * and somewhere along it the bulge of the galactic core. How close the planet is to the core
 * decides everything: far out the band is thin and faint; close in the bulge swells over half the
 * sky – and very close the supermassive black hole becomes visible, from a lensed point of light
 * up to a Gargantua filling the sky.
 */
vec3 sky(vec2 p, float t, float seed){
  float d = pow(h11(seed + 1.0), 0.85);                         // 0 = at the core, 1 = outer rim
  float c = 1.0 - d;
  bool outside = h11(seed + 30.0) < 0.14;                       // rare: a view from outside
  float ba = (h11(seed + 2.0) - 0.5) * 1.3 + t * 0.003;        // band angle, slowly turning
  float curv = (h11(seed + 3.0) - 0.5) * 0.45;
  float off = mix(-0.02, 0.26, h11(seed + 4.0));
  float u0 = mix(-0.7, 0.7, h11(seed + 5.0));                  // where along the band the core is
  vec2 cs = rot(-ba) * vec2(u0, off + curv * u0 * u0);          // the core on screen
  bool hole = !outside && d < 0.36;
  float closeness = smoothstep(0.36, 0.0, d);
  float rb = hole ? mix(0.0035, 0.2, pow(closeness, 2.4)) : 0.0;

  // gravitational lensing: everything behind the black hole is bent around it
  vec2 dd = p - cs;
  float dl = length(dd);
  vec2 sp = p;
  if (hole) sp = p - normalize(dd) * rb * rb * 1.8 / max(dl, rb * 0.5);

  vec3 col = stars(sp + vec2(t * 0.0015, 0.0), t) * (outside ? 0.4 : 0.8 + 0.5 * c);

  // ---- the galactic band
  vec2 bp = rot(ba) * sp;
  float u = bp.x;
  float v = bp.y - off - curv * u * u;
  float w = mix(0.055, 0.15, c) * (outside ? 0.6 : 1.0);
  float prof = exp(-pow(v / w, 2.0));
  float glow = exp(-pow(v / (w * 2.8), 2.0));
  float clouds = fbm(vec2(u * 2.2, v * 5.0) + seed);
  float grain = fbm(vec2(u * 9.0, v * 14.0) - seed);
  float bw = mix(0.1, 0.8, c * c);                               // bulge size grows near the core
  float bulge = exp(-(pow((u - u0) / bw, 2.0) + pow(v / (bw * 0.5), 2.0)));
  float lane = v - w * 0.18 * sin(u * 2.3 + seed);
  float rift = smoothstep(0.42, 0.7, fbm(vec2(u * 3.0, v * 9.0) + seed * 1.7)) * exp(-pow(lane / (w * 0.55), 2.0));
  rift = max(rift, exp(-pow(lane / (w * 0.3), 2.0)) * smoothstep(0.45, 0.7, fbm(vec2(u * 4.0, v * 6.0) + seed * 2.3)) * 0.85);
  vec3 bandCol = mix(vec3(0.86, 0.84, 0.92), neb(h11(seed + 6.0)), 0.35);
  float bright = mix(0.32, 0.85, c) * (outside ? 0.3 : 1.0);
  vec3 g = bandCol * (prof * (0.3 + 1.5 * clouds * grain) + glow * 0.12) * bright;
  vec3 bulgeCol = mix(vec3(1.0, 0.8, 0.56), bandCol, 0.25 + 0.3 * clouds);
  if (!outside) g += bulgeCol * bulge * (0.25 + 1.3 * grain * clouds) * mix(0.35, 1.25, c) * mix(1.0, 0.7, closeness);
  g += neb(h11(seed + 7.0)) * smoothstep(0.6, 0.82, fbm(sp * 7.0 + seed)) * prof * 0.55;          // nebulae
  g += neb(h11(seed + 8.0) + 0.5) * smoothstep(0.66, 0.86, fbm(sp * 5.0 - seed)) * prof * 0.35;
  g += starLayer(sp, 230.0, 0.5, t, 5.0) * prof * (0.8 + c);                                        // star clouds
  g *= 1.0 - rift * 0.88;
  col += g;

  // ---- a few galaxies far away
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    if (h11(seed + 40.0 + fi) < 0.45) continue;
    vec2 gp = vec2(mix(-0.8, 0.8, h11(seed + 50.0 + fi)), mix(-0.05, 0.45, h11(seed + 60.0 + fi)));
    col += farGalaxy(sp, gp, mix(0.008, 0.028, h11(seed + 70.0 + fi)), h11(seed + 80.0 + fi) * 6.3, mix(0.25, 0.9, h11(seed + 90.0 + fi)), seed + fi) * 0.55;
  }
  if (outside) col += spiralGalaxy(sp, t, seed);

  // ---- the black hole in the core, its accretion disk in the galactic plane
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
    light += hot * exp(-dl / (rb * 2.2 + 0.004)) * mix(0.5, 0.18, closeness) * shadow;   // far away: a bright point
    col = col * shadow + light;
  }
  return col;
}

// ---------------------------------------------------------------------------------------------
// The voyage through the wormhole: four scenes that melt into each other every ten seconds, in an
// order that differs per trip – so a long loading screen never looks the same for long.
// ---------------------------------------------------------------------------------------------

// 1 · silk: a twisting tube of smeared, flowing colour with streaks of starlight
vec3 silkTunnel(vec2 p, float t, float w, float k){
  float r = length(p);
  float z = 0.22 / (r + 0.02);
  float ang = atan(p.y, p.x) + z * 0.5 * k + t * 0.35;
  float u = ang / 6.28318;
  float v = z - t * 4.5;
  vec2 tc = vec2(cos(ang), sin(ang)) * 1.6 + vec2(v * 0.32, v * 0.21);   // seamless around the tube
  vec2 wq = vec2(fbm(tc + t * 0.25), fbm(tc + 5.2 - t * 0.2));
  float flowv = fbm(tc * 1.3 + wq * 2.4);
  float silk = pow(fbm(tc * 2.6 + wq * 3.2 + 1.7), 2.0);
  vec3 wall = neb(flowv * 1.5 + u + w * 0.8) * smoothstep(0.3, 0.85, flowv) * 1.5;
  wall += neb(flowv + 0.5 + w) * silk * 1.6;
  wall *= smoothstep(0.0, 0.35, r) * (0.6 + 0.4 * sin(v * 0.8 + flowv * 6.0));
  float lane = floor(u * 160.0);
  float rnd = h11(lane + 3.0);
  float sv = fract((z - t * 8.0 * (0.4 + rnd)) * 0.3 + rnd * 11.0);
  float streak = smoothstep(0.0, 0.1, sv) * smoothstep(0.6, 0.1, sv) * step(0.6, h11(lane + 17.0));
  float across = fract(u * 160.0);
  streak *= smoothstep(0.0, 0.45, across) * smoothstep(1.0, 0.55, across);
  return wall + mix(neb(rnd * 3.0), vec3(1.0, 0.95, 0.9), 0.55) * streak * smoothstep(0.03, 0.3, r) * 0.6;
}

// 2 · nebula: flying through veils of glowing gas that rush past the camera
vec3 nebulaFlight(vec2 p, float t){
  vec3 c = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float phase = t * 0.11 + fi / 5.0;
    float z = fract(phase);                                  // 0 far away → 1 passing us
    float sc = mix(5.0, 0.3, z * z);
    vec2 q = rot(fi * 1.7 + t * 0.04) * p * sc + vec2(fi * 7.3, fi * 3.1) + floor(phase) * 13.0;
    float d = fbm(q + fbm(q * 1.7 + fi) * 1.6);
    float a = smoothstep(0.0, 0.3, z) * smoothstep(1.0, 0.7, z);
    c += neb(fi * 0.27 + d * 0.9 + t * 0.015) * pow(d, 3.0) * 2.0 * a;
  }
  float r = length(p);
  float an = atan(p.y, p.x) / 6.28318;
  float lane = floor(an * 120.0);
  float s = fract(0.28 / (r + 0.01) * 0.3 - t * (0.8 + h11(lane) * 1.2) + h11(lane + 2.0) * 9.0);
  float st = smoothstep(0.0, 0.04, s) * smoothstep(0.25, 0.04, s) * step(0.82, h11(lane + 7.0));
  st *= smoothstep(0.0, 0.4, fract(an * 120.0)) * smoothstep(1.0, 0.6, fract(an * 120.0));
  return c + vec3(0.9, 0.94, 1.0) * st * smoothstep(0.05, 0.4, r) * 0.7;
}

// 3 · kaleidoscope: mirrored, endlessly zooming fractal light – the mushroom trip in space
vec3 kaleido(vec2 p, float t){
  float r = length(p);
  float seg = 6.28318 / 6.0;
  float a = abs(mod(atan(p.y, p.x) + t * 0.08, seg) - seg * 0.5);
  vec2 q = vec2(a * 1.7, log(r + 0.002) * 1.3 - t * 0.55);
  vec2 wq = vec2(fbm(q * 2.0 + t * 0.08), fbm(q * 2.0 + 3.1 - t * 0.05));
  float f = fbm(q * 3.0 + wq * 2.6);
  vec3 c = neb(f * 1.8 + r * 0.6 - t * 0.04) * smoothstep(0.35, 0.9, f) * 1.6;
  c += neb(f + 0.5) * pow(fbm(q * 6.0 - wq * 3.0), 3.0) * 1.8;
  return c * smoothstep(0.0, 0.25, r);
}

// 4 · star stream: hyperspace – three layers of star trails in different speeds and colours,
// with faint gas swirling between them
vec3 starStream(vec2 p, float t){
  vec3 c = vec3(0.0);
  float r = length(p);
  float an = atan(p.y, p.x) / 6.28318 + 0.5;
  float z = 0.3 / (r + 0.01);
  for (int l = 0; l < 3; l++) {
    float fl = float(l);
    float lanes = 80.0 + fl * 70.0;
    float lane = floor(an * lanes);
    float rnd = h11(lane + fl * 31.0);
    float across = fract(an * lanes);
    float s = fract(z * 0.25 - t * (1.0 + rnd * 1.6) + rnd * 7.0);
    float st = smoothstep(0.0, 0.05, s) * smoothstep(0.45, 0.05, s) * step(0.68, h11(lane + fl * 13.0 + 5.0));
    st *= smoothstep(0.0, 0.4, across) * smoothstep(1.0, 0.6, across);
    c += mix(neb(rnd * 2.0 + fl * 0.3), vec3(1.0), 0.45) * st * (0.55 + fl * 0.25);
  }
  vec2 tc = vec2(cos(an * 6.28318), sin(an * 6.28318)) * 1.3 + vec2(log(r + 0.01) * 1.5 - t * 0.9, 0.0);
  c += neb(an * 2.0 + t * 0.04) * pow(fbm(tc * 2.0 + fbm(tc * 3.0)), 2.0) * 0.9;
  return c * smoothstep(0.02, 0.25, r);
}

vec3 voyageScene(float id, vec2 p, float t, float w, float k){
  if (id < 0.5) return silkTunnel(p, t, w, k);
  if (id < 1.5) return nebulaFlight(p, t);
  if (id < 2.5) return kaleido(p, t);
  return starStream(p, t);
}

vec3 voyage(vec2 p, float t, float w, float k){
  float L = 10.0;
  float idx = floor(u_trip / L);
  float off = floor(h11(u_tseed) * 4.0);
  float step2 = h11(u_tseed + 1.0) < 0.5 ? 1.0 : 3.0;         // forwards or backwards through them
  float a = mod(off + idx * step2, 4.0);
  float b = mod(off + (idx + 1.0) * step2, 4.0);
  float bl = smoothstep(L - 3.0, L, mod(u_trip, L));
  vec3 c = voyageScene(a, p, t, w, k);
  if (bl > 0.001) c = mix(c, voyageScene(b, p, t, w, k), bl);
  float r = length(p);
  c += vec3(0.75, 0.85, 1.0) * exp(-r * 8.0) * (0.3 + 1.1 * w);   // the light at the end
  float ringR = 0.04 + 0.7 * w * w;                               // lensing ring sweeping outward
  c += vec3(0.8, 0.9, 1.0) * exp(-pow((r - ringR) / 0.012, 2.0)) * (1.0 - w) * 0.6 * (1.0 - smoothstep(3.0, 5.0, u_trip));
  return c;
}

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;     // y in [-0.5, 0.5]
  float t = u_time;
  float w = u_warp;
  float k = smoothstep(0.0, 0.2, w) * smoothstep(1.0, 0.8, w); // dive in, travel, come out

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
    col = mix(col, col * 0.15 + voyage(p, t, w, k), k);
    col += vec3(0.80, 0.88, 1.0) * exp(-pow((w - 0.5) / 0.08, 2.0)) * 0.3;  // soft glow at the crossing
  }



  col = 1.0 - exp(-col * 1.25);                           // soft tone mapping
  col *= 0.75 + 0.25 * smoothstep(1.1, 0.2, length(p));   // vignette
  gl_FragColor = vec4(col, 1.0);
}`

const FPS = { animated: 24, calm: 10, static: 0 } as const
export const JUMP_MS = 8000
/** warp while holding inside the tunnel, and how long coming out of it takes */
const HOLD = 0.32
const EXIT_MS = 3800

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
  jumpOnMount = false,
  from,
  travel = false,
  arrive = false,
  animateChanges = true,
  className = 'pointer-events-none fixed inset-0 -z-10 h-full w-full'
}: {
  seed: number
  mode: Settings['ui']['background']
  inGame: boolean
  /** start with the wormhole jump (from `from`, or a random galaxy) */
  jumpOnMount?: boolean
  from?: number
  /** stay inside the wormhole (loading screen) until `arrive` – then come out in the `seed` galaxy */
  travel?: boolean
  arrive?: boolean
  /** jump when `seed` changes – off when a full-window journey overlay does the jump instead */
  animateChanges?: boolean
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const effective: keyof typeof FPS = reduced ? 'static' : inGame && mode === 'animated' ? 'calm' : mode
  const idle = useIdleRef(inGame)
  const target = useRef(seed)
  const jump = useRef<{ from: number; to: number; start: number } | null>(null)
  const shown = useRef(jumpOnMount ? (from ?? seed + 13.7) : seed)
  const voyage = useRef<{ start: number; exitAt: number | null } | null>(travel ? { start: performance.now(), exitAt: null } : null)
  useEffect(() => {
    if (travel && !voyage.current) voyage.current = { start: performance.now(), exitAt: null }
    if (!travel) voyage.current = null
    if (travel && arrive && voyage.current && voyage.current.exitAt === null) voyage.current.exitAt = performance.now()
  }, [travel, arrive])

  // a new seed → jump (unless everything is still)
  useEffect(() => {
    if (seed === target.current && !jumpOnMount) return
    target.current = seed
    if (effective === 'static' || (!animateChanges && !jumpOnMount)) shown.current = seed
    else jump.current = { from: shown.current, to: seed, start: performance.now() }
  }, [seed, effective, jumpOnMount, animateChanges])

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
    const uTrip = gl.getUniformLocation(prog, 'u_trip')
    const uTseed = gl.getUniformLocation(prog, 'u_tseed')

    const SCALE = Math.min(1, (window.devicePixelRatio || 1) * 0.5)
    const resize = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    const draw = (now: number) => {
      let warp = 0
      let trip = 0
      let tseed = shown.current
      const j = jump.current
      const v = voyage.current
      if (v) {
        // loading screen: inside the tunnel as long as the game loads, then out into the galaxy
        trip = (now - v.start) / 1000
        tseed = target.current
        shown.current = target.current
        if (v.exitAt === null) warp = HOLD
        else {
          const x = (now - v.exitAt) / EXIT_MS
          warp = x >= 1 ? 0 : HOLD + (1 - HOLD) * x
        }
      } else if (j) {
        const x = Math.min(1, (now - j.start) / JUMP_MS)
        warp = x
        trip = (now - j.start) / 1000
        tseed = j.to
        shown.current = x < 0.5 ? j.from : j.to
        if (x >= 1) jump.current = null
      }
      gl.uniform1f(uTrip, trip)
      gl.uniform1f(uTseed, tseed)
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
      const moving = !!jump.current || !!voyage.current
      if (!moving && now - last < 1000 / (fps || 1) - 2) return
      if (!moving && (!fps || idle.current) && last) return
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

  return <canvas key={effective} ref={ref} aria-hidden className={className} />
}
