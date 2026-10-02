import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { Settings } from '@shared/types'

type Stored = Omit<Settings, 'hasApiKey'> & { apiKeyEnc?: string; apiKeyPlain?: string; schema?: number }

/** bump to migrate stored settings (2: UI switched to English → game data defaults to en_US) */
const SCHEMA = 3

export const DEFAULT_SETTINGS: Omit<Settings, 'hasApiKey'> = {
  platform: 'euw1',
  language: 'en_US',
  leaguePath: '',
  crawler: {
    seedTiers: ['CHALLENGER', 'GRANDMASTER', 'MASTER'],
    extraPlatforms: [],
    maxMatchesPerRun: 1500,
    matchesPerPlayer: 10,
    minGamesForTierList: 20
  },
  overlay: {
    enabled: true,
    hotkey: 'Alt+Shift+A',
    autoExpand: false,
    cardFrames: true,
    animation: 'smooth',
    loadingScreen: true,
    showInCapture: false,
    gameDisplayId: null
  },
  ui: {
    background: 'animated'
  },
  minimap: {
    enabled: true,
    inhibitors: true,
    relics: true,
    scale: 1
  },
  client: {
    autoImportRunes: true,
    autoImportItems: true,
    autoImportSpells: false,
    flashOn: 'F',
    autoAccept: false,
    acceptDelay: 'human'
  }
}

/**
 * Tiny JSON settings store. The Riot API key is encrypted with Electron's safeStorage
 * (DPAPI on Windows, Keychain on macOS) and never sent to the renderer.
 */
export class SettingsStore {
  private data: Stored

  constructor(private readonly file: string) {
    let loaded: Partial<Stored> = {}
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>
    } catch {
      /* first start */
    }
    this.data = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      crawler: { ...DEFAULT_SETTINGS.crawler, ...loaded.crawler },
      overlay: { ...DEFAULT_SETTINGS.overlay, ...loaded.overlay },
      minimap: { ...DEFAULT_SETTINGS.minimap, ...loaded.minimap },
      ui: { ...DEFAULT_SETTINGS.ui, ...loaded.ui },
      client: { ...DEFAULT_SETTINGS.client, ...loaded.client }
    }
    if ((loaded.schema ?? 1) < 2) this.data.language = 'en_US'
    // 3: only the card frames by default – the tier list panel is opt-in
    if ((loaded.schema ?? 1) < 3) this.data.overlay.autoExpand = false
    this.data.schema = SCHEMA
  }

  get(): Settings {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeyEnc, apiKeyPlain, schema, ...rest } = this.data
    return { ...rest, hasApiKey: !!(apiKeyEnc || apiKeyPlain) }
  }

  update(patch: Partial<Omit<Settings, 'hasApiKey'>>): Settings {
    this.data = {
      ...this.data,
      ...patch,
      crawler: { ...this.data.crawler, ...patch.crawler },
      overlay: { ...this.data.overlay, ...patch.overlay },
      minimap: { ...this.data.minimap, ...patch.minimap },
      ui: { ...this.data.ui, ...patch.ui },
      client: { ...this.data.client, ...patch.client }
    }
    this.save()
    return this.get()
  }

  getApiKey(): string | null {
    const envKey = process.env.RIOT_API_KEY
    if (envKey) return envKey
    if (this.data.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(this.data.apiKeyEnc, 'base64'))
      } catch {
        return null
      }
    }
    return this.data.apiKeyPlain ?? null
  }

  setApiKey(key: string): void {
    delete this.data.apiKeyEnc
    delete this.data.apiKeyPlain
    if (key) {
      if (safeStorage.isEncryptionAvailable()) this.data.apiKeyEnc = safeStorage.encryptString(key).toString('base64')
      else this.data.apiKeyPlain = key
    }
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
