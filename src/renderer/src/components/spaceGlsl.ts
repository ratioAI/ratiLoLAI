/**
 * GLSL shared by the space backgrounds: hashes and noise, the nebula palette, star layers,
 * galaxies, the night sky of a planet inside a galaxy (sky) and the view from its surface
 * (planetView). Every "seed" is a different place in the universe.
 */
export const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`

export const SPACE_LIB = `
precision highp float;
// the place whose stars are drawn (set in main – several places can be drawn in one frame)
float g_seed;
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

// A spiral galaxy in its own plane: q in galaxy units (1 ≈ the visible disk), seed picks the look.
vec3 galaxyShape(vec2 q, float t, float seed){
  float arms = floor(mix(2.0, 4.99, h11(seed + 26.0)));
  float twist = mix(2.4, 5.2, h11(seed + 27.0));
  vec3 armCol = neb(h11(seed + 28.0));
  vec3 armIn = neb(h11(seed + 28.0) + 0.3);
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

// A galaxy seen from far outside it (rare: a planet in the galactic halo or a satellite galaxy).
vec3 spiralGalaxy(vec2 p, float t, float seed){
  vec2 gc = vec2(mix(-0.5, 0.5, h11(seed + 21.0)), mix(0.05, 0.22, h11(seed + 22.0)));
  float grot = h11(seed + 23.0) * 6.283 + t * 0.004;
  float tilt = mix(0.3, 0.8, h11(seed + 24.0));
  float gscale = mix(0.3, 0.55, h11(seed + 25.0));
  vec2 q = rot(grot) * (p - gc);
  q.y /= tilt;
  return galaxyShape(q / gscale, t, seed);
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

// The night sky as seen from the planet's surface: the sky above a dark horizon with two ranges of
// mountains and a thin glow of atmosphere. drop > 0 lowers the horizon (lifting off / landing).
vec3 planetView(vec2 p, float t, float seed, float drop){
  vec3 col = sky(p, t, seed);
  vec2 pc = vec2(0.0, -3.42 - drop);
  vec3 atmo = neb(h11(seed + 12.0)) * 0.9;
  float ground = length(p - pc) - 3.0;
  float rough = mix(0.4, 1.4, h11(seed + 13.0));              // flat plains … jagged peaks
  float farR = ground - rough * (0.035 * ridge(p.x * 3.0 + seed) + 0.018 * ridge(p.x * 9.0 - seed)) - 0.006;
  float nearR = ground - rough * (0.028 * ridge(p.x * 1.7 - seed * 1.3) * ridge(p.x * 4.3 + 3.0) + 0.008 * noise(vec2(p.x * 30.0, seed)));
  float glow = exp(-max(farR, 0.0) * 26.0) * step(0.0, farR);
  col += atmo * glow * 0.32;
  col = mix(col, atmo * 0.07 + vec3(0.01, 0.008, 0.02), smoothstep(0.002, -0.002, farR));
  col = mix(col, vec3(0.004, 0.003, 0.009), smoothstep(0.002, -0.002, nearR));
  return col;
}

vec3 finish(vec3 col, vec2 p){
  col = 1.0 - exp(-col * 1.25);                               // soft tone mapping
  return col * (0.75 + 0.25 * smoothstep(1.1, 0.2, length(p))); // vignette
}
`

/** Fresh full-screen-quad program; null if WebGL refuses the shader. */
export function quadProgram(gl: WebGLRenderingContext, frag: string): WebGLProgram | null {
  const sh = (type: number, src: string): WebGLShader => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('space shader:', gl.getProgramInfoLog(prog))
    return null
  }
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  return prog
}

/** Numeric seed from any value (game id, string …). */
export const cosmicSeed = (v: number | string): number => {
  let h = 2166136261
  for (const c of String(v)) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return ((h >>> 0) % 100000) / 7.31
}
