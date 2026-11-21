/**
 * The Clips editor: trims and joins clips on a timeline, picks a picture format, puts meme text,
 * stickers, a stats overlay and music on top, and exports the result. The preview is composed
 * live on a canvas from the video elements (WebAudio plays the music in step); nothing is encoded
 * until "Export". Projects are saved per clip, with undo and redo.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  Copy,
  Crown,
  Download,
  Film,
  FolderOpen,
  Gauge,
  Loader2,
  Music,
  Pause,
  Play,
  Plus,
  Redo2,
  Save,
  Scissors,
  Smile,
  Square,
  Trash2,
  Type,
  Undo2,
  X
} from 'lucide-react'
import '@fontsource/anton/400.css'
import type { Clip, ExportJob } from '@shared/types'
import type { GameSummary } from '@shared/summary'
import { quips } from '@shared/quips'
import { clipDuration, clipTitle } from '@shared/clipLibrary'
import {
  BUILTIN_MUSIC,
  DISCORD_FREE_MB,
  EMOJI_STICKERS,
  SPEEDS,
  appendClip,
  cropRect,
  estimateExportMb,
  frameSize,
  movePart,
  newProject,
  partAt,
  planExport,
  projectDuration,
  removePart,
  splitAt,
  timeline,
  type Aspect,
  type EditProject,
  type ExportOptions,
  type ExportPresetId,
  type StickerItem,
  type TextItem,
  type Transition
} from '@shared/editProject'
import { api, isDemo } from '@/lib/api'
import { useApp } from '@/lib/store'
import { drawOverlays, emojiUrl, loadPeaks, renderExportImages } from '@/lib/clipCanvas'
import { EmptyState, formatBytes } from '@/components/Layout'
import { Modal as Dialog, modalOpen } from '@/components/Modal'
import { ShareToDiscord } from './Clips'

type Selection = { type: 'part'; index: number } | { type: 'text'; id: string } | { type: 'sticker'; id: string } | null
type Tab = 'format' | 'text' | 'stickers' | 'stats' | 'music'

const TRANSITION_LABEL: Record<Transition, string> = { cut: 'Cut', fade: 'Fade', glitch: 'Glitch' }
const NEXT_TRANSITION: Record<Transition, Transition> = { cut: 'fade', fade: 'glitch', glitch: 'cut' }
const ASPECTS: [Aspect, string][] = [
  ['16:9', '16:9'],
  ['9:16', '9:16 · Shorts'],
  ['1:1', '1:1']
]
const PRESETS: { id: ExportPresetId; name: string; hint: string }[] = [
  { id: 'discord', name: 'Discord', hint: 'Fits under the upload limit' },
  { id: 'hq', name: 'High quality MP4', hint: 'Full quality, 1080p60' },
  { id: 'short', name: '9:16 Short', hint: 'TikTok, Shorts, Reels' },
  { id: 'gif', name: 'GIF', hint: 'Animated, no sound' },
  { id: 'webm', name: 'WebM', hint: 'Small, for the web' }
]
const uid = (): string => Math.random().toString(36).slice(2, 10)
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const seconds = (value: number): string => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`

/** Project state with undo and redo. `set` records a step; `live` changes without one (while dragging). */
function useHistory(initial: EditProject | null) {
  const [project, setProject] = useState<EditProject | null>(initial)
  const past = useRef<EditProject[]>([])
  const future = useRef<EditProject[]>([])
  const [, bump] = useState(0)
  // Changes that follow each other within a moment (dragging a slider, typing) are ONE undo step:
  // otherwise a single drag fills the whole history and Ctrl+Z walks back tick by tick.
  const lastSet = useRef(0)
  const set = useCallback((next: EditProject | ((current: EditProject) => EditProject)) => {
    const now = performance.now()
    const sameGesture = now - lastSet.current < 400
    lastSet.current = now
    setProject((current) => {
      if (!current) return typeof next === 'function' ? current : next
      const value = typeof next === 'function' ? next(current) : next
      if (value === current) return current
      // (the updater may run twice in development: never push the same state twice)
      if (!sameGesture && past.current[past.current.length - 1] !== current) past.current = [...past.current.slice(-80), current]
      future.current = []
      return value
    })
    bump((n) => n + 1)
  }, [])
  const live = useCallback((next: (current: EditProject) => EditProject) => setProject((current) => (current ? next(current) : current)), [])
  /** call before a drag, so the whole drag is one undo step */
  const checkpoint = useCallback(() => {
    setProject((current) => {
      if (current) {
        past.current = [...past.current.slice(-80), current]
        future.current = []
      }
      return current
    })
  }, [])
  const undo = useCallback(() => {
    setProject((current) => {
      const previous = past.current.pop()
      if (!previous || !current) return current
      future.current.push(current)
      return previous
    })
    bump((n) => n + 1)
  }, [])
  const redo = useCallback(() => {
    setProject((current) => {
      const next = future.current.pop()
      if (!next || !current) return current
      past.current.push(current)
      return next
    })
    bump((n) => n + 1)
  }, [])
  const reset = useCallback((value: EditProject) => {
    past.current = []
    future.current = []
    setProject(value)
  }, [])
  return { project, set, live, checkpoint, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 }
}

/** The waveform of a clip between `from` and `to` seconds. */
function Waveform({ peaks, from, to, total }: { peaks: number[] | null; from: number; to: number; total: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const width = (element.width = element.clientWidth * 2)
    const height = (element.height = element.clientHeight * 2)
    const ctx = element.getContext('2d')!
    ctx.clearRect(0, 0, width, height)
    if (!peaks?.length || !(total > 0)) return
    ctx.fillStyle = 'rgba(244, 238, 252, 0.5)'
    const bars = Math.floor(width / 4)
    for (let i = 0; i < bars; i++) {
      const at = from + ((to - from) * i) / bars
      const peak = peaks[Math.min(peaks.length - 1, Math.floor((at / total) * peaks.length))] ?? 0
      const bar = Math.max(2, peak * height * 0.9)
      ctx.fillRect(i * 4, (height - bar) / 2, 2, bar)
    }
  }, [peaks, from, to, total])
  return <canvas ref={canvas} className="pointer-events-none absolute inset-0 h-full w-full" />
}

export function ClipEditor() {
  const { id } = useParams()
  const clipId = Number(id)
  const navigate = useNavigate()
  const { data } = useApp()
  const [library, setLibrary] = useState<Clip[] | null>(null)
  const history = useHistory(null)
  const { project } = history
  const [selection, setSelection] = useState<Selection>(null)
  const [tab, setTab] = useState<Tab>('format')
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [adding, setAdding] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [summary, setSummary] = useState<GameSummary | null>(null)
  const [peaks, setPeaks] = useState<Record<number, number[] | null>>({})
  const [saved, setSaved] = useState<boolean | 'failed'>(true)

  const canvas = useRef<HTMLCanvasElement>(null)
  const videos = useRef(new Map<number, HTMLVideoElement>())
  const clock = useRef({ time: 0, playing: false, last: 0 })
  const projectRef = useRef<EditProject | null>(null)
  projectRef.current = project
  const audio = useRef<{ context: AudioContext; gain: GainNode; buffer: AudioBuffer | null; source: AudioBufferSourceNode | null; file: string } | null>(null)
  const redraw = useRef(0)

  const clipsById = useMemo(() => new Map((library ?? []).map((clip) => [clip.id, clip])), [library])
  const owner = clipsById.get(clipId)
  const total = project ? projectDuration(project) : 0

  // --- load the library, the saved project and the game ---
  useEffect(() => {
    void api.listClips().then(setLibrary)
  }, [])
  useEffect(() => {
    if (!owner || project) return
    void api.getEdit(owner.id).then((stored) => {
      // a stored project may name clips that were deleted since
      const usable = stored && stored.clips.every((part) => clipsById.has(part.clipId)) ? stored : null
      history.reset(usable ?? newProject(owner.id, owner.durationMs / 1000))
    })
    if (owner.gameId) void api.getGame(owner.gameId).then(setSummary).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner])

  // --- autosave ---
  // Saved a moment after the last change. What is still waiting is written at once when the editor
  // closes (Back right after a change, or a finished game opening its summary), so nothing is lost.
  const unsaved = useRef<{ id: number; project: EditProject } | null>(null)
  const flushSave = useCallback((): void => {
    const waiting = unsaved.current
    if (!waiting) return
    unsaved.current = null
    api
      .saveEdit(waiting.id, waiting.project)
      .then(() => {
        if (!unsaved.current) setSaved(true)
      })
      .catch(() => {
        // keep it for the next try (the next change, or closing the editor)
        unsaved.current ??= waiting
        setSaved('failed')
      })
  }, [])
  // the project as it came from the disk is not a change
  const loadedProject = useRef<EditProject | null>(null)
  useEffect(() => {
    if (!project || !owner) return
    if (loadedProject.current === null) {
      loadedProject.current = project
      return
    }
    unsaved.current = { id: owner.id, project }
    setSaved(false)
    const timer = setTimeout(flushSave, 700)
    return () => clearTimeout(timer)
  }, [project, owner, flushSave])
  useEffect(() => flushSave, [flushSave])

  // --- one video element per clip in use, plus its waveform ---
  const usedIds = useMemo(() => [...new Set(project?.clips.map((part) => part.clipId) ?? [])].join(','), [project])
  useEffect(() => {
    const wanted = usedIds ? usedIds.split(',').map(Number) : []
    for (const [clip, video] of videos.current) {
      if (!wanted.includes(clip)) {
        video.pause()
        video.removeAttribute('src')
        videos.current.delete(clip)
      }
    }
    for (const clip of wanted) {
      const source = clipsById.get(clip)
      if (!source || videos.current.has(clip)) continue
      const video = document.createElement('video')
      video.src = source.url
      video.preload = 'auto'
      video.playsInline = true
      video.addEventListener('seeked', () => redraw.current++)
      video.addEventListener('loadeddata', () => redraw.current++)
      videos.current.set(clip, video)
      if (!(clip in peaks) && source.bytes < 200e6) {
        setPeaks((current) => ({ ...current, [clip]: null }))
        void loadPeaks(source.url).then((loaded) => setPeaks((current) => ({ ...current, [clip]: loaded })))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usedIds, clipsById])
  useEffect(() => {
    const elements = videos.current
    return () => {
      for (const video of elements.values()) video.pause()
      audio.current?.source?.stop()
      void audio.current?.context.close()
    }
  }, [])

  // --- music through WebAudio, in step with the timeline ---
  const stopMusic = useCallback(() => {
    try {
      audio.current?.source?.stop()
    } catch {
      // not started
    }
    if (audio.current) audio.current.source = null
  }, [])
  const startMusic = useCallback(
    async (at: number) => {
      const music = projectRef.current?.music
      stopMusic()
      if (!music) return
      if (!audio.current) {
        const context = new AudioContext()
        const gain = context.createGain()
        gain.connect(context.destination)
        audio.current = { context, gain, buffer: null, source: null, file: '' }
      }
      const engine = audio.current
      if (engine.file !== music.file) {
        const builtin = BUILTIN_MUSIC.find((track) => track.id === music.file)
        const url = builtin ? builtin.file : /^(blob:|rcclip:)/.test(music.file) ? music.file : await api.mediaUrl(music.file)
        if (!url) return
        try {
          engine.buffer = await engine.context.decodeAudioData(await (await fetch(url)).arrayBuffer())
          engine.file = music.file
        } catch {
          engine.buffer = null
        }
      }
      if (!engine.buffer || !clock.current.playing) return
      await engine.context.resume()
      const source = engine.context.createBufferSource()
      source.buffer = engine.buffer
      source.loop = true
      source.connect(engine.gain)
      source.start(0, (Math.max(0, music.offset) + at) % engine.buffer.duration)
      engine.source = source
    },
    [stopMusic]
  )

  // --- the preview: every frame, sync the videos to the timeline and compose the picture ---
  useEffect(() => {
    let frame = 0
    let lastDrawn = ''
    const loop = (now: number): void => {
      frame = requestAnimationFrame(loop)
      const current = projectRef.current
      const element = canvas.current
      if (!current || !element) return
      const state = clock.current
      const duration = projectDuration(current)
      if (state.playing) {
        state.time += Math.min(0.1, (now - state.last) / 1000)
        if (state.time >= duration) {
          state.time = duration
          state.playing = false
          setPlaying(false)
          stopMusic()
        }
      }
      state.last = now
      const hit = partAt(current, state.time)
      const parts = timeline(current)
      // the part before, while a fade or glitch still overlaps it
      const overlapping = hit && hit.part.index > 0 && state.time < hit.part.start + hit.part.overlap ? parts[hit.part.index - 1] : null
      const duck = current.music?.duck ? 0.35 : 1
      for (const [clip, video] of videos.current) {
        const active = hit && hit.part.part.clipId === clip
        const tail = overlapping && overlapping.part.clipId === clip && !active
        if (active || tail) {
          const part = active ? hit!.part : overlapping!
          const wanted = active ? hit!.clipTime : part.part.out - (hit!.part.start + hit!.part.overlap - state.time) * part.part.speed
          const drift = Math.abs(video.currentTime - wanted)
          if (drift > (state.playing ? 0.3 : 0.03) && !video.seeking) video.currentTime = wanted
          video.playbackRate = part.part.speed
          video.volume = duck
          if (state.playing && video.paused) void video.play().catch(() => undefined)
          if (!state.playing && !video.paused) video.pause()
        } else if (!video.paused) video.pause()
      }
      if (audio.current) {
        const music = current.music
        const fadeIn = music && music.fadeIn > 0 ? clamp(state.time / music.fadeIn, 0, 1) : 1
        const fadeOut = music && music.fadeOut > 0 ? clamp((duration - state.time) / music.fadeOut, 0, 1) : 1
        audio.current.gain.gain.value = music ? clamp(music.volume, 0, 1) * Math.min(fadeIn, fadeOut) : 0
      }
      // while paused only redraw when something changed
      const key = `${state.time.toFixed(3)}|${redraw.current}|${element.clientWidth}`
      if (!state.playing && key === lastDrawn && current === lastProject) return
      lastDrawn = key
      lastProject = current
      const size = frameSize(current.crop.aspect, 720)
      if (element.width !== size.width || element.height !== size.height) {
        element.width = size.width
        element.height = size.height
      }
      const ctx = element.getContext('2d')!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, size.width, size.height)
      const drawVideo = (clip: number, alpha: number): void => {
        const video = videos.current.get(clip)
        if (!video || video.readyState < 2) return
        const rect = cropRect({ width: video.videoWidth, height: video.videoHeight }, current.crop)
        ctx.globalAlpha = alpha
        ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, size.width, size.height)
        ctx.globalAlpha = 1
      }
      if (hit) {
        const mix = overlapping ? clamp((state.time - hit.part.start) / hit.part.overlap, 0, 1) : 1
        if (overlapping && overlapping.part.clipId !== hit.part.part.clipId) drawVideo(overlapping.part.clipId, 1)
        drawVideo(hit.part.part.clipId, hit.part.transition === 'fade' ? mix : 1)
        if (overlapping && hit.part.transition === 'glitch') {
          // a few slices of the picture jump sideways for a moment
          for (let i = 0; i < 6; i++) {
            const y = Math.floor(Math.random() * size.height)
            const h = 8 + Math.floor(Math.random() * 40)
            ctx.drawImage(element, 0, y, size.width, h, (Math.random() - 0.5) * 80 * (1 - mix), y, size.width, h)
          }
        }
      }
      drawOverlays(ctx, current, size, state.time, duration, data, () => redraw.current++)
      if (state.playing) setTime(state.time)
    }
    let lastProject: EditProject | null = null
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [data, stopMusic])

  const seek = useCallback(
    (to: number) => {
      const next = clamp(to, 0, projectRef.current ? projectDuration(projectRef.current) : 0)
      clock.current.time = next
      setTime(next)
      if (clock.current.playing) void startMusic(next)
    },
    [startMusic]
  )
  const toggle = useCallback(() => {
    const state = clock.current
    const duration = projectRef.current ? projectDuration(projectRef.current) : 0
    if (!state.playing && state.time >= duration - 0.05) {
      state.time = 0
      setTime(0)
    }
    state.playing = !state.playing
    state.last = performance.now()
    setPlaying(state.playing)
    if (state.playing) void startMusic(state.time)
    else stopMusic()
  }, [startMusic, stopMusic])

  // --- editing ---
  const selectedPart = selection?.type === 'part' && project ? project.clips[selection.index] : null
  const split = useCallback(() => history.set((current) => splitAt(current, clock.current.time)), [history])
  const deleteSelected = useCallback(() => {
    if (!selection) return
    history.set((current) =>
      selection.type === 'part'
        ? removePart(current, selection.index)
        : selection.type === 'text'
          ? { ...current, texts: current.texts.filter((text) => text.id !== selection.id) }
          : { ...current, stickers: current.stickers.filter((sticker) => sticker.id !== selection.id) }
    )
    setSelection(null)
  }, [history, selection])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      // an open dialog (add clip, export) has the keyboard: no splitting or deleting behind it
      if (modalOpen() || (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'z') return void (event.shiftKey ? history.redo() : history.undo()), event.preventDefault()
      if ((event.ctrlKey || event.metaKey) && key === 'y') return void history.redo(), event.preventDefault()
      if (key === ' ' || key === 'k') toggle()
      else if (key === 's') split()
      else if (key === 'delete' || key === 'backspace') deleteSelected()
      else if (key === 'j') seek(clock.current.time - 5)
      else if (key === 'l') seek(clock.current.time + 5)
      else if (key === 'arrowleft') seek(clock.current.time - 1 / 60)
      else if (key === 'arrowright') seek(clock.current.time + 1 / 60)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [history, toggle, split, deleteSelected, seek])

  const addText = (kind: TextItem['kind'], text: string) => {
    const item: TextItem = { id: uid(), kind, text, x: 0.5, y: 0.5, size: kind === 'box' ? 0.06 : 0.1, color: '#ffffff', start: 0, end: null, fade: kind === 'box' ? 0.3 : 0 }
    history.set((current) => ({ ...current, texts: [...current.texts.filter((other) => kind === 'box' || other.kind !== kind), item] }))
    setSelection({ type: 'text', id: item.id })
    setTab('text')
  }
  const addSticker = (src: string) => {
    const item: StickerItem = { id: uid(), src, x: 0.5, y: 0.35, scale: 0.14, start: 0, end: null }
    history.set((current) => ({ ...current, stickers: [...current.stickers, item] }))
    setSelection({ type: 'sticker', id: item.id })
  }
  const patchText = (textId: string, patch: Partial<TextItem>) =>
    history.set((current) => ({ ...current, texts: current.texts.map((text) => (text.id === textId ? { ...text, ...patch } : text)) }))
  const patchSticker = (stickerId: string, patch: Partial<StickerItem>) =>
    history.set((current) => ({ ...current, stickers: current.stickers.map((sticker) => (sticker.id === stickerId ? { ...sticker, ...patch } : sticker)) }))

  // dragging the selected text box or sticker on the preview
  const dragItem = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!project || !selection || selection.type === 'part') return
    const rect = event.currentTarget.getBoundingClientRect()
    const move = (clientX: number, clientY: number) => {
      const x = clamp((clientX - rect.left) / rect.width, 0, 1)
      const y = clamp((clientY - rect.top) / rect.height, 0, 1)
      history.live((current) =>
        selection.type === 'text'
          ? { ...current, texts: current.texts.map((text) => (text.id === selection.id && text.kind === 'box' ? { ...text, x, y } : text)) }
          : { ...current, stickers: current.stickers.map((sticker) => (sticker.id === selection.id ? { ...sticker, x, y } : sticker)) }
      )
    }
    history.checkpoint()
    move(event.clientX, event.clientY)
    const onMove = (moveEvent: PointerEvent) => move(moveEvent.clientX, moveEvent.clientY)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // suggestions from the game this clip belongs to
  const suggestions = useMemo(() => {
    const list: { label: string; apply: () => void }[] = [
      { label: 'PENTAKILL', apply: () => addText('top', 'PENTAKILL') },
      { label: '0/10 POWERSPIKE', apply: () => addText('bottom', '0/10 POWERSPIKE') }
    ]
    const me = summary?.players.find((player) => player.me)
    const quip = me && summary ? quips(summary)[me.puuid] : null
    if (quip) list.unshift({ label: `“${quip.length > 46 ? `${quip.slice(0, 44)}…` : quip}”`, apply: () => addText('bottom', quip) })
    if (me && summary?.mvp === me.puuid) list.push({ label: '👑 MVP crown', apply: () => (addSticker('emoji:1f451'), addText('top', 'MVP')) })
    if (me && summary?.blame === me.puuid) list.push({ label: '🤡 Troll crown', apply: () => (addSticker('emoji:1f921'), addText('top', 'CERTIFIED TROLL')) })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary])

  if (library && !owner) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <EmptyState icon={<Film size={28} />} title="Clip not found">
          <Link to="/clips" className="btn btn-ghost">
            Back to Clips
          </Link>
        </EmptyState>
      </div>
    )
  }
  if (!project || !owner) return null

  const parts = timeline(project)
  const selectedText = selection?.type === 'text' ? project.texts.find((text) => text.id === selection.id) : undefined
  const selectedSticker = selection?.type === 'sticker' ? project.stickers.find((sticker) => sticker.id === selection.id) : undefined
  const me = summary?.players.find((player) => player.me)

  return (
    <div className="page-enter flex h-full flex-col px-6 py-4">
      {/* --- top bar --- */}
      <div className="mb-3 flex items-center gap-2">
        <button className="btn btn-ghost px-2.5" onClick={() => navigate('/clips')} title="Back to Clips">
          <ChevronLeft size={16} />
        </button>
        <h1 className="min-w-0 truncate font-display text-xl font-extrabold">
          <span className="iridescent-text">Edit</span> · {clipTitle(owner)}
        </h1>
        {saved === 'failed' ? (
          <button className="text-xs font-semibold text-loss" onClick={flushSave} title="Your changes are not on the disk yet – click to try again">
            Could not save – retry
          </button>
        ) : (
          <span className="text-xs text-muted">{saved ? 'Saved' : 'Saving …'}</span>
        )}
        <span className="flex-1" />
        <button className="btn btn-ghost px-2.5" onClick={history.undo} disabled={!history.canUndo} title="Undo (Ctrl+Z)">
          <Undo2 size={16} />
        </button>
        <button className="btn btn-ghost px-2.5" onClick={history.redo} disabled={!history.canRedo} title="Redo (Ctrl+Y)">
          <Redo2 size={16} />
        </button>
        <button className="btn btn-primary" onClick={() => setExporting(true)}>
          <Download size={15} /> Export
        </button>
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        {/* --- preview --- */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl bg-black/50">
            <canvas
              ref={canvas}
              onPointerDown={dragItem}
              className="max-h-full max-w-full rounded-lg"
              style={{ aspectRatio: project.crop.aspect.replace(':', ' / '), cursor: selection && selection.type !== 'part' ? 'move' : 'default', height: '100%' } as CSSProperties}
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button className="btn btn-primary px-3" onClick={toggle} title="Play / pause (Space)">
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <span className="w-28 text-sm tabular-nums text-muted">
              {seconds(time)} / {seconds(total)}
            </span>
            <button className="btn btn-ghost" onClick={split} title="Split at the playhead (S)">
              <Scissors size={15} /> Split
            </button>
            <button className="btn btn-ghost" onClick={deleteSelected} disabled={!selection || (selection.type === 'part' && project.clips.length < 2)} title="Delete the selection (Del)">
              <Trash2 size={15} /> Delete
            </button>
            {selectedPart && selection?.type === 'part' && (
              <>
                <span className="ml-2 flex items-center gap-1 text-xs text-muted">
                  <Gauge size={14} /> Speed
                </span>
                <div className="flex rounded-xl border border-line bg-bg-2 p-1">
                  {SPEEDS.map((speed) => (
                    <button
                      key={speed}
                      onClick={() => history.set((current) => ({ ...current, clips: current.clips.map((part, i) => (i === selection.index ? { ...part, speed } : part)) }))}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold ${selectedPart.speed === speed ? 'bg-panel-2 text-accent' : 'text-muted'}`}
                    >
                      {speed}×
                    </button>
                  ))}
                </div>
                <button className="btn btn-ghost px-2" onClick={() => (history.set((current) => movePart(current, selection.index, -1)), setSelection({ type: 'part', index: Math.max(0, selection.index - 1) }))} disabled={selection.index === 0} title="Move left">
                  <ArrowLeft size={14} />
                </button>
                <button className="btn btn-ghost px-2" onClick={() => (history.set((current) => movePart(current, selection.index, 1)), setSelection({ type: 'part', index: Math.min(project.clips.length - 1, selection.index + 1) }))} disabled={selection.index === project.clips.length - 1} title="Move right">
                  <ArrowRight size={14} />
                </button>
              </>
            )}
            <span className="flex-1" />
            <button className="btn btn-ghost" onClick={() => setAdding(true)}>
              <Plus size={15} /> Add clip
            </button>
          </div>
        </div>

        {/* --- tools --- */}
        <div className="panel flex w-[340px] shrink-0 flex-col overflow-hidden">
          <div className="flex border-b border-line">
            {(
              [
                ['format', 'Format', <Square key="i" size={14} />],
                ['text', 'Text', <Type key="i" size={14} />],
                ['stickers', 'Stickers', <Smile key="i" size={14} />],
                ['stats', 'Stats', <Crown key="i" size={14} />],
                ['music', 'Music', <Music key="i" size={14} />]
              ] as [Tab, string, ReactNode][]
            ).map(([key, label, icon]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-semibold ${tab === key ? 'text-accent' : 'text-muted hover:text-text'}`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
            {tab === 'format' && (
              <>
                <ToolLabel>Picture format</ToolLabel>
                <div className="flex gap-2">
                  {ASPECTS.map(([aspect, label]) => (
                    <button
                      key={aspect}
                      onClick={() => history.set((current) => ({ ...current, crop: { ...current.crop, aspect } }))}
                      className={`btn flex-1 justify-center px-2 text-xs ${project.crop.aspect === aspect ? 'btn-primary' : 'btn-ghost'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {project.crop.aspect !== '16:9' && (
                  <Slider label="Move the crop" value={project.crop.x} min={0} max={1} step={0.01} onStart={history.checkpoint} onChange={(x) => history.live((current) => ({ ...current, crop: { ...current.crop, x } }))} />
                )}
                <ToolLabel>Transitions</ToolLabel>
                <p className="text-xs text-muted">Click the marker between two parts on the timeline to switch between cut, fade and glitch.</p>
              </>
            )}

            {tab === 'text' && (
              <>
                <ToolLabel>Add</ToolLabel>
                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-ghost px-2.5 text-xs" onClick={() => addText('top', 'TOP TEXT')}>
                    Meme top
                  </button>
                  <button className="btn btn-ghost px-2.5 text-xs" onClick={() => addText('bottom', 'BOTTOM TEXT')}>
                    Meme bottom
                  </button>
                  <button className="btn btn-ghost px-2.5 text-xs" onClick={() => addText('box', 'Text')}>
                    Text box
                  </button>
                </div>
                <ToolLabel>From this game</ToolLabel>
                <div className="flex flex-wrap gap-1.5">
                  {suggestions.map((suggestion) => (
                    <button key={suggestion.label} onClick={suggestion.apply} className="rounded-lg border border-line px-2.5 py-1 text-left text-xs font-semibold text-muted hover:border-accent/60 hover:text-text">
                      {suggestion.label}
                    </button>
                  ))}
                </div>
                {project.texts.length > 0 && <ToolLabel>Texts</ToolLabel>}
                {project.texts.map((text) => (
                  <button
                    key={text.id}
                    onClick={() => setSelection({ type: 'text', id: text.id })}
                    className={`block w-full truncate rounded-lg border px-2.5 py-1.5 text-left text-xs ${selectedText?.id === text.id ? 'border-accent/70 bg-accent/10' : 'border-line'}`}
                  >
                    <span className="mr-2 text-muted">{text.kind === 'box' ? 'Box' : text.kind === 'top' ? 'Top' : 'Bottom'}</span>
                    {text.text}
                  </button>
                ))}
                {selectedText && (
                  <div className="space-y-3 rounded-xl bg-panel-2 p-3">
                    <textarea className="input w-full text-sm" rows={2} value={selectedText.text} onChange={(event) => patchText(selectedText.id, { text: event.target.value })} />
                    <Slider label="Size" value={selectedText.size} min={0.03} max={0.2} step={0.005} onChange={(size) => patchText(selectedText.id, { size })} />
                    {selectedText.kind === 'box' && (
                      <label className="flex items-center justify-between text-xs text-muted">
                        Color
                        <input type="color" value={selectedText.color} onChange={(event) => patchText(selectedText.id, { color: event.target.value })} />
                      </label>
                    )}
                    <Slider label={`Shows from ${seconds(selectedText.start)}`} value={selectedText.start} min={0} max={total} step={0.1} onChange={(start) => patchText(selectedText.id, { start: Math.min(start, (selectedText.end ?? total) - 0.2) })} />
                    <Slider label={`until ${seconds(selectedText.end ?? total)}`} value={selectedText.end ?? total} min={0} max={total} step={0.1} onChange={(end) => patchText(selectedText.id, { end: end >= total - 0.05 ? null : Math.max(end, selectedText.start + 0.2) })} />
                    <Slider label="Fade in / out" value={selectedText.fade} min={0} max={2} step={0.1} onChange={(fade) => patchText(selectedText.id, { fade })} />
                    {selectedText.kind === 'box' && <p className="text-[11px] text-muted">Drag the text on the preview to move it.</p>}
                  </div>
                )}
              </>
            )}

            {tab === 'stickers' && (
              <>
                <ToolLabel>Emoji</ToolLabel>
                <div className="grid grid-cols-6 gap-1.5">
                  {EMOJI_STICKERS.map((code) => (
                    <button key={code} onClick={() => addSticker(`emoji:${code}`)} className="rounded-lg border border-line p-1.5 hover:border-accent/60">
                      <img src={emojiUrl(code) ?? ''} alt="" className="h-full w-full" />
                    </button>
                  ))}
                </div>
                <button
                  className="btn btn-ghost w-full justify-center text-xs"
                  onClick={async () => {
                    const picked = await api.pickMedia('image')
                    if (picked) addSticker(isDemo ? picked.url : picked.path)
                  }}
                >
                  <FolderOpen size={14} /> Your own picture
                </button>
                {project.stickers.length > 0 && <ToolLabel>On the clip</ToolLabel>}
                <div className="flex flex-wrap gap-1.5">
                  {project.stickers.map((sticker, index) => (
                    <button
                      key={sticker.id}
                      onClick={() => setSelection({ type: 'sticker', id: sticker.id })}
                      className={`rounded-lg border px-2.5 py-1 text-xs ${selectedSticker?.id === sticker.id ? 'border-accent/70 bg-accent/10' : 'border-line text-muted'}`}
                    >
                      Sticker {index + 1}
                    </button>
                  ))}
                </div>
                {selectedSticker && (
                  <div className="space-y-3 rounded-xl bg-panel-2 p-3">
                    <Slider label="Size" value={selectedSticker.scale} min={0.04} max={0.6} step={0.01} onChange={(scale) => patchSticker(selectedSticker.id, { scale })} />
                    <Slider label={`Shows from ${seconds(selectedSticker.start)}`} value={selectedSticker.start} min={0} max={total} step={0.1} onChange={(start) => patchSticker(selectedSticker.id, { start: Math.min(start, (selectedSticker.end ?? total) - 0.2) })} />
                    <Slider label={`until ${seconds(selectedSticker.end ?? total)}`} value={selectedSticker.end ?? total} min={0} max={total} step={0.1} onChange={(end) => patchSticker(selectedSticker.id, { end: end >= total - 0.05 ? null : Math.max(end, selectedSticker.start + 0.2) })} />
                    <p className="text-[11px] text-muted">Drag the sticker on the preview to move it.</p>
                  </div>
                )}
                <p className="text-[11px] text-muted">Emoji: Twemoji, CC-BY 4.0.</p>
              </>
            )}

            {tab === 'stats' && (
              <>
                <ToolLabel>Stats overlay</ToolLabel>
                {owner.game ? (
                  <>
                    <label className="flex items-center justify-between">
                      Champion, K/D/A and result
                      <input
                        type="checkbox"
                        checked={!!project.overlays.stats}
                        onChange={(event) =>
                          history.set((current) => ({
                            ...current,
                            overlays: { stats: event.target.checked ? { championId: owner.game!.championId, kda: owner.game!.kda, win: owner.game!.win, corner: 'tl' } : null }
                          }))
                        }
                      />
                    </label>
                    {project.overlays.stats && (
                      <div className="grid grid-cols-2 gap-2">
                        {(
                          [
                            ['tl', 'Top left'],
                            ['tr', 'Top right'],
                            ['bl', 'Bottom left'],
                            ['br', 'Bottom right']
                          ] as const
                        ).map(([corner, label]) => (
                          <button
                            key={corner}
                            onClick={() => history.set((current) => ({ ...current, overlays: { stats: { ...current.overlays.stats!, corner } } }))}
                            className={`btn justify-center px-2 text-xs ${project.overlays.stats?.corner === corner ? 'btn-primary' : 'btn-ghost'}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                    {me && <p className="text-xs text-muted">{summary?.mvp === me.puuid ? 'You were the MVP of this game.' : summary?.blame === me.puuid ? 'You were the troll of this game.' : ''}</p>}
                  </>
                ) : (
                  <p className="text-xs text-muted">This clip has no saved game, so there are no stats to show.</p>
                )}
              </>
            )}

            {tab === 'music' && (
              <MusicTool
                project={project}
                total={total}
                set={(music) => {
                  history.set((current) => ({ ...current, music }))
                  if (clock.current.playing) setTimeout(() => void startMusic(clock.current.time), 0)
                }}
              />
            )}
          </div>
        </div>
      </div>

      {/* --- timeline --- */}
      <Timeline
        project={project}
        parts={parts}
        total={total}
        time={time}
        selection={selection}
        clipsById={clipsById}
        peaks={peaks}
        onSeek={seek}
        onSelect={setSelection}
        onTrimStart={history.checkpoint}
        onTrim={(index, patch) => history.live((current) => ({ ...current, clips: current.clips.map((part, i) => (i === index ? { ...part, ...patch } : part)) }))}
        onTransition={(index) => history.set((current) => ({ ...current, transitions: current.transitions.map((transition, i) => (i === index ? NEXT_TRANSITION[transition] : transition)) }))}
      />

      {adding && (
        <Modal title="Add a clip" onClose={() => setAdding(false)}>
          <div className="grid max-h-[60vh] grid-cols-3 gap-3 overflow-auto">
            {(library ?? [])
              .filter((clip) => clip.kind !== 'export')
              .map((clip) => (
                <button
                  key={clip.id}
                  className="overflow-hidden rounded-xl bg-black text-left hover:brightness-125"
                  onClick={() => {
                    history.set((current) => appendClip(current, clip.id, clip.durationMs / 1000))
                    setAdding(false)
                  }}
                >
                  {clip.thumbUrl ? <img src={clip.thumbUrl} alt="" className="aspect-video w-full object-cover" /> : <span className="block aspect-video" />}
                  <span className="block truncate px-2 py-1.5 text-xs">
                    {clipTitle(clip)} · {clipDuration(clip.durationMs)}
                  </span>
                </button>
              ))}
          </div>
        </Modal>
      )}
      {exporting && (
        <ExportDialog
          project={project}
          owner={owner}
          onOptions={(output) => history.live((current) => ({ ...current, output }))}
          onClose={() => setExporting(false)}
          beforeStart={() => {
            if (clock.current.playing) toggle()
          }}
        />
      )}
    </div>
  )
}

function ToolLabel({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-bold tracking-[0.14em] text-muted uppercase">{children}</div>
}

function Slider({ label, value, min, max, step, onChange, onStart }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; onStart?: () => void }) {
  return (
    <label className="block text-xs text-muted">
      {label}
      <input type="range" className="mt-1 block w-full accent-[var(--color-accent)]" min={min} max={max} step={step} value={value} onPointerDown={onStart} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog onClose={onClose} label={title} className={`${wide ? 'max-w-3xl' : 'max-w-2xl'} p-6`}>
      <div className="mb-4 flex items-center">
        <h2 className="flex-1 font-display text-xl font-extrabold">{title}</h2>
        <button className="btn btn-ghost px-2 py-1.5" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      {children}
    </Dialog>
  )
}

/** Music: a built-in loop or a file of your own, with volume, start, ducking and fades. */
function MusicTool({ project, total, set }: { project: EditProject; total: number; set: (music: EditProject['music']) => void }) {
  const music = project.music
  const choose = (file: string, name: string) => set({ file, name, offset: music?.offset ?? 0, volume: music?.volume ?? 0.6, duck: music?.duck ?? true, fadeIn: music?.fadeIn ?? 0.5, fadeOut: music?.fadeOut ?? Math.min(2, total / 4) })
  return (
    <>
      <ToolLabel>Built-in loops (CC0)</ToolLabel>
      <div className="space-y-1.5">
        {BUILTIN_MUSIC.map((track) => (
          <button
            key={track.id}
            onClick={() => choose(track.id, track.name)}
            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs font-semibold ${music?.file === track.id ? 'border-accent/70 bg-accent/10 text-text' : 'border-line text-muted hover:text-text'}`}
          >
            {track.name}
            <span className="font-normal tabular-nums">{Math.round(track.seconds)} s loop</span>
          </button>
        ))}
      </div>
      <button
        className="btn btn-ghost w-full justify-center text-xs"
        onClick={async () => {
          const picked = await api.pickMedia('music')
          if (picked) choose(isDemo ? picked.url : picked.path, picked.name)
        }}
      >
        <FolderOpen size={14} /> Your own audio file
      </button>
      <p className="text-[11px] leading-relaxed text-muted">
        ratioAI comes with no chart music and downloads none. If you add a song of your own, you are responsible for the rights when you share the clip.
      </p>
      {music && (
        <div className="space-y-3 rounded-xl bg-panel-2 p-3">
          <div className="flex items-center gap-2 text-xs">
            <Music size={14} className="text-accent" />
            <span className="min-w-0 flex-1 truncate font-semibold">{music.name}</span>
            <button className="text-muted hover:text-loss" onClick={() => set(null)} title="Remove the music">
              <X size={14} />
            </button>
          </div>
          <Slider label={`Volume ${Math.round(music.volume * 100)} %`} value={music.volume} min={0} max={1} step={0.05} onChange={(volume) => set({ ...music, volume })} />
          <Slider label={`Start in the song at ${seconds(music.offset)}`} value={music.offset} min={0} max={240} step={0.5} onChange={(offset) => set({ ...music, offset })} />
          <label className="flex items-center justify-between text-xs">
            Turn the game sound down under the music
            <input type="checkbox" checked={music.duck} onChange={(event) => set({ ...music, duck: event.target.checked })} />
          </label>
          <Slider label={`Fade in ${music.fadeIn.toFixed(1)} s`} value={music.fadeIn} min={0} max={5} step={0.1} onChange={(fadeIn) => set({ ...music, fadeIn })} />
          <Slider label={`Fade out ${music.fadeOut.toFixed(1)} s`} value={music.fadeOut} min={0} max={5} step={0.1} onChange={(fadeOut) => set({ ...music, fadeOut })} />
        </div>
      )}
    </>
  )
}

/** The timeline: the video track with waveforms and trim handles, a track for texts and stickers, the music, the playhead. */
function Timeline({
  project,
  parts,
  total,
  time,
  selection,
  clipsById,
  peaks,
  onSeek,
  onSelect,
  onTrim,
  onTrimStart,
  onTransition
}: {
  project: EditProject
  parts: ReturnType<typeof timeline>
  total: number
  time: number
  selection: Selection
  clipsById: Map<number, Clip>
  peaks: Record<number, number[] | null>
  onSeek: (time: number) => void
  onSelect: (selection: Selection) => void
  onTrim: (index: number, patch: { in?: number; out?: number }) => void
  onTrimStart: () => void
  onTransition: (index: number) => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const pct = (value: number): string => `${(value / Math.max(0.001, total)) * 100}%`
  const drag = (event: ReactPointerEvent, handler: (seconds: number, deltaSeconds: number) => void) => {
    event.preventDefault()
    event.stopPropagation()
    const rect = track.current!.getBoundingClientRect()
    const startX = event.clientX
    const at = (clientX: number): number => clamp(((clientX - rect.left) / rect.width) * total, 0, total)
    const onMove = (moveEvent: PointerEvent) => handler(at(moveEvent.clientX), ((moveEvent.clientX - startX) / rect.width) * total)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    handler(at(event.clientX), 0)
  }
  const trim = (event: ReactPointerEvent, index: number, edge: 'in' | 'out') => {
    const part = project.clips[index]
    const length = (clipsById.get(part.clipId)?.durationMs ?? 0) / 1000
    onTrimStart()
    drag(event, (_at, delta) => {
      const moved = delta * part.speed
      if (edge === 'in') onTrim(index, { in: clamp(part.in + moved, 0, part.out - 0.2) })
      else onTrim(index, { out: clamp(part.out + moved, part.in + 0.2, length || part.out + moved) })
    })
  }
  const items = [
    ...project.texts.map((text) => ({ key: `t${text.id}`, label: text.text, start: text.start, end: text.end ?? total, select: { type: 'text', id: text.id } as Selection, color: '#ff7ad9' })),
    ...project.stickers.map((sticker, index) => ({ key: `s${sticker.id}`, label: `Sticker ${index + 1}`, start: sticker.start, end: sticker.end ?? total, select: { type: 'sticker', id: sticker.id } as Selection, color: '#6fe8ff' }))
  ]
  return (
    <div className="panel mt-3 shrink-0 select-none px-4 py-3">
      <div ref={track} className="relative">
        {/* ruler: click or drag to move the playhead */}
        <div className="relative h-5 cursor-pointer" onPointerDown={(event) => drag(event, (at) => onSeek(at))}>
          {Array.from({ length: Math.min(60, Math.floor(total / (total > 60 ? 10 : total > 20 ? 5 : 1)) + 1) }, (_, i) => i * (total > 60 ? 10 : total > 20 ? 5 : 1)).map((mark) => (
            <span key={mark} className="absolute top-0 text-[10px] text-muted tabular-nums" style={{ left: pct(mark) }}>
              {mark}s
            </span>
          ))}
        </div>
        {/* video track */}
        <div className="relative h-16 rounded-lg bg-black/40">
          {parts.map((entry) => {
            const clip = clipsById.get(entry.part.clipId)
            const active = selection?.type === 'part' && selection.index === entry.index
            return (
              <div
                key={entry.index}
                onPointerDown={() => onSelect({ type: 'part', index: entry.index })}
                className={`absolute top-0 h-full overflow-hidden rounded-lg border ${active ? 'border-accent' : 'border-white/15'}`}
                style={{ left: pct(entry.start), width: pct(entry.end - entry.start), background: 'linear-gradient(135deg, rgb(123 92 255 / 0.5), rgb(229 139 255 / 0.28))' }}
              >
                <Waveform peaks={peaks[entry.part.clipId] ?? null} from={entry.part.in} to={entry.part.out} total={(clip?.durationMs ?? 0) / 1000} />
                <span className="pointer-events-none absolute top-1 left-2.5 truncate text-[10px] font-semibold text-white/90">
                  {clip ? clipTitle(clip) : 'Missing clip'}
                  {entry.part.speed !== 1 && <span className="ml-1.5 rounded bg-black/50 px-1">{entry.part.speed}×</span>}
                </span>
                <span className="absolute top-0 left-0 h-full w-2 cursor-ew-resize bg-white/40 hover:bg-white/80" onPointerDown={(event) => trim(event, entry.index, 'in')} />
                <span className="absolute top-0 right-0 h-full w-2 cursor-ew-resize bg-white/40 hover:bg-white/80" onPointerDown={(event) => trim(event, entry.index, 'out')} />
              </div>
            )
          })}
          {parts.slice(1).map((entry) => (
            <button
              key={`x${entry.index}`}
              onClick={() => onTransition(entry.index - 1)}
              className="absolute -top-2 z-10 -translate-x-1/2 rounded-md border border-line bg-bg-2 px-1.5 py-0.5 text-[9px] font-bold text-accent"
              style={{ left: pct(entry.start + entry.overlap / 2) }}
              title="Transition: click to change"
            >
              {TRANSITION_LABEL[entry.transition]}
            </button>
          ))}
        </div>
        {/* texts and stickers */}
        {items.length > 0 && (
          <div className="relative mt-1.5" style={{ height: Math.min(4, items.length) * 18 }}>
            {items.slice(0, 4).map((item, row) => (
              <button
                key={item.key}
                onClick={() => onSelect(item.select)}
                className="absolute h-4 truncate rounded px-1.5 text-left text-[9px] font-semibold text-[#150a24]"
                style={{ left: pct(item.start), width: pct(Math.max(0.3, item.end - item.start)), top: row * 18, background: item.color }}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
        {/* music */}
        {project.music && (
          <div className="mt-1.5 flex h-4 items-center gap-1.5 truncate rounded bg-[#5fe0a0]/80 px-1.5 text-[9px] font-semibold text-[#06231a]">
            <Music size={10} /> {project.music.name}
          </div>
        )}
        {/* playhead */}
        <div className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white" style={{ left: pct(time) }}>
          <span className="absolute -top-0.5 -left-[5px] h-3 w-3 rotate-45 bg-white" />
        </div>
      </div>
    </div>
  )
}

/** The export dialog: preset, size, progress, and what to do with the finished file. */
export function ExportDialog({
  project,
  owner,
  onOptions,
  onClose,
  beforeStart
}: {
  project: EditProject
  owner: Clip
  onOptions?: (output: ExportOptions) => void
  onClose: () => void
  beforeStart?: () => void
}) {
  const { data } = useApp()
  const [options, setOptionsState] = useState<ExportOptions>(project.output)
  const [job, setJob] = useState<ExportJob | null>(null)
  const [title, setTitle] = useState(owner.title)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    void api.exportStatus().then((current) => current && (current.state === 'running' || current.state === 'paused') && setJob(current))
    // Only one export runs at a time, so a running one is always shown. But the end of an export this
    // dialog was not showing (a highlight video made elsewhere) is not this project's "Done".
    return api.on('exportProgress', (next) =>
      setJob((current) => (next.id === current?.id || next.state === 'running' || next.state === 'paused' ? next : current))
    )
  }, [])
  const setOptions = (patch: Partial<ExportOptions>) => {
    const next = { ...options, ...patch }
    setOptionsState(next)
    onOptions?.(next)
  }
  const plan = planExport(project, options)
  const estimate = estimateExportMb(project, plan)
  const active = job && (job.state === 'running' || job.state === 'paused')
  const start = async () => {
    beforeStart?.()
    setBusy(true)
    setNote(null)
    try {
      const withOptions = { ...project, output: options }
      const images = await renderExportImages(withOptions, plan, data)
      setJob(await api.exportStart({ clipId: owner.id, project: withOptions, title, images }))
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    }
    setBusy(false)
  }
  return (
    <Modal title="Export" onClose={onClose} wide>
      {!job || job.state === 'cancelled' || job.state === 'error' ? (
        <>
          <div className="mb-4 grid grid-cols-5 gap-2">
            {PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => setOptions({ preset: preset.id })}
                className={`rounded-xl border p-3 text-left ${options.preset === preset.id ? 'border-accent bg-accent/10' : 'border-line hover:border-accent/50'}`}
              >
                <div className="text-sm font-bold">{preset.name}</div>
                <div className="mt-1 text-[11px] leading-snug text-muted">{preset.hint}</div>
              </button>
            ))}
          </div>
          <div className="mb-4 space-y-3 rounded-xl bg-panel-2 p-4 text-sm">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-muted">
              <span>
                <b className="text-text tabular-nums">
                  {plan.width}×{plan.height}
                </b>{' '}
                · {plan.fps} fps · {plan.container.toUpperCase()}
              </span>
              <span>
                Length <b className="text-text tabular-nums">{seconds(projectDuration(project))}</b>
              </span>
              <span>
                Size <b className="text-text tabular-nums">{estimate !== null ? `~${estimate} MB` : plan.preset === 'gif' ? `up to ${options.targetMb} MB` : 'depends on the picture'}</b>
              </span>
            </div>
            {(options.preset === 'discord' || options.preset === 'gif') && (
              <label className="flex items-center justify-between gap-4">
                <span>
                  Stay below (MB)
                  <span className="ml-2 text-xs text-muted">
                    {options.preset === 'discord' ? `Discord's limit is ${DISCORD_FREE_MB} MB; boosted servers allow 50 or 100` : 'the GIF gets narrower and slower until it fits'}
                  </span>
                </span>
                <input type="number" className="input w-24 text-right" min={1} max={500} value={options.targetMb} onChange={(event) => setOptions({ targetMb: clamp(Number(event.target.value) || DISCORD_FREE_MB, 1, 500) })} />
              </label>
            )}
            {options.preset === 'gif' && (
              <div className="flex items-center justify-between gap-4">
                <span>Width and frames per second</span>
                <span className="flex gap-2">
                  <select className="input py-1.5" value={options.gifWidth} onChange={(event) => setOptions({ gifWidth: Number(event.target.value) === 640 ? 640 : 480 })}>
                    <option value={480}>480 px</option>
                    <option value={640}>640 px</option>
                  </select>
                  <select className="input py-1.5" value={options.gifFps} onChange={(event) => setOptions({ gifFps: ([10, 15, 20].includes(Number(event.target.value)) ? Number(event.target.value) : 15) as 10 | 15 | 20 })}>
                    <option value={10}>10 fps</option>
                    <option value={15}>15 fps</option>
                    <option value={20}>20 fps</option>
                  </select>
                </span>
              </div>
            )}
            <label className="flex items-center justify-between gap-4">
              <span>Title</span>
              <input className="input w-72" value={title} maxLength={120} placeholder={clipTitle(owner)} onChange={(event) => setTitle(event.target.value)} />
            </label>
          </div>
          {(job?.message || note) && <p className="mb-3 text-sm text-loss">{job?.message ?? note}</p>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-muted">No watermark, no outro. Exports run in the background and never during a game.</span>
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button className="btn btn-primary" onClick={start} disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Export
            </button>
          </div>
        </>
      ) : active ? (
        <div className="py-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span>{job.state === 'paused' ? job.message : `Exporting ${PRESETS.find((preset) => preset.id === job.preset)?.name ?? ''} …`}</span>
            <span className="tabular-nums text-muted">{Math.round(job.progress * 100)} %</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(job.progress * 100)}%`, background: 'linear-gradient(90deg, #ff7ad9, #b58bff, #6fe8ff)' }} />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={onClose}>
              Keep going in the background
            </button>
            <button className="btn btn-ghost text-loss" onClick={() => api.exportCancel()}>
              <X size={15} /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <ExportDone job={job} onClose={onClose} onAgain={() => setJob(null)} />
      )}
    </Modal>
  )
}

/** What to do with a finished export: copy the file, show it, save it somewhere, share it. */
export function ExportDone({ job, onClose, onAgain, extra }: { job: ExportJob; onClose: () => void; onAgain?: () => void; extra?: ReactNode }) {
  const [note, setNote] = useState<string | null>(null)
  const clip = job.clip
  return (
    <div className="py-2">
      <p className="mb-4 text-sm">
        <b>Done.</b> {clip ? `${clipDuration(clip.durationMs)} · ` : ''}
        {formatBytes(job.bytes)} – it is in your library under “Edited”.
      </p>
      <div className="flex flex-wrap gap-2">
        {clip && (
          <>
            <button className="btn btn-ghost" onClick={async () => setNote((await api.copyClipFile(clip.id)) ? 'Copied – paste it into Discord or a folder with Ctrl+V.' : 'Copying is only available in the desktop app.')}>
              <Copy size={15} /> Copy file
            </button>
            <button className="btn btn-ghost" onClick={() => api.showClipInFolder(clip.id)}>
              <FolderOpen size={15} /> Show in folder
            </button>
            <button className="btn btn-ghost" onClick={async () => setNote((await api.saveClipAs(clip.id)) ? 'Saved.' : null)}>
              <Save size={15} /> Save as…
            </button>
            <ShareToDiscord clip={clip} primary />
            {extra}
          </>
        )}
      </div>
      {note && <p className="mt-3 text-sm text-muted">{note}</p>}
      <div className="mt-5 flex justify-end gap-2">
        {onAgain && (
          <button className="btn btn-ghost" onClick={onAgain}>
            Export another format
          </button>
        )}
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
