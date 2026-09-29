import type { AugmentOffer, Settings, Tier } from '@shared/types'
import { COMBO_TYPE_LABELS, type AugmentTier } from '@shared/mayhem'
import { FrameCanvas, type FrameSpec } from './FrameCanvas'

const TIER_ORDER: Tier[] = ['S+', 'S', 'A', 'B', 'C', 'D']
const TIER_WORDS: Record<Tier, string> = { 'S+': 'Must pick', S: 'Great', A: 'Good', B: 'Okay', C: 'Meh', D: 'Avoid' }

/**
 * Frames drawn exactly over the three augment cards the game currently offers: an animated WebGL
 * border (FrameCanvas) plus a static crest with the tier and a one-line note inside the card.
 */
export function CardFrames({
  offer,
  tierById,
  animation = 'smooth'
}: {
  offer: AugmentOffer
  tierById: Map<number, AugmentTier>
  animation?: Settings['overlay']['animation']
}) {
  const rated = offer.cards.map((c) => (c.augmentId != null ? (tierById.get(c.augmentId) ?? null) : null))
  const bestRank = Math.min(...rated.map((t) => (t ? TIER_ORDER.indexOf(t.tier) : 99)))
  const isBest = (t: AugmentTier) =>
    TIER_ORDER.indexOf(t.tier) === bestRank && rated.filter((r) => r && TIER_ORDER.indexOf(r.tier) === bestRank).length === 1
  const specs: FrameSpec[] = offer.cards.flatMap((card, i) => {
    const t = rated[i]
    return t ? [{ rect: card.rect, tier: t.tier, best: isBest(t) }] : []
  })
  return (
    <>
      <FrameCanvas frames={specs} animation={animation} />
      {offer.cards.map((card, i) => {
        const t = rated[i]
        if (!t) return null
        const label = isBest(t) ? 'Best pick' : t.combo ? COMBO_TYPE_LABELS[t.combo] : !t.fits ? 'Weak fit' : TIER_WORDS[t.tier]
        return (
          <div
            key={i}
            className="card-frame"
            data-tier={t.tier}
            style={{ left: card.rect.x, top: card.rect.y, width: card.rect.width, height: card.rect.height }}
          >
            <div className="cf-crest">
              <span className="cf-shield">
                <span className="cf-tier">{t.tier}</span>
              </span>
              <span className="cf-label">{label}</span>
            </div>
            {t.note && <div className="cf-note">{t.note}</div>}
          </div>
        )
      })}
    </>
  )
}
