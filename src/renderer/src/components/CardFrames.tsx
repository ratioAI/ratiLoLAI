import type { AugmentOffer, Settings } from '@shared/types'
import type { AugmentTier } from '@shared/mayhem'
import { FrameCanvas, type FrameSpec } from './FrameCanvas'

/**
 * Overlay for the augment cards the game is offering: an animated WebGL border per card
 * (FrameCanvas) in the colour of the champion's static tier for that augment – the same tier list
 * the app shows before the game (curated combos, pick rate, archetype fit). Nothing on the card is
 * judged from the running game (enemies, owned augments), no card is singled out and no text is
 * drawn: League shows its own tier and description on the card.
 */
export function CardFrames({
  offer,
  tierById,
  animation = 'smooth'
}: {
  offer: AugmentOffer
  /** the champion's tiers (augmentTiersForChampion), by augment id */
  tierById: Map<number, AugmentTier>
  animation?: Settings['overlay']['animation']
}) {
  const specs: FrameSpec[] = offer.cards.flatMap((card) => {
    const rating = card.augmentId != null ? tierById.get(card.augmentId) : undefined
    return rating ? [{ rect: card.rect, tier: rating.tier }] : []
  })
  return <FrameCanvas frames={specs} animation={animation} />
}
