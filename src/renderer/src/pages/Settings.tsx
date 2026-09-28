import { useEffect, useState, type ReactNode } from 'react'
import { Download, ExternalLink, KeyRound, Loader2, MonitorPlay } from 'lucide-react'
import type { Platform, SeedTier, Settings as SettingsT, UpdateState } from '@shared/types'
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
  const [key, setKey] = useState('')
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [info, setInfo] = useState<{ version: string; update: UpdateState } | null>(null)

  useEffect(() => {
    api.appInfo().then(setInfo)
    return api.on('update', (update) => setInfo((i) => (i ? { ...i, update } : i)))
  }, [])

  if (!settings) return null

  const save = async (patch: Partial<Omit<SettingsT, 'hasApiKey'>>) => setSettings(await api.saveSettings(patch))
  const saveKey = async () => {
    setSaving(true)
    const res = await api.setApiKey(key)
    setKeyMsg(res)
    setSettings(await api.getSettings())
    setSaving(false)
    if (res.ok) setKey('')
  }
  const previewChampion = (): number => {
    if (champSelect?.myChampionId) return champSelect.myChampionId
    const byName = data && Object.values(data.champions).find((c) => c.name === live?.activeChampion)
    return byName?.key ?? 99 // Lux
  }

  return (
    <div className="fade-in mx-auto max-w-3xl p-8">
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
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <button className="btn btn-primary" disabled={saving || (!key && !settings.hasApiKey)} onClick={saveKey}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
            {key ? 'Save & test' : 'Remove key'}
          </button>
        </div>
        {keyMsg && <p className={`mt-2 text-sm ${keyMsg.ok ? 'text-win' : 'text-loss'}`}>{keyMsg.message}</p>}
        <button
          className="mt-3 inline-flex items-center gap-1 text-sm text-accent"
          onClick={() => api.openExternal('https://developer.riotgames.com/')}
        >
          Get a key at developer.riotgames.com <ExternalLink size={13} />
        </button>
        <Field label="Region (server)">
          <select className="input" value={settings.platform} onChange={(e) => save({ platform: e.target.value as Platform })}>
            {Object.entries(PLATFORMS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Language of game data (champion, item & augment names)">
          <select className="input" value={settings.language} onChange={(e) => save({ language: e.target.value })}>
            {LANGUAGES.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </Group>

      <Group title="In-game overlay (ARAM: Mayhem)">
        <p className="mb-2 text-sm text-muted">
          Frames the augment cards by tier right in the game. It only looks at the screen while an augment is waiting to be
          picked (level 1, 7, 11, 15 – the choice opens when you are dead or in the fountain) and disappears as soon as you
          have picked one. League must run in <b className="text-text">Borderless</b> or <b className="text-text">Windowed</b>{' '}
          mode – exclusive fullscreen cannot be overlaid.
        </p>
        <Toggle label="Enable overlay" value={settings.overlay.enabled} onChange={(v) => save({ overlay: { ...settings.overlay, enabled: v } })} />
        <Toggle
          label="Also show the tier list panel next to the cards"
          value={settings.overlay.autoExpand}
          onChange={(v) => save({ overlay: { ...settings.overlay, autoExpand: v } })}
        />
        <Toggle
          label="Frame the offered augment cards directly in the game (screen recognition)"
          value={settings.overlay.cardFrames}
          onChange={(v) => save({ overlay: { ...settings.overlay, cardFrames: v } })}
        />
        <Field label="Hotkey to show / hide">
          <input
            className="input w-44 text-center"
            defaultValue={settings.overlay.hotkey}
            onBlur={(e) => save({ overlay: { ...settings.overlay, hotkey: e.target.value.trim() } })}
          />
        </Field>
        <div className="pt-3">
          <button className="btn btn-ghost" onClick={() => api.overlayPreview(previewChampion())}>
            <MonitorPlay size={15} /> Preview overlay (20 s)
          </button>
        </div>
      </Group>

      <Group title="League client">
        <Toggle label="Import runes automatically" value={settings.client.autoImportRunes} onChange={(v) => save({ client: { ...settings.client, autoImportRunes: v } })} />
        <Toggle label="Import item set automatically" value={settings.client.autoImportItems} onChange={(v) => save({ client: { ...settings.client, autoImportItems: v } })} />
        <Toggle label="Set summoner spells automatically" value={settings.client.autoImportSpells} onChange={(v) => save({ client: { ...settings.client, autoImportSpells: v } })} />
        <Field label="Flash on key">
          <div className="flex rounded-xl border border-line bg-bg-2 p-1">
            {(['D', 'F'] as const).map((k) => (
              <button
                key={k}
                onClick={() => save({ client: { ...settings.client, flashOn: k } })}
                className={`rounded-lg px-4 py-1 text-sm font-bold ${settings.client.flashOn === k ? 'bg-panel-2 text-accent' : 'text-muted'}`}
              >
                {k}
              </button>
            ))}
          </div>
        </Field>
        <Toggle label="Auto-accept match" value={settings.client.autoAccept} onChange={(v) => save({ client: { ...settings.client, autoAccept: v } })} />
        <Field label="Install folder (optional)">
          <input
            className="input w-80"
            placeholder="C:\Riot Games\League of Legends"
            defaultValue={settings.leaguePath}
            onBlur={(e) => save({ leaguePath: e.target.value.trim() })}
          />
        </Field>
      </Group>

      <Group title="Crawler">
        <Field label="Player pool">
          <div className="flex gap-2">
            {(['CHALLENGER', 'GRANDMASTER', 'MASTER'] as SeedTier[]).map((t) => {
              const on = settings.crawler.seedTiers.includes(t)
              return (
                <button
                  key={t}
                  onClick={() =>
                    save({
                      crawler: {
                        ...settings.crawler,
                        seedTiers: on ? settings.crawler.seedTiers.filter((x) => x !== t) : [...settings.crawler.seedTiers, t]
                      }
                    })
                  }
                  className={`rounded-lg border px-3 py-1 text-xs font-semibold ${on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-muted'}`}
                >
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                </button>
              )
            })}
          </div>
        </Field>
        <Field label="Additional regions">
          <div className="flex max-w-md flex-wrap justify-end gap-1.5">
            {(Object.keys(PLATFORMS) as Platform[])
              .filter((p) => p !== settings.platform)
              .map((p) => {
                const on = settings.crawler.extraPlatforms.includes(p)
                return (
                  <button
                    key={p}
                    onClick={() =>
                      save({
                        crawler: {
                          ...settings.crawler,
                          extraPlatforms: on ? settings.crawler.extraPlatforms.filter((x) => x !== p) : [...settings.crawler.extraPlatforms, p]
                        }
                      })
                    }
                    className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${on ? 'border-accent/50 bg-accent/10 text-accent' : 'border-line text-muted'}`}
                  >
                    {PLATFORMS[p].label}
                  </button>
                )
              })}
          </div>
        </Field>
        <NumberField label="Max. new matches per run" value={settings.crawler.maxMatchesPerRun} min={50} max={100000} onChange={(v) => save({ crawler: { ...settings.crawler, maxMatchesPerRun: v } })} />
        <NumberField label="Matches per player" value={settings.crawler.matchesPerPlayer} min={1} max={100} onChange={(v) => save({ crawler: { ...settings.crawler, matchesPerPlayer: v } })} />
        <NumberField label="Min. games for the tier list" value={settings.crawler.minGamesForTierList} min={1} max={5000} onChange={(v) => save({ crawler: { ...settings.crawler, minGamesForTierList: v } })} />
      </Group>

      <Group title="Updates">
        <UpdateRow info={info} />
      </Group>

      <p className="mt-8 text-xs leading-relaxed text-muted">
        Rift Companion {isDemo ? '(web demo)' : ''} isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone
        officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered
        trademarks of Riot Games, Inc.
      </p>
    </div>
  )
}

function UpdateRow({ info }: { info: { version: string; update: UpdateState } | null }) {
  if (!info) return null
  const u = info.update
  const text: Record<UpdateState['status'], string> = {
    idle: 'Waiting for update check …',
    checking: 'Checking for updates …',
    available: `Update ${u.version} available`,
    downloading: `Downloading update ${u.version ?? ''} … ${u.progress ? Math.round(u.progress) + '%' : ''}`,
    ready: `Update ${u.version} is ready – it installs when you close the app.`,
    none: 'You are on the latest version.',
    error: `Update check failed: ${u.message ?? ''}`,
    dev: 'Development build – updates are disabled.'
  }
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <div>
        <div className="font-semibold">Version {info.version}</div>
        <div className={u.status === 'error' ? 'text-loss' : 'text-muted'}>{text[u.status]}</div>
      </div>
      {u.status === 'ready' && (
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

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
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

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <input
        type="number"
        className="input w-32 text-right"
        defaultValue={value}
        min={min}
        max={max}
        onBlur={(e) => {
          const v = Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min)))
          e.target.value = String(v)
          if (v !== value) onChange(v)
        }}
      />
    </Field>
  )
}
