/**
 * Developer tools: fly through the universe on demand, show the overlays without a game, simulate
 * the League client and an ARAM game, and measure relic pads on new maps.
 *
 * The page only exists in `npm run dev` (main.tsx and Layout.tsx leave it out of every build), and
 * its main-process half (main/admin.ts) is only loaded there too.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Camera,
  Check,
  Copy,
  Crosshair,
  Diamond,
  Eye,
  EyeOff,
  FastForward,
  FolderOpen,
  Gamepad2,
  Gauge,
  Loader2,
  Map as MapIcon,
  Orbit,
  Play,
  RotateCcw,
  Rocket,
  Save,
  ScrollText,
  Square,
  Swords,
  Trash2,
  X
} from 'lucide-react'
import type { AdminMinimapSnapshot, AdminRelicPad, AdminRelicSeen, AdminSimOptions, AdminSimState, MinimapState } from '@shared/types'
import { FLIGHT_VARIANTS, type FlightVariant } from '@shared/journey'
import { GALAXY_TYPES, TYPE_NAMES, UNIVERSE, cosmicSeed, galaxyKind, galaxyOf, type GalaxyType } from '@shared/universe'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { sendCosmos } from '@/lib/cosmosControl'
import { demoChampSelect, demoSummary } from '@/lib/mockApi'
import { PageHeader } from '@/components/Layout'
import { DEMO_LOBBY } from './OverlayLoading'
import { clearBadShaders, currentBadShaders, testFlightShaders } from '@/components/flightGl'
import { NIGHT_SKY_FRAG } from '@/components/CosmosBackground'
import { VERT } from '@/components/spaceGlsl'
import './admin.css'

const TEAM_COLOR = { ORDER: '#5aa9ff', CHAOS: '#ff5c6c' } as const
const TEAM_NAME = { ORDER: 'Blue', CHAOS: 'Red' } as const
const VARIANT_NAME: Record<FlightVariant, string> = { wormhole: 'Wormhole', slingshot: 'Slingshot' }
/** first spawn of a relic in game seconds and its respawn (same as main/minimap/timers.ts) */
const RELIC_FIRST = { outer: 105, inner: 150, base: 0 } as const
const RELIC_RESPAWN = 92.5

const clock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs one action at a time per card and keeps its result for the status line. */
function useAction() {
  const [state, setState] = useState<{ busy: string | null; message: string | null; error: boolean }>({
    busy: null,
    message: null,
    error: false
  })
  const run = useCallback(async (label: string, task: () => Promise<string | void> | string | void) => {
    setState({ busy: label, message: null, error: false })
    try {
      const message = await task()
      setState({ busy: null, message: message || null, error: false })
    } catch (error) {
      setState({
        busy: null,
        message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': /, '') : String(error),
        error: true
      })
    }
  }, [])
  return { ...state, run }
}
type Action = ReturnType<typeof useAction>

/** Re-renders every second, for clocks that run between updates. */
function useSecondTick(active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function Card({
  icon,
  title,
  hint,
  wide,
  action,
  children
}: {
  icon: ReactNode
  title: string
  hint?: ReactNode
  wide?: boolean
  action?: Action
  children: ReactNode
}) {
  return (
    <section className={`panel admin-card flex flex-col p-5 ${wide ? 'xl:col-span-2' : ''}`}>
      <header className="mb-4 flex items-start gap-3">
        <span className="admin-icon">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg leading-tight font-extrabold tracking-tight">{title}</h2>
          {hint && <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p>}
        </div>
      </header>
      <div className="flex-1 space-y-4">{children}</div>
      {action && (action.busy || action.message) && (
        <div className={`admin-status mt-4 ${action.error ? 'admin-status-error' : ''}`}>
          {action.busy ? (
            <>
              <Loader2 size={13} className="animate-spin" /> {action.busy} …
            </>
          ) : (
            <>
              {action.error ? <X size={13} /> : <Check size={13} />} {action.message}
            </>
          )}
        </div>
      )}
    </section>
  )
}

function Label({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <span className="text-[11px] font-bold tracking-[0.14em] text-muted uppercase">{children}</span>
      {right}
    </div>
  )
}

function Btn({
  onClick,
  icon,
  children,
  primary,
  danger,
  disabled,
  title
}: {
  onClick: () => void
  icon?: ReactNode
  children: ReactNode
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      className={`btn admin-btn ${primary ? 'btn-primary' : 'btn-ghost'} ${danger ? 'admin-btn-danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      {children}
    </button>
  )
}

/** Two to four options side by side. */
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <div className="admin-segmented">
      {options.map(([option, label]) => (
        <button key={option} className={option === value ? 'is-active' : ''} onClick={() => onChange(option)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  suffix
}: {
  label: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  suffix?: string
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted">
      {label}
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          className="input admin-number"
          value={value}
          min={min}
          max={max}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)))
          }}
        />
        {suffix && <span className="text-muted">{suffix}</span>}
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Flights & universe
// ---------------------------------------------------------------------------

const TYPE_COUNT = Object.fromEntries(
  GALAXY_TYPES.map((type) => [type, UNIVERSE.filter((galaxy) => galaxy.type === type).length])
) as Record<GalaxyType, number>

/** A random place (seed) in a galaxy of this type, not in the galaxy we're in. */
function placeIn(type: GalaxyType | 'any', avoidGalaxy: number): number {
  for (let attempt = 0; attempt < 20_000; attempt++) {
    const seed = cosmicSeed(`${Math.random()}`)
    const galaxy = galaxyOf(seed)
    if (galaxy.id !== avoidGalaxy && (type === 'any' || galaxy.type === type)) return seed
  }
  return cosmicSeed(Date.now())
}

const storedSeed = (): number => {
  try {
    return Number(localStorage.getItem('rc.cosmos')) || 0
  } catch {
    return 0
  }
}

const storedFlights = (): FlightVariant[] => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('rc.flights') ?? '[]')
    return Array.isArray(stored) ? stored.filter((entry): entry is FlightVariant => FLIGHT_VARIANTS.includes(entry)) : []
  } catch {
    return []
  }
}

function GalaxyLine({ seed, label }: { seed: number; label: string }) {
  const galaxy = galaxyOf(seed)
  return (
    <div className="admin-galaxy">
      <span className="text-[10px] font-bold tracking-[0.16em] text-muted uppercase">{label}</span>
      <span className="font-display text-base font-extrabold tracking-tight text-text">{galaxy.name}</span>
      <span className="text-xs text-muted">
        {galaxy.designation} · {galaxyKind(galaxy)}
      </span>
    </div>
  )
}

function FlightsCard() {
  const navigate = useNavigate()
  const action = useAction()
  // both live in localStorage and change with every flight, so they're simply read every second
  useSecondTick()
  const current = storedSeed()
  const flights = storedFlights()
  const [type, setType] = useState<GalaxyType | 'any'>('any')
  const [target, setTarget] = useState(() => placeIn('any', galaxyOf(storedSeed()).id))
  const [stay, setStay] = useState(true)
  const [shaderTest, setShaderTest] = useState<{ name: string; ms: number | null; linked: boolean }[] | null>(null)
  const { settings } = useApp()
  const noFlights = settings?.ui.background === 'static'

  const reroll = (nextType = type) => setTarget(placeIn(nextType, galaxyOf(storedSeed()).id))
  const fly = (variant?: FlightVariant) => {
    sendCosmos({ type: 'fly', to: target, variant, stay })
    reroll()
  }

  return (
    <Card
      icon={<Orbit size={18} />}
      title="Flights & universe"
      hint="Fly anywhere without accepting a match. A real match picks wormhole or slingshot at random, never three of a kind in a row."
      action={action}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <GalaxyLine seed={current} label="You are here" />
        <GalaxyLine seed={target} label="Destination" />
      </div>

      <div>
        <Label
          right={
            <button className="admin-link" onClick={() => reroll()}>
              another one
            </button>
          }
        >
          Galaxy type
        </Label>
        <select
          className="input w-full"
          value={type}
          onChange={(event) => {
            const next = event.target.value as GalaxyType | 'any'
            setType(next)
            reroll(next)
          }}
        >
          <option value="any">Any ({UNIVERSE.length} galaxies)</option>
          {GALAXY_TYPES.map((galaxyType) => (
            <option key={galaxyType} value={galaxyType}>
              {TYPE_NAMES[galaxyType]} ({TYPE_COUNT[galaxyType]})
            </option>
          ))}
        </select>
      </div>

      <div>
        <Label>Fly there</Label>
        <div className="flex flex-wrap gap-2">
          {FLIGHT_VARIANTS.map((variant) => (
            <Btn key={variant} primary icon={<Rocket size={15} />} onClick={() => fly(variant)} disabled={noFlights}>
              {VARIANT_NAME[variant]}
            </Btn>
          ))}
          <Btn icon={<Rocket size={15} />} onClick={() => fly()} disabled={noFlights}>
            Random kind
          </Btn>
          <Btn
            icon={<Crosshair size={15} />}
            onClick={() =>
              action.run('Teleporting', () => {
                sendCosmos({ type: 'teleport', to: target })
                const galaxy = galaxyOf(target)
                reroll()
                return `Now in ${galaxy.name} – the Games tab shows its night sky`
              })
            }
          >
            Teleport
          </Btn>
        </div>
        <label className="mt-2.5 flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={!stay} onChange={(event) => setStay(!event.target.checked)} />
          End on the Live tab like after a real match
        </label>
        {noFlights && <p className="mt-2 text-xs text-gold">Flights are off with the static background (Settings › Appearance).</p>}
      </div>

      <div>
        <Label>Shaders</Label>
        <Btn
          icon={<Gauge size={15} />}
          disabled={!!action.busy}
          onClick={() =>
            action.run('Compiling the flight shaders one by one', async () => {
              setShaderTest([])
              // the night sky first, as a reference: the planet shader has the same big sky (once)
              const where = await testFlightShaders(
                (name, ms, linked) => {
                  api.logDiag(
                    `shader test: ${name} ${ms === null ? 'not done after 60 s' : `${ms} ms`}${linked || ms === null ? '' : ' – failed to link'}`
                  )
                  setShaderTest((current) => [...(current ?? []), { name, ms, linked }])
                },
                [{ name: 'night-sky', vert: VERT, frag: NIGHT_SKY_FRAG }]
              )
              api.logDiag(`shader test: ${where}`)
              return `Done – ${where} (also in overlay.log)`
            })
          }
        >
          Test flight shaders
        </Btn>
        <p className="mt-2 text-xs text-muted">
          Hung the GPU here before:{' '}
          {currentBadShaders().length ? (
            <>
              <b className="text-loss">{currentBadShaders().join(', ')}</b> – flights are skipped.{' '}
              <button
                className="admin-link"
                onClick={() =>
                  action.run('Resetting', () => {
                    clearBadShaders()
                    return 'Forgotten – the next start compiles them again'
                  })
                }
              >
                try again
              </button>
            </>
          ) : (
            'none'
          )}
        </p>
        {shaderTest && shaderTest.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {shaderTest.map(({ name, ms, linked }) => (
              <span key={name} className={`admin-chip ${ms === null || !linked ? 'admin-chip-bad' : ms > 3000 ? 'admin-chip-slow' : ''}`}>
                {name} · {ms === null ? 'stuck' : !linked ? 'failed' : `${ms} ms`}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Btn icon={<MapIcon size={15} />} onClick={() => navigate('/games/map')}>
          Star map
        </Btn>
        <Btn icon={<Eye size={15} />} onClick={() => navigate('/games')}>
          Night sky
        </Btn>
        <span className="flex-1" />
        <span className="text-xs text-muted">
          Last flights: {flights.length ? flights.map((variant) => VARIANT_NAME[variant]).join(', ') : '–'}
        </span>
        <button
          className="admin-link"
          onClick={() =>
            action.run('Resetting', () => {
              localStorage.removeItem('rc.flights')
              return 'Flight history cleared'
            })
          }
        >
          reset
        </button>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Overlays without a game
// ---------------------------------------------------------------------------

function OverlaysCard() {
  const { data, champSelect, live } = useApp()
  const action = useAction()
  const admin = api.admin
  const champions = useMemo(() => (data ? Object.values(data.champions).sort((a, b) => a.name.localeCompare(b.name)) : []), [data])
  const [championId, setChampionId] = useState<number>(() => {
    if (champSelect?.myChampionId) return champSelect.myChampionId
    const byName = data && Object.values(data.champions).find((champion) => champion.name === live?.activeChampion)
    return byName?.key ?? 99
  })
  const [map, setMap] = useState(12)

  return (
    <Card
      icon={<Eye size={18} />}
      title="Overlays without a game"
      hint="Shown on the game screen (Settings › In-game overlay) and kept there until you hide them."
      action={action}
    >
      <div>
        <Label>Minimap timers</Label>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => action.run('Showing timers', async () => void (await admin?.showMinimapDemo('mixed')))}>Mixed</Btn>
          <Btn onClick={() => action.run('Showing timers', async () => void (await admin?.showMinimapDemo('soon')))}>About to respawn</Btn>
          <div className="flex items-center gap-1.5">
            <Btn onClick={() => action.run('Showing pads', async () => void (await admin?.showMinimapDemo('pads', map)))}>
              Relic pads of map
            </Btn>
            <input
              type="number"
              className="input admin-number"
              value={map}
              min={1}
              onChange={(event) => setMap(Math.max(1, Math.round(Number(event.target.value) || 12)))}
              aria-label="Map number"
            />
          </div>
        </div>
      </div>

      <div>
        <Label>Augment choice (card frames)</Label>
        <div className="flex gap-2">
          <select className="input min-w-0 flex-1" value={championId} onChange={(event) => setChampionId(Number(event.target.value))}>
            {champions.map((champion) => (
              <option key={champion.key} value={champion.key}>
                {champion.name}
              </option>
            ))}
          </select>
          <Btn
            icon={<Play size={15} />}
            onClick={() => action.run('Showing card frames', async () => void (await admin?.showFrames(championId)))}
          >
            Show
          </Btn>
        </div>
      </div>

      <div>
        <Label>Loading screen</Label>
        <Btn
          icon={<Play size={15} />}
          onClick={() => action.run('Showing loading panel', async () => void (await admin?.showLoading(DEMO_LOBBY)))}
        >
          Win rates panel (demo lobby)
        </Btn>
      </div>

      <div className="border-t border-line/60 pt-4">
        <Btn
          danger
          icon={<EyeOff size={15} />}
          onClick={() =>
            action.run('Hiding', async () => {
              await admin?.hideOverlays()
              return 'Previews hidden – real overlays are back'
            })
          }
        >
          Hide all overlays
        </Btn>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Simulated client and game
// ---------------------------------------------------------------------------

function timerNow(timers: MinimapState | null): number {
  return timers ? timers.gameTime + (Date.now() - timers.measuredAt) / 1000 : 0
}

function SimCard() {
  const { data } = useApp()
  const admin = api.admin
  const action = useAction()
  const [options, setOptions] = useState<AdminSimOptions>({ mode: 'mayhem', map: 12, startAt: 90, inhibitorRespawn: 250 })
  const [sim, setSim] = useState<AdminSimState | null>(null)
  const [timers, setTimers] = useState<MinimapState | null>(null)
  useSecondTick(!!sim)

  useEffect(() => {
    void api.getMapTimers().then(setTimers)
    return api.on('mapTimers', setTimers)
  }, [])
  useEffect(() => {
    if (!admin) return
    let active = true
    const load = () =>
      void admin
        .simState()
        .then((state) => active && setSim(state))
        .catch(() => undefined)
    load()
    const timer = setInterval(load, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [admin])

  const simAction = (label: string, payload: Parameters<NonNullable<typeof admin>['simAction']>[0]) =>
    action.run(label, async () => {
      setSim((await admin?.simAction(payload)) ?? null)
    })

  const now = timerNow(timers)
  const relicView = (id: string) => timers?.relics.find((relic) => relic.id === id)

  return (
    <Card
      icon={<Gamepad2 size={18} />}
      title="Simulate the client and a game"
      hint="Goes through the same code as the League client: a simulated ARAM game feeds the Live tab and the overlays like the live data does, the relic detection is told what the pads show."
      wide
      action={action}
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_1.6fr]">
        <div className="space-y-4">
          <div>
            <Label>League client</Label>
            <div className="flex flex-wrap gap-2">
              <Btn icon={<Rocket size={15} />} onClick={() => action.run('Accepting', async () => void (await admin?.acceptMatch()))}>
                Match accepted
              </Btn>
              <Btn
                icon={<Swords size={15} />}
                disabled={!data}
                onClick={() =>
                  action.run(
                    'Sending champion select',
                    async () => void (data && (await admin?.emit('champSelect', demoChampSelect(data))))
                  )
                }
              >
                Champ select
              </Btn>
              <Btn onClick={() => action.run('Ending champion select', async () => void (await admin?.emit('champSelect', null)))}>
                End it
              </Btn>
            </div>
            <button
              className="admin-link mt-2"
              disabled={!data}
              onClick={() =>
                action.run('Accepted – champion select comes in 4 s', async () => {
                  await admin?.acceptMatch()
                  await sleep(4000)
                  if (data) await admin?.emit('champSelect', demoChampSelect(data))
                  return 'Champion select arrived during the flight – it should keep playing'
                })
              }
            >
              Accept, then champ select 4 s into the flight
            </button>
          </div>

          <div>
            <Label>Post-game summary</Label>
            <div className="flex flex-wrap gap-2">
              <Btn
                icon={<Save size={15} />}
                onClick={() =>
                  action.run('Saving test game', async () => {
                    const summary = demoSummary(Math.floor(Math.random() * 24))
                    await admin?.saveTestGame({ ...summary, gameId: -Math.floor(Date.now() / 1000), createdAt: Date.now() })
                  })
                }
              >
                Test game
              </Btn>
              <Btn
                danger
                icon={<Trash2 size={15} />}
                onClick={() =>
                  action.run('Deleting', async () => {
                    const removed = (await admin?.deleteTestGames()) ?? 0
                    return removed ? `Deleted ${removed} test game${removed === 1 ? '' : 's'}` : 'No test games saved'
                  })
                }
              >
                Delete test games
              </Btn>
            </div>
            <p className="mt-2 text-xs text-muted">Test games get negative ids, only they are deleted.</p>
          </div>
        </div>

        <div className="admin-subpanel">
          <Label
            right={
              sim ? (
                <span className="admin-live">
                  <span className="admin-live-dot" /> {sim.options.mode === 'mayhem' ? 'Mayhem' : 'ARAM'} · map {sim.options.map} ·{' '}
                  <b>{clock(sim.gameTime)}</b>
                </span>
              ) : null
            }
          >
            Simulated ARAM game
          </Label>
          {!sim ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted">
                  Mode
                  <Segmented
                    value={options.mode}
                    options={[
                      ['aram', 'ARAM'],
                      ['mayhem', 'Mayhem']
                    ]}
                    onChange={(mode) => setOptions({ ...options, mode })}
                  />
                </label>
                <NumberField label="Map" value={options.map} min={1} max={9999} onChange={(map) => setOptions({ ...options, map })} />
                <NumberField
                  label="Start at"
                  value={options.startAt}
                  min={0}
                  max={3000}
                  suffix="s"
                  onChange={(startAt) => setOptions({ ...options, startAt })}
                />
                <NumberField
                  label="Inhibitor respawn"
                  value={options.inhibitorRespawn}
                  min={61}
                  max={599}
                  suffix="s"
                  onChange={(inhibitorRespawn) => setOptions({ ...options, inhibitorRespawn })}
                />
              </div>
              <p className="text-xs leading-relaxed text-muted">
                The respawn is what the simulated game really does – set it to e.g. 240 to watch the app correct its 250 s guess with the 15
                s warning and learn it for the mode. Mayhem also starts the augment card scanner, like a real game.
              </p>
              <Btn
                primary
                icon={<Play size={15} />}
                onClick={() =>
                  action.run('Starting', async () => {
                    setSim((await admin?.simStart(options)) ?? null)
                  })
                }
              >
                Start game
              </Btn>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2">
                {(['ORDER', 'CHAOS'] as const).map((team) => {
                  const down = timers?.inhibitors.find((inhibitor) => inhibitor.team === team)
                  return (
                    <div key={team} className="admin-row">
                      <Diamond size={14} style={{ color: TEAM_COLOR[team] }} fill={down ? 'transparent' : TEAM_COLOR[team]} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-text">{TEAM_NAME[team]} inhibitor</div>
                        <div className="text-[11px] text-muted">
                          {down ? `down · overlay says back in ${clock(down.respawnAt - now)}` : 'standing'}
                        </div>
                      </div>
                      <button className="admin-chip" onClick={() => simAction('Destroying', { type: 'inhibitor', team, event: 'killed' })}>
                        destroy
                      </button>
                      <button className="admin-chip" onClick={() => simAction('Warning', { type: 'inhibitor', team, event: 'soon' })}>
                        warn
                      </button>
                      <button
                        className="admin-chip"
                        onClick={() => simAction('Respawning', { type: 'inhibitor', team, event: 'respawned' })}
                      >
                        back
                      </button>
                    </div>
                  )
                })}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                {sim.pads.map((pad) => {
                  const view = relicView(pad.id)
                  const first = pad.kind === 'base' ? 0 : RELIC_FIRST[pad.kind]
                  const takenNow = pad.takenAt !== null && sim.gameTime < pad.takenAt + RELIC_RESPAWN
                  const canTake = sim.gameTime >= first && !takenNow
                  const status = !view
                    ? 'not on the overlay'
                    : view.state === 'spawn' && view.at !== null
                      ? `overlay: back in ${clock(view.at - now)}`
                      : view.state === 'up'
                        ? 'overlay: up'
                        : 'overlay: not seen yet'
                  return (
                    <div key={pad.id} className="admin-row">
                      <span className="admin-dot" style={{ background: TEAM_COLOR[pad.team] }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-text">
                          {TEAM_NAME[pad.team]} {pad.kind} relic
                        </div>
                        <div className="text-[11px] text-muted">{status}</div>
                      </div>
                      <button
                        className="admin-chip"
                        disabled={!canTake}
                        onClick={() => simAction('Taking relic', { type: 'relicTaken', padId: pad.id })}
                      >
                        take
                      </button>
                    </div>
                  )
                })}
                {!sim.pads.length && (
                  <p className="text-xs text-gold">No relic pads known for map {sim.options.map} – measure them below.</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {[15, 60, 240].map((seconds) => (
                  <Btn
                    key={seconds}
                    icon={<FastForward size={15} />}
                    onClick={() => simAction(`Skipping ${seconds} s`, { type: 'skip', seconds })}
                  >
                    +{seconds < 60 ? `${seconds} s` : `${seconds / 60} min`}
                  </Btn>
                ))}
                <span className="flex-1" />
                <Btn
                  danger
                  icon={<Square size={14} />}
                  onClick={() =>
                    action.run('Stopping', async () => {
                      await admin?.simStop()
                      setSim(null)
                    })
                  }
                >
                  End game
                </Btn>
              </div>
              {sim.inhibitorEvents.length > 0 && (
                <div className="admin-events">
                  {sim.inhibitorEvents.slice(-6).map((event, i) => (
                    <div key={i}>
                      <b>{clock(event.time)}</b> {event.inhibitor.includes('_T1_') ? 'Blue' : 'Red'} inhibitor {event.type}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Relic pad calibration
// ---------------------------------------------------------------------------

type Pad = AdminRelicPad & { seen: AdminRelicSeen | null }

const SEEN_LABEL: Record<AdminRelicSeen, string> = { present: 'relic seen', absent: 'no relic', unclear: 'unclear' }

function toDataUrl(image: NonNullable<AdminMinimapSnapshot['image']>): string {
  const canvas = document.createElement('canvas')
  canvas.width = image.width
  canvas.height = image.height
  const pixels = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)
  canvas.getContext('2d')!.putImageData(pixels, 0, 0)
  return canvas.toDataURL()
}

function padId(pads: Pad[], team: AdminRelicPad['team'], kind: AdminRelicPad['kind']): string {
  const base = `${team === 'ORDER' ? 'order' : 'chaos'}-${kind}`
  if (!pads.some((pad) => pad.id === base)) return base
  let n = 2
  while (pads.some((pad) => pad.id === `${base}-${n}`)) n++
  return `${base}-${n}`
}

function CalibrationCard() {
  const admin = api.admin
  const action = useAction()
  const [snapshot, setSnapshot] = useState<AdminMinimapSnapshot | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [map, setMap] = useState(12)
  const [pads, setPads] = useState<Pad[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [team, setTeam] = useState<AdminRelicPad['team']>('ORDER')
  const [kind, setKind] = useState<AdminRelicPad['kind']>('base')
  const [delay, setDelay] = useState(5)
  const [countdown, setCountdown] = useState(0)
  const [dirty, setDirty] = useState(false)

  const take = (wait: number) =>
    action.run('Taking a snapshot', async () => {
      if (!admin) return
      for (let left = wait; left > 0; left--) {
        setCountdown(left)
        await sleep(1000)
      }
      setCountdown(0)
      const result = await admin.minimapSnapshot()
      setSnapshot(result)
      setImageUrl(result.image ? toDataUrl(result.image) : null)
      setMap(result.map)
      setPads(result.pads)
      setSelected(null)
      setDirty(false)
      if (!result.image) throw new Error(result.error ?? 'No picture')
      return `${result.image.width}×${result.image.height} px of display ${result.display.id}${result.inGame ? ` · in game on map ${result.map}` : ' · no game running'}`
    })

  const update = (next: Pad[]) => {
    setPads(next)
    setDirty(true)
    void admin
      ?.classifyPads(next)
      .then((seen) => setPads((current) => (current === next ? next.map((pad, i) => ({ ...pad, seen: seen[i] ?? null })) : current)))
  }

  const place = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const pos = {
      x: Math.round(((event.clientX - box.left) / box.width) * 1000) / 1000,
      y: Math.round(((event.clientY - box.top) / box.height) * 1000) / 1000
    }
    if (selected) update(pads.map((pad) => (pad.id === selected ? { ...pad, pos } : pad)))
    else {
      const id = padId(pads, team, kind)
      update([...pads, { id, team, kind, pos, seen: null }])
    }
  }

  const patch = snapshot?.patch ?? 0.065
  const source = dirty
    ? 'unsaved changes'
    : snapshot
      ? { measured: 'measured with this tool', 'built-in': 'built into the app', none: 'none known yet' }[snapshot.source]
      : null

  return (
    <Card
      icon={<Crosshair size={18} />}
      title="Relic pad calibration"
      hint={
        <>
          For maps whose relic pads the app doesn't know yet (Butcher's Bridge, Koeshin's Crossing, the Cafe Cuties base relics). Take a
          snapshot during a game – the map number comes from the game – then click where the relics sit. Each square is what the detection
          looks at; it should read <i>relic seen</i> while a relic is up and <i>no relic</i> once it's taken.
        </>
      }
      wide
      action={action}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,420px)_1fr]">
        <div>
          <div
            className={`admin-minimap ${imageUrl ? 'cursor-crosshair' : ''}`}
            onClick={imageUrl ? place : undefined}
            style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined}
          >
            {!imageUrl && (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted">
                <Camera size={22} />
                {countdown ? (
                  <span className="font-display text-3xl font-extrabold text-text">{countdown}</span>
                ) : (
                  'No snapshot yet. With a delay you have time to switch back to the game.'
                )}
              </div>
            )}
            {imageUrl &&
              pads.map((pad) => (
                <button
                  key={pad.id}
                  className={`admin-pad ${pad.id === selected ? 'is-selected' : ''} ${pad.seen ? `seen-${pad.seen}` : ''}`}
                  style={{
                    left: `${pad.pos.x * 100}%`,
                    top: `${pad.pos.y * 100}%`,
                    width: `${patch * 100}%`,
                    height: `${patch * 100}%`,
                    borderColor: TEAM_COLOR[pad.team]
                  }}
                  title={`${pad.id} · ${pad.seen ? SEEN_LABEL[pad.seen] : '?'}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelected(pad.id === selected ? null : pad.id)
                  }}
                >
                  <span>{pad.kind[0].toUpperCase()}</span>
                </button>
              ))}
            {countdown > 0 && imageUrl && <div className="admin-countdown">{countdown}</div>}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn primary icon={<Camera size={15} />} onClick={() => take(delay)} disabled={!!action.busy}>
              Snapshot
            </Btn>
            <Segmented
              value={String(delay) as '0' | '3' | '5' | '10'}
              options={[
                ['0', 'now'],
                ['3', '3 s'],
                ['5', '5 s'],
                ['10', '10 s']
              ]}
              onChange={(value) => setDelay(Number(value))}
            />
          </div>
        </div>

        <div className="space-y-4">
          {snapshot && (
            <div className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs text-muted sm:grid-cols-3">
              <div>
                Display <b className="text-text">{snapshot.display.id}</b> ({snapshot.display.width}×{snapshot.display.height} @
                {snapshot.display.scaleFactor}×)
              </div>
              <div>
                Game: <b className="text-text">{snapshot.inGame ? `running${snapshot.mapName ? ` (${snapshot.mapName})` : ''}` : 'none'}</b>
              </div>
              <div>
                Pads: <b className={dirty ? 'text-gold' : 'text-text'}>{source}</b>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <NumberField
              label="Map number"
              value={map}
              min={1}
              max={9999}
              onChange={(value) => {
                setMap(value)
                setDirty(true)
              }}
            />
            <label className="flex flex-col gap-1 text-[11px] font-semibold text-muted">
              New pad
              <span className="flex gap-2">
                <Segmented
                  value={team}
                  options={[
                    ['ORDER', 'Blue'],
                    ['CHAOS', 'Red']
                  ]}
                  onChange={setTeam}
                />
                <Segmented
                  value={kind}
                  options={[
                    ['outer', 'Outer'],
                    ['inner', 'Inner'],
                    ['base', 'Base']
                  ]}
                  onChange={setKind}
                />
              </span>
            </label>
          </div>
          <p className="text-xs text-muted">
            {selected ? (
              <>
                Click the map to move <b className="text-text">{selected}</b>, or{' '}
                <button className="admin-link" onClick={() => setSelected(null)}>
                  stop moving
                </button>
                .
              </>
            ) : (
              'Click the map to add a pad, click a pad to move it.'
            )}
          </p>

          <div className="admin-table">
            {pads.map((pad) => (
              <div
                key={pad.id}
                className={`admin-table-row ${pad.id === selected ? 'is-selected' : ''}`}
                onClick={() => setSelected(pad.id === selected ? null : pad.id)}
              >
                <span className="admin-dot" style={{ background: TEAM_COLOR[pad.team] }} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text">{pad.id}</span>
                <span className="w-24 font-mono text-[11px] text-muted">
                  {pad.pos.x.toFixed(3)}, {pad.pos.y.toFixed(3)}
                </span>
                <span className={`admin-seen ${pad.seen ? `seen-${pad.seen}` : ''}`}>{pad.seen ? SEEN_LABEL[pad.seen] : '–'}</span>
                <button
                  className="admin-icon-btn"
                  title="Remove"
                  onClick={(event) => {
                    event.stopPropagation()
                    if (selected === pad.id) setSelected(null)
                    update(pads.filter((other) => other.id !== pad.id))
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {!pads.length && <div className="p-3 text-xs text-muted">No pads for map {map}.</div>}
          </div>

          <div className="flex flex-wrap gap-2">
            <Btn
              primary
              icon={<Save size={15} />}
              disabled={!dirty || !pads.length}
              onClick={() =>
                action.run('Saving', async () => {
                  await admin?.savePads(
                    map,
                    pads.map(({ id, team: padTeam, kind: padKind, pos }) => ({ id, team: padTeam, kind: padKind, pos }))
                  )
                  setDirty(false)
                  setSnapshot((current) => (current ? { ...current, map, source: 'measured' } : current))
                  return `${pads.length} pads saved for map ${map} – used from the next update on`
                })
              }
            >
              Save for map {map}
            </Btn>
            <Btn
              icon={<Eye size={15} />}
              disabled={dirty}
              title={dirty ? 'Save first' : undefined}
              onClick={() => action.run('Showing pads', async () => void (await admin?.showMinimapDemo('pads', map)))}
            >
              Show on the game minimap
            </Btn>
            <Btn
              danger
              icon={<RotateCcw size={15} />}
              onClick={() =>
                action.run('Resetting', async () => {
                  await admin?.savePads(map, null)
                  setDirty(false)
                  return `Map ${map} uses the built-in pads again (if there are any) – take a new snapshot to see them`
                })
              }
            >
              Built-in pads
            </Btn>
          </div>
        </div>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Log and raw data
// ---------------------------------------------------------------------------

function LogCard() {
  const admin = api.admin
  const action = useAction()
  const [follow, setFollow] = useState(true)
  const [lines, setLines] = useState<string[]>([])
  const [raw, setRaw] = useState<'off' | 'live' | 'timers'>('off')
  const [rawText, setRawText] = useState('')
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!follow || !admin) return
    let active = true
    const load = () =>
      void admin
        .log(150)
        .then((next) => active && setLines(next))
        .catch(() => undefined)
    load()
    const timer = setInterval(load, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [follow, admin])
  useEffect(() => {
    const element = logRef.current
    if (element && follow) element.scrollTop = element.scrollHeight
  }, [lines, follow])
  useEffect(() => {
    if (raw === 'off') return
    let active = true
    const load = async () => {
      const value = raw === 'live' ? await api.liveGame() : await api.getMapTimers()
      if (active)
        setRawText(value ? JSON.stringify(value, null, 2) : `null – ${raw === 'live' ? 'no game running' : 'no map timers right now'}`)
    }
    void load()
    const timer = setInterval(() => void load(), 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [raw])

  return (
    <Card
      icon={<ScrollText size={18} />}
      title="Log & raw data"
      hint="The same overlay.log your friends can send you (Settings › Diagnostics), live."
      wide
      action={action}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Btn icon={follow ? <Square size={13} /> : <Play size={15} />} onClick={() => setFollow(!follow)}>
          {follow ? 'Pause' : 'Follow'}
        </Btn>
        <Btn
          icon={<Copy size={15} />}
          onClick={() =>
            action.run('Copying', async () => {
              await navigator.clipboard.writeText(lines.join('\n'))
              return `${lines.length} lines copied`
            })
          }
        >
          Copy
        </Btn>
        <Btn icon={<FolderOpen size={15} />} onClick={() => action.run('Opening', async () => void (await api.openDiagnosticsFolder()))}>
          Log folder
        </Btn>
        <span className="flex-1" />
        <Segmented
          value={raw}
          options={[
            ['off', 'Log only'],
            ['live', 'Live data'],
            ['timers', 'Map timers']
          ]}
          onChange={setRaw}
        />
      </div>
      <div className={`grid gap-3 ${raw === 'off' ? '' : 'lg:grid-cols-2'}`}>
        <pre ref={logRef} className="admin-pre">
          {lines.length ? lines.join('\n') : 'Nothing logged yet.'}
        </pre>
        {raw !== 'off' && <pre className="admin-pre">{rawText}</pre>}
      </div>
    </Card>
  )
}

export function Admin() {
  return (
    <div className="page-enter mx-auto max-w-[1180px] p-8">
      <PageHeader title="Admin">
        <span className="admin-badge">
          <span className="admin-badge-dot" /> Developer build only · not in the installer
        </span>
      </PageHeader>
      {!api.admin && (
        <div className="panel mb-5 p-4 text-sm text-gold">
          The desktop half of the admin tool isn't loaded – start the app with <code>npm run dev</code>.
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        <FlightsCard />
        <OverlaysCard />
        <SimCard />
        <CalibrationCard />
        <LogCard />
      </div>
    </div>
  )
}
