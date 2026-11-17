import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { LocateFixed, Sparkles } from 'lucide-react'
import type { AchievementState, GameListEntry } from '@shared/types'
import { SKY_RADIUS, constellationOf, rankColor } from '@shared/achievements'
import {
  GALAXY_COUNT,
  TYPE_NAMES,
  UNIVERSE,
  cosmicSeed,
  extentOf,
  galaxyKind,
  galaxyOf,
  length,
  lerp,
  sub,
  type Galaxy,
  type Vec3
} from '@shared/universe'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ChampIcon } from '@/components/icons'
import { PageHeader } from '@/components/Layout'
import { UniverseGl, projectPoint, type Camera, type ConstellationMesh, type StarCloud } from '@/components/universeGl'
import { RankChip } from './Achievements'
import { freshCanvas } from '@/lib/glCanvas'

interface Visit {
  galaxy: Galaxy
  /** newest first */
  games: GameListEntry[]
}

const OVERVIEW = { target: [0, 0, 0] as Vec3, distance: 235 }
/** Markers further away than this show only their ring, so a zoomed-out map isn't buried in names. */
const LABEL_DEPTH = 120
const FOV = 0.85
/** frame rate of the idle animation (turning galaxies, twinkling, the flow along the route) */
const IDLE_FPS = 30

const CONSTELLATIONS_KEY = 'rc.constellations'

/**
 * Vertex data of the constellations (7 floats per vertex: position, colour, point size). Unlocked
 * ones shine in their rank's colour with their lines, locked ones are a few faint stars without
 * lines, locked secret ones aren't there at all.
 */
function constellationData(achievements: AchievementState[]): { points: Float32Array; lines: Float32Array } {
  const points: number[] = []
  const lines: number[] = []
  for (const achievement of achievements) {
    if (achievement.secret && !achievement.unlocked) continue
    const { stars, mags, lines: edges } = constellationOf(achievement.id)
    const colourOf = (i: number): Vec3 => rankColor(achievement.rank, stars.length > 1 ? i / (stars.length - 1) : 0)
    stars.forEach((star, i) => {
      if (achievement.unlocked) points.push(...star, ...colourOf(i).map((c) => c * (0.75 + 0.5 * mags[i])), 5 + 6 * mags[i])
      else points.push(...star, 0.5 * mags[i], 0.52 * mags[i], 0.68 * mags[i], 3 + 2 * mags[i])
    })
    if (achievement.unlocked)
      for (const [a, b] of edges) {
        lines.push(...stars[a], ...colourOf(a).map((c) => c * 0.42), 1)
        lines.push(...stars[b], ...colourOf(b).map((c) => c * 0.42), 1)
      }
  }
  return { points: new Float32Array(points), lines: new Float32Array(lines) }
}

/** The galaxy the app is in right now (where the last flight went). */
function currentGalaxy(): Galaxy | null {
  try {
    const seed = Number(localStorage.getItem('rc.cosmos'))
    return seed ? galaxyOf(seed) : null
  } catch {
    return null
  }
}

/**
 * The universe catalogue as a 3D map you can turn and zoom. Galaxies you played in are marked, a
 * line connects them in the order of your games, and picking one lists the games played there.
 * Everything moves: galaxies turn, stars twinkle, light runs along the route. That animation stops
 * while a game is running, when the window is hidden, and with the static background setting.
 */
export function StarMap() {
  const { live, settings } = useApp()
  const navigate = useNavigate()
  const [games, setGames] = useState<GameListEntry[]>([])
  const [achievements, setAchievements] = useState<AchievementState[]>([])
  const [showSky, setShowSky] = useState(() => {
    try {
      return localStorage.getItem(CONSTELLATIONS_KEY) !== 'off'
    } catch {
      return true
    }
  })
  /** the constellation under the mouse, with where to put its label */
  const [hovered, setHovered] = useState<{ id: string; x: number; y: number } | null>(null)
  const [selected, setSelected] = useState<Galaxy | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const markerRefs = useRef(new Map<number, HTMLDivElement>())
  const here = useMemo(currentGalaxy, [])
  // view state lives in a ref: it changes every frame while dragging and must not re-render React
  const view = useRef({ yaw: 0.6, pitch: 0.35, ...OVERVIEW, goal: { ...OVERVIEW }, touched: false, dirty: true })
  const inGame = !!live?.active
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const animated = !reducedMotion && settings?.ui.background !== 'static'

  useEffect(() => {
    const load = () => void api.listGames().then(setGames)
    load()
    return api.on('gameSummary', load)
  }, [])
  useEffect(() => {
    const load = () => void api.getAchievements().then(setAchievements)
    load()
    return api.on('achievementsUnlocked', load)
  }, [])
  const sky = useMemo(() => ({ ...constellationData(showSky ? achievements : []), version: Date.now() }), [achievements, showSky])
  // what can be hovered: the stars of every constellation that is drawn
  const skyTargets = useMemo(
    () => (showSky ? achievements.filter((achievement) => achievement.unlocked || !achievement.secret) : []),
    [achievements, showSky]
  )
  const toggleSky = () => {
    setShowSky((on) => {
      try {
        localStorage.setItem(CONSTELLATIONS_KEY, on ? 'off' : 'on')
      } catch {
        /* private mode */
      }
      return !on
    })
    setHovered(null)
  }

  const visits = useMemo(() => {
    const byGalaxy = new Map<number, Visit>()
    for (const game of games) {
      const galaxy = galaxyOf(cosmicSeed(game.cosmos))
      const visit = byGalaxy.get(galaxy.id) ?? { galaxy, games: [] }
      visit.games.push(game)
      byGalaxy.set(galaxy.id, visit)
    }
    return [...byGalaxy.values()].sort((a, b) => b.games[0].createdAt - a.games[0].createdAt)
  }, [games])
  // galaxies that get a marker: visited ones, where we are, and the selected one
  const marked = useMemo(() => {
    const list = new Map<number, Galaxy>(visits.map((visit) => [visit.galaxy.id, visit.galaxy]))
    if (here) list.set(here.id, here)
    if (selected) list.set(selected.id, selected)
    return [...list.values()]
  }, [visits, here, selected])
  // the route from game to game, oldest first
  const route = useMemo(
    () => [...games].sort((a, b) => a.createdAt - b.createdAt).map((game) => galaxyOf(cosmicSeed(game.cosmos)).pos),
    [games]
  )

  const latest = useRef({ marked, route, selected, inGame, animated, sky, skyTargets, hovered, navigate })
  latest.current = { marked, route, selected, inGame, animated, sky, skyTargets, hovered, navigate }
  useEffect(() => {
    view.current.dirty = true
  }, [marked, route, selected, animated, sky])

  const focus = (galaxy: Galaxy | null) => {
    setSelected(galaxy)
    view.current.goal = galaxy ? { target: galaxy.pos, distance: galaxy.radius * extentOf(galaxy) * 9 } : { ...OVERVIEW }
    view.current.touched = true
    view.current.dirty = true
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const canvas = freshCanvas(host, 'block h-full w-full cursor-grab touch-none active:cursor-grabbing')
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    const universe = gl && UniverseGl.create(gl)
    if (!gl || !universe) return () => canvas.remove()
    let cloud: StarCloud | null = null
    let skyMesh: ConstellationMesh | null = null
    let skyVersion = -1
    const state = view.current

    const camera = (): Camera => {
      const direction: Vec3 = [
        Math.cos(state.pitch) * Math.sin(state.yaw),
        Math.sin(state.pitch),
        Math.cos(state.pitch) * Math.cos(state.yaw)
      ]
      const eye: Vec3 = [
        state.target[0] + direction[0] * state.distance,
        state.target[1] + direction[1] * state.distance,
        state.target[2] + direction[2] * state.distance
      ]
      return { eye, forward: sub(state.target, eye), up: [0, 1, 0], fovY: FOV }
    }
    const resize = () => {
      const scale = Math.min(1.5, window.devicePixelRatio || 1)
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * scale))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * scale))
      state.dirty = true
    }
    resize()

    let rafId = 0
    let last = performance.now()
    let lastDraw = 0
    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const { marked: markers, route: path, selected: picked, inGame: playing, animated: moving } = latest.current
      const alive = moving && !playing && !document.hidden
      // ease towards the focused galaxy (or back to the overview)
      const gap = length(sub(state.goal.target, state.target)) + Math.abs(state.goal.distance - state.distance)
      if (gap > 1e-3) {
        const k = 1 - Math.exp(-dt * 4)
        state.target = lerp(state.target, state.goal.target, k)
        state.distance += (state.goal.distance - state.distance) * k
        state.dirty = true
      }
      // slow turn until the user takes over; never while a game is running
      if (!state.touched && alive) {
        state.yaw += dt * 0.04
        state.dirty = true
      }
      // the idle animation runs at a modest frame rate; dragging and zooming get every frame
      if (alive && now - lastDraw >= 1000 / IDLE_FPS - 2) state.dirty = true
      if (!state.dirty) return
      state.dirty = false
      lastDraw = now

      const cam = camera()
      const time = moving ? now / 1000 : 0
      universe.begin(cam)
      universe.drawBackdrop(time)
      universe.drawGalaxies(time, 1.25, moving ? 1 : 0)
      universe.drawRoute(path, [0.34, 0.22, 0.5], time)
      // the achievements' constellations on the sky sphere around everything
      const skyData = latest.current.sky
      if (skyData.version !== skyVersion) {
        skyMesh = universe.createConstellations(skyData.points, skyData.lines, skyMesh)
        skyVersion = skyData.version
      }
      if (skyMesh) universe.drawConstellations(skyMesh, SKY_RADIUS, time, canvas.height / 720)
      // close to the selected galaxy its single stars come out, turning with their galaxy
      if (picked) {
        if (cloud?.galaxy.id !== picked.id) cloud = universe.createStars(picked, 24_000)
        const near = Math.min(1, Math.max(0, (16 - state.distance / (picked.radius * extentOf(picked))) / 8))
        universe.drawStars(cloud, near, canvas.height / 720, picked.spin * time, time)
      }
      const aspect = canvas.width / canvas.height
      for (const galaxy of markers) {
        const element = markerRefs.current.get(galaxy.id)
        if (!element) continue
        const point = projectPoint(cam, aspect, galaxy.pos)
        const visible = point && point.x > -0.05 && point.x < 1.05 && point.y > -0.05 && point.y < 1.05
        element.style.display = visible ? '' : 'none'
        if (point) {
          element.style.transform = `translate(${point.x * canvas.clientWidth}px, ${point.y * canvas.clientHeight}px)`
          element.classList.toggle('map-far', point.depth > LABEL_DEPTH)
        }
      }
    }
    rafId = requestAnimationFrame(frame)

    // ---- controls: drag to turn, wheel to zoom, click to pick the nearest galaxy
    let drag: { x: number; y: number; moved: number } | null = null
    const down = (event: PointerEvent) => {
      drag = { x: event.clientX, y: event.clientY, moved: 0 }
      canvas.setPointerCapture(event.pointerId)
    }
    /** The constellation with a star closest to the pointer (within a few pixels), and where that star is. */
    const constellationAt = (clientX: number, clientY: number): { id: string; x: number; y: number } | null => {
      const rect = canvas.getBoundingClientRect()
      const cam = camera()
      const aspect = rect.width / rect.height
      let best: { id: string; x: number; y: number; pixels: number } | null = null
      for (const achievement of latest.current.skyTargets) {
        for (const star of constellationOf(achievement.id).stars) {
          const point = projectPoint(cam, aspect, star)
          if (!point) continue
          const x = point.x * rect.width
          const y = point.y * rect.height
          const pixels = Math.hypot(x - (clientX - rect.left), y - (clientY - rect.top))
          if (pixels < 14 && (!best || pixels < best.pixels)) best = { id: achievement.id, x, y, pixels }
        }
      }
      return best && { id: best.id, x: best.x, y: best.y }
    }
    const move = (event: PointerEvent) => {
      if (!drag) {
        const over = constellationAt(event.clientX, event.clientY)
        const current = latest.current.hovered
        if (over?.id !== current?.id || (over && current && Math.hypot(over.x - current.x, over.y - current.y) > 3)) setHovered(over)
        return
      }
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      drag = { x: event.clientX, y: event.clientY, moved: drag.moved + Math.abs(dx) + Math.abs(dy) }
      state.yaw -= dx * 0.005
      state.pitch = Math.min(1.45, Math.max(-1.45, state.pitch + dy * 0.005))
      state.touched = true
      state.dirty = true
    }
    const up = (event: PointerEvent) => {
      const clicked = drag && drag.moved < 5
      drag = null
      if (!clicked) return
      // a lit constellation opens the game that unlocked it
      const over = constellationAt(event.clientX, event.clientY)
      const achievement = over && latest.current.skyTargets.find((candidate) => candidate.id === over.id)
      if (achievement?.unlocked && achievement.gameId !== null) {
        latest.current.navigate(`/games/${achievement.gameId}`)
        return
      }
      const rect = canvas.getBoundingClientRect()
      const cam = camera()
      const aspect = rect.width / rect.height
      const markedIds = new Set(latest.current.marked.map((galaxy) => galaxy.id))
      let best: { galaxy: Galaxy; score: number } | null = null
      for (const galaxy of UNIVERSE) {
        const point = projectPoint(cam, aspect, galaxy.pos)
        if (!point) continue
        const pixels = Math.hypot(point.x * rect.width - (event.clientX - rect.left), point.y * rect.height - (event.clientY - rect.top))
        // marked galaxies are easier to hit
        const reach = markedIds.has(galaxy.id) ? 22 : 12
        if (pixels < reach && (!best || pixels / reach < best.score)) best = { galaxy, score: pixels / reach }
      }
      focus(best?.galaxy ?? null)
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = Math.exp(event.deltaY * 0.0012)
      state.goal = { target: state.goal.target, distance: Math.min(520, Math.max(2.5, state.goal.distance * factor)) }
      state.touched = true
      state.dirty = true
    }
    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('wheel', wheel, { passive: false })
    const leave = () => setHovered(null)
    canvas.addEventListener('pointerleave', leave)
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('wheel', wheel)
      canvas.removeEventListener('pointerleave', leave)
      window.removeEventListener('resize', resize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
    // the canvas is set up once; everything that changes is read from refs
  }, [])

  const selectedVisit = selected ? visits.find((visit) => visit.galaxy.id === selected.id) : undefined
  const visitOf = (galaxy: Galaxy) => visits.find((visit) => visit.galaxy.id === galaxy.id)
  return (
    <div className="page-enter flex h-full flex-col px-8 pt-8 pb-6">
      <PageHeader title="Star map">
        <span className="text-sm text-muted tabular-nums">
          {visits.length} / {GALAXY_COUNT} galaxies visited
        </span>
        <button
          className={`btn btn-ghost ${showSky ? 'text-accent' : ''}`}
          onClick={toggleSky}
          aria-pressed={showSky}
          title="Your achievements as constellations in the sky"
        >
          <Sparkles size={15} /> Constellations
        </button>
        <button className="btn btn-ghost" onClick={() => focus(null)}>
          Overview
        </button>
        {here && (
          <button className="btn btn-ghost" onClick={() => focus(here)}>
            <LocateFixed size={15} /> Where am I
          </button>
        )}
        <Link to="/games" className="btn btn-ghost">
          All games
        </Link>
      </PageHeader>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="relative min-w-0 flex-1 overflow-hidden rounded-2xl border border-line bg-black">
          {/* the canvas is created by the effect (see freshCanvas) */}
          <div ref={hostRef} className="h-full w-full" />
          {hovered && <ConstellationLabel achievement={achievements.find((achievement) => achievement.id === hovered.id)} at={hovered} />}
          {/* markers follow their galaxy; the frame loop moves them */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {marked.map((galaxy) => {
              const visit = visitOf(galaxy)
              const isHere = here?.id === galaxy.id
              const isSelected = selected?.id === galaxy.id
              const colour = isSelected ? '#ffffff' : isHere ? '#7ef2ff' : '#ffd36b'
              return (
                <div
                  key={galaxy.id}
                  ref={(element) => {
                    if (element) markerRefs.current.set(galaxy.id, element)
                    else markerRefs.current.delete(galaxy.id)
                  }}
                  className="absolute top-0 left-0"
                  style={{ display: 'none' }}
                >
                  <span
                    className="absolute -top-[9px] -left-[9px] block h-[18px] w-[18px] rounded-full"
                    style={{ border: `1.5px solid ${colour}`, boxShadow: `0 0 10px ${colour}90` }}
                  />
                  {(isHere || isSelected) && animated && (
                    <span
                      className="map-ping absolute -top-[9px] -left-[9px] block h-[18px] w-[18px] rounded-full"
                      style={{ borderColor: colour }}
                    />
                  )}
                  <span
                    className={`absolute top-[-8px] left-[15px] text-[11px] leading-tight font-semibold whitespace-nowrap ${isHere || isSelected ? '' : 'map-label'}`}
                    style={{ color: colour }}
                  >
                    {galaxy.name}
                    {(visit || isHere) && (
                      <span className="block text-[10px] font-normal text-muted">
                        {isHere ? 'you are here' : ''}
                        {isHere && visit ? ' · ' : ''}
                        {visit ? `${visit.games.length} ${visit.games.length === 1 ? 'game' : 'games'}` : ''}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        <aside className="panel flex w-72 shrink-0 flex-col overflow-hidden">
          {selected ? (
            <>
              <div className="border-b border-line p-4">
                <div className="font-display text-xl leading-tight font-extrabold">{selected.name}</div>
                <div className="mt-0.5 text-xs text-muted">
                  {selected.designation} · {galaxyKind(selected)}
                  {here && here.id !== selected.id && ` · ${length(sub(selected.pos, here.pos)).toFixed(1)} Mly from here`}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {selectedVisit ? (
                  selectedVisit.games.map((game) => (
                    <Link
                      key={game.gameId}
                      to={`/games/${game.gameId}`}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/5"
                    >
                      <ChampIcon id={game.championId} size={28} tooltip={false} />
                      <span className={`w-14 text-sm font-bold ${game.win ? 'text-[#5fb4ff]' : 'text-[#ff7a62]'}`}>
                        {game.win ? 'Victory' : 'Defeat'}
                      </span>
                      <span className="text-sm tabular-nums">
                        {game.kda[0]}/<span className="text-loss">{game.kda[1]}</span>/{game.kda[2]}
                      </span>
                      <span className="ml-auto text-[11px] text-muted">{new Date(game.createdAt).toLocaleDateString()}</span>
                    </Link>
                  ))
                ) : (
                  <p className="p-2 text-sm text-muted">No games played here yet.</p>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="border-b border-line px-4 py-3 text-[11px] font-bold tracking-wider text-muted uppercase">
                Visited galaxies
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {visits.map((visit) => {
                  const wins = visit.games.filter((game) => game.win).length
                  return (
                    <button
                      key={visit.galaxy.id}
                      onClick={() => focus(visit.galaxy)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-white/5"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{visit.galaxy.name}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {visit.galaxy.designation} · {TYPE_NAMES[visit.galaxy.type]}
                        </span>
                      </span>
                      <span className="text-xs tabular-nums">
                        <span className="text-[#5fb4ff]">{wins}W</span> <span className="text-[#ff7a62]">{visit.games.length - wins}L</span>
                      </span>
                    </button>
                  )
                })}
                {!visits.length && <p className="p-2 text-sm text-muted">No games yet.</p>}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/** Name, description and date (or progress) of the constellation under the mouse. */
function ConstellationLabel({ achievement, at }: { achievement?: AchievementState; at: { x: number; y: number } }) {
  if (!achievement) return null
  return (
    <div
      className="pointer-events-none absolute z-10 w-64 rounded-xl border border-white/15 bg-[#0d0820]/90 p-3 text-xs shadow-[0_14px_40px_-10px_rgb(0_0_0/0.9)] backdrop-blur"
      style={{ left: Math.max(8, at.x + 16), top: Math.max(8, at.y - 12) }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="font-display text-sm font-extrabold">{achievement.name}</span>
        <RankChip rank={achievement.rank} />
      </div>
      <p className="leading-snug text-muted">{achievement.description}</p>
      <p className="mt-1.5 font-semibold">
        {achievement.unlocked ? (
          <span className="text-text">
            Discovered {achievement.unlockedAt ? new Date(achievement.unlockedAt).toLocaleDateString() : ''}
            {achievement.gameId !== null && <span className="text-accent"> · click to open the game</span>}
          </span>
        ) : (
          <span className="text-muted">
            Not discovered yet{achievement.goal > 1 ? ` · ${achievement.progress}/${achievement.goal}` : ''}
          </span>
        )}
      </p>
    </div>
  )
}
