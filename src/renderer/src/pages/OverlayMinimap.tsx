import { useEffect, useState, type CSSProperties } from 'react'
import type { MinimapState } from '@shared/types'
import { api } from '@/lib/api'

const TEAM_COLOR = { ORDER: '#5aa9ff', CHAOS: '#ff5c6c' } as const
const RELIC_COLOR = '#5dff9b'
/** used for the ring when the start of a relic timer isn't known */
const RELIC_RESPAWN = 92.5

const formatTimer = (seconds: number): string => {
  const total = Math.max(0, Math.ceil(seconds))
  return total < 60 ? String(total) : `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Example timers for the web demo and screenshots ('#/overlay/minimap?demo'). */
function demoState(): MinimapState {
  const now = 400
  return {
    gameTime: now,
    measuredAt: Date.now(),
    rect: { x: 0, y: 0, w: 0, h: 0 },
    inhibitors: [
      { team: 'ORDER', respawnAt: now + 22, since: now - 228, pos: { x: 0.24, y: 0.748 } },
      { team: 'CHAOS', respawnAt: now + 171, since: now - 79, pos: { x: 0.754, y: 0.254 } }
    ],
    relics: [
      { id: 'order-inner', team: 'ORDER', kind: 'inner', pos: { x: 0.37, y: 0.692 }, state: 'spawn', at: now + 64, since: now - 28.5 },
      { id: 'order-outer', team: 'ORDER', kind: 'outer', pos: { x: 0.462, y: 0.594 }, state: 'up', at: null },
      { id: 'chaos-outer', team: 'CHAOS', kind: 'outer', pos: { x: 0.589, y: 0.472 }, state: 'spawn', at: now + 7, since: now - 85.5 },
      { id: 'chaos-inner', team: 'CHAOS', kind: 'inner', pos: { x: 0.686, y: 0.386 }, state: 'spawn', at: now + 41, since: now - 51.5 }
    ]
  }
}

/** Ring that fills up until the relic is back, with the seconds left in the middle. */
function RelicTimer({ remaining, total, size }: { remaining: number; total: number; size: number }) {
  const progress = Math.min(1, Math.max(0, 1 - remaining / total))
  const radius = size / 2 - 2
  const circumference = 2 * Math.PI * radius
  const soon = remaining < 10
  return (
    <span className={`mm-relic ${soon ? 'mm-soon' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.37) }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} className="mm-ring-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          className="mm-ring"
          style={{ strokeDasharray: `${circumference * progress} ${circumference}` }}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="mm-relic-time">{formatTimer(remaining)}</span>
    </span>
  )
}

/** Crystal icon, team colour and time, with a bar that fills up until the inhibitor is back. */
function InhibitorTimer({ remaining, total, team }: { remaining: number; total: number; team: 'ORDER' | 'CHAOS' }) {
  const progress = Math.min(1, Math.max(0, 1 - remaining / total))
  return (
    <span className={`mm-inhib ${remaining < 30 ? 'mm-soon' : ''}`} style={{ '--team': TEAM_COLOR[team] } as CSSProperties}>
      <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden className="mm-inhib-icon">
        <path d="M4 0 8 4 4 10 0 4Z" />
      </svg>
      <span className="mm-inhib-time">{formatTimer(remaining)}</span>
      <span className="mm-inhib-bar" style={{ transform: `scaleX(${progress})` }} />
    </span>
  )
}

/**
 * Minimap window: health relic and inhibitor respawn timers drawn on the minimap. Counts down
 * locally and re-renders once per second; nothing is animated, so the transparent window over the
 * game is only repainted once a second.
 */
export function OverlayMinimap() {
  const [state, setState] = useState<MinimapState | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    const unsubscribe = api.on('minimap', setState)
    if (window.location.hash.includes('demo')) {
      const margin = 36
      setState({ ...demoState(), local: { x: margin, y: margin, w: window.innerWidth - margin * 2, h: window.innerHeight - margin * 2 } })
    }
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [])

  const local = state?.local
  if (!state || !local) return null
  const now = state.gameTime + (Date.now() - state.measuredAt) / 1000
  const ring = Math.round(Math.min(34, Math.max(22, local.w * 0.088)))

  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      {state.relics.map((relic) => {
        // The game draws its own countdown on the pad before the first spawn (1:45 outer, 2:30 inner),
        // so we only show respawns
        const isFirstSpawn = relic.kind !== 'base' && relic.at === (relic.kind === 'outer' ? 105 : 150) && !relic.since
        if (relic.state !== 'spawn' || relic.at === null || isFirstSpawn) return null
        const remaining = relic.at - now
        if (remaining <= 0) return null
        const total = relic.since != null ? relic.at - relic.since : RELIC_RESPAWN
        return (
          <div
            key={relic.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: local.x + relic.pos.x * local.w, top: local.y + relic.pos.y * local.h, '--relic': RELIC_COLOR } as CSSProperties}
          >
            <RelicTimer remaining={remaining} total={total} size={ring} />
          </div>
        )
      })}
      {state.inhibitors.map((inhibitor, i) => {
        const remaining = inhibitor.respawnAt - now
        if (remaining <= 0) return null
        const total = inhibitor.since != null ? inhibitor.respawnAt - inhibitor.since : 250
        return (
          <div
            key={i}
            className="absolute -translate-x-1/2"
            // Sits just below the inhibitor icon so the game's own label next to it stays readable. Red's
            // inner relic is just below-left of its inhibitor, so that label moves a little to the right.
            style={{
              left: local.x + inhibitor.pos.x * local.w + (inhibitor.team === 'CHAOS' ? local.w * 0.06 : 0),
              top: local.y + inhibitor.pos.y * local.h + local.h * 0.035
            }}
          >
            <InhibitorTimer remaining={remaining} total={total} team={inhibitor.team} />
          </div>
        )
      })}
    </div>
  )
}
