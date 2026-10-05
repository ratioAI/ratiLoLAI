import type { ReactNode } from 'react'
import type { MayhemAugment, Tier } from '@shared/types'
import { GameImage } from './icons'
import { RARITY_COLORS, RARITY_LABELS } from './mayhem'

function Crest({ tier }: { tier: Tier }) {
  if (tier === 'S+')
    return (
      <svg className="aug-crest" width="30" height="16" viewBox="0 0 30 16" aria-hidden>
        <defs>
          <linearGradient id="crest-splus" x1="0" x2="1">
            <stop offset="0" stopColor="#f5c451" />
            <stop offset="1" stopColor="#7ef0ff" />
          </linearGradient>
        </defs>
        <path d="M2 14 5 4l5 5 5-8 5 8 5-5 3 10z" fill="url(#crest-splus)" stroke="#0b0e14" strokeWidth="1.2" />
        <circle cx="15" cy="3" r="2" fill="#fff" />
      </svg>
    )
  if (tier === 'S')
    return (
      <svg className="aug-crest" width="22" height="12" viewBox="0 0 22 12" aria-hidden>
        <path d="M1 11 11 1l10 10z" fill="#b265ff" stroke="#0b0e14" strokeWidth="1.2" />
        <path d="M7 11 11 6l4 5z" fill="#f0b8ff" />
      </svg>
    )
  if (tier === 'A')
    return (
      <svg className="aug-crest" width="14" height="12" viewBox="0 0 14 12" aria-hidden>
        <path d="M7 1 13 6 7 11 1 6z" fill="#8fc0ff" stroke="#0b0e14" strokeWidth="1.2" />
      </svg>
    )
  return null
}

/** An augment icon wrapped in a tier frame (S+ animated radiant, S royal, A crystal, B emerald, C steel, D bronze). */
export function AugmentFrame({
  augment,
  tier,
  size = 48,
  note,
  extra,
  onHover
}: {
  augment: MayhemAugment
  tier: Tier
  size?: number
  note?: string | null
  extra?: ReactNode
  /** when set, no tooltip is rendered – the caller shows the details itself */
  onHover?: (hovered: boolean) => void
}) {
  return (
    <span
      className="aug-frame"
      data-tier={tier}
      onMouseEnter={onHover && (() => onHover(true))}
      onMouseLeave={onHover && (() => onHover(false))}
    >
      {(tier === 'S+' || tier === 'S' || tier === 'A') && <span className="aug-glow" />}
      <span className="aug-inner">
        <GameImage
          src={augment.icon}
          size={size}
          alt={augment.name}
          rounded="rounded-none"
          tooltip={
            onHover ? undefined : (
              <span className="block max-w-[240px]">
                <span className="flex items-center gap-2">
                  <b>{augment.name}</b>
                  <span className="rounded px-1 text-[10px] font-black text-bg" style={{ background: 'var(--color-gold)' }}>
                    {tier}
                  </span>
                </span>
                <span className="block text-[11px]" style={{ color: RARITY_COLORS[augment.rarity] }}>
                  {RARITY_LABELS[augment.rarity]}
                  {augment.pickRate != null && <span className="text-muted"> · picked {augment.pickRate.toFixed(1)}%</span>}
                </span>
                {note && <span className="mt-1 block text-text/90">{note}</span>}
                {extra}
              </span>
            )
          }
        />
      </span>
      <Crest tier={tier} />
      <span className="aug-badge">{tier}</span>
    </span>
  )
}
