import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { LocateFixed } from 'lucide-react'
import type { GameListEntry } from '@shared/types'
import { GALAXY_COUNT, UNIVERSE, cosmicSeed, galaxyOf, length, lerp, sub, type Galaxy, type Vec3 } from '@shared/universe'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ChampIcon } from '@/components/icons'
import { PageHeader } from '@/components/Layout'
import { UniverseGl, projectPoint, type Camera, type StarCloud } from '@/components/universeGl'

interface Visit {
  galaxy: Galaxy
  /** newest first */
  games: GameListEntry[]
}

const OVERVIEW = { target: [0, 0, 0] as Vec3, distance: 235 }
/** Markers further away than this show only their ring, so a zoomed-out map isn't buried in names. */
const LABEL_DEPTH = 120
const FOV = 0.85

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
 */
export function StarMap() {
  const { live } = useApp()
  const [games, setGames] = useState<GameListEntry[]>([])
  const [selected, setSelected] = useState<Galaxy | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const markerRefs = useRef(new Map<number, HTMLDivElement>())
  const here = useMemo(currentGalaxy, [])
  // view state lives in a ref: it changes every frame while dragging and must not re-render React
  const view = useRef({ yaw: 0.6, pitch: 0.35, ...OVERVIEW, goal: { ...OVERVIEW }, touched: false, dirty: true })
  const inGame = !!live?.active

  useEffect(() => {
    const load = () => void api.listGames().then(setGames)
    load()
    return api.on('gameSummary', load)
  }, [])

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

  const latest = useRef({ marked, route, selected, inGame })
  latest.current = { marked, route, selected, inGame }
  useEffect(() => {
    view.current.dirty = true
  }, [marked, route, selected])

  const focus = (galaxy: Galaxy | null) => {
    setSelected(galaxy)
    view.current.goal = galaxy ? { target: galaxy.pos, distance: galaxy.radius * 9 } : { ...OVERVIEW }
    view.current.touched = true
    view.current.dirty = true
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' })
    const universe = gl && UniverseGl.create(gl)
    if (!gl || !universe) return
    let cloud: StarCloud | null = null
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
    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const { marked: markers, route: path, selected: picked, inGame: playing } = latest.current
      // ease towards the focused galaxy (or back to the overview)
      const gap = length(sub(state.goal.target, state.target)) + Math.abs(state.goal.distance - state.distance)
      if (gap > 1e-3) {
        const k = 1 - Math.exp(-dt * 4)
        state.target = lerp(state.target, state.goal.target, k)
        state.distance += (state.goal.distance - state.distance) * k
        state.dirty = true
      }
      // slow turn until the user takes over; never while a game is running
      if (!state.touched && !playing && !document.hidden) {
        state.yaw += dt * 0.04
        state.dirty = true
      }
      if (!state.dirty) return
      state.dirty = false

      const cam = camera()
      universe.begin(cam)
      universe.drawGalaxies(now / 1000, 1.25)
      universe.drawRoute(path, [0.34, 0.22, 0.5])
      // close to the selected galaxy its single stars come out
      if (picked) {
        if (cloud?.galaxy.id !== picked.id) cloud = universe.createStars(picked, 24_000)
        const near = Math.min(1, Math.max(0, (16 - state.distance / picked.radius) / 8))
        universe.drawStars(cloud, near, canvas.height / 720)
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
    const move = (event: PointerEvent) => {
      if (!drag) return
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
    window.addEventListener('resize', resize)
    return () => {
      cancelAnimationFrame(rafId)
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('wheel', wheel)
      window.removeEventListener('resize', resize)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
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
          <canvas ref={canvasRef} className="h-full w-full cursor-grab touch-none active:cursor-grabbing" />
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
                  {selected.designation} · {selected.arms} spiral arms
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
                        <span className="block text-[11px] text-muted">{visit.galaxy.designation}</span>
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
