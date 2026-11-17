import { useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/lib/store'
import { playAnnouncement, prepareAudio } from '@/lib/announcer'

/**
 * Plays the hype announcer in the main window (never in the game overlays). The main process only
 * sends what should be heard (enabled, trigger switched on, cooldown over); this just plays it,
 * with the current volume and voice setting. The audio graph is set up at start, so the first
 * sound in a game has no delay, and it plays with the window minimized too.
 */
export function AnnouncerHost() {
  const { settings } = useApp()
  const current = useRef(settings?.announcer)
  current.current = settings?.announcer
  useEffect(() => {
    prepareAudio()
    return api.on('announce', (announcement) => {
      const options = current.current
      void playAnnouncement(announcement, { volume: options?.volume ?? 0.6, voice: options?.voice ?? true })
    })
  }, [])
  return null
}
