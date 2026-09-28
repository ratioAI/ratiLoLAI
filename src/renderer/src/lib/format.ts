import type { Tier } from '@shared/types'

export const pct = (n: number, digits = 1): string => `${(n * 100).toFixed(digits)}%`
export const num = (n: number): string => n.toLocaleString('de-DE')

export function duration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function timeAgo(ts: number): string {
  const diff = (Date.now() - ts) / 1000
  if (diff < 60) return 'gerade eben'
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`
  const days = Math.floor(diff / 86400)
  return days === 1 ? 'vor 1 Tag' : `vor ${days} Tagen`
}

export const TIER_COLORS: Record<Tier, string> = {
  'S+': 'var(--color-tier-splus)',
  S: 'var(--color-tier-s)',
  A: 'var(--color-tier-a)',
  B: 'var(--color-tier-b)',
  C: 'var(--color-tier-c)',
  D: 'var(--color-tier-d)'
}

/** Colour for a win rate: red below 48%, neutral around 50%, green above 52%. */
export function wrColor(wr: number): string {
  if (wr >= 0.53) return 'var(--color-win)'
  if (wr >= 0.51) return '#8fe3b5'
  if (wr <= 0.47) return 'var(--color-loss)'
  if (wr <= 0.49) return '#ff9aa4'
  return 'var(--color-text)'
}

export const RANK_COLORS: Record<string, string> = {
  IRON: '#8b7b74',
  BRONZE: '#b0714f',
  SILVER: '#9fb0bf',
  GOLD: '#e3b451',
  PLATINUM: '#4fc1b3',
  EMERALD: '#3fcf7f',
  DIAMOND: '#6b9dff',
  MASTER: '#c07bff',
  GRANDMASTER: '#ff5d6c',
  CHALLENGER: '#f5d67a'
}

export const QUEUES: Record<number, string> = {
  420: 'Solo/Duo',
  440: 'Flex',
  400: 'Normal Draft',
  430: 'Normal Blind',
  490: 'Quickplay',
  450: 'ARAM',
  1700: 'Arena',
  1900: 'URF',
  900: 'ARURF'
}
