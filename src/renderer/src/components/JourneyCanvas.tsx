import { useEffect, useRef } from 'react'
import { SPACE_LIB, quadProgram } from './spaceGlsl'

/** Duration of the flight from one planet to the next. */
export const JOURNEY_MS = 12_000

/*
 * The flight to the next game as one continuous camera move. Timeline in seconds (phases overlap):
 *
 *   0    to 2.4   take-off. The old planet's horizon drops away and its sky recedes.
 *   1.2  to 8.8   intergalactic space. Galaxies stream past on the sides, the target galaxy sits
 *                 straight ahead and grows from a speck until it fills the view.
 *   7.4  to 10    into the galaxy, aiming at a star in one of its arms. Stars rush past, the star
 *                 turns into a sun and its planets and orbits show up.
 *   9    to 10.7  the camera turns towards one planet and closes in.
 *   10.7 to 12    landing. The planet becomes the horizon and its night sky fades in, ending on
 *                 the same view CosmosBackground shows afterwards.
 */
const FRAG = `${SPACE_LIB}
uniform vec2 u_res;
uniform float u_time;
uniform float u_T;
uniform float u_from;
uniform float u_to;

float ease(float x){ x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }

// distance flown through intergalactic space (smoothstep: speed up, then brake)
float camTravel(float T){
  float x = clamp((T - 1.0) / 7.5, 0.0, 1.0);
  return 26.0 * x * x * (3.0 - 2.0 * x);
}
float camSpeed(float T){
  float x = clamp((T - 1.0) / 7.5, 0.0, 1.0);
  return 26.0 * 6.0 * x * (1.0 - x) / 7.5;
}

// galaxies at random depths in front of the camera, kept off the centre and stretched at high speed
vec3 galaxyField(vec2 p, float camZ, float speed, float t, float seed){
  vec3 c = vec3(0.0);
  for (int i = 0; i < 26; i++) {
    float fi = float(i);
    float ha = h11(seed + fi * 3.17);
    vec2 off = vec2(cos(ha * 6.2832), sin(ha * 6.2832)) * mix(0.9, 2.2, h11(seed + fi * 5.71));   // stay away from the centre
    float dz = mod(h11(seed + fi * 7.33) * 18.0 - camZ, 18.0) + 0.25;
    vec2 cpos = off / dz;
    float size = mix(0.1, 0.3, h11(seed + fi * 9.13)) / dz;
    float smear = 1.0 + speed * 0.25 / dz;
    if (length(p - cpos) > size * 3.0 * smear) continue;   // skip pixels far from this galaxy
    float fade = smoothstep(18.0, 11.0, dz) * smoothstep(0.25, 0.8, dz);
    vec2 rad = normalize(cpos + 1e-4);
    vec2 tan2 = vec2(-rad.y, rad.x);
    vec2 d = p - cpos;
    vec2 q = rad * dot(d, rad) / smear + tan2 * dot(d, tan2);   // stretch along the direction of motion
    float ang = h11(seed + fi * 11.0) * 6.28;
    float tilt = mix(0.3, 1.0, h11(seed + fi * 13.0));
    if (size > 0.09) {
      vec2 g = rot(ang) * q;
      g.y /= tilt;
      c += galaxyShape(g / (size * 0.8), t, seed + fi) * fade;
    } else {
      c += farGalaxy(q + cpos, cpos, size, ang, tilt, seed + fi) * fade * 1.3;
    }
  }
  return c;
}

// the point we fly towards: a star on one of the target galaxy's spiral arms
vec2 aimPoint(float seed){
  float twist = mix(2.4, 5.2, h11(seed + 27.0));
  float r = 0.55;
  float a = twist * log(r + 0.06);
  return vec2(cos(a), sin(a)) * r;
}

vec3 targetGalaxy(vec2 p, float gs, float t, float seed){
  vec2 q = rot(h11(seed + 31.0) * 6.28) * p;
  q.y /= mix(0.45, 0.85, h11(seed + 32.0));
  return galaxyShape(q / gs + aimPoint(seed), t, seed);
}

// three star layers zooming past, each one looping and fading in and out
vec3 starRush(vec2 p, float T, float t){
  vec3 c = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float ph = T * 0.5 + fi / 3.0;
    float s = fract(ph);
    c += starLayer(p / exp2(s * 3.0) + fi * 7.1, 45.0, 0.84, t, 40.0 + fi + floor(ph) * 3.0) * sin(3.14159 * s) * 1.3;
  }
  return c;
}

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
  surf += atmo * pow(1.0 - z, 3.0) * 0.6;                        // more atmosphere visible towards the edge
  vec3 col = mix(surf * (0.06 + lit * 1.8), vec3(0.004, 0.003, 0.009), night);
  float ds = length(p - c) - R;
  rim = atmo * exp(-max(ds, 0.0) / (0.006 + 0.02 * min(R, 1.0))) * step(0.0, ds) * mix(0.5, 0.32, night);
  return vec4(col, cover);
}

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float T = u_T;
  float t = u_time;
  vec3 col = vec3(0.0);

  // ---- take-off from the old planet
  float aHome = 1.0 - smoothstep(1.0, 2.4, T);
  if (aHome > 0.0) {
    g_seed = u_from;
    float e = ease(T / 2.2);
    col += planetView(p * (1.0 + e * 1.6), t, u_from, e * 0.9) * aHome;
  }

  // ---- target solar system, in screen space around its sun
  float S = 0.05 * exp(max(T - 8.2, 0.0) * 1.3);                    // grows as we approach
  float a2 = h11(u_to + 41.0) * 6.28;
  float r2 = 1.6;
  vec2 target = vec2(cos(a2), sin(a2) * 0.3) * r2 * S;               // target planet position relative to the sun
  float pan = ease((T - 9.0) / 1.4);
  vec2 focus = target * pan;                                         // camera pans over to the planet
  vec2 pw = p + focus;

  // ---- intergalactic space
  float aField = smoothstep(1.2, 2.4, T) * (1.0 - smoothstep(7.6, 8.8, T));
  if (aField > 0.0) {
    g_seed = u_to + 77.0;
    vec3 bg = starLayer(p * 0.6, 40.0, 0.975, t, 3.0) * 0.45;
    col += (bg + galaxyField(p, camTravel(T), camSpeed(T), t, u_to + 5.0)) * aField;
  }

  // ---- target galaxy straight ahead, growing until we're inside it
  float aGal = smoothstep(1.4, 3.0, T) * (1.0 - smoothstep(9.4, 10.4, T));
  if (aGal > 0.0) {
    g_seed = u_to;
    float gs = 0.03 * exp(0.55 * (T - 1.0)) * exp(max(T - 8.0, 0.0));
    col += targetGalaxy(pw, gs, t, u_to) * aGal;
  }

  // ---- inside the galaxy: star rush, the sun, its planets and orbits
  float aIn = smoothstep(7.4, 8.4, T) * (1.0 - smoothstep(11.0, 11.8, T));
  float L = ease((T - 10.7) / 1.3);                                  // landing progress
  vec2 sunPos = -focus;
  if (aIn > 0.0) {
    g_seed = u_to + 3.0;
    col += starRush(pw, T, t) * aIn * (1.0 - smoothstep(9.6, 10.6, T));
    float sr = min(0.003 * exp(max(T - 7.8, 0.0) * 1.5), 0.06);
    col += sunGlow(p - sunPos, sr) * smoothstep(7.6, 8.4, T) * (1.0 - L);
    float aSys = smoothstep(8.4, 9.2, T) * (1.0 - L);
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float ri = (0.55 + fi * 0.52) * S;
      vec2 d = p - sunPos;
      float orbit = abs(length(vec2(d.x, d.y / 0.3)) - ri);
      col += neb(0.1 + fi * 0.2) * exp(-orbit / 0.0018) * 0.18 * aSys;
      if (i == 2) continue;                                          // the target planet is drawn separately below
      float ai = h11(u_to + 50.0 + fi) * 6.28;
      vec2 pp = sunPos + vec2(cos(ai), sin(ai) * 0.3) * ri;
      float pr = 0.004 + 0.002 * h11(u_to + 60.0 + fi);
      col += neb(h11(u_to + 70.0 + fi)) * smoothstep(pr, pr * 0.6, length(p - pp)) * 1.4 * aSys;
    }
  }

  // ---- target planet: a dot, then a disk, then the ground we stand on
  if (T > 8.4) {
    float grow = 0.005 * exp(max(T - 9.4, 0.0) * 3.0);
    vec2 pc = mix(sunPos + target, vec2(0.0, -3.42), L);
    float R = mix(min(grow, 0.26), 3.0, L);
    vec2 sunDir = normalize(sunPos - pc + 1e-4);
    vec3 rim;
    vec4 disk = planetDisk(p, pc, R, sunDir, u_to, L, rim);
    float a = smoothstep(8.4, 9.2, T);
    g_seed = u_to;
    if (L > 0.0) col = mix(col, sky(p, t, u_to), L * (1.0 - disk.a)); // fade in its night sky above the horizon
    col = mix(col, disk.rgb, disk.a * a) + rim * a;
  }

  // ---- arrived: cross-fade to the regular view from the new planet
  float fin = smoothstep(11.3, 12.0, T);
  if (fin > 0.0) {
    g_seed = u_to;
    col = mix(col, planetView(p, t, u_to, 0.0), fin);
  }
  gl_FragColor = vec4(finish(col, p), 1.0);
}`

/**
 * Plays the flight once, filling its parent. Renders every frame while running, then holds the
 * last one and leaves fading out to the parent.
 */
export function JourneyCanvas({ from, to, className = 'h-full w-full' }: { from: number; to: number; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' })
    if (!gl) return
    const program = quadProgram(gl, FRAG)
    if (!program) return
    const uniform = (name: string) => gl.getUniformLocation(program, name)
    const [uRes, uTime, uT, uFrom, uTo] = ['u_res', 'u_time', 'u_T', 'u_from', 'u_to'].map(uniform)
    const SCALE = Math.min(1, (window.devicePixelRatio || 1) * 0.5)
    const resize = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()
    const start = performance.now()
    let rafId = 0
    const frame = (now: number) => {
      // dev helper: set window.__journeyT to freeze the flight at that second (for screenshots)
      const frozen = (window as { __journeyT?: number }).__journeyT
      const T = frozen ?? Math.min(JOURNEY_MS, now - start) / 1000
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform1f(uTime, now / 1000)
      gl.uniform1f(uT, T)
      gl.uniform1f(uFrom, from)
      gl.uniform1f(uTo, to)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      if (T * 1000 < JOURNEY_MS) rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [from, to])
  return <canvas ref={canvasRef} aria-hidden className={className} />
}
