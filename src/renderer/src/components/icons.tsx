import { memo, useState, type ReactNode } from 'react'
import type { StatRole, Tier } from '@shared/types'
import { useGameData } from '@/lib/store'
import { img } from '@/lib/img'
import { TIER_COLORS } from '@/lib/format'

// CSS-only hover tooltip; renders the children unchanged when there's no content
function Tooltip({ content, children }: { content?: ReactNode; children: ReactNode }) {
  if (!content) return <>{children}</>
  return (
    <span className="tooltip inline-flex">
      {children}
      <span className="tooltip-body">{content}</span>
    </span>
  )
}

/** Game asset image that falls back to the first two letters of `alt` if it fails to load. */
export function GameImage({
  src,
  size,
  alt,
  rounded = 'rounded-lg',
  className = '',
  tooltip
}: {
  src: string
  size: number
  alt: string
  rounded?: string
  className?: string
  tooltip?: ReactNode
}) {
  const [failed, setFailed] = useState(false)
  const image =
    !src || failed ? (
      <span
        className={`${rounded} ${className} inline-flex shrink-0 items-center justify-center bg-panel-2 text-[10px] font-bold text-muted`}
        style={{ width: size, height: size }}
      >
        {alt.slice(0, 2).toUpperCase()}
      </span>
    ) : (
      <img
        src={src}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(true)}
        className={`${rounded} ${className} shrink-0 object-cover`}
        style={{ width: size, height: size }}
      />
    )
  return <Tooltip content={tooltip}>{image}</Tooltip>
}

export const ChampIcon = memo(function ChampIcon({
  id,
  size = 40,
  className = '',
  tooltip = true
}: {
  id: number
  size?: number
  className?: string
  tooltip?: boolean
}) {
  const data = useGameData()
  if (!data) return null
  const champ = data.champions[id]
  return (
    <GameImage
      src={img.champion(data, id)}
      size={size}
      alt={champ?.name ?? '?'}
      className={className}
      tooltip={tooltip && champ ? <b>{champ.name}</b> : undefined}
    />
  )
})

export const ItemIcon = memo(function ItemIcon({ id, size = 36, count }: { id: number; size?: number; count?: number }) {
  const data = useGameData()
  if (!data || !id) return <span className="inline-block shrink-0 rounded-md bg-bg-2" style={{ width: size, height: size }} />
  const item = data.items[id]
  return (
    <span className="relative inline-flex">
      <GameImage
        src={img.item(data, id)}
        size={size}
        alt={item?.name ?? String(id)}
        rounded="rounded-md"
        tooltip={
          item ? (
            <span className="block">
              <b className="text-accent">{item.name}</b> <span className="text-gold">· {item.gold}g</span>
              {/* plaintext is often empty, so fall back to the start of the full description */}
              <span className="mt-1 block text-muted">{item.plaintext || stripHtml(item.description).slice(0, 220)}</span>
            </span>
          ) : undefined
        }
      />
      {count && count > 1 ? (
        <span className="absolute -right-1 -bottom-1 rounded bg-black/80 px-1 text-[10px] font-bold">{count}</span>
      ) : null}
    </span>
  )
})

export const RuneIcon = memo(function RuneIcon({ id, size = 32, dim = false }: { id: number; size?: number; dim?: boolean }) {
  const data = useGameData()
  if (!data) return null
  // the id can be a single rune or a whole tree; trees have no shortDesc
  const rune = data.runes[id] ?? data.runeTrees.find((tree) => tree.id === id)
  return (
    <GameImage
      src={img.rune(data, id)}
      size={size}
      alt={rune?.name ?? '?'}
      rounded="rounded-full"
      className={dim ? 'opacity-25 grayscale' : ''}
      tooltip={
        rune ? (
          <span className="block">
            <b>{rune.name}</b>
            {'shortDesc' in rune && rune.shortDesc ? <span className="mt-1 block text-muted">{rune.shortDesc}</span> : null}
          </span>
        ) : undefined
      }
    />
  )
})

export const SpellIcon = memo(function SpellIcon({ id, size = 30 }: { id: number; size?: number }) {
  const data = useGameData()
  if (!data) return null
  const spell = data.spells[id]
  return (
    <GameImage
      src={img.spell(data, id)}
      size={size}
      alt={spell?.name ?? '?'}
      rounded="rounded-md"
      tooltip={spell ? <b>{spell.name}</b> : undefined}
    />
  )
})

export function TierBadge({ tier, size = 'md' }: { tier: Tier | null; size?: 'sm' | 'md' | 'lg' }) {
  if (!tier) return <span className="text-muted">–</span>
  const sizeClass = size === 'lg' ? 'h-11 min-w-11 text-lg' : size === 'sm' ? 'h-6 min-w-7 text-xs' : 'h-8 min-w-9 text-sm'
  return (
    <span
      className={`${sizeClass} inline-flex items-center justify-center rounded-lg px-1.5 font-extrabold`}
      style={{ color: TIER_COLORS[tier], background: `color-mix(in srgb, ${TIER_COLORS[tier]} 14%, transparent)` }}
    >
      {tier}
    </span>
  )
}

/** Lane icons. Our own drawings, not Riot assets. */
export function RoleIcon({ role, size = 18, className = '' }: { role: StatRole | 'ALL'; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', className, fill: 'currentColor' }
  switch (role) {
    case 'TOP':
      return (
        <svg {...common}>
          <path d="M3 3h14l-4 4H7v6l-4 4z" />
          <rect x="10" y="10" width="4" height="4" opacity=".55" />
          <path d="M21 7v14H7l4-4h6v-6z" opacity=".35" />
        </svg>
      )
    case 'JUNGLE':
      return (
        <svg {...common}>
          <path d="M12 2c-1 4-4 6-4 10 0 2.2 1.1 4.1 2.8 5.2L12 22l1.2-4.8C14.9 16.1 16 14.2 16 12c0-4-3-6-4-10zM5 6c0 3 1 5.5 2.5 7C7.2 10 6.3 8 5 6zm14 0c-1.3 2-2.2 4-2.5 7C18 11.5 19 9 19 6z" />
        </svg>
      )
    case 'MIDDLE':
      return (
        <svg {...common}>
          <path d="M17 3h4v4L7 21H3v-4z" />
          <path d="M3 3h7l-3 3v5l-4 4zM21 21h-7l3-3v-5l4-4z" opacity=".35" />
        </svg>
      )
    case 'BOTTOM':
      return (
        <svg {...common}>
          <path d="M21 21H7l4-4h6v-6l4-4z" />
          <rect x="10" y="10" width="4" height="4" opacity=".55" />
          <path d="M3 17V3h14l-4 4H7v6z" opacity=".35" />
        </svg>
      )
    case 'UTILITY':
      return (
        <svg {...common}>
          <path d="M9 3h6l-1 4h-4zM4 8h16l-3 4h-3l1 9-3-3-3 3 1-9H7z" />
        </svg>
      )
    case 'ARAM':
      return (
        <svg {...common}>
          <path d="M12 2 9.5 6.5 12 8l2.5-1.5zM4 9l3 1-1 3 3 2 3-2 3 2 3-2-1-3 3-1-3-2-2 1.5L12 10 9 8.5 7 7z" />
          <path d="M6 17h12l-1.5 5h-9z" opacity=".5" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <rect x="3" y="3" width="8" height="8" rx="2" />
          <rect x="13" y="3" width="8" height="8" rx="2" opacity=".6" />
          <rect x="3" y="13" width="8" height="8" rx="2" opacity=".6" />
          <rect x="13" y="13" width="8" height="8" rx="2" />
        </svg>
      )
  }
}

// item descriptions from Data Dragon contain HTML-ish markup (<br>, <stats>, ...)
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
