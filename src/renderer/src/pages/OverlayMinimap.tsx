import { useEffect, useState } from 'react'
import type { MinimapState } from '@shared/types'
import { api } from '@/lib/api'

const TEAM_COLOR = { ORDER: '#4ea3ff', CHAOS: '#ff5a5a' } as const

const fmt = (s: number): string => {
  const v = Math.max(0, Math.ceil(s))
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`
}

/**
 * Minimap window: inhibitor respawn timers next to the inhibitor icons. Counts down locally,
 * re-renders once per second and has nothing animated.
 */
export function OverlayMinimap() {
  const [state, setState] = useState<MinimapState | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    const off = api.on('minimap', setState)
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [])

  const local = state?.local
  if (!state || !local) return null
  const now = state.gameTime + (Date.now() - state.measuredAt) / 1000

  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      {state.relics.map((r) => {
        // before the first spawn the game shows its own countdown on the pad – only respawns here
        const first = r.at === (r.kind === 'outer' ? 105 : 150)
        if (r.state !== 'spawn' || r.at === null || first) return null
        const left = r.at - now
        if (left <= 0) return null
        return (
          <div
            key={r.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: local.x + r.pos.x * local.w, top: local.y + r.pos.y * local.h }}
          >
            <span className={`mm-chip mm-relic ${left < 10 ? 'mm-soon' : ''}`} style={{ '--team': '#5dff9b' } as React.CSSProperties}>
              {fmt(left)}
            </span>
          </div>
        )
      })}
      {state.inhibitors.map((inh, i) => {
        const left = inh.respawnAt - now
        if (left <= 0) return null
        return (
          <div
            key={i}
            className="absolute -translate-x-1/2"
            // just below the inhibitor icon, so a label drawn by the game next to it stays readable
            style={{ left: local.x + inh.pos.x * local.w, top: local.y + inh.pos.y * local.h + local.h * 0.035 }}
          >
            <span className={`mm-chip ${left < 30 ? 'mm-soon' : ''}`} style={{ '--team': TEAM_COLOR[inh.team] } as React.CSSProperties}>
              {fmt(left)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
