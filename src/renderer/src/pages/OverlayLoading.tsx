import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { LoadingPlayer, LoadingState } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ChampIcon } from '@/components/icons'
import { CosmosBackground, cosmicSeed } from '@/components/CosmosBackground'
import { Logo } from '@/components/Layout'

const MODE_LABEL = { mayhem: 'ARAM: Mayhem', aram: 'ARAM' } as const

// Example lobby for screenshots and the web demo
const DEMO: LoadingState = {
  mode: 'mayhem',
  players: (
    [
      ['Axel Fungus', 412, true, true, false, 23, 14],
      ['blackbird', 86, true, false, true, 31, 15],
      ['Doulul', 99, true, false, true, 12, 8],
      ['Toni', 222, true, false, false, 0, 0],
      ['ratio', 103, true, false, false, 44, 19],
      ['simwai', 157, false, false, false, 17, 11],
      ['Psychedelic Bard', 432, false, false, false, 52, 30],
      ['Guido', 25, false, false, false, 9, 3],
      ['Splitter', 11, false, false, false, 28, 13],
      ['NOATAQQ', 54, false, false, false, 6, 4]
    ] as const
  ).map(([name, championId, ally, me, premade, games, wins], i) => ({
    puuid: String(i),
    riotId: `${name}#EUW`,
    championId,
    ally,
    me,
    premade,
    record: { games, wins },
    loading: false
  }))
}

/** Name colour: you in gold, your premades in blue, everyone else white. */
const nameClass = (player: LoadingPlayer): string => (player.me ? 'text-gold' : player.premade ? 'text-[#7cc4ff]' : 'text-text')

function Row({ p }: { p: LoadingPlayer }) {
  const winRate = p.record && p.record.games ? (p.record.wins / p.record.games) * 100 : null
  const color = winRate === null ? '#a39cc0' : winRate >= 55 ? '#54f0a4' : winRate <= 45 ? '#ff6b8b' : '#f1edfb'
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-black/35 px-2 py-1.5">
      <ChampIcon id={p.championId} size={30} tooltip={false} className="rounded-lg" />
      <span className={`w-[150px] truncate text-[13px] font-semibold ${nameClass(p)}`}>{p.riotId.split('#')[0] || '—'}</span>
      <span className="flex flex-1 items-center gap-2">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <span className="block h-full rounded-full" style={{ width: `${winRate ?? 0}%`, background: color }} />
        </span>
        {p.loading ? (
          <Loader2 size={13} className="animate-spin text-muted" />
        ) : (
          <span className="w-[86px] text-right text-[12px] font-bold tabular-nums" style={{ color }}>
            {winRate === null ? 'no games' : `${winRate.toFixed(0)}%`}
            {p.record?.games ? <span className="ml-1 font-medium text-muted">{p.record.games} G</span> : null}
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * Loading-screen panel: every player's recent win rate in this mode, from their client match
 * history. Shown automatically while the game loads, hidden with Space, gone once the game starts.
 */
export function OverlayLoading() {
  const { settings } = useApp()
  const [state, setState] = useState<LoadingState | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    // '#/overlay/loading?demo' shows the example data (screenshots, web demo)
    if (window.location.hash.includes('demo')) setState(DEMO)
    return api.on('loading', setState)
  }, [])

  const seed = state ? cosmicSeed(state.seed ?? state.players.map((player) => player.puuid).join()) : 0
  if (!state) return null
  const staticBackground = settings?.ui.background === 'static'
  const allies = state.players.filter((player) => player.ally)
  const enemies = state.players.filter((player) => !player.ally)
  return (
    <div
      className="fixed inset-1 overflow-hidden rounded-[22px] border border-white/15 shadow-2xl select-none"
      style={{ transform: 'translateZ(0)' }}
    >
      {/* Same sky as the planet the app flew to when the match was accepted */}
      <CosmosBackground seed={seed} mode={staticBackground ? 'static' : 'animated'} inGame={false} />
      <div className="relative flex h-full flex-col bg-black/25 p-4">
        <div className="mb-3 flex items-center gap-2.5">
          <Logo size={24} />
          <span className="font-display text-lg font-extrabold">
            <span className="iridescent-text">{MODE_LABEL[state.mode]}</span>
          </span>
          <span className="text-xs text-muted">win rate in recent games (client match history)</span>
          <span className="ml-auto rounded-md bg-black/40 px-2 py-0.5 text-[11px] text-muted">
            <kbd className="font-bold text-text">Space</kbd> hide / show
          </span>
        </div>
        <div className="grid flex-1 grid-cols-2 gap-4">
          {[
            ['Your team', allies, '#4ea3ff'],
            ['Enemy team', enemies, '#ff5a78']
          ].map(([title, list, color]) => (
            <div key={title as string} className="flex flex-col gap-1.5">
              <div className="text-[11px] font-bold tracking-wider uppercase" style={{ color: color as string }}>
                {title as string}
              </div>
              {(list as LoadingPlayer[]).map((player) => (
                <Row key={player.puuid} p={player} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
