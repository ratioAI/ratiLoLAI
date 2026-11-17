/** One event of the Live Client Data feed (only the fields used here). */
export interface LiveEvent {
  EventID: number
  EventName: string
  EventTime: number
  KillerName?: string
  VictimName?: string
  Assisters?: string[]
  KillStreak?: number
  Acer?: string
  AcingTeam?: string
  Recipient?: string
  Result?: string
}
