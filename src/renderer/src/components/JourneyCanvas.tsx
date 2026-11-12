import { useEffect, useRef } from 'react'
import { FLIGHT_S, JOURNEY_S, flightPlan, routeDust } from '@shared/journey'
import { length, neighbourhoodStars, sub } from '@shared/universe'
import { SPACE_LIB, VERT } from './spaceGlsl'
import { UniverseGl, createProgram } from './universeGl'

/** Duration of the flight from one planet to the next. */
export const JOURNEY_MS = JOURNEY_S * 1000

/*
 * The flight to the next game: one continuous camera move through the universe catalogue
 * (shared/universe.ts), from the planet of the last game to the planet of the next one.
 *
 * Space itself is real 3D: every galaxy of the catalogue sits at its position, the camera follows
 * the route of shared/journey.ts, and what passes by does so with true perspective and parallax.
 * The two ends of the trip, where a planet fills the view, are painted over that by a second pass
 * (PLANET_FRAG below), which also makes the flight start and end on exactly the picture
 * CosmosBackground shows while you are standing on the planet.
 *
 * Timeline in seconds (phases overlap):
 *
 *   0    to 2.4   take-off. The old planet's horizon drops away, the stars of its galaxy appear.
 *   2    to 4.5   up and out of the galaxy's disk, the galaxy shrinks behind and below.
 *   4    to 8     intergalactic space at full speed, the target galaxy dead ahead and growing,
 *                 other galaxies of the catalogue drifting past.
 *   7.5  to 10    down over the target's disk and into one of its arms. Its stars rush past, the
 *                 one we aim for turns into a sun and its planets and orbits show up.
 *   9    to 10.7  the camera turns towards one planet and closes in.
 *   10.7 to 12    landing. The planet becomes the horizon and its night sky fades in.
 */
const PLANET_FRAG = `${SPACE_LIB}
uniform vec2 u_res;
uniform float u_time;
uniform float u_T;
uniform float u_from;
uniform float u_to;

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
  surf += atmo * pow(1.0 - z, 3.0) * 0.6;                        // more atmosphere visible towards the edge
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
  float t = u_time;
  vec3 glow = vec3(0.0);

  // ---- take-off from the old planet
  float aHome = 1.0 - smoothstep(1.0, 2.4, T);
  if (aHome > 0.0) {
    g_seed = u_from;
    float e = ease(T / 2.2);
    cover(planetView(p * (1.0 + e * 1.6), t, u_from, e * 0.9), aHome);
  }

  // ---- target solar system, in screen space around its sun (the star the camera flies at)
  float S = 0.05 * exp(max(T - 8.2, 0.0) * 1.3);                    // grows as we approach
  float a2 = h11(u_to + 41.0) * 6.28;
  vec2 target = vec2(cos(a2), sin(a2) * 0.3) * 1.6 * S;              // target planet relative to the sun
  float pan = ease((T - 9.0) / 1.4);
  vec2 sunPos = -target * pan;                                       // camera pans over to the planet
  float L = ease((T - 10.7) / 1.3);                                  // landing progress
  float aIn = smoothstep(7.4, 8.4, T) * (1.0 - smoothstep(11.0, 11.8, T));
  if (aIn > 0.0) {
    float sr = min(0.003 * exp(max(T - 7.8, 0.0) * 1.5), 0.06);
    glow += sunGlow(p - sunPos, sr) * smoothstep(7.6, 8.4, T) * (1.0 - L) * aIn;
    float aSys = smoothstep(8.4, 9.2, T) * (1.0 - L) * aIn;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float ri = (0.55 + fi * 0.52) * S;
      vec2 d = p - sunPos;
      float orbit = abs(length(vec2(d.x, d.y / 0.3)) - ri);
      glow += neb(0.1 + fi * 0.2) * exp(-orbit / 0.0018) * 0.18 * aSys;
      if (i == 2) continue;                                          // the target planet is drawn separately below
      float ai = h11(u_to + 50.0 + fi) * 6.28;
      vec2 pp = sunPos + vec2(cos(ai), sin(ai) * 0.3) * ri;
      float pr = 0.004 + 0.002 * h11(u_to + 60.0 + fi);
      glow += neb(h11(u_to + 70.0 + fi)) * smoothstep(pr, pr * 0.6, length(p - pp)) * 1.4 * aSys;
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
    if (L > 0.0) {                                                   // its night sky fades in above the horizon
      float aSky = L * (1.0 - disk.a);
      cover(sky(p, t, u_to), aSky);
      glow *= 1.0 - aSky;
    }
    cover(disk.rgb, disk.a * a);
    glow = glow * (1.0 - disk.a * a) + rim * a;
  }

  // ---- arrived: cross-fade to the regular view from the new planet
  float fin = smoothstep(11.3, 12.0, T);
  if (fin > 0.0) {
    g_seed = u_to;
    cover(planetView(p, t, u_to, 0.0), fin);
    glow *= 1.0 - fin;
  }
  vec3 covered = g_alpha > 0.0 ? finish(g_col / g_alpha, p) * g_alpha : vec3(0.0);
  gl_FragColor = vec4(covered + finish(glow, p), g_alpha);
}`

const STARS_PER_GALAXY = 36_000
const STARS_NEARBY = 4500
const DUST_GRAINS = 2600

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
    const universe = UniverseGl.create(gl)
    const planets = createProgram(gl, VERT, PLANET_FRAG)
    if (!universe || !planets) return

    const plan = flightPlan(from, to)
    const starsFrom = universe.createStars(plan.from, STARS_PER_GALAXY)
    const starsTo = plan.to.id === plan.from.id ? starsFrom : universe.createStars(plan.to, STARS_PER_GALAXY)
    // the dense stellar neighbourhoods of the two planets
    const nearFrom = universe.createStars(plan.from, neighbourhoodStars(from, STARS_NEARBY))
    const nearTo = universe.createStars(plan.to, neighbourhoodStars(to, STARS_NEARBY))
    const dust = routeDust(plan, DUST_GRAINS)
    const dustBuffer = universe.createBuffer(dust.data)
    const quad = universe.createBuffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]))

    // three quarters of the device resolution: single stars stay crisp, the planet passes stay cheap
    const SCALE = Math.min(1, (window.devicePixelRatio || 1) * 0.75)
    const resize = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * SCALE))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * SCALE))
    }
    resize()
    const smooth = (edge0: number, edge1: number, x: number) => {
      const s = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
      return s * s * (3 - 2 * s)
    }
    /** How visible a galaxy's single stars are: only from close up, from afar the disk does the job. */
    const starAlpha = (galaxy: typeof plan.from, eye: [number, number, number]) =>
      smooth(7 * galaxy.radius, 2.5 * galaxy.radius, length(sub(eye, galaxy.pos)))

    const start = performance.now()
    let rafId = 0
    const frame = (now: number) => {
      // dev helper: set window.__journeyT to freeze the flight at that second (for screenshots)
      const frozen = (window as { __journeyT?: number }).__journeyT
      const T = frozen ?? Math.min(JOURNEY_MS, now - start) / 1000
      const time = now / 1000
      const pose = plan.cameraAt(T)
      universe.begin(pose)
      // before 1 s the old planet still covers everything, after 11.9 s the new one does
      if (T > 0.95 && T < 11.95) {
        const pointScale = Math.max(1, canvas.height / 720)
        universe.drawGalaxies(time)
        universe.drawStars(starsFrom, starAlpha(plan.from, pose.eye), pointScale)
        if (starsTo !== starsFrom) universe.drawStars(starsTo, starAlpha(plan.to, pose.eye), pointScale)
        // only on the way out and on the way in, so a hop within one galaxy doesn't draw both at once
        if (T < FLIGHT_S / 2) universe.drawStars(nearFrom, starAlpha(plan.from, pose.eye), pointScale)
        else universe.drawStars(nearTo, starAlpha(plan.to, pose.eye), pointScale)
        universe.drawStreaks(dustBuffer, DUST_GRAINS, plan.cameraAt(T - 0.03), dust.range, 0.55 * Math.pow(pose.speed, 1.5))
      }
      // planets on top
      if (T < 2.4 || T > 7.4) {
        gl.useProgram(planets.program)
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
        universe.bindQuad(planets, quad)
        gl.uniform2f(planets.uniform('u_res'), canvas.width, canvas.height)
        gl.uniform1f(planets.uniform('u_time'), time)
        gl.uniform1f(planets.uniform('u_T'), T)
        gl.uniform1f(planets.uniform('u_from'), from)
        gl.uniform1f(planets.uniform('u_to'), to)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      }
      if (T * 1000 < JOURNEY_MS || frozen !== undefined) rafId = requestAnimationFrame(frame)
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
