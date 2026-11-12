import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Crown, Skull, Trophy } from 'lucide-react'
import type { LeaderboardEntry } from '@shared/types'
import { podium, type PodiumKind } from '@shared/leaderboard'
import { api } from '@/lib/api'
import { ChampIcon } from '@/components/icons'
import { EmptyState, PageHeader } from '@/components/Layout'

const pct = (part: number, whole: number): string => `${whole ? Math.round((part / whole) * 100) : 0} %`
const shortName = (riotId: string): string => riotId.split('#')[0]

const STYLE: Record<PodiumKind, { title: string; unit: string; accent: string; steps: [string, string, string] }> = {
  // gold, silver, bronze
  mvp: { title: 'MVP', unit: 'MVP', accent: '#f2c14e', steps: ['#f2c14e', '#cfd6e4', '#d08a4e'] },
  // three reds, darkest for third place
  troll: { title: 'Troll', unit: 'Troll', accent: '#ff7a62', steps: ['#ff6a4d', '#d9584a', '#a84a48'] }
}
const STEP_HEIGHT = [132, 96, 68]

/** One step of the podium with the player standing on it. */
function Step({ entry, place, kind }: { entry: LeaderboardEntry | undefined; place: 0 | 1 | 2; kind: PodiumKind }) {
  const style = STYLE[kind]
  const colour = style.steps[place]
  const count = entry ? (kind === 'mvp' ? entry.mvps : entry.trolls) : 0
  return (
    <div className="flex w-[32%] min-w-0 flex-col items-center">
      {entry ? (
        <div className="pop-in mb-2 flex w-full flex-col items-center" style={{ animationDelay: `${500 - place * 120}ms` }}>
          <div className="relative">
            {place === 0 && (
              <span className="absolute -top-5 left-1/2 -translate-x-1/2" style={{ color: colour }}>
                {kind === 'mvp' ? <Crown size={20} /> : <Skull size={18} />}
              </span>
            )}
            <span className="block overflow-hidden rounded-full" style={{ boxShadow: `0 0 0 2px ${colour}, 0 0 22px -4px ${colour}` }}>
              <ChampIcon id={entry.championId} size={place === 0 ? 64 : 50} tooltip={false} />
            </span>
          </div>
          <div
            className={`mt-2 w-full truncate text-center font-display text-sm font-extrabold ${entry.me ? 'text-gold' : 'text-text'}`}
            title={entry.riotId}
          >
            {shortName(entry.riotId)}
          </div>
          <div className="text-sm font-bold tabular-nums" style={{ color: colour }}>
            {count}× {style.unit}
          </div>
          <div className="text-[11px] text-muted tabular-nums">
            {pct(count, entry.games)} of {entry.games}
          </div>
        </div>
      ) : (
        <div className="mb-2 text-xs text-muted">–</div>
      )}
      <div
        className="podium-step flex w-full items-start justify-center rounded-t-xl pt-2 font-display text-3xl font-extrabold"
        style={{
          height: STEP_HEIGHT[place],
          color: `${colour}`,
          background: `linear-gradient(180deg, ${colour}55, ${colour}14)`,
          borderTop: `2px solid ${colour}`,
          animationDelay: `${place * 120}ms`
        }}
      >
        {place + 1}
      </div>
    </div>
  )
}

function Podium({ entries, kind }: { entries: LeaderboardEntry[]; kind: PodiumKind }) {
  const ranked = podium(entries, kind)
  const style = STYLE[kind]
  return (
    <div className="panel flex flex-col px-5 pt-4" style={{ borderColor: `${style.accent}55` }}>
      <h2 className="mb-6 flex items-center gap-2 text-sm font-bold tracking-wider uppercase" style={{ color: style.accent }}>
        {kind === 'mvp' ? <Crown size={16} /> : <Skull size={16} />} {style.title}
      </h2>
      {/* second place left, winner in the middle, third right */}
      <div className="mt-auto flex items-end justify-center gap-1.5">
        <Step entry={ranked[1]} place={1} kind={kind} />
        <Step entry={ranked[0]} place={0} kind={kind} />
        <Step entry={ranked[2]} place={2} kind={kind} />
      </div>
    </div>
  )
}

type SortKey = 'games' | 'winRate' | 'mvps' | 'mvpRate' | 'trolls' | 'trollRate' | 'avgScore'
const COLUMNS: { key: SortKey; label: string; value: (entry: LeaderboardEntry) => number; text: (entry: LeaderboardEntry) => string }[] = [
  { key: 'games', label: 'Games', value: (entry) => entry.games, text: (entry) => String(entry.games) },
  { key: 'winRate', label: 'Win rate', value: (entry) => entry.wins / entry.games, text: (entry) => pct(entry.wins, entry.games) },
  { key: 'mvps', label: 'MVP', value: (entry) => entry.mvps, text: (entry) => String(entry.mvps) },
  { key: 'mvpRate', label: 'MVP rate', value: (entry) => entry.mvps / entry.games, text: (entry) => pct(entry.mvps, entry.games) },
  { key: 'trolls', label: 'Troll', value: (entry) => entry.trolls, text: (entry) => String(entry.trolls) },
  { key: 'trollRate', label: 'Troll rate', value: (entry) => entry.trolls / entry.games, text: (entry) => pct(entry.trolls, entry.games) },
  { key: 'avgScore', label: 'Ø impact', value: (entry) => entry.avgScore, text: (entry) => String(entry.avgScore) }
]

/** Who of you and your premades was MVP or troll how often: two podiums and the full table. */
export function Leaderboard() {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null)
  const [sort, setSort] = useState<SortKey>('mvps')
  useEffect(() => {
    const load = () => void api.getLeaderboard().then(setEntries)
    load()
    return api.on('gameSummary', load)
  }, [])
  const column = COLUMNS.find((candidate) => candidate.key === sort)!
  const rows = [...(entries ?? [])].sort((a, b) => column.value(b) - column.value(a) || b.games - a.games)
  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader title="Leaderboard">
        <Link to="/games" className="btn btn-ghost">
          All games
        </Link>
      </PageHeader>
      {!entries ? null : !entries.length ? (
        <EmptyState icon={<Trophy size={28} />} title="No games yet">
          Play a game with ratioAI running – you and your premades show up here.
        </EmptyState>
      ) : (
        <>
          <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2">
            <Podium entries={entries} kind="mvp" />
            <Podium entries={entries} kind="troll" />
          </div>
          <div className="panel mt-4 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wider text-muted uppercase">
                  <th className="px-4 py-2.5 font-bold">Player</th>
                  {COLUMNS.map(({ key, label }) => (
                    <th key={key} className="px-3 py-2.5 text-right font-bold">
                      <button className={`uppercase ${sort === key ? 'text-accent' : 'hover:text-text'}`} onClick={() => setSort(key)}>
                        {label}
                        {sort === key ? ' ▾' : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.puuid} className="border-b border-line/50 last:border-0">
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2.5">
                        <ChampIcon id={entry.championId} size={28} tooltip={false} />
                        <span className={`font-semibold ${entry.me ? 'text-gold' : 'text-text'}`}>{shortName(entry.riotId)}</span>
                      </span>
                    </td>
                    {COLUMNS.map(({ key, text }) => (
                      <td
                        key={key}
                        className={`px-3 py-2 text-right tabular-nums ${
                          key === 'mvps' ? 'font-bold text-[#f2c14e]' : key === 'trolls' ? 'font-bold text-[#ff7a62]' : 'text-text'
                        }`}
                      >
                        {text(entry)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
