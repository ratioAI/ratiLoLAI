import { useEffect, useMemo, useState } from 'react'
import type { AugmentOffer } from '@shared/types'
import { augmentTiersForChampion } from '@shared/mayhem'
import { liveChampionKey } from '@shared/staticData'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { CardFrames } from '@/components/CardFrames'
import { useMayhemData } from '@/components/mayhem'

/** Frames window: sized by the main process to cover just the three augment cards. */
export function OverlayFrames() {
  const { data: statics, live, settings } = useApp()
  const { data } = useMayhemData()
  const [offer, setOffer] = useState<AugmentOffer | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    return api.on('framesOffer', setOffer)
  }, [])

  const liveChampionId = liveChampionKey(statics, live)
  const championId = offer?.championId ?? liveChampionId
  // the champion's static tier list, the same one shown before the game
  const tierById = useMemo(() => {
    const tiers = data && statics && championId ? augmentTiersForChampion(data, statics, championId) : []
    return new Map(tiers.map((tier) => [tier.augment.id, tier]))
  }, [data, statics, championId])

  if (!offer || !tierById.size) return null
  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      <CardFrames offer={offer} tierById={tierById} animation={settings?.overlay.animation ?? 'smooth'} />
    </div>
  )
}
