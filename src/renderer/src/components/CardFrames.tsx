import type { AugmentOffer, Settings, Tier } from '@shared/types'
import { COMBO_TYPE_LABELS, type AugmentTier } from '@shared/mayhem'
import { FrameCanvas, type FrameSpec } from './FrameCanvas'

const TIER_ORDER: Tier[] = ['S+', 'S', 'A', 'B', 'C', 'D']
const TIER_WORDS: Record<Tier, string> = { 'S+': 'Must pick', S: 'Great', A: 'Good', B: 'Okay', C: 'Meh', D: 'Avoid' }

/**
 * Overlay for the augment cards the game is offering: an animated WebGL border per card (FrameCanvas)
 * plus a static crest with the tier and a one-line note.
 */
export function CardFrames({
  offer,
  tierById,
  animation = 'smooth',
  names = {}
}: {
  offer: AugmentOffer
  tierById: Map<number, AugmentTier>
  animation?: Settings['overlay']['animation']
  /** augment id to name, used in the combo note */
  names?: Record<number, string>
}) {
  const rated = offer.cards.map((card) => (card.augmentId != null ? (tierById.get(card.augmentId) ?? null) : null))
  const bestRank = Math.min(...rated.map((rating) => (rating ? TIER_ORDER.indexOf(rating.tier) : 99)))
  // "Best pick" only when one card is clearly ahead; a shared top tier highlights nothing
  const isBest = (rating: AugmentTier) =>
    TIER_ORDER.indexOf(rating.tier) === bestRank &&
    rated.filter((other) => other && TIER_ORDER.indexOf(other.tier) === bestRank).length === 1
  const specs: FrameSpec[] = offer.cards.flatMap((card, i) => {
    const rating = rated[i]
    const combo = !!rating?.synergy && rating.synergy.type !== 'trap'
    return rating ? [{ rect: card.rect, tier: rating.tier, best: isBest(rating), combo }] : []
  })
  return (
    <>
      <FrameCanvas frames={specs} animation={animation} />
      {offer.cards.map((card, i) => {
        const rating = rated[i]
        if (!rating) return null
        const synergy = rating.synergy
        const label =
          synergy && synergy.type !== 'trap' && !synergy.missing.length
            ? 'Completes combo'
            : isBest(rating)
              ? 'Best pick'
              : synergy && synergy.type !== 'trap'
                ? 'Builds combo'
                : synergy
                  ? 'Trap combo'
                  : rating.combo
                    ? COMBO_TYPE_LABELS[rating.combo]
                    : !rating.fits
                      ? 'Weak fit'
                      : TIER_WORDS[rating.tier]
        const note = synergy
          ? `${synergy.type === 'trap' ? 'Trap with' : 'Combo with'} ${synergy.with.map((id) => names[id] ?? '?').join(' + ')}${
              synergy.missing.length ? ` – ${synergy.missing.length} more to go` : ''
            }`
          : rating.note
        return (
          <div
            key={i}
            className="card-frame"
            data-tier={rating.tier}
            data-combo={synergy && synergy.type !== 'trap' ? '' : undefined}
            style={{ left: card.rect.x, top: card.rect.y, width: card.rect.width, height: card.rect.height }}
          >
            <div className="cf-crest">
              <span className="cf-shield">
                <span className="cf-tier">{rating.tier}</span>
              </span>
              <span className="cf-label">{label}</span>
            </div>
            {note && <div className={`cf-note ${synergy ? 'cf-note-combo' : ''}`}>{note}</div>}
          </div>
        )
      })}
    </>
  )
}
