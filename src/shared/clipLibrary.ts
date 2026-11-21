/** The Clips library: labels, filters, search and sorting. Pure. */
import type { Clip } from './types'
import type { AutoClipKind } from './recorder'

const AUTO_LABEL: Record<AutoClipKind, string> = {
  penta: 'Pentakill',
  quadra: 'Quadra kill',
  triple: 'Triple kill',
  firstBlood: 'First blood',
  ace: 'Ace',
  death: 'Team fight',
  gameEnd: 'Game end'
}

/** "Pentakill", "Bookmark", "Clip" … for the badge on a clip. */
export function clipKindLabel(kind: Clip['kind']): string {
  if (kind === 'manual') return 'Clip'
  if (kind === 'bookmark') return 'Bookmark'
  if (kind === 'export') return 'Edited'
  return AUTO_LABEL[kind.slice(5) as AutoClipKind] ?? 'Auto'
}

export type ClipKindFilter = 'all' | 'manual' | 'auto' | 'bookmark' | 'export'
export type ClipSort = 'newest' | 'oldest' | 'longest' | 'largest' | 'best'

export interface ClipFilter {
  championId: number | null
  /** game mode as the summary has it ("ARAM", "KIWI", …) */
  mode: string | null
  /** only clips of the last … days (null = all) */
  days: number | null
  kind: ClipKindFilter
  favorites: boolean
  search: string
}

export const NO_CLIP_FILTER: ClipFilter = { championId: null, mode: null, days: null, kind: 'all', favorites: false, search: '' }

/** What the title of a clip is when the user gave it none. */
export function clipTitle(clip: Pick<Clip, 'title' | 'kind'>): string {
  return clip.title.trim() || clipKindLabel(clip.kind)
}

/**
 * The clips that pass the filter. The search looks at the title, the kind and the champion's name
 * (`championName` resolves an id; clips without a game only match by title and kind).
 */
export function filterClips(clips: readonly Clip[], filter: ClipFilter, now: number, championName: (id: number) => string = () => ''): Clip[] {
  const words = filter.search.toLowerCase().split(/\s+/).filter(Boolean)
  const since = filter.days === null ? null : now - filter.days * 86_400_000
  return clips.filter((clip) => {
    if (filter.favorites && !clip.favorite) return false
    if (filter.championId !== null && clip.game?.championId !== filter.championId) return false
    if (filter.mode !== null && clip.game?.mode !== filter.mode) return false
    if (since !== null && clip.createdAt < since) return false
    if (filter.kind === 'auto' ? !clip.kind.startsWith('auto:') : filter.kind !== 'all' && clip.kind !== filter.kind) return false
    if (!words.length) return true
    const text = `${clipTitle(clip)} ${clipKindLabel(clip.kind)} ${clip.game ? championName(clip.game.championId) : ''}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

export function sortClips(clips: readonly Clip[], sort: ClipSort): Clip[] {
  const by: Record<ClipSort, (a: Clip, b: Clip) => number> = {
    newest: (a, b) => b.createdAt - a.createdAt || b.id - a.id,
    oldest: (a, b) => a.createdAt - b.createdAt || a.id - b.id,
    longest: (a, b) => b.durationMs - a.durationMs || b.createdAt - a.createdAt,
    largest: (a, b) => b.bytes - a.bytes || b.createdAt - a.createdAt,
    // most worth watching first (see @shared/highlights); clips not looked at yet go last
    best: (a, b) => (b.highlight?.score ?? -1) - (a.highlight?.score ?? -1) || b.createdAt - a.createdAt
  }
  return [...clips].sort(by[sort])
}

/** Champions and modes that occur in the clips, for the filter menus (most clips first). */
export function clipFacets(clips: readonly Clip[]): { champions: { id: number; count: number }[]; modes: { mode: string; count: number }[] } {
  const champions = new Map<number, number>()
  const modes = new Map<string, number>()
  for (const clip of clips) {
    if (!clip.game) continue
    champions.set(clip.game.championId, (champions.get(clip.game.championId) ?? 0) + 1)
    modes.set(clip.game.mode, (modes.get(clip.game.mode) ?? 0) + 1)
  }
  return {
    champions: [...champions].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || a.id - b.id),
    modes: [...modes].map(([mode, count]) => ({ mode, count })).sort((a, b) => b.count - a.count || a.mode.localeCompare(b.mode))
  }
}

/** "0:42" */
export function clipDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
