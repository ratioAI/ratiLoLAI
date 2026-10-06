import { liveChampionKey } from '@shared/staticData'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Sparkles, X } from 'lucide-react'
import type { AugmentOffer, AugmentRarity, Tier } from '@shared/types'
import { augmentTiersWithOwned, COMBO_TYPE_LABELS, type AugmentTier } from '@shared/mayhem'
import { cardRects } from '@shared/cardLayout'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { ChampIcon } from '@/components/icons'
import { AugmentFrame } from '@/components/AugmentFrame'
import { CardFrames } from '@/components/CardFrames'
import { RARITY_COLORS, RARITY_LABELS, useMayhemData, useOwnedAugments } from '@/components/mayhem'

const SHOWN_TIERS: Tier[] = ['S+', 'S', 'A', 'B']

/**
 * In-game augment tier panel for ARAM: Mayhem. `part="panel"` is the small transparent window at the
 * right screen edge; the default renders panel and card frames in one page (web demo, screenshots).
 */
export function Overlay({ part = 'demo' }: { part?: 'demo' | 'panel' }) {
  const { data: statics, live, settings } = useApp()
  const { data, error } = useMayhemData()
  const owned = useOwnedAugments()
  const [expanded, setExpanded] = useState(() => window.location.hash.includes('champ='))
  // '#/overlay?champ=99' previews the overlay for a champion (used by the web demo)
  const [previewChampionId, setPreviewChampionId] = useState(
    () => Number(new URLSearchParams(window.location.hash.split('?')[1]).get('champ')) || 0
  )
  const [rarity, setRarity] = useState<AugmentRarity | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [focused, setFocused] = useState<AugmentTier | null>(null)
  // '#/overlay?champ=412&offer=1011,2107,1349' fakes an augment choice (web demo, screenshots)
  const [offer] = useState<AugmentOffer | null>(() => {
    const offerIds = new URLSearchParams(window.location.hash.split('?')[1]).get('offer')
    if (!offerIds) return null
    const rects = cardRects(window.innerWidth, window.innerHeight)
    return { displayId: 0, cards: offerIds.split(',').map((id, i) => ({ augmentId: Number(id), text: '', score: 1, rect: rects[i] })) }
  })
  const hovered = useRef(false)
  const autoExpandRef = useRef(true)

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    const unsubscribers = [
      api.on('overlayToggle', () => setExpanded((isExpanded) => !isExpanded)),
      // The panel opens together with the cards and closes once an augment is picked
      api.on('augmentCards', ({ visible }) => setExpanded(visible && autoExpandRef.current)),
      api.on('overlayPreview', ({ championId }) => {
        setPreviewChampionId(championId)
        setExpanded(true)
      })
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [])

  const championId = useMemo(() => {
    if (previewChampionId) return previewChampionId
    return liveChampionKey(statics, live)
  }, [previewChampionId, live, statics])

  autoExpandRef.current = settings?.overlay.autoExpand ?? true
  const level = live?.players.find((player) => player.riotId === live.activePlayer)?.level ?? 0

  const tiers = useMemo(
    () => (data && statics && championId ? augmentTiersWithOwned(data, statics, championId, owned) : []),
    [data, statics, championId, owned]
  )
  const visibleTiers = tiers.filter((entry) => !rarity || entry.augment.rarity === rarity)
  const groups = (showAll ? (['S+', 'S', 'A', 'B', 'C', 'D'] as Tier[]) : SHOWN_TIERS)
    .map((tier) => ({ tier, items: visibleTiers.filter((entry) => entry.tier === tier) }))
    .filter((group) => group.items.length)

  // The overlay window is click-through except while the mouse is over the panel
  const setHover = (isHovered: boolean) => {
    hovered.current = isHovered
    api.setOverlayInteractive(isHovered)
  }

  if (!statics) return null
  if (!championId)
    return (
      <div className="pointer-events-none fixed inset-0 select-none">
        <div
          className={`overlay-panel absolute ${part === 'panel' ? 'right-1 top-1' : 'right-3 top-[14%]'} flex items-center gap-2 px-3 py-2 text-xs font-bold text-[#f0e6d2]`}
        >
          <Sparkles size={14} className="text-gold" /> Augments
          <span className="text-[10px] font-medium text-muted">waiting for your champion…</span>
        </div>
      </div>
    )
  const hotkey = settings?.overlay.hotkey ?? 'Alt+Shift+A'
  const tierById = new Map(tiers.map((entry) => [entry.augment.id, entry]))

  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      {part === 'demo' && offer && <CardFrames offer={offer} tierById={tierById} animation={settings?.overlay.animation ?? 'smooth'} />}
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
                <div className="text-[10px] text-muted">ARAM: Mayhem · augment tiers{level ? ` · level ${level}` : ''}</div>
              </div>
              <button onClick={() => setExpanded(false)} className="rounded p-1 text-muted hover:text-text" title={`Hide (${hotkey})`}>
                <X size={15} />
              </button>
            </div>

            <div className="mb-3 flex gap-1">
              {(['prismatic', 'gold', 'silver'] as AugmentRarity[]).map((option) => (
                <button
                  key={option}
                  onClick={() => setRarity((current) => (current === option ? null : option))}
                  className={`flex-1 rounded-md border px-1 py-0.5 text-[10px] font-bold ${rarity && rarity !== option ? 'opacity-40' : ''}`}
                  style={{ color: RARITY_COLORS[option], borderColor: `color-mix(in srgb, ${RARITY_COLORS[option]} 40%, transparent)` }}
                >
                  {RARITY_LABELS[option]}
                </button>
              ))}
            </div>

            {!data ? (
              <p className={`text-xs ${error ? 'text-loss' : 'text-muted'}`}>{error ?? 'Loading augment data …'}</p>
            ) : (
              <div className="max-h-[62vh] space-y-3 overflow-y-auto pr-1">
                {groups.map((group) => (
                  <div key={group.tier}>
                    <div className="grid grid-cols-5 gap-x-2 gap-y-6 pt-3 pb-2">
                      {group.items.map((entry) => (
                        <AugmentFrame
                          key={entry.augment.id}
                          augment={entry.augment}
                          tier={entry.tier}
                          size={42}
                          onHover={(hovering) => setFocused(hovering ? entry : null)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => setShowAll((current) => !current)}
                  className="flex w-full items-center justify-center gap-1 text-[10px] text-muted hover:text-text"
                >
                  <ChevronDown size={12} className={showAll ? 'rotate-180' : ''} /> {showAll ? 'Hide C & D tier' : 'Show C & D tier'}
                </button>
              </div>
            )}
            <div className="mt-2 min-h-[58px] rounded-lg bg-black/35 p-2 text-xs">
              {focused ? (
                <>
                  <div className="flex items-center gap-2">
                    <b className="truncate text-[#f0e6d2]">{focused.augment.name}</b>
                    <span className="text-[10px] font-bold" style={{ color: RARITY_COLORS[focused.augment.rarity] }}>
                      {RARITY_LABELS[focused.augment.rarity]}
                    </span>
                    <span className="ml-auto text-[10px] text-muted">
                      {focused.combo
                        ? COMBO_TYPE_LABELS[focused.combo]
                        : focused.augment.pickRate != null
                          ? `picked ${focused.augment.pickRate.toFixed(1)}%`
                          : ''}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-text/85">
                    {focused.note ?? 'No note yet.'}
                    {!focused.fits && <span className="text-loss"> · weak fit for this champion</span>}
                  </div>
                </>
              ) : (
                <span className="text-[11px] text-muted">Hover an augment to see why it is rated this way.</span>
              )}
            </div>
            <div className="mt-2 border-t border-white/10 pt-2 text-[9px] leading-snug text-muted">
              Tiers = curated combos + pick rate + champion fit (no win rates – Riot asks devs not to publish them). Data: arammayhem.com
              (CC BY 4.0)
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
