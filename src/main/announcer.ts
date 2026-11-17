import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { LiveGameState, Settings } from '@shared/types'
import { detectTriggers, pickAnnouncement, TRIGGERS, type Announcement, type LiveEvent, type Trigger } from '@shared/announcer'

/**
 * Feeds the live event feed into the announcer, one poll at a time (no loop of its own). Keeps the
 * id of the last event seen so nothing is announced twice, starts over when a new game begins, and
 * keeps counting while the announcer is off so turning it on mid-game doesn't replay old events.
 */
export class AnnouncerFeed {
  private lastEventId: number | null = null
  private lastGameTime = 0
  private lastPlayedAt: number | null = null

  constructor(
    private readonly deps: {
      settings(): Settings['announcer']
      announce(announcement: Announcement): void
      now?(): number
    }
  ) {}

  tick(events: readonly LiveEvent[], state: LiveGameState | null): void {
    if (!state?.active) {
      this.lastEventId = null
      this.lastGameTime = 0
      return
    }
    // the clock went backwards: a new game (or a replay); its event ids start from 0 again
    if (state.gameTime + 5 < this.lastGameTime) this.lastEventId = null
    this.lastGameTime = state.gameTime
    const me = state.activePlayer ?? ''
    const myTeam = state.players.find((player) => player.riotId === me)?.team ?? null
    const { announcements, lastEventId } = detectTriggers(this.lastEventId, events, { me, premades: state.premades ?? [], myTeam })
    this.lastEventId = lastEventId
    const settings = this.deps.settings()
    if (!settings.enabled || !announcements.length) return
    const now = this.deps.now?.() ?? Date.now()
    const pick = pickAnnouncement(announcements, {
      enabled: settings.triggers,
      cooldownS: settings.cooldownS,
      lastPlayedAt: this.lastPlayedAt,
      now
    })
    if (!pick) return
    this.lastPlayedAt = now
    this.deps.announce(pick)
  }
}

const SOUND_TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' }

/** Your own sound for a trigger: userData/sounds/<trigger>.mp3 (or .wav / .ogg), null when there is none. */
export async function customSound(dir: string, trigger: string): Promise<{ data: Uint8Array; mime: string } | null> {
  if (!(TRIGGERS as readonly string[]).includes(trigger)) return null
  for (const [extension, mime] of Object.entries(SOUND_TYPES)) {
    const data = await readFile(join(dir, `${trigger as Trigger}.${extension}`)).catch(() => null)
    // a few MB at most: these are short clips
    if (data && data.length <= 8 * 1024 * 1024) return { data: new Uint8Array(data), mime }
  }
  return null
}

/** Creates the sounds folder (with nothing in it) so "Open sound folder" always has somewhere to go. */
export async function ensureSoundFolder(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  return dir
}
