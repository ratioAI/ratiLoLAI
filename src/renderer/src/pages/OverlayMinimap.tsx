import { useEffect, useState } from 'react'
import type { MinimapState } from '@shared/types'
import { api } from '@/lib/api'

const TEAM_COLOR = { ORDER: '#4ea3ff', CHAOS: '#ff5a5a' } as const

const formatTimer = (seconds: number): string => {
  const total = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Minimap window: health relic and inhibitor respawn timers drawn on the minimap. Counts down
 * locally and re-renders once per second, nothing is animated.
 */
export function OverlayMinimap() {
  const [state, setState] = useState<MinimapState | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    const unsubscribe = api.on('minimap', setState)
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [])

  const local = state?.local
  if (!state || !local) return null
  const now = state.gameTime + (Date.now() - state.measuredAt) / 1000

  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      {state.relics.map((relic) => {
        // The game draws its own countdown on the pad before the first spawn (1:45 outer, 2:30 inner),
        // so we only show respawns
        const isFirstSpawn = relic.at === (relic.kind === 'outer' ? 105 : 150)
        if (relic.state !== 'spawn' || relic.at === null || isFirstSpawn) return null
        const remaining = relic.at - now
        if (remaining <= 0) return null
        return (
          <div
            key={relic.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: local.x + relic.pos.x * local.w, top: local.y + relic.pos.y * local.h }}
          >
            <span className={`mm-chip mm-relic ${remaining < 10 ? 'mm-soon' : ''}`} style={{ '--team': '#5dff9b' } as React.CSSProperties}>
              {formatTimer(remaining)}
            </span>
          </div>
        )
      })}
      {state.inhibitors.map((inhibitor, i) => {
        const remaining = inhibitor.respawnAt - now
        if (remaining <= 0) return null
        return (
          <div
            key={i}
            className="absolute -translate-x-1/2"
            // Sits just below the inhibitor icon so the game's own label next to it stays readable
            style={{ left: local.x + inhibitor.pos.x * local.w, top: local.y + inhibitor.pos.y * local.h + local.h * 0.035 }}
          >
            <span
              className={`mm-chip ${remaining < 30 ? 'mm-soon' : ''}`}
              style={{ '--team': TEAM_COLOR[inhibitor.team] } as React.CSSProperties}
            >
              {formatTimer(remaining)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
