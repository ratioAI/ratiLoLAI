import { useState } from 'react'
import { Flame, Info, Loader2, Send } from 'lucide-react'
import type { GameSummary } from '@shared/summary'
import {
  GAP,
  IDLE_RUN,
  WILL_BANDS,
  WILL_FACTOR_NAMES,
  WILL_WEIGHTS,
  willFactorText,
  willPresenceText,
  willSurrenderText,
  willToWin,
  willVerdict,
  type WillScore
} from '@shared/will'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'

const ALLY = '#5fb4ff'
const ENEMY = '#ff7a62'
const pct = (value: number): string => `${Math.round(value * 100)} %`
const gold = `${GAP / 1000}k`
const factorText = willFactorText
const presenceText = (will: WillScore, summary: GameSummary): string =>
  willPresenceText(will, (puuid) => summary.players.find((player) => player.puuid === puuid)?.riotId.split('#')[0] ?? '?')
const surrenderText = willSurrenderText

/** One 0–100 bar with its number; null = not tested. */
function ScoreBar({ score, color, title }: { score: number | null; color: string; title: string }) {
  return (
    <span className="flex items-center gap-2" title={title}>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
        {score !== null && <span className="bar-grow block h-full rounded-full" style={{ width: `${score}%`, background: color }} />}
      </span>
      <span className="w-7 text-right text-xs font-semibold text-text tabular-nums">{score === null ? '–' : Math.round(score)}</span>
    </span>
  )
}

/** A modifier (presence, surrender) as text instead of a bar. */
function Modifier({ value, bad, title }: { value: string; bad: boolean; title: string }) {
  return (
    <span className={`text-right text-xs font-semibold tabular-nums ${bad ? 'text-loss' : 'text-muted'}`} title={title}>
      {value}
    </span>
  )
}

/*
 * Geometry of the scale, top to bottom (px): your team's label 0–16, the track 24–32 with your
 * team's dot on it (21–35), the enemy's triangle 37–43 and label 44–60, the band names from 66.
 * Dot and triangle: the two teams differ in shape too, not only in colour.
 */
const TRACK_TOP = 24

/** Your team: a dot on the track, label above. */
function AllyMarker({ score }: { score: number }) {
  return (
    <div className="pop-in pointer-events-none absolute inset-y-0" style={{ left: `${score}%`, animationDelay: '400ms' }}>
      <span
        className="absolute left-0 h-3.5 w-3.5 -translate-x-1/2 rounded-full"
        style={{ top: TRACK_TOP - 3, background: ALLY, boxShadow: '0 0 0 2px #140d28' }}
      />
      <MarkerLabel score={score} label="Your team" top={0} />
    </div>
  )
}

/** The enemy: a triangle under the track pointing at it, label below. */
function EnemyMarker({ score }: { score: number }) {
  return (
    <div className="pop-in pointer-events-none absolute inset-y-0" style={{ left: `${score}%`, animationDelay: '550ms' }}>
      <span
        className="absolute left-0 h-0 w-0 -translate-x-1/2 border-x-[6px] border-b-[7px] border-x-transparent"
        style={{ top: TRACK_TOP + 13, borderBottomColor: ENEMY }}
      />
      <MarkerLabel score={score} label="Enemy" top={TRACK_TOP + 20} />
    </div>
  )
}

function MarkerLabel({ score, label, top }: { score: number; label: string; top: number }) {
  return (
    <span
      className="absolute text-xs whitespace-nowrap"
      // shifts with the score, so the label stays inside the scale at both ends
      style={{ top, transform: `translateX(-${score}%)` }}
    >
      <span className="text-muted">{label}</span> <span className="font-bold text-text tabular-nums">{score}</span>
    </span>
  )
}

/** How the score is made, opens on hover or keyboard focus. */
function Explanation() {
  return (
    <span tabIndex={0} className="group relative cursor-help outline-none">
      <Info size={13} className="text-muted" />
      <span className="pointer-events-none absolute top-full right-0 z-30 mt-2 w-[420px] translate-y-1 rounded-xl border border-white/20 bg-[#120b24] p-3 text-xs leading-snug font-normal tracking-normal text-muted normal-case opacity-0 shadow-[0_18px_50px_-10px_rgb(0_0_0/0.85)] transition duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus:translate-y-0 group-focus:opacity-100">
        <span className="mb-1.5 block text-[13px] font-semibold text-text">How much did the team want to win?</span>
        <span className="mb-2 block">
          Effort, not skill or result: each factor compares the team with what a typical team does in the same spot – also when it was
          getting stomped. 50 = a typical ARAM: Mayhem team (calibrated on 90 teams).
        </span>
        <span className="mb-2 block rounded-lg bg-white/5 px-2 py-1.5 font-mono text-[11px] text-text">
          will = base × presence − surrender
        </span>
        <span className="block">
          <b className="text-text">Base</b> – teamplay {pct(WILL_WEIGHTS.teamplay)}, fighting spirit {pct(WILL_WEIGHTS.spirit)}, closing
          drive {pct(WILL_WEIGHTS.drive)}. A factor the game never tested is left out and the others share its weight.
        </span>
        <span className="mt-1 block">
          <b className="text-text">Fighting spirit</b> – kills won while {gold}+ gold behind, against the share teams usually win at that
          gap. <b className="text-text">Closing drive</b> – turrets and inhibitors taken while {gold}+ ahead.
        </span>
        <span className="mt-1 block">
          <b className="text-text">Presence</b> – share of the team that played; a champion standing on one spot for {IDLE_RUN}+ minutes
          counts as away.
        </span>
        <span className="mt-1 block">
          <b className="text-text">Surrender</b> – 15 to 25 points off, more the closer the game still was.
        </span>
        <span className="mt-2 block border-t border-white/10 pt-2">
          All from Riot&apos;s match data. A heuristic for fun, not a verdict.
        </span>
      </span>
    </span>
  )
}

/** Sends the will to win of this game to your Discord channel – only when you press it, never on its own. */
function ShareWill({ gameId }: { gameId: number }) {
  const { settings } = useApp()
  const [state, setState] = useState<{ busy: boolean; result: { ok: boolean; message: string } | null }>({ busy: false, result: null })
  const ready = !!settings?.hasDiscordWebhook
  return (
    <span className="flex items-center gap-2 normal-case">
      {state.result && (
        <span className={`max-w-56 truncate text-[11px] font-normal ${state.result.ok ? 'text-win' : 'text-loss'}`} title={state.result.message}>
          {state.result.message}
        </span>
      )}
      <button
        className="btn btn-ghost px-2.5 py-1 text-xs"
        disabled={!ready || state.busy}
        title={ready ? 'Send the will to win of this game to your Discord channel' : 'Save a Discord webhook in Settings first'}
        onClick={async () => {
          setState({ busy: true, result: null })
          const result = await api.postWillToDiscord(gameId).catch((error: Error) => ({ ok: false, message: error.message }))
          setState({ busy: false, result })
        }}
      >
        {state.busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send to Discord
      </button>
    </span>
  )
}

/**
 * The will-to-win scale of a finished game: your team's score on a 0–100 track with the enemy's
 * for comparison, and what made it. Nothing for games it can't judge (see willToWin).
 */
export function WillScale({ summary }: { summary: GameSummary }) {
  const ours = willToWin(summary, true)
  const theirs = willToWin(summary, false)
  if (!ours) return null
  const verdict = willVerdict(ours, theirs)
  return (
    <div className="panel relative z-10 mt-3 px-4 pt-3 pb-3">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-muted uppercase">
        <Flame size={13} /> Will to win
        <span className="ml-auto" />
        <ShareWill gameId={summary.gameId} />
        <Explanation />
      </h2>
      <div className="grid grid-cols-1 items-center gap-x-8 gap-y-3 md:grid-cols-[290px_1fr]">
        <div>
          <div className="flex items-baseline gap-3">
            <span className="font-display text-5xl leading-none font-extrabold text-text tabular-nums">{ours.score}</span>
            <span className="font-display text-lg font-extrabold whitespace-nowrap text-text">{ours.band.label}</span>
          </div>
          <p className="mt-1.5 text-[13px] text-muted">
            {ours.band.text} {verdict}
          </p>
        </div>
        {/* the track: five bands from dim to bright, your team's dot on it, the enemy's triangle below */}
        <div
          className="relative h-[80px]"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={ours.score}
          aria-valuetext={`${ours.score} – ${ours.band.label}${theirs ? `; enemy ${theirs.score}` : ''}`}
        >
          <div className="absolute inset-x-0 flex h-2 gap-[2px]" style={{ top: TRACK_TOP }}>
            {WILL_BANDS.map((band, i) => (
              <span
                key={band.label}
                className="flex-1 first:rounded-l-full last:rounded-r-full"
                style={{ background: `rgb(229 139 255 / ${0.12 + i * 0.13})` }}
              />
            ))}
          </div>
          <div className="absolute inset-x-0 top-[66px] flex text-[10px] text-muted">
            {WILL_BANDS.map((band) => (
              <span key={band.label} className={`flex-1 text-center ${band === ours.band ? 'font-bold text-text' : ''}`}>
                {band.label}
              </span>
            ))}
          </div>
          {theirs && <EnemyMarker score={theirs.score} />}
          <AllyMarker score={ours.score} />
        </div>
      </div>

      {/* what made it: one row per factor, your team's line of text, both teams' scores */}
      <div className="mt-3 grid grid-cols-[130px_1fr_150px_150px] items-center gap-x-4 gap-y-1.5 border-t border-white/10 pt-2.5 text-sm">
        <span />
        <span />
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted uppercase">
          <span className="h-2 w-2 rounded-full" style={{ background: ALLY }} /> Your team
        </span>
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted uppercase">
          <span className="h-0 w-0 border-x-[5px] border-b-[7px] border-x-transparent" style={{ borderBottomColor: ENEMY }} /> Enemy
        </span>
        {ours.factors.map((factor, i) => {
          const enemy = theirs?.factors[i]
          return (
            <div key={factor.key} className="contents">
              <span className="font-semibold text-text">{WILL_FACTOR_NAMES[factor.key]}</span>
              <span className="truncate text-xs text-muted" title={factorText(factor)}>
                {factorText(factor)}
              </span>
              <ScoreBar score={factor.score} color={ALLY} title={`Your team: ${factorText(factor)}`} />
              {enemy ? <ScoreBar score={enemy.score} color={ENEMY} title={`Enemy: ${factorText(enemy)}`} /> : <span />}
            </div>
          )
        })}
        <span className="font-semibold text-text">Presence</span>
        <span className="truncate text-xs text-muted" title={presenceText(ours, summary)}>
          {presenceText(ours, summary)}
        </span>
        <Modifier value={`× ${ours.presence.toFixed(2)}`} bad={ours.presence < 0.95} title={`Your team: ${presenceText(ours, summary)}`} />
        {theirs ? (
          <Modifier
            value={`× ${theirs.presence.toFixed(2)}`}
            bad={theirs.presence < 0.95}
            title={`Enemy: ${presenceText(theirs, summary)}`}
          />
        ) : (
          <span />
        )}
        <span className="font-semibold text-text">Surrender</span>
        <span className="truncate text-xs text-muted">{surrenderText(ours)}</span>
        <Modifier
          value={ours.surrender ? `− ${Math.round(ours.surrender)}` : '–'}
          bad={ours.surrender > 0}
          title={`Your team: ${surrenderText(ours)}`}
        />
        {theirs ? (
          <Modifier
            value={theirs.surrender ? `− ${Math.round(theirs.surrender)}` : '–'}
            bad={theirs.surrender > 0}
            title={`Enemy: ${surrenderText(theirs)}`}
          />
        ) : (
          <span />
        )}
      </div>
    </div>
  )
}
