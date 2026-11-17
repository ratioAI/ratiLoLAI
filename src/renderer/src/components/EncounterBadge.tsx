import { Clover, CloudRain, Crosshair, Eye, Skull, Swords, type LucideIcon } from 'lucide-react'
import { ENCOUNTER_LABELS, agoText, type Encounter, type EncounterKind } from '@shared/encounters'

/** Icon and colour of each kind of encounter (loading screen, profile). */
export const ENCOUNTER_STYLE: Record<EncounterKind, { icon: LucideIcon; color: string }> = {
  nemesis: { icon: Skull, color: '#ff5c8a' },
  victim: { icon: Crosshair, color: '#ffb35c' },
  luckyCharm: { icon: Clover, color: '#54f0a4' },
  jinx: { icon: CloudRain, color: '#8fa8ff' },
  rival: { icon: Swords, color: '#d79bff' },
  familiar: { icon: Eye, color: '#8fe3ff' }
}

/** Tooltip with the full numbers behind an encounter. */
export function encounterTitle(encounter: Encounter, now = Date.now()): string {
  const { together, against, last } = encounter
  const parts = [ENCOUNTER_LABELS[encounter.kind]]
  if (together.games) parts.push(`together ${together.wins}W ${together.games - together.wins}L`)
  if (against.games) parts.push(`against ${against.wins}W ${against.games - against.wins}L`)
  parts.push(`last met ${agoText(last.createdAt, now)} (${last.win ? 'you won' : 'you lost'})`)
  if (encounter.formerRiotId) parts.push(`then called ${encounter.formerRiotId}`)
  return parts.join(' · ')
}

/** The kind's icon in its colour. */
export function EncounterIcon({ kind, size = 11 }: { kind: EncounterKind; size?: number }) {
  const { icon: Icon, color } = ENCOUNTER_STYLE[kind]
  return (
    <Icon size={size} strokeWidth={2.4} style={{ color, filter: `drop-shadow(0 0 4px ${color}aa)` }} className="shrink-0" aria-hidden />
  )
}
