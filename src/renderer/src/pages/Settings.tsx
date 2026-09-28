import { useState, type ReactNode } from 'react'
import { ExternalLink, KeyRound, Loader2 } from 'lucide-react'
import type { Platform, SeedTier, Settings as SettingsT } from '@shared/types'
import { PLATFORMS } from '@shared/types'
import { api, isDemo } from '@/lib/api'
import { useApp } from '@/lib/store'
import { PageHeader } from '@/components/Layout'

const LANGUAGES = [
  ['de_DE', 'Deutsch'],
  ['en_US', 'English'],
  ['fr_FR', 'Français'],
  ['es_ES', 'Español'],
  ['pl_PL', 'Polski'],
  ['tr_TR', 'Türkçe'],
  ['ko_KR', '한국어']
]

export function Settings() {
  const { settings, setSettings } = useApp()
  const [key, setKey] = useState('')
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
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

  return (
    <div className="fade-in mx-auto max-w-3xl p-8">
      <PageHeader title="Einstellungen" />

      <Group title="Riot API">
        <p className="mb-3 text-sm text-muted">
          Der Key wird verschlüsselt (Windows DPAPI / macOS Keychain) lokal gespeichert und nur für Anfragen an die offizielle Riot API genutzt.
          {settings.hasApiKey && <span className="ml-1 font-semibold text-win">Ein Key ist hinterlegt.</span>}
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
            {key ? 'Speichern & testen' : 'Key entfernen'}
          </button>
        </div>
        {keyMsg && <p className={`mt-2 text-sm ${keyMsg.ok ? 'text-win' : 'text-loss'}`}>{keyMsg.message}</p>}
        <button
          className="mt-3 inline-flex items-center gap-1 text-sm text-accent"
          onClick={() => api.openExternal('https://developer.riotgames.com/')}
        >
          Key auf developer.riotgames.com holen <ExternalLink size={13} />
        </button>
        <Field label="Region (Server)">
          <select className="input" value={settings.platform} onChange={(e) => save({ platform: e.target.value as Platform })}>
            {Object.entries(PLATFORMS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Sprache der Spieldaten">
          <select className="input" value={settings.language} onChange={(e) => save({ language: e.target.value })}>
            {LANGUAGES.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </Group>

      <Group title="League Client">
        <Toggle label="Runen beim Lock-in automatisch importieren" value={settings.client.autoImportRunes} onChange={(v) => save({ client: { ...settings.client, autoImportRunes: v } })} />
        <Toggle label="Item-Set beim Lock-in automatisch importieren" value={settings.client.autoImportItems} onChange={(v) => save({ client: { ...settings.client, autoImportItems: v } })} />
        <Toggle label="Beschwörerzauber automatisch setzen" value={settings.client.autoImportSpells} onChange={(v) => save({ client: { ...settings.client, autoImportSpells: v } })} />
        <Field label="Flash auf Taste">
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
        <Toggle label="Match automatisch annehmen" value={settings.client.autoAccept} onChange={(v) => save({ client: { ...settings.client, autoAccept: v } })} />
        <Field label="Installationsordner (optional)">
          <input
            className="input w-80"
            placeholder="C:\Riot Games\League of Legends"
            defaultValue={settings.leaguePath}
            onBlur={(e) => save({ leaguePath: e.target.value.trim() })}
          />
        </Field>
      </Group>

      <Group title="Crawler">
        <Field label="Spieler-Pool">
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
        <Field label="Zusätzliche Regionen">
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
        <NumberField label="Max. neue Matches pro Lauf" value={settings.crawler.maxMatchesPerRun} min={50} max={100000} onChange={(v) => save({ crawler: { ...settings.crawler, maxMatchesPerRun: v } })} />
        <NumberField label="Matches pro Spieler" value={settings.crawler.matchesPerPlayer} min={1} max={100} onChange={(v) => save({ crawler: { ...settings.crawler, matchesPerPlayer: v } })} />
        <NumberField label="Mindestspiele für Tierliste" value={settings.crawler.minGamesForTierList} min={1} max={5000} onChange={(v) => save({ crawler: { ...settings.crawler, minGamesForTierList: v } })} />
      </Group>

      <p className="mt-8 text-xs leading-relaxed text-muted">
        Rift Companion {isDemo ? '(Web-Demo)' : ''} isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone
        officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered
        trademarks of Riot Games, Inc.
      </p>
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
        className={`relative h-6 w-11 rounded-full transition ${value ? 'bg-accent' : 'bg-panel-2 ring-1 ring-line'}`}
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
