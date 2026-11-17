import { useEffect, useState, type ReactNode } from 'react'
import { Check, Clapperboard, Download, ExternalLink, FolderOpen, KeyRound, Loader2, MonitorPlay, RefreshCw, ScanSearch, Send, Webhook, X } from 'lucide-react'
import type {
  EditableSettings,
  FfmpegState,
  RecorderSetup,
  OverlayDiagnostics,
  Platform,
  ScanTestResult,
  SeedTier,
  Settings as SettingsT,
  UpdateState
} from '@shared/types'
import { DISCORD_MODES } from '@shared/discordPayload'
import {
  AUTO_CLIP_KINDS,
  AUTO_CLIP_LABELS,
  QUALITY_PROFILES,
  encoderById,
  estimateMbPerMinute,
  hotkeyConflicts,
  pickEncoder,
  type RecorderSettings
} from '@shared/recorder'
import { FFMPEG_BUILD } from '@shared/ffmpegBuild'
import { PLATFORMS } from '@shared/types'
import { api, isDemo } from '@/lib/api'
import { useApp } from '@/lib/store'
import { PageHeader } from '@/components/Layout'

const LANGUAGES = [
  ['en_US', 'English'],
  ['en_GB', 'English (UK)'],
  ['de_DE', 'Deutsch'],
  ['fr_FR', 'Français'],
  ['es_ES', 'Español'],
  ['pl_PL', 'Polski'],
  ['tr_TR', 'Türkçe'],
  ['ko_KR', '한국어']
]

export function Settings() {
  const { settings, setSettings, champSelect, live, data } = useApp()
  const [apiKey, setApiKey] = useState('')
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [info, setInfo] = useState<{ version: string; update: UpdateState } | null>(null)

  useEffect(() => {
    api.appInfo().then(setInfo)
    return api.on('update', (update) => setInfo((current) => (current ? { ...current, update } : current)))
  }, [])

  if (!settings) return null

  const save = async (patch: Partial<EditableSettings>) => setSettings(await api.saveSettings(patch))
  const saveKey = async () => {
    setSaving(true)
    setKeyStatus(null)
    const result = await api.setApiKey(apiKey)
    setKeyStatus(result)
    setSettings(await api.getSettings())
    setSaving(false)
    if (result.ok) setApiKey('')
  }
  const previewChampion = (): number => {
    if (champSelect?.myChampionId) return champSelect.myChampionId
    const byName = data && Object.values(data.champions).find((champion) => champion.name === live?.activeChampion)
    return byName?.key ?? 99 // Lux as a fallback
  }

  return (
    <div className="page-enter mx-auto max-w-3xl p-8">
      <PageHeader title="Settings" />

      <Group title="Riot API">
        <p className="mb-3 text-sm text-muted">
          The key is stored encrypted (Windows DPAPI / macOS Keychain) and only used for requests to the official Riot API.
          {settings.hasApiKey && <span className="ml-1 font-semibold text-win">A key is saved.</span>}
        </p>
        <div className="flex gap-2">
          <input
            type="password"
            className="input flex-1"
            placeholder="RGAPI-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <button className="btn btn-primary" disabled={saving || (!apiKey && !settings.hasApiKey)} onClick={saveKey}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
            {apiKey ? 'Save & test' : 'Remove key'}
          </button>
        </div>
        {saving && apiKey && (
          <p className="mt-2 text-sm text-muted">Testing the key … a freshly generated key can take Riot a few seconds to activate.</p>
        )}
        {!saving && keyStatus && <p className={`mt-2 text-sm ${keyStatus.ok ? 'text-win' : 'text-loss'}`}>{keyStatus.message}</p>}
        <button
          className="mt-3 inline-flex items-center gap-1 text-sm text-accent"
          onClick={() => api.openExternal('https://developer.riotgames.com/')}
        >
          Get a key at developer.riotgames.com <ExternalLink size={13} />
        </button>
        <Field label="Region (server)">
          <select className="input" value={settings.platform} onChange={(event) => save({ platform: event.target.value as Platform })}>
            {Object.entries(PLATFORMS).map(([id, info]) => (
              <option key={id} value={id}>
                {info.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Language of game data (champion, item & augment names)">
          <select className="input" value={settings.language} onChange={(event) => save({ language: event.target.value })}>
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      </Group>

      <Group title="Appearance">
        <Field label="Background">
          <div className="flex rounded-xl border border-line bg-bg-2 p-1">
            {(
              [
                ['animated', 'Flowing'],
                ['calm', 'Calm'],
                ['static', 'Still']
              ] as const
            ).map(([option, label]) => (
              <button
                key={option}
                onClick={() => save({ ui: { ...settings.ui, background: option } })}
                className={`rounded-lg px-3 py-1 text-xs font-bold ${settings.ui.background === option ? 'bg-panel-2 text-accent' : 'text-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        <p className="pt-1 text-xs text-muted">
          While a game is running the background automatically slows down, so it never competes with League for your graphics card.
        </p>
      </Group>

      <Group title="In-game overlay (ARAM: Mayhem)">
        <p className="mb-2 text-sm text-muted">
          Frames the augment cards by tier right in the game. It only looks at the screen while an augment is waiting to be picked (level 1,
          7, 11, 15) and only while the choice can open – when you are dead, at the start of the game, right after respawning or shopping –
          and disappears as soon as you have picked one. No screenshots are taken while you are fighting. League must run in{' '}
          <b className="text-text">Borderless</b> or <b className="text-text">Windowed</b> mode – exclusive fullscreen cannot be overlaid.
        </p>
        <Toggle
          label="Enable overlay"
          value={settings.overlay.enabled}
          onChange={(value) => save({ overlay: { ...settings.overlay, enabled: value } })}
        />
        <Toggle
          label="Show the overlay in screen shares and recordings (Discord, OBS)"
          value={settings.overlay.showInCapture}
          onChange={(value) => save({ overlay: { ...settings.overlay, showInCapture: value } })}
        />
        <Toggle
          label="Loading screen: win rates of all players (Space shows / hides)"
          value={settings.overlay.loadingScreen}
          onChange={(value) => save({ overlay: { ...settings.overlay, loadingScreen: value } })}
        />
        <Toggle
          label="Frame the offered augment cards directly in the game (screen recognition)"
          value={settings.overlay.cardFrames}
          onChange={(value) => save({ overlay: { ...settings.overlay, cardFrames: value } })}
        />
        <Field label="Frame animation">
          <div className="flex rounded-xl border border-line bg-bg-2 p-1">
            {(
              [
                ['smooth', 'Smooth (30 fps)'],
                ['low', 'Light (15 fps)'],
                ['off', 'Static']
              ] as const
            ).map(([option, label]) => (
              <button
                key={option}
                onClick={() => save({ overlay: { ...settings.overlay, animation: option } })}
                className={`rounded-lg px-3 py-1 text-xs font-bold ${settings.overlay.animation === option ? 'bg-panel-2 text-accent' : 'text-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Hotkey: look for the augment cards now">
          <input
            className="input w-44 text-center"
            defaultValue={settings.overlay.hotkey}
            onBlur={(event) => save({ overlay: { ...settings.overlay, hotkey: event.target.value.trim() } })}
          />
        </Field>
        <div className="pt-3">
          <button className="btn btn-ghost" onClick={() => api.overlayPreview(previewChampion())}>
            <MonitorPlay size={15} /> Preview overlay (20 s)
          </button>
        </div>
        {!isDemo && <OverlayDiagnosticsPanel />}
      </Group>

      <Group title="Minimap timers (ARAM)">
        <p className="mb-2 text-sm text-muted">
          Health relic respawns (the game only counts down the first spawn) and inhibitor respawns, right on the minimap and on the Live
          page. Inhibitors come from the game's live data; relics are recognised by looking at the four relic pads on the minimap once per
          second.
        </p>
        <Toggle
          label="Show minimap timers"
          value={settings.minimap.enabled}
          onChange={(value) => save({ minimap: { ...settings.minimap, enabled: value } })}
        />
        <Toggle
          label="Inhibitor respawn timers"
          value={settings.minimap.inhibitors}
          onChange={(value) => save({ minimap: { ...settings.minimap, inhibitors: value } })}
        />
        <Toggle
          label="Health relic timers"
          value={settings.minimap.relics}
          onChange={(value) => save({ minimap: { ...settings.minimap, relics: value } })}
        />
        <Field label={`Minimap size (match the in-game "Minimap scale") – ${Math.round(settings.minimap.scale * 100)} %`}>
          <input
            type="range"
            min={0.6}
            max={1.6}
            step={0.02}
            className="w-56 accent-[var(--color-accent)]"
            defaultValue={settings.minimap.scale}
            onMouseUp={(event) => save({ minimap: { ...settings.minimap, scale: Number((event.target as HTMLInputElement).value) } })}
            onKeyUp={(event) => save({ minimap: { ...settings.minimap, scale: Number((event.target as HTMLInputElement).value) } })}
          />
        </Field>
        <p className="pt-2 text-xs text-muted">
          "Preview overlay" above also shows example timers, so you can check they sit on the inhibitors.
        </p>
      </Group>

      <Group title="League client">
        <Toggle
          label="Import runes automatically"
          value={settings.client.autoImportRunes}
          onChange={(value) => save({ client: { ...settings.client, autoImportRunes: value } })}
        />
        <Toggle
          label="Import item set automatically"
          value={settings.client.autoImportItems}
          onChange={(value) => save({ client: { ...settings.client, autoImportItems: value } })}
        />
        <Toggle
          label="Set summoner spells automatically"
          value={settings.client.autoImportSpells}
          onChange={(value) => save({ client: { ...settings.client, autoImportSpells: value } })}
        />
        <Field label="Flash on key">
          <div className="flex rounded-xl border border-line bg-bg-2 p-1">
            {(['D', 'F'] as const).map((flashKey) => (
              <button
                key={flashKey}
                onClick={() => save({ client: { ...settings.client, flashOn: flashKey } })}
                className={`rounded-lg px-4 py-1 text-sm font-bold ${settings.client.flashOn === flashKey ? 'bg-panel-2 text-accent' : 'text-muted'}`}
              >
                {flashKey}
              </button>
            ))}
          </div>
        </Field>
        <Toggle
          label="Auto-accept match"
          value={settings.client.autoAccept}
          onChange={(value) => save({ client: { ...settings.client, autoAccept: value } })}
        />
        {settings.client.autoAccept && (
          <Field label="Accept after">
            <div className="flex rounded-xl border border-line bg-bg-2 p-1">
              {(
                [
                  ['human', 'Random 2–6 s'],
                  ['slow', 'Random 4–8 s'],
                  ['instant', 'Instantly']
                ] as const
              ).map(([option, label]) => (
                <button
                  key={option}
                  onClick={() => save({ client: { ...settings.client, acceptDelay: option } })}
                  className={`rounded-lg px-3 py-1 text-xs font-bold ${settings.client.acceptDelay === option ? 'bg-panel-2 text-accent' : 'text-muted'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="Install folder (optional)">
          <input
            className="input w-80"
            placeholder="C:\Riot Games\League of Legends"
            defaultValue={settings.leaguePath}
            onBlur={(event) => save({ leaguePath: event.target.value.trim() })}
          />
        </Field>
      </Group>

      <Group title="Discord">
        <DiscordSettings settings={settings} save={save} refresh={async () => setSettings(await api.getSettings())} />
      </Group>

      <Group title="Clips">
        <ClipsSettings settings={settings} save={save} />
      </Group>

      <Group title="Crawler">
        <Field label="Player pool">
          <div className="flex gap-2">
            {(['CHALLENGER', 'GRANDMASTER', 'MASTER'] as SeedTier[]).map((tier) => {
              const on = settings.crawler.seedTiers.includes(tier)
              return (
                <button
                  key={tier}
                  onClick={() =>
                    save({
                      crawler: {
                        ...settings.crawler,
                        seedTiers: on
                          ? settings.crawler.seedTiers.filter((selected) => selected !== tier)
                          : [...settings.crawler.seedTiers, tier]
                      }
                    })
                  }
                  className={`rounded-lg border px-3 py-1 text-xs font-semibold ${on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-muted'}`}
                >
                  {tier.charAt(0) + tier.slice(1).toLowerCase()}
                </button>
              )
            })}
          </div>
        </Field>
        <Field label="Additional regions">
          <div className="flex max-w-md flex-wrap justify-end gap-1.5">
            {(Object.keys(PLATFORMS) as Platform[])
              .filter((platform) => platform !== settings.platform)
              .map((platform) => {
                const on = settings.crawler.extraPlatforms.includes(platform)
                return (
                  <button
                    key={platform}
                    onClick={() =>
                      save({
                        crawler: {
                          ...settings.crawler,
                          extraPlatforms: on
                            ? settings.crawler.extraPlatforms.filter((selected) => selected !== platform)
                            : [...settings.crawler.extraPlatforms, platform]
                        }
                      })
                    }
                    className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-muted'}`}
                  >
                    {PLATFORMS[platform].label}
                  </button>
                )
              })}
          </div>
        </Field>
        <NumberField
          label="Max. new matches per run"
          value={settings.crawler.maxMatchesPerRun}
          min={50}
          max={100000}
          onChange={(value) => save({ crawler: { ...settings.crawler, maxMatchesPerRun: value } })}
        />
        <NumberField
          label="Matches per player"
          value={settings.crawler.matchesPerPlayer}
          min={1}
          max={100}
          onChange={(value) => save({ crawler: { ...settings.crawler, matchesPerPlayer: value } })}
        />
        <NumberField
          label="Min. games for the tier list"
          value={settings.crawler.minGamesForTierList}
          min={1}
          max={5000}
          onChange={(value) => save({ crawler: { ...settings.crawler, minGamesForTierList: value } })}
        />
      </Group>

      <Group title="Updates">
        <UpdateRow info={info} />
      </Group>

      <p className="mt-8 text-xs leading-relaxed text-muted">
        ratioAI {isDemo ? '(web demo)' : ''} isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone
        officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or
        registered trademarks of Riot Games, Inc.
      </p>
    </div>
  )
}

/** Webhook URL (stored encrypted, never shown again), a test button and what gets posted. */
function DiscordSettings({
  settings,
  save,
  refresh
}: {
  settings: SettingsT
  save: (patch: Partial<EditableSettings>) => Promise<void>
  refresh: () => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const discord = settings.discord
  const set = (patch: Partial<SettingsT['discord']>) => save({ discord: { ...discord, ...patch } })
  const saveUrl = async () => {
    setBusy('save')
    setStatus(null)
    const result = await api.setDiscordWebhook(url)
    setStatus(result)
    if (result.ok) setUrl('')
    await refresh()
    setBusy(null)
  }
  const test = async () => {
    setBusy('test')
    setStatus(null)
    setStatus(await api.testDiscordWebhook().catch((error: Error) => ({ ok: false, message: error.message })))
    setBusy(null)
  }
  return (
    <>
      <p className="mb-3 text-sm text-muted">
        After every game a summary with everyone's quips lands in your friends' channel. Create a webhook in Discord (channel settings ›
        Integrations › Webhooks) and paste its URL – it is stored encrypted and only used to post there.
        {settings.hasDiscordWebhook && <span className="ml-1 font-semibold text-win">A webhook is saved.</span>}
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="off"
          className="input flex-1"
          placeholder={
            settings.hasDiscordWebhook ? '••••••••••••••••  (saved – paste a new one to replace it)' : 'https://discord.com/api/webhooks/…'
          }
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <button className="btn btn-primary" disabled={!!busy || (!url && !settings.hasDiscordWebhook)} onClick={saveUrl}>
          {busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Webhook size={15} />}
          {url || !settings.hasDiscordWebhook ? 'Save' : 'Remove'}
        </button>
        <button className="btn btn-ghost" disabled={!!busy || !settings.hasDiscordWebhook} onClick={test}>
          {busy === 'test' ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} Test
        </button>
      </div>
      {status && <p className={`mt-2 text-sm ${status.ok ? 'text-win' : 'text-loss'}`}>{status.message}</p>}
      <Toggle label="Post finished games automatically" value={discord.enabled} onChange={(value) => set({ enabled: value })} />
      <Field label="Modes">
        <div className="flex flex-wrap justify-end gap-1.5">
          {DISCORD_MODES.map(([mode, label]) => {
            const on = discord.modes.includes(mode)
            return (
              <button
                key={mode}
                onClick={() => set({ modes: on ? discord.modes.filter((other) => other !== mode) : [...discord.modes, mode] })}
                className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${on ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-muted'}`}
              >
                {label}
              </button>
            )
          })}
        </div>
      </Field>
      <Toggle label="Only games with premades" value={discord.onlyWithPremades} onChange={(value) => set({ onlyWithPremades: value })} />
      <Toggle
        label="Show strangers only as their champion (no names)"
        value={discord.anonymizeRandoms}
        onChange={(value) => set({ anonymizeRandoms: value })}
      />
      <Toggle label="Include the quips" value={discord.includeQuips} onChange={(value) => set({ includeQuips: value })} />
      <Toggle
        label="Include new achievements"
        value={discord.includeAchievements}
        onChange={(value) => set({ includeAchievements: value })}
      />
      <Toggle
        label="Add the game's best automatic clip under the summary"
        value={discord.attachBestClip}
        onChange={(value) => set({ attachBestClip: value })}
      />
      <NumberField
        label="Upload limit for clips (MB) – 20 for everyone, 50 or 100 on boosted servers"
        value={discord.uploadLimitMb}
        min={1}
        max={500}
        onChange={(uploadLimitMb) => set({ uploadLimitMb })}
      />
    </>
  )
}

const FFMPEG_LABEL: Record<FfmpegState['status'], string> = {
  missing: 'Not downloaded',
  downloading: 'Downloading',
  verifying: 'Checking the download',
  unpacking: 'Unpacking',
  ready: 'Ready',
  error: 'Failed'
}

/** One line of the recorder's setup: a check or a cross, a name and what is there. */
function SetupLine({ ok, busy, label, children }: { ok: boolean; busy?: boolean; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5 text-sm">
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${ok ? 'bg-win/15 text-win' : 'bg-panel-2 text-muted'}`}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : ok ? <Check size={12} /> : <X size={12} />}
      </span>
      <span className="w-28 shrink-0 font-semibold">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-muted">{children}</span>
    </div>
  )
}

/**
 * Clips: the gameplay recorder. On/off, what it needs (FFmpeg, a hardware encoder, the sound
 * helper), mode, quality, sound, hotkeys, automatic clips and storage.
 */
function ClipsSettings({ settings, save }: { settings: SettingsT; save: (patch: Partial<EditableSettings>) => Promise<void> }) {
  const recorder = settings.recorder
  const [setup, setSetup] = useState<RecorderSetup | null>(null)
  const [testing, setTesting] = useState(false)
  const [hotkeys, setHotkeys] = useState(recorder.hotkeys)
  useEffect(() => {
    void api.recorderSetup().then(setSetup)
    return api.on('ffmpeg', (ffmpeg) => {
      setSetup((current) => (current ? { ...current, ffmpeg } : current))
      // the encoders are tested right after the download
      if (ffmpeg.status === 'ready') void api.recorderSetup().then(setSetup)
    })
  }, [])
  const set = (patch: Partial<RecorderSettings>) => save({ recorder: { ...recorder, ...patch } })
  const install = async () => {
    await api.installFfmpeg().catch(() => undefined)
    setSetup(await api.recorderSetup())
  }
  const enable = async (value: boolean) => {
    await set({ enabled: value })
    if (value && setup && setup.ffmpeg.status !== 'ready' && setup.ffmpeg.status !== 'downloading') void install()
  }
  const testEncoders = async () => {
    setTesting(true)
    await api.testEncoders().catch(() => null)
    setSetup(await api.recorderSetup())
    setTesting(false)
  }
  const ffmpeg = setup?.ffmpeg ?? { status: 'missing' as const }
  const downloading = ffmpeg.status === 'downloading' || ffmpeg.status === 'verifying' || ffmpeg.status === 'unpacking'
  const available = setup?.encoders?.available ?? []
  const encoder = pickEncoder(available, recorder.encoder)
  const conflicts = hotkeyConflicts(hotkeys, { augment: settings.overlay.hotkey })
  const saveHotkeys = () => {
    if (!conflicts.length && JSON.stringify(hotkeys) !== JSON.stringify(recorder.hotkeys)) void set({ hotkeys })
  }
  // the estimate uses the encoder that will record (HEVC when nothing was tested yet)
  const mbPerMinute = (quality: RecorderSettings['quality']) => estimateMbPerMinute(quality, encoder?.codec ?? 'hevc', recorder.fps, null)

  return (
    <>
      <Toggle label="Record my games" value={recorder.enabled} onChange={enable} />
      {setup && !setup.supported && !isDemo && (
        <p className="py-2 text-sm text-gold">Recording needs Windows 10 version 2004 or newer.</p>
      )}
      <div className="border-b border-line/50 py-2">
        <SetupLine ok={ffmpeg.status === 'ready'} busy={downloading} label="FFmpeg">
          <span>
            {FFMPEG_LABEL[ffmpeg.status]}
            {ffmpeg.status === 'ready' && ffmpeg.version ? ` · ${ffmpeg.version}` : ''}
            {ffmpeg.status === 'downloading' ? ` · ${Math.round((ffmpeg.progress ?? 0) * 100)} %` : ''}
          </span>
          {ffmpeg.status === 'downloading' && (
            <span className="h-1.5 w-40 overflow-hidden rounded-full bg-panel-2">
              <span className="block h-full rounded-full bg-accent transition-all" style={{ width: `${Math.round((ffmpeg.progress ?? 0) * 100)}%` }} />
            </span>
          )}
          {ffmpeg.status === 'error' && <span className="text-loss">{ffmpeg.message}</span>}
          {(ffmpeg.status === 'missing' || ffmpeg.status === 'error') && (
            <button className="btn btn-ghost px-2 py-1 text-xs" onClick={install}>
              <Download size={13} /> Download
            </button>
          )}
        </SetupLine>
        <SetupLine ok={!!encoder} busy={testing} label="Encoder">
          {encoder ? (
            <span>
              {available.map((id) => encoderById(id)?.label).filter(Boolean).join(' ✓ · ')} ✓
            </span>
          ) : setup?.encoders ? (
            <span className="text-gold">No hardware encoder (NVENC, AMF, Quick Sync) found – recording stays off.</span>
          ) : (
            <span>Tested after the download</span>
          )}
          {ffmpeg.status === 'ready' && (
            <button className="btn btn-ghost px-2 py-1 text-xs" onClick={testEncoders} disabled={testing}>
              <RefreshCw size={13} /> Test again
            </button>
          )}
        </SetupLine>
        <SetupLine ok={!!setup?.audioHelper} label="Sound">
          {!setup?.audioHelper
            ? 'Sound helper missing – clips are recorded without sound'
            : recorder.audio.source === 'all'
              ? 'Everything your PC plays – game, Discord voice, music – except ratioAI itself'
              : 'Only the game – no Discord voice, no other programs'}
        </SetupLine>
      </div>

      <Field label="Mode">
        <select className="input w-56" value={recorder.mode} onChange={(event) => set({ mode: event.target.value as RecorderSettings['mode'] })}>
          <option value="replay">Instant replay (last seconds)</option>
          <option value="session">Whole game</option>
        </select>
      </Field>
      {recorder.mode === 'replay' && (
        <NumberField label="Replay length (seconds)" value={recorder.replaySeconds} min={10} max={300} onChange={(replaySeconds) => set({ replaySeconds })} />
      )}
      <Field label="Quality">
        <select className="input w-56" value={recorder.quality} onChange={(event) => set({ quality: event.target.value as RecorderSettings['quality'] })}>
          {Object.values(QUALITY_PROFILES).map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label} · {profile.maxHeight ? `${profile.maxHeight}p` : 'native'} · ~{mbPerMinute(profile.id)} MB/min
            </option>
          ))}
        </select>
      </Field>
      <Field label="Frames per second">
        <select className="input w-56" value={recorder.fps} onChange={(event) => set({ fps: Number(event.target.value) === 30 ? 30 : 60 })}>
          <option value={60}>60</option>
          <option value={30}>30</option>
        </select>
      </Field>
      <Field label="Encoder">
        <select className="input w-56" value={recorder.encoder} onChange={(event) => set({ encoder: event.target.value })}>
          <option value="auto">Automatic{encoder ? ` (${encoder.label})` : ''}</option>
          {available.map((id) => (
            <option key={id} value={id}>
              {encoderById(id)?.label ?? id}
            </option>
          ))}
        </select>
      </Field>
      <Toggle label="Record sound" value={recorder.audio.game} onChange={(game) => set({ audio: { ...recorder.audio, game } })} />
      {recorder.audio.game && (
        <Field label="Sound in the recording">
          <select
            className="input w-56"
            value={recorder.audio.source}
            onChange={(event) => set({ audio: { ...recorder.audio, source: event.target.value === 'game' ? 'game' : 'all' } })}
          >
            <option value="all">Everything: game, Discord, music</option>
            <option value="game">Only the game</option>
          </select>
        </Field>
      )}
      {recorder.audio.game && recorder.audio.source === 'all' && (
        <p className="-mt-1 mb-2 text-xs text-muted">
          Clips sound like the moment did: your friends on Discord, your music and the game together. Discord never plays your own voice back
          to you – turn on the microphone below to have it in the clip too.
        </p>
      )}
      <Toggle label="Record my microphone" value={recorder.audio.mic} onChange={(mic) => set({ audio: { ...recorder.audio, mic } })} />
      {recorder.audio.mic && (
        <Field label="Microphone volume">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            className="w-56 accent-[var(--color-accent)]"
            value={recorder.audio.micVolume}
            onChange={(event) => set({ audio: { ...recorder.audio, micVolume: Number(event.target.value) } })}
          />
        </Field>
      )}
      {(
        [
          ['clip', 'Hotkey: save a clip'],
          ['bookmark', 'Hotkey: bookmark (clip after the game)'],
          ['screenshot', 'Hotkey: screenshot']
        ] as const
      ).map(([name, label]) => (
        <Field key={name} label={label}>
          <input
            className="input w-56"
            value={hotkeys[name]}
            placeholder="off"
            onChange={(event) => setHotkeys({ ...hotkeys, [name]: event.target.value })}
            onBlur={saveHotkeys}
          />
        </Field>
      ))}
      {conflicts.map((conflict) => (
        <p key={conflict} className="py-1 text-sm text-loss">
          {conflict}
        </p>
      ))}
      <Field label="Automatic clips">
        <div className="flex max-w-md flex-wrap justify-end gap-1.5">
          {AUTO_CLIP_KINDS.map((kind) => {
            const on = recorder.autoClips[kind]
            return (
              <button
                key={kind}
                onClick={() => set({ autoClips: { ...recorder.autoClips, [kind]: !on } })}
                className={`rounded-lg border px-2.5 py-1 text-xs font-bold ${on ? 'border-accent/60 bg-accent/15 text-accent' : 'border-line text-muted'}`}
              >
                {AUTO_CLIP_LABELS[kind]}
              </button>
            )
          })}
        </div>
      </Field>
      <Field label="Storage folder">
        <div className="flex min-w-0 items-center gap-2">
          <span className="max-w-[260px] truncate text-xs text-muted" title={setup?.folder}>
            {setup?.folder ?? ''}
          </span>
          <button
            className="btn btn-ghost px-2 py-1 text-xs"
            onClick={async () => {
              const folder = await api.chooseClipFolder()
              if (folder) {
                await set({ storage: { ...recorder.storage, folder } })
                setSetup(await api.recorderSetup())
              }
            }}
          >
            Change
          </button>
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={() => api.openClipFolder()}>
            <FolderOpen size={13} /> Open folder
          </button>
        </div>
      </Field>
      <NumberField label="Storage limit (GB)" value={recorder.storage.maxGb} min={2} max={2000} onChange={(maxGb) => set({ storage: { ...recorder.storage, maxGb } })} />
      {recorder.mode === 'session' && (
        <NumberField
          label="Delete whole-game recordings after (days)"
          value={recorder.storage.keepSessionsDays}
          min={1}
          max={365}
          onChange={(keepSessionsDays) => set({ storage: { ...recorder.storage, keepSessionsDays } })}
        />
      )}
      <Toggle label="Click sound when a clip was saved" value={recorder.clipSound} onChange={(clipSound) => set({ clipSound })} />
      <p className="pt-3 text-xs leading-relaxed text-muted">
        <Clapperboard size={12} className="mr-1 inline" />
        Recording uses Windows' own capture interfaces only (Windows Graphics Capture, WASAPI); nothing is injected into the game. Third-party
        licenses: FFmpeg {FFMPEG_BUILD.version} ({FFMPEG_BUILD.license}, runs as its own program) ·{' '}
        <button className="underline" onClick={() => api.openExternal(FFMPEG_BUILD.licenseUrl)}>
          license
        </button>{' '}
        ·{' '}
        <button className="underline" onClick={() => api.openExternal(FFMPEG_BUILD.sourceUrl)}>
          build and source
        </button>
      </p>
    </>
  )
}

function UpdateRow({ info }: { info: { version: string; update: UpdateState } | null }) {
  if (!info) return null
  const update = info.update
  const statusText: Record<UpdateState['status'], string> = {
    idle: 'Waiting for update check …',
    checking: 'Checking for updates …',
    available: `Update ${update.version} available`,
    downloading: `Downloading update ${update.version ?? ''} … ${update.progress ? Math.round(update.progress) + '%' : ''}`,
    ready: `Update ${update.version} is ready – it installs when you close the app.`,
    none: 'You are on the latest version.',
    error: `Update check failed: ${update.message ?? ''}`,
    dev: 'Development build – updates are disabled.'
  }
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <div>
        <div className="font-semibold">Version {info.version}</div>
        <div className={update.status === 'error' ? 'text-loss' : 'text-muted'}>{statusText[update.status]}</div>
      </div>
      {update.status === 'ready' && (
        <button className="btn btn-primary" onClick={() => api.installUpdate()}>
          <Download size={15} /> Restart & update
        </button>
      )}
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel mb-5 p-6">
      <h2 className="mb-4 text-sm font-bold tracking-wide text-muted uppercase">{title}</h2>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/50 py-3 last:border-0">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Field label={label}>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${value ? 'bg-accent' : 'bg-panel-2 ring-1 ring-line'}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${value ? 'left-[22px]' : 'left-0.5'}`} />
      </button>
    </Field>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        className="input w-32 text-right"
        defaultValue={value}
        min={min}
        max={max}
        onBlur={(event) => {
          const clamped = Math.min(max, Math.max(min, Math.round(Number(event.target.value) || min)))
          event.target.value = String(clamped)
          if (clamped !== value) onChange(clamped)
        }}
      />
    </Field>
  )
}

/** Live status of the screen recognition, plus a one-click test that saves screenshots for debugging. */
function OverlayDiagnosticsPanel() {
  const [diagnostics, setDiagnostics] = useState<OverlayDiagnostics | null>(null)
  const [testResult, setTestResult] = useState<ScanTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    // Poll only while the panel is open
    let active = true
    const load = () =>
      void api
        .overlayDiagnostics()
        .then((result) => active && setDiagnostics(result))
        .catch(() => undefined)
    load()
    const timer = setInterval(load, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [open])

  const runTest = async () => {
    setTesting(true)
    try {
      setTestResult(await api.overlayTestScan())
    } finally {
      setTesting(false)
    }
  }

  const yes = (flag: boolean | undefined) => (flag ? <span className="text-emerald-400">yes</span> : <span className="text-muted">no</span>)

  return (
    <div className="mt-4 rounded-xl border border-line bg-bg-2 p-3 text-xs">
      <button className="flex w-full items-center justify-between font-semibold text-text" onClick={() => setOpen((isOpen) => !isOpen)}>
        Diagnostics <span className="text-muted">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {diagnostics && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              <div>
                Game mode: <b className="text-text">{diagnostics.gameMode ?? '–'}</b>
              </div>
              <div>
                Queue: <b className="text-text">{diagnostics.queueId ?? '–'}</b>
              </div>
              <div>Mayhem detected: {yes(diagnostics.mayhem)}</div>
              <div>
                Level: <b className="text-text">{diagnostics.level || '–'}</b>
                {diagnostics.dead ? ' (dead)' : ''}
              </div>
              <div>Augment pending: {yes(diagnostics.augmentPending)}</div>
              <div>Choice can be open: {yes(diagnostics.canOpen)}</div>
              <div>Scanning: {yes(diagnostics.scanning)}</div>
              <div>Cards on screen: {yes(diagnostics.cardsVisible)}</div>
              <div>Overlay visible: {yes(diagnostics.overlayVisible)}</div>
              <div>
                Screen stream: <b className="text-text">{diagnostics.captureStream}</b>
              </div>
            </div>
          )}
          <p className="text-muted">
            Open the augment choice in game (alt-tab is fine in borderless mode) and click <b>Test screen recognition</b>. The screenshots
            are saved to the log folder – attach them together with <code>overlay.log</code> when reporting a problem.
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-ghost" disabled={testing} onClick={runTest}>
              {testing ? <Loader2 size={15} className="animate-spin" /> : <ScanSearch size={15} />} Test screen recognition
            </button>
            <button className="btn btn-ghost" onClick={() => api.openDiagnosticsFolder()}>
              <FolderOpen size={15} /> Open log folder
            </button>
          </div>
          {testResult && (
            <div className="space-y-1">
              <div>
                Capture took <b className="text-text">{testResult.captureMs} ms</b> for {testResult.screens.length} screen(s)
              </div>
              {testResult.screens.map((screen, i) => (
                <div key={i}>
                  Screen {i + 1} ({screen.size}):{' '}
                  {screen.black ? (
                    <span className="text-red-400">black image – use Borderless mode</span>
                  ) : (
                    <>cards {yes(screen.visible)}</>
                  )}
                  {screen.titles.length > 0 && (
                    <> · read: {screen.titles.map((title, j) => `"${title}"${screen.matches[j] ? ' ✓' : ' ✗'}`).join(', ')}</>
                  )}
                </div>
              ))}
            </div>
          )}
          {diagnostics && diagnostics.log.length > 0 && (
            <pre className="max-h-48 overflow-auto rounded-lg bg-black/40 p-2 text-[10px] leading-4 text-muted">
              {diagnostics.log.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
