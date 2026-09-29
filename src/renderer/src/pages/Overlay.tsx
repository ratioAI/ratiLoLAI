import { liveChampionKey } from '@shared/staticData'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Sparkles, X } from 'lucide-react'
import type { AugmentOffer, AugmentRarity, Tier } from '@shared/types'
import { augmentTiersForChampion, COMBO_TYPE_LABELS, type AugmentTier } from '@shared/mayhem'
import { cardRects } from '@shared/cardLayout'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ChampIcon } from '@/components/icons'
import { AugmentFrame } from '@/components/AugmentFrame'
import { CardFrames } from '@/components/CardFrames'
import { RARITY_COLORS, RARITY_LABELS, useMayhemData } from '@/components/mayhem'

const SHOWN_TIERS: Tier[] = ['S+', 'S', 'A', 'B']

/** In-game overlay (separate transparent window) for ARAM: Mayhem augment picks. */
/**
 * In-game augment tier panel. `part="panel"` is the small window at the right screen edge;
 * the default renders panel + frames in one page (web demo, screenshots).
 */
export function Overlay({ part = 'demo' }: { part?: 'demo' | 'panel' }) {
  const { data: statics, live, settings } = useApp()
  const { data, error } = useMayhemData()
  const [expanded, setExpanded] = useState(() => window.location.hash.includes('champ='))
  // '#/overlay?champ=99' previews the overlay for a champion (used by the web demo)
  const [previewChamp, setPreviewChamp] = useState(() => Number(new URLSearchParams(window.location.hash.split('?')[1]).get('champ')) || 0)
  const [rarity, setRarity] = useState<AugmentRarity | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [focus, setFocus] = useState<AugmentTier | null>(null)
  // '#/overlay?champ=412&offer=1011,2107,1349' simulates an augment choice (web demo / screenshots)
  const [offer] = useState<AugmentOffer | null>(() => {
    const ids = new URLSearchParams(window.location.hash.split('?')[1]).get('offer')
    if (!ids) return null
    const rects = cardRects(window.innerWidth, window.innerHeight)
    return { displayId: 0, cards: ids.split(',').map((id, i) => ({ augmentId: Number(id), text: '', score: 1, rect: rects[i] })) }
  })
  const hovered = useRef(false)
  const autoExpandRef = useRef(true)

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    const offs = [
      api.on('overlayToggle', () => setExpanded((e) => !e)),
      // the panel opens together with the cards and closes once an augment is picked
      api.on('augmentCards', ({ visible }) => setExpanded(visible && autoExpandRef.current)),
      api.on('overlayPreview', ({ championId }) => {
        setPreviewChamp(championId)
        setExpanded(true)
      })
    ]
    return () => offs.forEach((o) => o())
  }, [])

  const championId = useMemo(() => {
    if (previewChamp) return previewChamp
    return liveChampionKey(statics, live)
  }, [previewChamp, live, statics])

  autoExpandRef.current = settings?.overlay.autoExpand ?? true
  const level = live?.players.find((p) => p.riotId === live.activePlayer)?.level ?? 0

  const tiers = useMemo(
    () => (data && statics && championId ? augmentTiersForChampion(data, statics, championId) : []),
    [data, statics, championId]
  )
  const visible = tiers.filter((t) => !rarity || t.augment.rarity === rarity)
  const groups = (showAll ? (['S+', 'S', 'A', 'B', 'C', 'D'] as Tier[]) : SHOWN_TIERS)
    .map((tier) => ({ tier, items: visible.filter((t) => t.tier === tier) }))
    .filter((g) => g.items.length)

  const setHover = (h: boolean) => {
    hovered.current = h
    api.setOverlayInteractive(h)
  }

  if (!statics) return null
  if (!championId)
    return (
      <div className="pointer-events-none fixed inset-0 select-none">
        <div className={`overlay-panel absolute ${part === 'panel' ? 'right-1 top-1' : 'right-3 top-[14%]'} flex items-center gap-2 px-3 py-2 text-xs font-bold text-[#f0e6d2]`}>
          <Sparkles size={14} className="text-gold" /> Augments
          <span className="text-[10px] font-medium text-muted">waiting for your champion…</span>
        </div>
      </div>
    )
  const hotkey = settings?.overlay.hotkey ?? 'Alt+Shift+A'
  const tierById = new Map(tiers.map((t) => [t.augment.id, t]))

  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      {part === 'demo' && offer && (
        <CardFrames offer={offer} tierById={tierById} animation={settings?.overlay.animation ?? 'smooth'} />
      )}
      <div
        className={`pointer-events-auto absolute ${part === 'panel' ? 'right-1 top-1' : 'right-3 top-[14%]'}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {!expanded ? (
          <button
            onClick={() => {
              setExpanded(true)
              void api.overlayScanNow()
            }}
            className="overlay-panel flex items-center gap-2 px-3 py-2 text-xs font-bold text-[#f0e6d2]"
          >
            <Sparkles size={14} className="text-gold" /> Augments
            <span className="text-[10px] font-medium text-muted">{hotkey}</span>
          </button>
        ) : (
          <div className="overlay-panel w-[330px] p-3">
            <div className="mb-3 flex items-center gap-2.5">
              <ChampIcon id={championId} size={34} tooltip={false} className="ring-1 ring-gold/50" />
              <div className="min-w-0 flex-1">
                <div className="overlay-title truncate text-sm font-bold uppercase">{statics.champions[championId]?.name}</div>
                <div className="text-[10px] text-muted">
                  ARAM: Mayhem · augment tiers{level ? ` · level ${level}` : ''}
                </div>
              </div>
              <button onClick={() => setExpanded(false)} className="rounded p-1 text-muted hover:text-text" title={`Hide (${hotkey})`}>
                <X size={15} />
              </button>
            </div>

            <div className="mb-3 flex gap-1">
              {(['prismatic', 'gold', 'silver'] as AugmentRarity[]).map((r) => (
                <button
                  key={r}
                  onClick={() => setRarity((cur) => (cur === r ? null : r))}
                  className={`flex-1 rounded-md border px-1 py-0.5 text-[10px] font-bold ${rarity && rarity !== r ? 'opacity-40' : ''}`}
                  style={{ color: RARITY_COLORS[r], borderColor: `color-mix(in srgb, ${RARITY_COLORS[r]} 40%, transparent)` }}
                >
                  {RARITY_LABELS[r]}
                </button>
              ))}
            </div>

            {!data ? (
              <p className={`text-xs ${error ? 'text-loss' : 'text-muted'}`}>{error ?? 'Loading augment data …'}</p>
            ) : (
              <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
                {groups.map((g) => (
                  <div key={g.tier}>
                    <div className="grid grid-cols-5 gap-x-2 gap-y-6 pt-3 pb-2">
                      {g.items.map((t) => (
                        <AugmentFrame
                          key={t.augment.id}
                          augment={t.augment}
                          tier={t.tier}
                          size={42}
                          onHover={(h) => setFocus(h ? t : null)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => setShowAll((s) => !s)}
                  className="flex w-full items-center justify-center gap-1 text-[10px] text-muted hover:text-text"
                >
                  <ChevronDown size={12} className={showAll ? 'rotate-180' : ''} /> {showAll ? 'Hide C & D tier' : 'Show C & D tier'}
                </button>
              </div>
            )}
            <div className="mt-2 min-h-[58px] rounded-lg bg-black/35 p-2 text-xs">
              {focus ? (
                <>
                  <div className="flex items-center gap-2">
                    <b className="truncate text-[#f0e6d2]">{focus.augment.name}</b>
                    <span className="text-[10px] font-bold" style={{ color: RARITY_COLORS[focus.augment.rarity] }}>
                      {RARITY_LABELS[focus.augment.rarity]}
                    </span>
                    <span className="ml-auto text-[10px] text-muted">
                      {focus.combo ? COMBO_TYPE_LABELS[focus.combo] : focus.augment.pickRate != null ? `picked ${focus.augment.pickRate.toFixed(1)}%` : ''}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-text/85">
                    {focus.note ?? 'No note yet.'}
                    {!focus.fits && <span className="text-loss"> · weak fit for this champion</span>}
                  </div>
                </>
              ) : (
                <span className="text-[11px] text-muted">Hover an augment to see why it is rated this way.</span>
              )}
            </div>
            <div className="mt-2 border-t border-white/10 pt-2 text-[9px] leading-snug text-muted">
              Tiers = curated combos + pick rate + champion fit (no win rates – Riot asks devs not to publish them). Data:
              arammayhem.com (CC BY 4.0)
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

