import { useEffect, useMemo, useState } from 'react'
import type { AugmentOffer } from '@shared/types'
import { augmentTiersWithOwned } from '@shared/mayhem'
import { cardRects } from '@shared/cardLayout'
import { useApp } from '@/lib/store'
import { CardFrames } from '@/components/CardFrames'
import { useMayhemData, useOwnedAugments } from '@/components/mayhem'

/**
 * The card frames as one full page, for the web demo and screenshots (in the app they live in their
 * own small window, see OverlayFrames). '#/overlay?champ=412&offer=1011,2107,1349' fakes an augment
 * choice for that champion.
 */
export function Overlay() {
  const { data: statics, settings } = useApp()
  const { data } = useMayhemData()
  const owned = useOwnedAugments()
  const [params] = useState(() => new URLSearchParams(window.location.hash.split('?')[1]))
  const championId = Number(params.get('champ')) || 0
  const [offer] = useState<AugmentOffer | null>(() => {
    const offerIds = params.get('offer')
    if (!offerIds) return null
    const rects = cardRects(window.innerWidth, window.innerHeight)
    return { displayId: 0, cards: offerIds.split(',').map((id, i) => ({ augmentId: Number(id), text: '', score: 1, rect: rects[i] })) }
  })

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
  }, [])

  const tierById = useMemo(
    () =>
      new Map(
        (data && statics && championId ? augmentTiersWithOwned(data, statics, championId, owned) : []).map((entry) => [
          entry.augment.id,
          entry
        ])
      ),
    [data, statics, championId, owned]
  )
  if (!statics || !offer) return null
  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      <CardFrames offer={offer} tierById={tierById} animation={settings?.overlay.animation ?? 'smooth'} />
    </div>
  )
}
