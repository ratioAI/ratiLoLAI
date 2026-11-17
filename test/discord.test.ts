import { describe, expect, it, vi } from 'vitest'
import {
  DISCORD_LIMITS,
  buildDiscordPayload,
  discordModeOf,
  escapeDiscord,
  isDiscordWebhook,
  type DiscordPayload
} from '../src/shared/discordPayload'
import { demoGame } from '../src/shared/demoGame'
import { quips } from '../src/shared/quips'
import { GameStore } from '../src/main/games'
import { DiscordPoster, DISCORD_MAX_AGE_MS } from '../src/main/discord'
import type { Settings } from '../src/shared/types'

const NOW = Date.UTC(2026, 10, 17, 12)
const champion = (id: number) => ({ name: `Champ${id}`, id: `Champ${id}Key` })
const embedSize = (payload: DiscordPayload) => {
  const embed = payload.embeds[0]
  return (
    embed.title.length + embed.footer.text.length + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  )
}

describe('webhook URL', () => {
  it.each([
    ['https://discord.com/api/webhooks/123456789/abcDEF_-123', true],
    ['https://canary.discord.com/api/webhooks/1/x', true],
    ['https://ptb.discordapp.com/api/webhooks/1/x', true],
    ['https://discordapp.com/api/webhooks/1/x-y_z', true],
    ['http://discord.com/api/webhooks/1/x', false],
    ['https://discord.com.evil.io/api/webhooks/1/x', false],
    ['https://evil.io/https://discord.com/api/webhooks/1/x', false],
    ['https://discord.com/api/webhooks/abc/x', false],
    ['https://discord.com/api/webhooks/1/x/extra', false],
    ['https://discord.com/api/webhooks/1/x?wait=true', false],
    ['', false]
  ])('%s → %s', (url, ok) => expect(isDiscordWebhook(url)).toBe(ok))
})

describe('buildDiscordPayload', () => {
  const summary = demoGame(NOW)

  it('matches the snapshot', () => {
    const payload = buildDiscordPayload(summary, {
      quips: quips(summary),
      champion,
      ddragonVersion: '15.22.1',
      achievements: [{ name: 'Triple Threat', description: 'Get a triple kill.' }],
      anonymizeRandoms: false
    })
    expect(payload).toMatchSnapshot()
  })

  it('has the result, mode and duration in the title, green for a win, the champion icon and no pings', () => {
    const payload = buildDiscordPayload(summary, { champion, ddragonVersion: '15.22.1', anonymizeRandoms: false })
    const embed = payload.embeds[0]
    expect(payload.username).toBe('ratioAI')
    expect(payload.allowed_mentions).toEqual({ parse: [] })
    expect(embed.title).toBe('VICTORY · ARAM: Mayhem · 18:41')
    expect(embed.color).toBe(0x2ecc71)
    expect(embed.thumbnail?.url).toBe('https://ddragon.leagueoflegends.com/cdn/15.22.1/img/champion/Champ99Key.png')
    expect(embed.fields.map((field) => field.name)).toEqual(['Your team', 'Enemy team', 'MVP 👑', 'Troll 🤡', 'Highlights'])
    expect(buildDiscordPayload({ ...summary, win: false }, { champion, anonymizeRandoms: false, test: true }).embeds[0]).toMatchObject({
      title: '[TEST] DEFEAT · ARAM: Mayhem · 18:41',
      color: 0xe74c3c
    })
  })

  it('anonymizes strangers: champion only, also in the highlights', () => {
    const payload = buildDiscordPayload(summary, { champion, quips: quips(summary), anonymizeRandoms: true })
    const text = JSON.stringify(payload)
    for (const stranger of ['Random Ryze', 'Bard Enjoyer', 'Splitpushed', 'Enemy Jinx', 'Enemy Lulu']) expect(text).not.toContain(stranger)
    // you and your premade keep your names
    expect(text).toContain('You')
    expect(text).toContain('Duo Partner')
    expect(payload.embeds[0].fields[1].value).toContain('**Champ222** · 14/7/9')
  })

  it('leaves out the troll in a team of one', () => {
    const solo = { ...summary, players: summary.players.filter((player) => player.me || !player.ally) }
    const names = buildDiscordPayload(solo, { champion, anonymizeRandoms: false }).embeds[0].fields.map((field) => field.name)
    expect(names).not.toContain('Troll 🤡')
  })

  it('stays within Discord’s limits: quips get shorter first, fields are cut', () => {
    const long = 'x'.repeat(300)
    const huge = {
      ...summary,
      players: summary.players.map((player) => ({ ...player, riotId: `${'N'.repeat(200)}${player.puuid}#EUW` })),
      highlights: Array.from({ length: 5 }, () => long)
    }
    const payload = buildDiscordPayload(huge, {
      champion: (id) => ({ name: `${'C'.repeat(90)}${id}`, id: 'X' }),
      quips: Object.fromEntries(huge.players.map((player) => [player.puuid, long])),
      achievements: Array.from({ length: 30 }, () => ({ name: long, description: long })),
      anonymizeRandoms: false
    })
    for (const field of payload.embeds[0].fields) {
      expect(field.value.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldValue)
      expect(field.name.length).toBeLessThanOrEqual(DISCORD_LIMITS.fieldName)
    }
    expect(embedSize(payload)).toBeLessThanOrEqual(DISCORD_LIMITS.total)
    expect(payload.embeds[0].fields[0].value.endsWith('…')).toBe(true)
  })

  it('keeps quips when they fit and shortens them when the team field is too long', () => {
    const lines = quips(summary)
    const short = buildDiscordPayload(summary, { champion, quips: lines, anonymizeRandoms: false })
    expect(short.embeds[0].fields[0].value).toContain(`*${escapeDiscord(lines['demo-0'])}*`)
    const long = Object.fromEntries(summary.players.map((player) => [player.puuid, 'y'.repeat(400)]))
    const value = buildDiscordPayload(summary, { champion, quips: long, anonymizeRandoms: false }).embeds[0].fields[0].value
    expect(value.length).toBeLessThanOrEqual(1024)
    expect(value).toContain('y'.repeat(20))
  })

  it('escapes markdown and mentions in names', () => {
    expect(escapeDiscord('@everyone *bold* _x_ `c` ||s||')).toBe('@​everyone \\*bold\\* \\_x\\_ \\`c\\` \\|\\|s\\|\\|')
  })

  it('knows the modes', () => {
    expect(discordModeOf({ queueId: 2400, mode: 'KIWI' })).toBe('mayhem')
    expect(discordModeOf({ queueId: 450, mode: 'ARAM' })).toBe('aram')
    expect(discordModeOf({ queueId: 420, mode: 'CLASSIC' })).toBe('ranked')
    expect(discordModeOf({ queueId: 1700, mode: 'CHERRY' })).toBe('other')
  })
})

describe('DiscordPoster', () => {
  const URL = 'https://discord.com/api/webhooks/1/token'
  const baseSettings: Settings['discord'] = {
    enabled: true,
    modes: ['mayhem'],
    onlyWithPremades: false,
    anonymizeRandoms: true,
    includeQuips: true,
    includeAchievements: true,
    attachBestClip: false,
    uploadLimitMb: 20
  }
  const setup = (responses: Response[], settings: Partial<Settings['discord']> = {}) => {
    const store = new GameStore(':memory:')
    const calls: unknown[] = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return responses.shift() ?? new Response(null, { status: 204 })
    })
    const sleeps: number[] = []
    const logs: string[] = []
    const poster = new DiscordPoster({
      db: store.database,
      settings: () => ({ ...baseSettings, ...settings }),
      webhook: () => URL,
      staticData: async () => null,
      tiers: async () => null,
      achievementsOf: () => [],
      log: (message) => logs.push(message),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      sleep: async (ms) => void sleeps.push(ms)
    })
    return { poster, calls, sleeps, logs }
  }
  const game = { ...demoGame(NOW), gameId: 777 }

  it('posts a fresh game once (dedupe through discord_posts)', async () => {
    const { poster, calls } = setup([])
    await poster.maybePost(game)
    await poster.maybePost(game)
    expect(calls).toHaveLength(1)
    expect(poster.posted(777)).toBe(true)
    expect(poster.skipReason(game)).toBe('already posted')
  })

  it('skips test games, old games, other modes and games without premades when asked', () => {
    const { poster } = setup([])
    expect(poster.skipReason({ ...game, gameId: -5 })).toBe('test game')
    expect(poster.skipReason({ ...game, createdAt: NOW - DISCORD_MAX_AGE_MS - game.duration * 1000 - 1 })).toMatch(/30 minutes/)
    expect(poster.skipReason({ ...game, queueId: 450, mode: 'ARAM' })).toMatch(/mode aram/)
    expect(
      setup([], { onlyWithPremades: true }).poster.skipReason({ ...game, players: game.players.map((p) => ({ ...p, premade: false })) })
    ).toMatch(/premade/)
    expect(setup([], { enabled: false }).poster.skipReason(game)).toMatch(/off/)
  })

  it('waits retry_after once on 429 and tries again', async () => {
    const { poster, calls, sleeps } = setup([new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 })])
    const result = await poster.post(game)
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([1500])
  })

  it('gives up after a second 429 and never throws on errors', async () => {
    const limited = () => new Response(JSON.stringify({ retry_after: 0.2 }), { status: 429 })
    const { poster } = setup([limited(), limited()])
    expect((await poster.post(game)).ok).toBe(false)
    expect(poster.posted(777)).toBe(false)
    const broken = setup([new Response(JSON.stringify({ message: 'Unknown Webhook' }), { status: 404 })])
    const result = await broken.poster.post(game)
    expect(result).toMatchObject({ ok: false })
    expect(result.message).toMatch(/doesn’t exist/)
    expect(broken.logs.some((line) => line.includes('failed'))).toBe(true)
  })

  it('a test message is marked and not remembered as posted', async () => {
    const { poster, calls } = setup([])
    await poster.post(game, true)
    expect((calls[0] as DiscordPayload).embeds[0].title.startsWith('[TEST] ')).toBe(true)
    expect(poster.posted(777)).toBe(false)
  })
})
