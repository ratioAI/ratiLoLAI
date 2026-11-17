/**
 * The Discord message for a finished game: one embed with the result, both teams with K/D/A and
 * their quips, MVP and troll, the best highlights and new achievements. Pure: the main process
 * sends it to the user's own webhook (main/discord.ts).
 *
 * Discord limits (https://discord.com/developers/docs/resources/message#embed-object-embed-limits):
 * title 256, description 4096, 25 fields, field name 256, field value 1024, footer 2048 and
 * 6000 characters for the whole embed. Everything here is cut to fit, quips first.
 */
import { teamBlame, type GameSummary, type SummaryPlayer } from './summary'
import { selectModeOfQueue, type SelectMode } from './types'
import { DDRAGON } from './staticData'

export const DISCORD_LIMITS = { title: 256, fieldName: 256, fieldValue: 1024, footer: 2048, total: 6000, fields: 25 } as const

/** Accepted webhook URLs: Discord's own (stable, canary, ptb, old discordapp.com domain). */
export const DISCORD_WEBHOOK_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/

export const isDiscordWebhook = (url: string): boolean => DISCORD_WEBHOOK_RE.test(url.trim())

export type DiscordMode = 'mayhem' | 'aram' | 'ranked' | 'other'
export const DISCORD_MODES: [DiscordMode, string][] = [
  ['mayhem', 'ARAM: Mayhem'],
  ['aram', 'ARAM'],
  ['ranked', 'Ranked'],
  ['other', 'Other modes']
]

/** Which of the mode switches a game falls under. */
export const discordModeOf = (summary: Pick<GameSummary, 'queueId' | 'mode'>): DiscordMode =>
  selectModeOfQueue(summary.queueId, summary.mode) as SelectMode

const MODE_LABEL: Record<string, string> = { KIWI: 'ARAM: Mayhem', ARAM: 'ARAM', CLASSIC: "Summoner's Rift" }

export interface DiscordEmbedField {
  name: string
  value: string
  inline?: boolean
}

export interface DiscordEmbed {
  title: string
  color: number
  description?: string
  thumbnail?: { url: string }
  fields: DiscordEmbedField[]
  footer: { text: string }
  timestamp: string
}

export interface DiscordPayload {
  username: string
  /** never ping anyone, whatever a Riot ID looks like */
  allowed_mentions: { parse: [] }
  embeds: [DiscordEmbed]
}

export interface DiscordPayloadOptions {
  /** quip per puuid (shared/quips.ts), leave out for none */
  quips?: Record<string, string>
  /** champion name and Data Dragon id ("MonkeyKing") by champion id */
  champion: (championId: number) => { name: string; id: string } | undefined
  /** Data Dragon version for the champion icon (public URL, Discord loads it itself) */
  ddragonVersion?: string
  /** achievements this game unlocked */
  achievements?: { name: string; description: string }[]
  /** players that are neither you nor a premade only appear as their champion */
  anonymizeRandoms: boolean
  /** "[TEST]" in front of the title */
  test?: boolean
}

export const WIN_COLOR = 0x2ecc71
export const LOSS_COLOR = 0xe74c3c

const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`

/** Escapes Discord markdown and defuses mentions, so a name is shown as written. */
export function escapeDiscord(text: string): string {
  return text.replace(/([\\*_~`|>[\]()])/g, '\\$1').replace(/@/g, '@\u200b')
}

/** Cuts a text to `max` characters, with an ellipsis when something was cut. */
export const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`)

/** A player's name for the post: their game name, or their champion when they are a stranger and anonymized. */
function displayName(player: SummaryPlayer, champName: string, anonymize: boolean): string {
  if (anonymize && !player.me && !player.premade) return champName
  return player.riotId.split('#')[0] || champName
}

/** Fits team lines (main part + optional italic quip) into one field value: quips get shorter, then go. */
function fitTeam(lines: { main: string; quip: string }[], max: number, quipLength: number): string {
  for (const limit of [quipLength, 60, 40, 24, 0]) {
    if (limit > quipLength) continue
    const text = lines
      .map((line) => (line.quip && limit > 0 ? `${line.main}\n> *${escapeDiscord(cut(line.quip, limit))}*` : line.main))
      .join('\n')
    if (text.length <= max) return text
  }
  return cut(lines.map((line) => line.main).join('\n'), max)
}

const embedSize = (embed: DiscordEmbed): number =>
  embed.title.length +
  (embed.description?.length ?? 0) +
  embed.footer.text.length +
  embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)

/** The webhook body for a game. */
export function buildDiscordPayload(summary: GameSummary, options: DiscordPayloadOptions): DiscordPayload {
  const champ = (id: number) => options.champion(id)
  const nameOfChamp = (id: number): string => champ(id)?.name ?? `Champion ${id}`
  const name = (player: SummaryPlayer): string => displayName(player, nameOfChamp(player.championId), options.anonymizeRandoms)
  const me = summary.players.find((player) => player.me)
  const allies = summary.players.filter((player) => player.ally)
  const enemies = summary.players.filter((player) => !player.ally)

  const title = cut(
    `${options.test ? '[TEST] ' : ''}${summary.win ? 'VICTORY' : 'DEFEAT'} · ${MODE_LABEL[summary.mode] ?? summary.mode} · ${clock(summary.duration)}`,
    DISCORD_LIMITS.title
  )
  const meChamp = me && champ(me.championId)
  const thumbnail =
    meChamp && options.ddragonVersion ? { url: `${DDRAGON}/cdn/${options.ddragonVersion}/img/champion/${meChamp.id}.png` } : undefined

  const teamLines = (team: SummaryPlayer[]) =>
    team.map((player) => {
      const shownName = name(player)
      const championName = nameOfChamp(player.championId)
      const who =
        shownName === championName
          ? `**${escapeDiscord(championName)}**`
          : `**${escapeDiscord(championName)}** · ${escapeDiscord(shownName)}`
      const tags = `${summary.mvp === player.puuid ? ' 👑' : ''}${player.me ? ' ⭐' : ''}`
      return { main: `${who} · ${player.kills}/${player.deaths}/${player.assists}${tags}`, quip: options.quips?.[player.puuid] ?? '' }
    })

  const fields: DiscordEmbedField[] = []
  const teamField = (label: string, team: SummaryPlayer[], quipLength: number): DiscordEmbedField => ({
    name: label,
    value: fitTeam(teamLines(team), DISCORD_LIMITS.fieldValue, quipLength) || '—'
  })
  fields.push(teamField('Your team', allies, 200), teamField('Enemy team', enemies, 200))

  const mvp = summary.players.find((player) => player.puuid === summary.mvp)
  // like the game history: nobody is the troll of a team of one
  const troll = allies.length > 1 ? teamBlame(summary) : null
  if (mvp)
    fields.push({
      name: 'MVP 👑',
      value: cut(`${escapeDiscord(name(mvp))} (${nameOfChamp(mvp.championId)}) · impact ${mvp.score}`, 1024),
      inline: true
    })
  if (troll)
    fields.push({
      name: summary.win ? 'Troll 🤡' : 'Most to blame 🤡',
      value: cut(`${escapeDiscord(name(troll))} (${nameOfChamp(troll.championId)}) · impact ${troll.score}`, 1024),
      inline: true
    })

  // the first highlights are the strongest (thrown lead / comeback, then the biggest swing)
  let highlights = summary.highlights.slice(0, 2)
  if (options.anonymizeRandoms) {
    // highlights name players by their game name; strangers become their champion
    for (const player of summary.players.filter((other) => !other.me && !other.premade)) {
      const gameName = player.riotId.split('#')[0]
      if (gameName) highlights = highlights.map((line) => line.split(gameName).join(nameOfChamp(player.championId)))
    }
  }
  if (highlights.length)
    fields.push({ name: 'Highlights', value: cut(highlights.map((line) => `• ${escapeDiscord(line)}`).join('\n'), 1024) })
  if (options.achievements?.length)
    fields.push({
      name: 'New constellations ✨',
      value: cut(
        options.achievements
          .map((achievement) => `**${escapeDiscord(achievement.name)}** – ${escapeDiscord(achievement.description)}`)
          .join('\n'),
        1024
      )
    })

  const embed: DiscordEmbed = {
    title,
    color: summary.win ? WIN_COLOR : LOSS_COLOR,
    ...(thumbnail ? { thumbnail } : {}),
    fields: fields.slice(0, DISCORD_LIMITS.fields),
    footer: { text: 'ratioAI · ad-free League companion' },
    timestamp: new Date(summary.createdAt + Math.max(0, summary.duration) * 1000).toISOString()
  }
  // the whole embed must stay under 6000: shorter quips first, then the extras go
  for (const quipLength of [60, 30, 0]) {
    if (embedSize(embed) <= DISCORD_LIMITS.total) break
    embed.fields[0] = teamField('Your team', allies, quipLength)
    embed.fields[1] = teamField('Enemy team', enemies, quipLength)
  }
  while (embedSize(embed) > DISCORD_LIMITS.total && embed.fields.length > 2) embed.fields.pop()
  if (embedSize(embed) > DISCORD_LIMITS.total)
    for (const field of embed.fields) field.value = cut(field.value, Math.floor((DISCORD_LIMITS.total - 400) / embed.fields.length))
  return { username: 'ratioAI', allowed_mentions: { parse: [] }, embeds: [embed] }
}
