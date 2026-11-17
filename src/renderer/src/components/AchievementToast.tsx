import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { AchievementState } from '@shared/types'
import { api } from '@/lib/api'
import { RANK_CSS } from '@shared/achievements'
import { ConstellationReveal, REVEAL_S } from './ConstellationReveal'

/** How long one toast stays. */
const SHOW_MS = (REVEAL_S + 4) * 1000

/** "New constellation discovered: …" with the constellation drawing itself. Pure presentation. */
export function DiscoveryCard({
  achievement,
  animate = true,
  compact = false
}: {
  achievement: AchievementState
  animate?: boolean
  compact?: boolean
}) {
  const accent = achievement.rank === 'cosmic' ? '#b58bff' : RANK_CSS[achievement.rank]
  return (
    <div className="flex items-center gap-3">
      <ConstellationReveal id={achievement.id} rank={achievement.rank} size={compact ? 64 : 84} animate={animate} className="shrink-0" />
      <div className="min-w-0">
        <div className="text-[10px] font-bold tracking-[0.2em] uppercase" style={{ color: accent }}>
          New constellation discovered
        </div>
        <div className="font-display text-lg leading-tight font-extrabold">
          <span className={achievement.rank === 'cosmic' ? 'iridescent-text' : ''}>{achievement.name}</span>
        </div>
        <div className="text-xs leading-snug text-muted">{achievement.description}</div>
      </div>
    </div>
  )
}

/**
 * Toasts for freshly unlocked achievements, one after the other, bottom right of the main window.
 * The game page of the game that unlocked them shows them itself, so there no toast is needed.
 */
export function AchievementToasts() {
  const [queue, setQueue] = useState<AchievementState[]>([])
  const location = useLocation()
  const navigate = useNavigate()
  const path = useRef(location.pathname)
  path.current = location.pathname

  useEffect(
    () =>
      api.on('achievementsUnlocked', async (ids) => {
        const all = await api.getAchievements().catch(() => [] as AchievementState[])
        const fresh = all.filter((achievement) => ids.includes(achievement.id))
        // the game page that unlocked them plays the animation itself
        const shownThere = fresh.filter((achievement) => achievement.gameId !== null && path.current === `/games/${achievement.gameId}`)
        const toast = fresh.filter((achievement) => !shownThere.includes(achievement))
        setQueue((current) => [...current, ...toast.filter((achievement) => !current.some((queued) => queued.id === achievement.id))])
      }),
    []
  )

  const current = queue[0]
  const next = useCallback(() => setQueue((list) => list.slice(1)), [])
  useEffect(() => {
    if (!current) return
    void api.markAchievementsSeen([current.id]).catch(() => undefined)
    const timer = setTimeout(next, SHOW_MS)
    return () => clearTimeout(timer)
  }, [current, next])

  if (!current) return null
  return (
    <button
      key={current.id}
      className="achievement-toast fixed right-5 bottom-5 z-[150] w-[380px] rounded-2xl border border-white/15 bg-[#0e0820]/92 p-3 text-left shadow-[0_24px_60px_-12px_rgb(0_0_0/0.9)] backdrop-blur"
      onClick={() => {
        next()
        navigate('/games/achievements')
      }}
    >
      <DiscoveryCard achievement={current} />
      {queue.length > 1 && <span className="absolute top-2 right-3 text-[10px] text-muted">+{queue.length - 1} more</span>}
    </button>
  )
}
