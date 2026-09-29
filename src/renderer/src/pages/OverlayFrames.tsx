import { useEffect, useMemo, useState } from 'react'
import type { AugmentOffer } from '@shared/types'
import { augmentTiersWithOwned } from '@shared/mayhem'
import { liveChampionKey } from '@shared/staticData'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { CardFrames } from '@/components/CardFrames'
import { useMayhemData, useOwnedAugments } from '@/components/mayhem'

/** Frames window: sized by the main process to cover just the three augment cards. */
export function OverlayFrames() {
  const { data: statics, live, settings } = useApp()
  const { data } = useMayhemData()
  const [offer, setOffer] = useState<AugmentOffer | null>(null)
  const owned = useOwnedAugments()

  useEffect(() => {
    document.documentElement.classList.add('overlay-mode')
    return api.on('framesOffer', setOffer)
  }, [])

  const liveChamp = liveChampionKey(statics, live)
  const championId = offer?.championId ?? liveChamp
  const tierById = useMemo(() => {
    // combos with the augments already picked lift (or sink) the offered cards
    const tiers = data && statics && championId ? augmentTiersWithOwned(data, statics, championId, owned) : []
    return new Map(tiers.map((t) => [t.augment.id, t]))
  }, [data, statics, championId, owned])
  const names = useMemo(
    () => Object.fromEntries(Object.values(data?.augments ?? {}).map((a) => [a.id, a.name])) as Record<number, string>,
    [data]
  )

  if (!offer || !tierById.size) return null
  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      <CardFrames offer={offer} tierById={tierById} names={names} animation={settings?.overlay.animation ?? 'smooth'} />
    </div>
  )
}
