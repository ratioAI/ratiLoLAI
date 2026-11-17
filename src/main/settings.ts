import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'
import type { EditableSettings, Settings } from '@shared/types'
import { DEFAULT_RECORDER, mergeRecorderSettings } from '@shared/recorder'
import { DISCORD_UPLOAD_MB } from '@shared/discordPayload'

type Stored = EditableSettings & {
  apiKeyEnc?: string
  apiKeyPlain?: string
  discordWebhookEnc?: string
  discordWebhookPlain?: string
  schema?: number
}

/**
 * Bump this to migrate stored settings.
 * 2: the UI switched to English, so game data defaults to en_US.
 * 3: only the card frames are on by default, the tier list panel is opt-in.
 * 4: the tier list panel is gone (its setting is dropped).
 * 5: Discord webhook and hype announcer (1.2).
 * 6: Clips, the gameplay recorder (1.3). New block `recorder`, off by default.
 * 7: the hype announcer is gone (its block `announcer` is dropped); the recorder records the whole PC sound.
 */
const SCHEMA = 7

export const DEFAULT_SETTINGS: EditableSettings = {
  platform: 'euw1',
  language: 'en_US',
  leaguePath: '',
  crawler: {
    seedTiers: ['CHALLENGER', 'GRANDMASTER', 'MASTER'],
    extraPlatforms: [],
    maxMatchesPerRun: 1500,
    matchesPerPlayer: 10,
    minGamesForTierList: 20,
    autoCrawl: true
  },
  overlay: {
    enabled: true,
    hotkey: 'Alt+Shift+A',
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
  },
  discord: {
    enabled: false,
    modes: ['mayhem', 'aram'],
    onlyWithPremades: false,
    anonymizeRandoms: true,
    includeQuips: true,
    includeAchievements: true,
    attachBestClip: false,
    uploadLimitMb: DISCORD_UPLOAD_MB
  },
  // off by default: recording starts only after you turned it on (and FFmpeg was downloaded)
  recorder: DEFAULT_RECORDER
}

/**
 * Small JSON settings store. The Riot API key is encrypted with Electron's safeStorage
 * (DPAPI on Windows, Keychain on macOS) and never sent to the renderer.
 */
export class SettingsStore {
  private data: Stored

  constructor(private readonly file: string) {
    let loaded: Partial<Stored> = {}
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>
    } catch {
      // no file yet on first start
    }
    this.data = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      crawler: { ...DEFAULT_SETTINGS.crawler, ...loaded.crawler },
      overlay: { ...DEFAULT_SETTINGS.overlay, ...loaded.overlay },
      minimap: { ...DEFAULT_SETTINGS.minimap, ...loaded.minimap },
      ui: { ...DEFAULT_SETTINGS.ui, ...loaded.ui },
      client: { ...DEFAULT_SETTINGS.client, ...loaded.client },
      discord: { ...DEFAULT_SETTINGS.discord, ...loaded.discord },
      recorder: mergeRecorderSettings(DEFAULT_SETTINGS.recorder, loaded.recorder)
    }
    if ((loaded.schema ?? 1) < 2) this.data.language = 'en_US'
    // the tier list panel next to the cards was removed in 1.0.5
    delete (this.data.overlay as Partial<Record<'autoExpand', unknown>>).autoExpand
    // the hype announcer was removed in 1.3
    delete (this.data as Partial<Record<'announcer', unknown>>).announcer
    this.data.schema = SCHEMA
  }

  get(): Settings {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeyEnc, apiKeyPlain, discordWebhookEnc, discordWebhookPlain, schema, ...rest } = this.data
    return { ...rest, hasApiKey: !!(apiKeyEnc || apiKeyPlain), hasDiscordWebhook: !!(discordWebhookEnc || discordWebhookPlain) }
  }

  update(patch: Partial<EditableSettings>): Settings {
    this.data = {
      ...this.data,
      ...patch,
      crawler: { ...this.data.crawler, ...patch.crawler },
      overlay: { ...this.data.overlay, ...patch.overlay },
      minimap: { ...this.data.minimap, ...patch.minimap },
      ui: { ...this.data.ui, ...patch.ui },
      client: { ...this.data.client, ...patch.client },
      discord: { ...this.data.discord, ...patch.discord },
      recorder: mergeRecorderSettings(this.data.recorder, patch.recorder)
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

  /** The Discord webhook URL, decrypted. Never sent to the renderer. */
  getDiscordWebhook(): string | null {
    if (this.data.discordWebhookEnc && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(this.data.discordWebhookEnc, 'base64'))
      } catch {
        return null
      }
    }
    return this.data.discordWebhookPlain ?? null
  }

  /** Stores the webhook URL encrypted like the API key ('' removes it). */
  setDiscordWebhook(url: string): void {
    delete this.data.discordWebhookEnc
    delete this.data.discordWebhookPlain
    if (url) {
      if (safeStorage.isEncryptionAvailable()) this.data.discordWebhookEnc = safeStorage.encryptString(url).toString('base64')
      else this.data.discordWebhookPlain = url
    }
    this.save()
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }
}
