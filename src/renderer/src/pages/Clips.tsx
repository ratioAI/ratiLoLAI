/**
 * Clips: the library of everything the recorder saved. A grid of thumbnails with a muted preview
 * on hover, filters, search, a player with keyboard shortcuts, whole-game recordings and the
 * storage overview. Everything here runs in the main window only, never in the game.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Check,
  Clapperboard,
  Film,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Loader2,
  Pencil,
  Scissors,
  Search,
  Sparkles,
  Star,
  Trash2,
  X
} from 'lucide-react'
import type { CleanupPreview, Clip, ClipStorageInfo, SessionRecording } from '@shared/types'
import {
  NO_CLIP_FILTER,
  clipDuration,
  clipFacets,
  clipKindLabel,
  clipTitle,
  filterClips,
  sortClips,
  type ClipFilter,
  type ClipKindFilter,
  type ClipSort
} from '@shared/clipLibrary'
import { api, isDemo } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ChampIcon } from '@/components/icons'
import { EmptyState, PageHeader, formatBytes } from '@/components/Layout'

const MODE: Record<string, string> = { KIWI: 'ARAM: Mayhem', ARAM: 'ARAM', CLASSIC: "Summoner's Rift" }
const KINDS: [ClipKindFilter, string][] = [
  ['all', 'All'],
  ['manual', 'Manual'],
  ['auto', 'Auto'],
  ['bookmark', 'Bookmarks'],
  ['export', 'Edited']
]
const DATES: [number | null, string][] = [
  [null, 'Any time'],
  [1, 'Today'],
  [7, 'Last 7 days'],
  [30, 'Last 30 days']
]
const SORTS: [ClipSort, string][] = [
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  ['longest', 'Longest'],
  ['largest', 'Largest']
]
/** one frame at 60 fps, for the arrow keys */
const FRAME = 1 / 60

/** Champion, K/D/A and result of the game a clip belongs to. */
export function ClipGameLine({ clip, size = 22 }: { clip: Pick<Clip, 'game'>; size?: number }) {
  if (!clip.game) return <span className="text-xs text-muted">No game</span>
  const [kills, deaths, assists] = clip.game.kda
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs">
      <ChampIcon id={clip.game.championId} size={size} tooltip={false} />
      <span className="font-semibold tabular-nums">
        {kills}/<span className="text-loss">{deaths}</span>/{assists}
      </span>
      <span className={`font-bold ${clip.game.win ? 'text-[#5fb4ff]' : 'text-[#ff7a62]'}`}>{clip.game.win ? 'W' : 'L'}</span>
    </span>
  )
}

/** One clip in the grid. Hovering plays a muted preview; the video is only loaded then. */
function ClipCard({
  clip,
  selecting,
  selected,
  onOpen,
  onSelect,
  onFavorite
}: {
  clip: Clip
  selecting: boolean
  selected: boolean
  onOpen: () => void
  onSelect: () => void
  onFavorite: () => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div
      className={`clip-card group panel relative overflow-hidden ${selected ? 'clip-card-selected' : ''}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button className="relative block aspect-video w-full overflow-hidden bg-black" onClick={selecting ? onSelect : onOpen} aria-label={`Play ${clipTitle(clip)}`}>
        {clip.thumbUrl ? (
          <img src={clip.thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-muted">
            <Film size={28} />
          </span>
        )}
        {hover && !selecting && (
          <video
            src={clip.url}
            muted
            autoPlay
            loop
            playsInline
            preload="auto"
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <span className="clip-badge absolute bottom-2 right-2 tabular-nums">{clipDuration(clip.durationMs)}</span>
        <span className={`clip-badge absolute top-2 left-2 ${clip.kind.startsWith('auto:') ? 'clip-badge-auto' : ''}`}>{clipKindLabel(clip.kind)}</span>
      </button>
      <button
        className={`absolute top-2 right-2 rounded-full p-1.5 transition ${clip.favorite ? 'text-gold' : 'text-white/60 opacity-0 group-hover:opacity-100'}`}
        style={{ background: 'rgb(7 5 15 / 0.65)' }}
        onClick={onFavorite}
        title={clip.favorite ? 'Remove from favorites' : 'Favorite'}
      >
        <Star size={15} fill={clip.favorite ? 'currentColor' : 'none'} />
      </button>
      {(selecting || selected) && (
        <button
          className={`absolute top-2 left-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border ${selected ? 'border-accent bg-accent text-[#150a24]' : 'border-white/50 bg-black/60'}`}
          onClick={onSelect}
          aria-label="Select"
        >
          {selected && <Check size={14} />}
        </button>
      )}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{clipTitle(clip)}</div>
          <div className="text-[11px] text-muted">
            {new Date(clip.createdAt).toLocaleDateString()} · {formatBytes(clip.bytes)}
          </div>
        </div>
        <ClipGameLine clip={clip} />
      </div>
    </div>
  )
}

/**
 * The player: Space or K play/pause, J and L five seconds back and forth, the arrow keys one frame,
 * F favorite, Esc closes. `source` is a clip or a whole-game recording.
 */
export function ClipPlayer({
  clip,
  session,
  onClose,
  onChanged,
  onDeleted
}: {
  clip?: Clip
  session?: SessionRecording
  onClose: () => void
  onChanged?: (clip: Clip) => void
  onDeleted?: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const navigate = useNavigate()
  const [title, setTitle] = useState(clip?.title ?? '')
  const [renaming, setRenaming] = useState(false)
  const [favorite, setFavorite] = useState(!!clip?.favorite)
  // whole-game recordings: the stretch that becomes a clip
  const [mark, setMark] = useState<{ in: number; out: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const url = clip?.url ?? session?.url ?? ''

  const toggleFavorite = useCallback(async () => {
    if (!clip) return
    const next = await api.updateClip(clip.id, { favorite: !favorite })
    setFavorite(!favorite)
    if (next) onChanged?.(next)
  }, [clip, favorite, onChanged])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const element = video.current
      if (!element || (event.target as HTMLElement | null)?.tagName === 'INPUT') return
      const key = event.key.toLowerCase()
      if (key === 'escape') return onClose()
      if (key === ' ' || key === 'k') {
        if (element.paused) void element.play()
        else element.pause()
      } else if (key === 'j') element.currentTime = Math.max(0, element.currentTime - 5)
      else if (key === 'l') element.currentTime = Math.min(element.duration || 0, element.currentTime + 5)
      else if (key === 'arrowleft' || key === 'arrowright') {
        element.pause()
        element.currentTime = Math.max(0, element.currentTime + (key === 'arrowleft' ? -FRAME : FRAME))
      } else if (key === 'f') void toggleFavorite()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, toggleFavorite])

  const rename = async () => {
    setRenaming(false)
    if (!clip || title === clip.title) return
    const next = await api.updateClip(clip.id, { title })
    if (next) onChanged?.(next)
  }
  const remove = async () => {
    if (!clip) return
    await api.deleteClips([clip.id])
    onDeleted?.()
    onClose()
  }
  const now = (): number => video.current?.currentTime ?? 0
  const saveMarked = async () => {
    if (!session || !mark || mark.out <= mark.in) return
    setBusy(true)
    const saved = await api.clipFromRecording(session.id, mark.in * 1000, mark.out * 1000).catch(() => null)
    setBusy(false)
    setNote(saved ? `Clip saved (${clipDuration(saved.durationMs)})` : 'The clip could not be saved.')
    if (saved) setMark(null)
  }
  const game = clip?.game ?? session?.game ?? null
  const gameId = clip?.gameId ?? session?.gameId ?? null

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-8" style={{ background: 'rgb(4 2 10 / 0.86)' }} onClick={onClose}>
      <div className="panel flex max-h-full w-full max-w-5xl flex-col overflow-hidden" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3">
          {clip && renaming ? (
            <input
              autoFocus
              className="input flex-1 py-1"
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={rename}
              onKeyDown={(event) => event.key === 'Enter' && void rename()}
            />
          ) : (
            <h2 className="min-w-0 flex-1 truncate font-display text-lg font-extrabold">
              {clip ? title.trim() || clipKindLabel(clip.kind) : `Whole game · ${new Date(session!.startedAt).toLocaleString()}`}
            </h2>
          )}
          {game && <ClipGameLine clip={{ game }} size={26} />}
          <button className="btn btn-ghost px-2 py-1.5" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <video ref={video} src={url} controls autoPlay className="min-h-0 w-full flex-1 bg-black" style={{ maxHeight: '64vh' }} />
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          {clip && (
            <>
              <button className="btn btn-ghost" onClick={toggleFavorite} title="Favorite (F)">
                <Star size={15} fill={favorite ? 'currentColor' : 'none'} className={favorite ? 'text-gold' : ''} /> Favorite
              </button>
              <button className="btn btn-ghost" onClick={() => setRenaming(true)}>
                <Pencil size={15} /> Rename
              </button>
              <button className="btn btn-primary" onClick={() => navigate(`/clips/edit/${clip.id}`)}>
                <Scissors size={15} /> Edit
              </button>
            </>
          )}
          {session && (
            <>
              <button className="btn btn-ghost" onClick={() => setMark({ in: now(), out: mark && mark.out > now() ? mark.out : now() + 30 })}>
                Set start
              </button>
              <button className="btn btn-ghost" onClick={() => setMark({ in: mark && mark.in < now() ? mark.in : Math.max(0, now() - 30), out: now() })}>
                Set end
              </button>
              <button className="btn btn-primary" disabled={!mark || busy} onClick={saveMarked}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Scissors size={15} />}
                {mark ? `Save ${clipDuration((mark.out - mark.in) * 1000)} as a clip` : 'Save as a clip'}
              </button>
              {note && <span className="text-sm text-muted">{note}</span>}
            </>
          )}
          {gameId !== null && gameId > 0 && (
            <Link to={`/games/${gameId}`} className="btn btn-ghost">
              <Gamepad2 size={15} /> Game
            </Link>
          )}
          <span className="flex-1" />
          <span className="hidden text-[11px] text-muted lg:block">Space play · J / L 5 s · ← → frame</span>
          {clip && !isDemo && (
            <button className="btn btn-ghost" onClick={() => api.showClipInFolder(clip.id)}>
              <FolderOpen size={15} /> Show in folder
            </button>
          )}
          {clip && (
            <button className="btn btn-ghost text-loss" onClick={remove}>
              <Trash2 size={15} /> Delete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Used / limit, and "Clean up", which first shows what would go. */
function StorageBar({ storage, onCleaned }: { storage: ClipStorageInfo | null; onCleaned: () => void }) {
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [busy, setBusy] = useState(false)
  if (!storage) return null
  const share = (bytes: number): string => `${Math.min(100, (bytes / Math.max(1, storage.quotaBytes)) * 100)}%`
  const over = storage.usedBytes > storage.quotaBytes
  return (
    <>
      <div className="flex items-center gap-3 text-xs text-muted">
        <HardDrive size={15} />
        <div className="flex h-2 w-44 overflow-hidden rounded-full bg-panel-2" title={`Clips ${formatBytes(storage.clipBytes)} · whole games ${formatBytes(storage.sessionBytes)} · other ${formatBytes(storage.otherBytes)}`}>
          <span style={{ width: share(storage.clipBytes), background: '#e58bff' }} />
          <span style={{ width: share(storage.sessionBytes), background: '#6fe8ff' }} />
          <span style={{ width: share(storage.otherBytes), background: '#7b6aa8' }} />
        </div>
        <span className={`tabular-nums ${over ? 'text-gold' : ''}`}>
          {formatBytes(storage.usedBytes)} / {formatBytes(storage.quotaBytes)}
        </span>
        <button className="btn btn-ghost px-2.5 py-1 text-xs" onClick={async () => setPreview(await api.cleanupPreview())}>
          <Sparkles size={13} /> Clean up
        </button>
      </div>
      {preview && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-8" style={{ background: 'rgb(4 2 10 / 0.8)' }} onClick={() => setPreview(null)}>
          <div className="panel w-full max-w-lg p-6" onClick={(event) => event.stopPropagation()}>
            <h2 className="mb-3 font-display text-xl font-extrabold">Clean up</h2>
            {preview.items.length ? (
              <>
                <p className="mb-3 text-sm text-muted">
                  This would be deleted and free {formatBytes(preview.freedBytes)}. Clips and favorites are never deleted by the cleanup.
                </p>
                <ul className="mb-4 max-h-64 space-y-1 overflow-auto text-sm">
                  {preview.items.map((item) => (
                    <li key={item.name} className="flex items-center justify-between gap-3 rounded-lg bg-panel-2 px-3 py-1.5">
                      <span className="min-w-0 truncate">
                        {item.type === 'session' ? 'Whole game' : 'Replay leftovers'} · <span className="text-muted">{item.name}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-muted">{formatBytes(item.bytes)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mb-4 text-sm text-muted">Nothing to clean up: there are no leftovers and no expired whole-game recordings.</p>
            )}
            {preview.overQuota && (
              <p className="mb-4 text-sm text-gold">Your clips alone are above the limit. Delete some, or raise the limit in the settings.</p>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setPreview(null)}>
                {preview.items.length ? 'Cancel' : 'Close'}
              </button>
              {preview.items.length > 0 && (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    await api.cleanupRun().catch(() => null)
                    setBusy(false)
                    setPreview(null)
                    onCleaned()
                  }}
                >
                  {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} Delete {formatBytes(preview.freedBytes)}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Select<T extends string | number>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (value: T) => void; label: string }) {
  return (
    <select
      aria-label={label}
      className="input py-1.5 text-xs"
      value={String(value)}
      onChange={(event) => onChange(options.find(([option]) => String(option) === event.target.value)![0])}
    >
      {options.map(([option, text]) => (
        <option key={String(option)} value={String(option)}>
          {text}
        </option>
      ))}
    </select>
  )
}

/** A whole-game recording: play it, keep it past the cleanup, or delete it. */
export function SessionRow({ session, onPlay, onChanged }: { session: SessionRecording; onPlay: () => void; onChanged: () => void }) {
  const daysLeft = session.expiresAt === null ? null : Math.ceil((session.expiresAt - Date.now()) / 86_400_000)
  return (
    <div className="panel flex items-center gap-4 p-3">
      <button className="btn btn-ghost px-2.5" onClick={onPlay} title="Play">
        <Film size={16} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{new Date(session.startedAt).toLocaleString()}</div>
        <div className="text-[11px] text-muted">
          {clipDuration(session.durationMs)} · {formatBytes(session.bytes)} ·{' '}
          {session.kept ? 'kept' : daysLeft !== null && daysLeft > 0 ? `deleted in ${daysLeft} d` : 'deleted with the next cleanup'}
        </div>
      </div>
      <ClipGameLine clip={{ game: session.game }} />
      <button
        className={`btn ${session.kept ? 'btn-primary' : 'btn-ghost'}`}
        onClick={async () => {
          await api.keepRecording(session.id, !session.kept)
          onChanged()
        }}
      >
        <Check size={15} /> {session.kept ? 'Kept' : 'Keep'}
      </button>
      <button
        className="btn btn-ghost text-loss"
        onClick={async () => {
          await api.deleteRecording(session.id)
          onChanged()
        }}
      >
        <Trash2 size={15} /> Delete
      </button>
    </div>
  )
}

export function Clips() {
  const { data } = useApp()
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [sessions, setSessions] = useState<SessionRecording[]>([])
  const [storage, setStorage] = useState<ClipStorageInfo | null>(null)
  const [tab, setTab] = useState<'clips' | 'sessions'>('clips')
  const [filter, setFilter] = useState<ClipFilter>(NO_CLIP_FILTER)
  const [sort, setSort] = useState<ClipSort>('newest')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [open, setOpen] = useState<{ clip?: Clip; session?: SessionRecording } | null>(null)

  const load = useCallback(() => {
    void api.listClips().then(setClips)
    void api.listRecordings().then(setSessions)
    void api.clipStorage().then(setStorage)
  }, [])
  useEffect(() => {
    load()
    const unsubscribers = [api.on('clipSaved', load), api.on('gameSummary', load)]
    return () => unsubscribers.forEach((off) => off())
  }, [load])

  const facets = useMemo(() => clipFacets(clips ?? []), [clips])
  const championName = useCallback((id: number) => data?.champions[id]?.name ?? '', [data])
  const shown = useMemo(
    () => sortClips(filterClips(clips ?? [], filter, Date.now(), championName), sort),
    [clips, filter, sort, championName]
  )
  const set = (patch: Partial<ClipFilter>) => setFilter((current) => ({ ...current, ...patch }))
  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const favorite = async (clip: Clip) => {
    const next = await api.updateClip(clip.id, { favorite: !clip.favorite })
    if (next) setClips((current) => current?.map((entry) => (entry.id === next.id ? next : entry)) ?? null)
  }
  const deleteSelected = async () => {
    await api.deleteClips([...selected])
    setSelected(new Set())
    load()
  }
  const filtered = JSON.stringify(filter) !== JSON.stringify(NO_CLIP_FILTER)

  let body: ReactNode
  if (tab === 'sessions') {
    body = sessions.length ? (
      <div className="stagger space-y-2">
        {sessions.map((session) => (
          <SessionRow key={session.id} session={session} onPlay={() => setOpen({ session })} onChanged={load} />
        ))}
      </div>
    ) : (
      <EmptyState icon={<Film size={28} />} title="No whole-game recordings">
        Switch the mode to “Whole game” in Settings › Clips to keep entire games. They are deleted after a few days unless you keep them.
      </EmptyState>
    )
  } else if (!clips?.length) {
    body = (
      <EmptyState icon={<Clapperboard size={28} />} title="No clips yet">
        Turn on “Record my games” in Settings › Clips. During a game, press the clip hotkey to save the last seconds – pentakills and aces are
        saved on their own.
      </EmptyState>
    )
  } else if (!shown.length) {
    body = (
      <EmptyState icon={<Search size={28} />} title="No clip matches">
        <button className="btn btn-ghost" onClick={() => setFilter(NO_CLIP_FILTER)}>
          Clear filters
        </button>
      </EmptyState>
    )
  } else {
    body = (
      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4">
        {shown.map((clip) => (
          <ClipCard
            key={clip.id}
            clip={clip}
            selecting={selected.size > 0}
            selected={selected.has(clip.id)}
            onOpen={() => setOpen({ clip })}
            onSelect={() => toggle(clip.id)}
            onFavorite={() => void favorite(clip)}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="page-enter mx-auto max-w-7xl p-8">
      <PageHeader title="Clips">
        <StorageBar storage={storage} onCleaned={load} />
        <div className="flex rounded-xl border border-line bg-bg-2 p-1">
          {(
            [
              ['clips', `Clips${clips ? ` · ${clips.length}` : ''}`],
              ['sessions', `Whole games${sessions.length ? ` · ${sessions.length}` : ''}`]
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${tab === key ? 'bg-panel-2 text-accent' : 'text-muted'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {!isDemo && (
          <button className="btn btn-ghost" onClick={() => api.openClipFolder()}>
            <FolderOpen size={15} /> Open folder
          </button>
        )}
      </PageHeader>

      {tab === 'clips' && !!clips?.length && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
            <input
              className="input w-56 py-1.5 text-xs"
              style={{ paddingLeft: '2rem' }}
              placeholder="Search title or champion"
              value={filter.search}
              onChange={(event) => set({ search: event.target.value })}
            />
          </label>
          <div className="flex rounded-xl border border-line bg-bg-2 p-1">
            {KINDS.map(([kind, label]) => (
              <button
                key={kind}
                onClick={() => set({ kind })}
                className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${filter.kind === kind ? 'bg-panel-2 text-accent' : 'text-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <Select<number>
            label="Champion"
            value={filter.championId ?? 0}
            options={[[0, 'All champions'], ...facets.champions.map(({ id, count }): [number, string] => [id, `${championName(id) || id} (${count})`])]}
            onChange={(id) => set({ championId: id || null })}
          />
          <Select<string>
            label="Mode"
            value={filter.mode ?? ''}
            options={[['', 'All modes'], ...facets.modes.map(({ mode, count }): [string, string] => [mode, `${MODE[mode] ?? mode} (${count})`])]}
            onChange={(mode) => set({ mode: mode || null })}
          />
          <Select<number>
            label="Date"
            value={filter.days ?? 0}
            options={DATES.map(([days, label]): [number, string] => [days ?? 0, label])}
            onChange={(days) => set({ days: days || null })}
          />
          <button
            onClick={() => set({ favorites: !filter.favorites })}
            className={`btn px-2.5 py-1.5 text-xs ${filter.favorites ? 'btn-primary' : 'btn-ghost'}`}
          >
            <Star size={13} fill={filter.favorites ? 'currentColor' : 'none'} /> Favorites
          </button>
          <span className="flex-1" />
          {selected.size > 0 ? (
            <>
              <span className="text-xs text-muted">{selected.size} selected</span>
              <button className="btn btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setSelected(new Set(shown.map((clip) => clip.id)))}>
                All
              </button>
              <button className="btn btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setSelected(new Set())}>
                None
              </button>
              <button className="btn btn-ghost px-2.5 py-1.5 text-xs text-loss" onClick={deleteSelected}>
                <Trash2 size={13} /> Delete
              </button>
            </>
          ) : (
            <>
              <span className="text-xs text-muted tabular-nums">
                {filtered ? `${shown.length} of ${clips.length}` : `${clips.length} clips`}
              </span>
              <button className="btn btn-ghost px-2.5 py-1.5 text-xs" onClick={() => shown[0] && toggle(shown[0].id)} disabled={!shown.length}>
                Select
              </button>
            </>
          )}
          <Select<ClipSort> label="Sort" value={sort} options={SORTS} onChange={setSort} />
        </div>
      )}

      {body}

      {open && (
        <ClipPlayer
          key={open.clip ? `c${open.clip.id}` : `s${open.session!.id}`}
          clip={open.clip}
          session={open.session}
          onClose={() => {
            setOpen(null)
            load()
          }}
          onChanged={(next) => setClips((current) => current?.map((entry) => (entry.id === next.id ? next : entry)) ?? null)}
          onDeleted={load}
        />
      )}
    </div>
  )
}

/** The clips of one game and its whole-game recording, on the game's page. */
export function GameClips({ gameId }: { gameId: number }) {
  const [clips, setClips] = useState<Clip[]>([])
  const [session, setSession] = useState<SessionRecording | null>(null)
  const [open, setOpen] = useState<{ clip?: Clip; session?: SessionRecording } | null>(null)
  const load = useCallback(() => {
    void api.listClips().then((all) => setClips(all.filter((clip) => clip.gameId === gameId).sort((a, b) => a.startMs - b.startMs)))
    void api.gameRecording(gameId).then(setSession)
  }, [gameId])
  useEffect(() => {
    load()
    return api.on('clipSaved', load)
  }, [load])
  if (!clips.length && !session) return null
  return (
    <div className="panel mb-4 px-4 py-3">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-xs font-bold text-muted uppercase">Clips of this game</h2>
        <Link to="/clips" className="ml-auto text-xs text-muted hover:text-text">
          All clips
        </Link>
      </div>
      {session && (
        <div className="mb-3">
          <SessionRow session={session} onPlay={() => setOpen({ session })} onChanged={load} />
        </div>
      )}
      {clips.length > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-1">
          {clips.map((clip) => (
            <button key={clip.id} className="group relative w-52 shrink-0 overflow-hidden rounded-xl bg-black text-left" onClick={() => setOpen({ clip })}>
              {clip.thumbUrl ? (
                <img src={clip.thumbUrl} alt="" loading="lazy" className="aspect-video w-full object-cover transition group-hover:brightness-125" />
              ) : (
                <span className="flex aspect-video w-full items-center justify-center text-muted">
                  <Film size={24} />
                </span>
              )}
              <span className={`clip-badge absolute top-2 left-2 ${clip.kind.startsWith('auto:') ? 'clip-badge-auto' : ''}`}>{clipTitle(clip)}</span>
              <span className="clip-badge absolute right-2 bottom-2 tabular-nums">{clipDuration(clip.durationMs)}</span>
            </button>
          ))}
        </div>
      )}
      {open && (
        <ClipPlayer
          key={open.clip ? `c${open.clip.id}` : 's'}
          clip={open.clip}
          session={open.session}
          onClose={() => {
            setOpen(null)
            load()
          }}
          onDeleted={load}
        />
      )}
    </div>
  )
}
