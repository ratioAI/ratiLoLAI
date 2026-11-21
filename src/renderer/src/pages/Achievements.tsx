import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Lock, Orbit } from 'lucide-react'
import type { AchievementState } from '@shared/types'
import { ACHIEVEMENTS, CATEGORY_LABELS, RANK_CSS, RANK_ORDER, type AchievementCategory, type AchievementRank } from '@shared/achievements'
import { api } from '@/lib/api'
import { PageHeader, PageLoading } from '@/components/Layout'
import { ConstellationReveal } from '@/components/ConstellationReveal'
import { formatDate } from '@/lib/format'

const RANK_LABEL: Record<AchievementRank, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', cosmic: 'Cosmic' }

/** Small rank label in the rank's colour (cosmic gets the iridescent gradient). */
export function RankChip({ rank }: { rank: AchievementRank }) {
  const cosmic = rank === 'cosmic'
  return (
    <span
      className="rounded-full px-1.5 py-px text-[9px] font-extrabold tracking-wider uppercase"
      style={
        cosmic
          ? { background: RANK_CSS.cosmic, color: '#140b26' }
          : { color: RANK_CSS[rank], background: `color-mix(in srgb, ${RANK_CSS[rank]} 16%, transparent)` }
      }
    >
      {RANK_LABEL[rank]}
    </span>
  )
}

type SortKey = 'category' | 'rank' | 'progress' | 'recent'
const SORTS: [SortKey, string][] = [
  ['category', 'Category'],
  ['rank', 'Rank'],
  ['progress', 'Progress'],
  ['recent', 'Recent']
]
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as AchievementCategory[]
const catalogueIndex = new Map(ACHIEVEMENTS.map((def, i) => [def.id, i]))

function sorted(list: AchievementState[], key: SortKey): AchievementState[] {
  const share = (achievement: AchievementState) => (achievement.unlocked ? 1 : achievement.progress / achievement.goal)
  const byCatalogue = (a: AchievementState, b: AchievementState) => (catalogueIndex.get(a.id) ?? 0) - (catalogueIndex.get(b.id) ?? 0)
  return [...list].sort((a, b) => {
    switch (key) {
      case 'category':
        return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || byCatalogue(a, b)
      case 'rank':
        return RANK_ORDER.indexOf(b.rank) - RANK_ORDER.indexOf(a.rank) || byCatalogue(a, b)
      case 'progress':
        return share(b) - share(a) || byCatalogue(a, b)
      case 'recent':
        return (b.unlockedAt ?? -1) - (a.unlockedAt ?? -1) || share(b) - share(a) || byCatalogue(a, b)
    }
  })
}

function AchievementCard({ achievement }: { achievement: AchievementState }) {
  const hidden = achievement.secret && !achievement.unlocked
  const percent = Math.round((achievement.progress / achievement.goal) * 100)
  const accent = achievement.rank === 'cosmic' ? '#b58bff' : RANK_CSS[achievement.rank]
  const body = (
    <div
      className={`flex h-full gap-3 p-3 transition ${achievement.unlocked ? 'tinted rounded-2xl hover:brightness-125' : 'panel'}`}
      style={achievement.unlocked ? { ['--tint' as string]: accent } : undefined}
    >
      <div className="relative flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-xl bg-black/40">
        {hidden ? (
          <Lock size={22} className="text-muted" />
        ) : (
          <span style={{ opacity: achievement.unlocked ? 1 : 0.28, filter: achievement.unlocked ? undefined : 'grayscale(1)' }}>
            <ConstellationReveal id={achievement.id} rank={achievement.rank} size={76} animate={false} />
          </span>
        )}
        {achievement.unlocked && !achievement.seen && (
          <span className="absolute -top-1.5 -right-1.5 rounded-full bg-accent px-1.5 text-[9px] font-extrabold text-bg">NEW</span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[15px] font-extrabold">{hidden ? '???' : achievement.name}</span>
          <RankChip rank={achievement.rank} />
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted">
          {hidden ? 'Secret – play to find out.' : achievement.description}
        </p>
        <div className="mt-auto pt-2">
          {achievement.unlocked ? (
            <span className="text-[11px] font-semibold text-text">
              Discovered {achievement.unlockedAt ? formatDate(achievement.unlockedAt) : ''}
            </span>
          ) : achievement.goal > 1 && !hidden ? (
            <div className="flex items-center gap-2">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <span
                  className="bar-grow block h-full rounded-full"
                  style={{ width: `${percent}%`, background: RANK_CSS[achievement.rank] }}
                />
              </span>
              <span className="text-[11px] text-muted tabular-nums">
                {achievement.progress}/{achievement.goal}
              </span>
            </div>
          ) : (
            <span className="text-[11px] text-muted">Not discovered yet</span>
          )}
        </div>
      </div>
    </div>
  )
  return achievement.unlocked && achievement.gameId !== null ? <Link to={`/games/${achievement.gameId}`}>{body}</Link> : body
}

/** Games → Achievements: every achievement as a card with its constellation and progress. */
export function Achievements() {
  const [list, setList] = useState<AchievementState[] | null>(null)
  const [sort, setSort] = useState<SortKey>('category')
  useEffect(() => {
    const load = () => void api.getAchievements().then(setList)
    load()
    return api.on('achievementsUnlocked', load)
  }, [])
  // once the page has shown them, new ones aren't new any more
  useEffect(() => {
    const unseen = (list ?? []).filter((achievement) => achievement.unlocked && !achievement.seen).map((achievement) => achievement.id)
    if (!unseen.length) return
    const timer = setTimeout(() => void api.markAchievementsSeen(unseen), 4000)
    return () => clearTimeout(timer)
  }, [list])
  const shown = useMemo(() => sorted(list ?? [], sort), [list, sort])
  const unlocked = (list ?? []).filter((achievement) => achievement.unlocked).length
  const groups =
    sort === 'category'
      ? CATEGORY_ORDER.map((category) => [category, shown.filter((achievement) => achievement.category === category)] as const).filter(
          ([, items]) => items.length
        )
      : ([[null, shown]] as const)
  return (
    <div className="page-enter mx-auto max-w-6xl p-8">
      <PageHeader title="Achievements">
        {list && (
          <span className="mr-1 text-sm text-muted tabular-nums">
            {unlocked} / {list.length} discovered
          </span>
        )}
        <div className="flex rounded-xl border border-line bg-bg-2 p-1">
          {SORTS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${sort === key ? 'bg-panel-2 text-accent' : 'text-muted'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <Link to="/games/map" className="btn btn-ghost">
          <Orbit size={15} /> Star map
        </Link>
        <Link to="/games" className="btn btn-ghost">
          All games
        </Link>
      </PageHeader>
      {!list && <PageLoading />}
      {groups.map(([category, items]) => (
        <section key={category ?? 'all'} className="mb-6">
          {category && <h2 className="mb-2 text-xs font-bold tracking-wider text-muted uppercase">{CATEGORY_LABELS[category]}</h2>}
          <div className="stagger grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((achievement) => (
              <AchievementCard key={achievement.id} achievement={achievement} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
