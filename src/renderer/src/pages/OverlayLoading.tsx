import { useEffect, useState, type CSSProperties } from 'react'
import { Link2, Loader2 } from 'lucide-react'
import type { LoadingPlayer, LoadingState } from '@shared/types'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ChampIcon } from '@/components/icons'
import { CosmosBackground, cosmicSeed } from '@/components/CosmosBackground'
import { Logo } from '@/components/Layout'

const MODE_LABEL = { mayhem: 'ARAM: Mayhem', aram: 'ARAM' } as const
const TEAM = {
  ally: { label: 'Your team', color: '#5aa9ff' },
  enemy: { label: 'Enemy team', color: '#ff5c6c' }
} as const
/** below this many games a win rate says little, so it is shown dimmed */
const FEW_GAMES = 5

/** Example lobby for screenshots, the web demo and the admin tool. */
export const DEMO_LOBBY: LoadingState = {
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
      ['Guido', 25, false, false, false, 3, 1],
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

const winRateOf = (player: LoadingPlayer): number | null =>
  player.record && player.record.games ? (player.record.wins / player.record.games) * 100 : null

const rateColor = (winRate: number | null): string =>
  winRate === null ? '#8f88ad' : winRate >= 55 ? '#54f0a4' : winRate <= 45 ? '#ff6b8b' : '#f1edfb'

/** Average win rate of a team, weighted by games, from the players that have games. */
function teamWinRate(players: LoadingPlayer[]): { rate: number | null; games: number } {
  const games = players.reduce((sum, player) => sum + (player.record?.games ?? 0), 0)
  const wins = players.reduce((sum, player) => sum + (player.record?.wins ?? 0), 0)
  return { rate: games ? (wins / games) * 100 : null, games }
}

function Row({ player, side }: { player: LoadingPlayer; side: 'ally' | 'enemy' }) {
  const winRate = winRateOf(player)
  const games = player.record?.games ?? 0
  const wins = player.record?.wins ?? 0
  const color = rateColor(winRate)
  const few = games > 0 && games < FEW_GAMES
  const team = TEAM[side]
  const mirrored = side === 'enemy'
  const name = player.riotId.split('#')[0] || '—'
  return (
    <div
      className={`ld-row ${mirrored ? 'ld-row-enemy' : ''} ${player.me ? 'ld-row-me' : ''}`}
      style={{ '--team': team.color } as CSSProperties}
    >
      <ChampIcon id={player.championId} size={30} tooltip={false} className="ld-champ" />
      <div className="ld-who">
        <div className="ld-name">
          <span className={player.me ? 'text-gold' : player.premade ? 'text-[#8fd0ff]' : 'text-text'}>{name}</span>
          {player.me && <span className="ld-tag ld-tag-me">you</span>}
          {player.premade && !player.me && (
            <span className="ld-tag" title="In a party with you">
              <Link2 size={10} /> party
            </span>
          )}
        </div>
        {/* wins and losses as one split bar */}
        <div className="ld-split" title={games ? `${wins} wins, ${games - wins} losses` : undefined}>
          {games > 0 && (
            <>
              <span className="ld-split-win" style={{ flexGrow: wins }} />
              <span className="ld-split-loss" style={{ flexGrow: games - wins }} />
            </>
          )}
        </div>
      </div>
      <div className="ld-stat">
        {player.loading ? (
          <Loader2 size={14} className="animate-spin text-muted" />
        ) : winRate === null ? (
          <span className="ld-none">no games</span>
        ) : (
          <>
            <span className="ld-rate" style={{ color, opacity: few ? 0.6 : 1 }}>
              {winRate.toFixed(0)}
              <small>%</small>
            </span>
            <span className="ld-games">
              {wins}W {games - wins}L{few ? ' · few' : ''}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Loading-screen panel: every player's recent win rate in this mode, from their client match
 * history, your team left and the enemies mirrored on the right. Shown automatically while the game
 * loads, hidden with Space, gone once the game starts.
 */
export function OverlayLoading() {
  const { settings } = useApp()
  const [state, setState] = useState<LoadingState | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    // '#/overlay/loading?demo' shows the example data (screenshots, web demo)
    if (window.location.hash.includes('demo')) setState(DEMO_LOBBY)
    return api.on('loading', setState)
  }, [])

  const seed = state ? cosmicSeed(state.seed ?? state.players.map((player) => player.puuid).join()) : 0
  if (!state) return null
  const staticBackground = settings?.ui.background === 'static'
  const allies = state.players.filter((player) => player.ally)
  const enemies = state.players.filter((player) => !player.ally)
  const ours = teamWinRate(allies)
  const theirs = teamWinRate(enemies)
  return (
    <div className="ld-panel fixed inset-1 overflow-hidden select-none" style={{ transform: 'translateZ(0)' }}>
      {/* Same sky as the planet the app flew to when the match was accepted, dimmed behind the table */}
      <CosmosBackground seed={seed} mode={staticBackground ? 'static' : 'calm'} inGame={false} />
      <div className="ld-shade" />
      <div className="relative flex h-full flex-col px-5 pt-3 pb-3.5">
        <div className="mb-2.5 flex items-center gap-2.5">
          <Logo size={22} />
          <span className="font-display text-[17px] font-extrabold tracking-tight">
            <span className="iridescent-text">{MODE_LABEL[state.mode]}</span>
          </span>
          <span className="text-[11px] tracking-wide text-white/45 uppercase">recent win rate · client match history</span>
          <span className="ml-auto rounded-md border border-white/10 bg-black/40 px-2 py-0.5 text-[11px] text-white/55">
            <kbd className="font-bold text-white/85">Space</kbd> hide / show
          </span>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[1fr_auto_1fr] gap-4">
          <div className="flex flex-col gap-1">
            <div className="ld-team" style={{ color: TEAM.ally.color }}>
              {TEAM.ally.label}
            </div>
            {allies.map((player) => (
              <Row key={player.puuid} player={player} side="ally" />
            ))}
          </div>
          {/* team averages face each other in the middle */}
          <div className="flex w-[76px] flex-col items-center justify-center gap-1.5 pt-5">
            <span className="ld-avg" style={{ color: rateColor(ours.rate) }}>
              {ours.rate === null ? '–' : `${ours.rate.toFixed(0)}%`}
            </span>
            <span className="ld-vs">VS</span>
            <span className="ld-avg" style={{ color: rateColor(theirs.rate) }}>
              {theirs.rate === null ? '–' : `${theirs.rate.toFixed(0)}%`}
            </span>
            <span className="mt-1 text-center text-[9px] leading-tight tracking-wider text-white/35 uppercase">team average</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="ld-team text-right" style={{ color: TEAM.enemy.color }}>
              {TEAM.enemy.label}
            </div>
            {enemies.map((player) => (
              <Row key={player.puuid} player={player} side="enemy" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
