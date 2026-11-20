import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WindowMode } from '@shared/overlayNotice'

export type { WindowMode }

/** League's video settings as far as the overlay cares. */
export interface GameWindowSettings {
  mode: WindowMode | null
  /** game resolution, 0 when unknown */
  width: number
  height: number
  /** where the values came from, for the log (client + game.cfg: the mode from the client, the resolution from the file) */
  source: 'client' | 'game.cfg' | 'client + game.cfg'
}

/** WindowMode in game.cfg and the client's settings: 0 = fullscreen, 1 = windowed, 2 = borderless. */
function toMode(value: unknown): WindowMode | null {
  const number = typeof value === 'string' ? Number(value.trim()) : value
  return number === 0 ? 'fullscreen' : number === 1 ? 'windowed' : number === 2 ? 'borderless' : null
}

const toSize = (value: unknown): number => {
  const number = typeof value === 'string' ? Number(value.trim()) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? Math.round(number) : 0
}

/** Parses the client's GET /lol-game-settings/v1/game-settings response. */
export function parseClientGameSettings(json: unknown): GameWindowSettings | null {
  const general = (json as { General?: Record<string, unknown> } | null)?.General
  if (!general || typeof general !== 'object') return null
  const mode = toMode(general.WindowMode)
  if (mode === null && !toSize(general.Width)) return null
  return { mode, width: toSize(general.Width), height: toSize(general.Height), source: 'client' }
}

/** Parses the [General] section of League's Config/game.cfg (INI). */
export function parseGameCfg(text: string): GameWindowSettings | null {
  let section = ''
  const values: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    if (section !== 'general') continue
    const eq = line.indexOf('=')
    if (eq > 0) values[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim()
  }
  const mode = toMode(values.windowmode)
  if (mode === null && !toSize(values.width)) return null
  return { mode, width: toSize(values.width), height: toSize(values.height), source: 'game.cfg' }
}

/** Reads Config/game.cfg from the first install folder that has one. */
export async function readGameCfg(installDirs: string[]): Promise<GameWindowSettings | null> {
  for (const dir of installDirs.filter(Boolean)) {
    try {
      const parsed = parseGameCfg(await readFile(join(dir, 'Config', 'game.cfg'), 'utf8'))
      if (parsed) return parsed
    } catch {
      // not installed there
    }
  }
  return null
}
