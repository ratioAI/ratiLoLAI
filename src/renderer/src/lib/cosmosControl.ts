import type { FlightVariant } from '@shared/journey'

/**
 * Admin tool → the window's place in the universe (useCosmos in main.tsx): fly to a place, or move
 * there without a flight. Only listened to in `npm run dev`.
 */
export type CosmosCommand =
  /** `stay` = keep the page you're on afterwards instead of switching to the Live tab like a match does */
  { type: 'fly'; to: number; variant?: FlightVariant; stay?: boolean } | { type: 'teleport'; to: number }

export const COSMOS_EVENT = 'rc-admin-cosmos'

export function sendCosmos(command: CosmosCommand): void {
  window.dispatchEvent(new CustomEvent<CosmosCommand>(COSMOS_EVENT, { detail: command }))
}
