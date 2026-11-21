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
import { WILL_FACTOR_NAMES, willFactorText, willPresenceText, willSurrenderText, willToWin, willVerdict } from './will'

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

// ---------------------------------------------------------------------------
// Will to win
// ---------------------------------------------------------------------------

/** Embed colour per band, lowest first (grey → blue → violet → gold). */
const WILL_COLORS = [0x7f8c8d, 0xb4c2d1, 0x5fb4ff, 0xb58bff, 0xf2c14e]

/** A 0–100 score as ten squares, e.g. 🟦🟦🟦🟦🟦🟦🟦⬛⬛⬛. */
export function willBar(score: number, square: string): string {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)))
  return square.repeat(filled) + '⬛'.repeat(10 - filled)
}

/**
 * The message for the will to win of a game (sent only when you press the button on the game page):
 * both teams' scores as bars, the verdict and what made it. Null when the game can't be judged.
 */
export function buildWillPayload(
  summary: GameSummary,
  options: Pick<DiscordPayloadOptions, 'champion' | 'ddragonVersion' | 'test'>
): DiscordPayload | null {
  const ours = willToWin(summary, true)
  if (!ours) return null
  const theirs = willToWin(summary, false)
  const nameOf = (puuid: string): string => {
    const player = summary.players.find((other) => other.puuid === puuid)
    if (!player) return '?'
    const champion = options.champion(player.championId)?.name ?? `Champion ${player.championId}`
    // "away" is a label nobody gets with their name unless they are you or a premade, whatever the setting
    return escapeDiscord(displayName(player, champion, true))
  }
  const title = cut(
    `${options.test ? '[TEST] ' : ''}🔥 Will to win · ${summary.win ? 'VICTORY' : 'DEFEAT'} · ${MODE_LABEL[summary.mode] ?? summary.mode} · ${clock(summary.duration)}`,
    DISCORD_LIMITS.title
  )
  const lines = [
    `🔵 **Your team ${ours.score}** – ${ours.band.label}`,
    willBar(ours.score, '🟦'),
    ...(theirs ? [`🔺 **Enemy ${theirs.score}** – ${theirs.band.label}`, willBar(theirs.score, '🟥')] : []),
    '',
    `*${[ours.band.text, willVerdict(ours, theirs)].filter(Boolean).join(' ')}*`
  ]
  const score = (value: number | null): string => (value === null ? '–' : String(Math.round(value)))
  const fields: DiscordEmbedField[] = ours.factors.map((factor, i) => {
    const enemy = theirs?.factors[i]
    return {
      name: cut(
        `${WILL_FACTOR_NAMES[factor.key]} · ${score(factor.score)}${enemy ? ` vs ${score(enemy.score)}` : ''}`,
        DISCORD_LIMITS.fieldName
      ),
      value: cut(willFactorText(factor), DISCORD_LIMITS.fieldValue)
    }
  })
  fields.push({
    name: `Presence · × ${ours.presence.toFixed(2)}${theirs ? ` vs × ${theirs.presence.toFixed(2)}` : ''}`,
    value: cut(willPresenceText(ours, nameOf), DISCORD_LIMITS.fieldValue)
  })
  if (ours.surrender || theirs?.surrender)
    fields.push({
      name: `Surrender · ${ours.surrender ? `− ${Math.round(ours.surrender)}` : '–'}${theirs ? ` vs ${theirs.surrender ? `− ${Math.round(theirs.surrender)}` : '–'}` : ''}`,
      value: willSurrenderText(ours.surrender ? ours : theirs!) + (ours.surrender ? ' (your team)' : ' (the enemy)')
    })
  const me = summary.players.find((player) => player.me)
  const meChamp = me && options.champion(me.championId)
  const embed: DiscordEmbed = {
    title,
    color: WILL_COLORS[Math.min(WILL_COLORS.length - 1, Math.floor(ours.score / 20))],
    description: lines.join('\n'),
    ...(meChamp && options.ddragonVersion
      ? { thumbnail: { url: `${DDRAGON}/cdn/${options.ddragonVersion}/img/champion/${meChamp.id}.png` } }
      : {}),
    fields,
    footer: { text: 'ratioAI · will to win – effort, not skill · 50 = a typical team' },
    timestamp: new Date(summary.createdAt + Math.max(0, summary.duration) * 1000).toISOString()
  }
  return { username: 'ratioAI', allowed_mentions: { parse: [] }, embeds: [embed] }
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

/** Discord's upload limit for webhooks and everyone without Nitro, in MiB (20 since August 2026). */
export const DISCORD_UPLOAD_MB = 20

export interface ClipPayloadInput {
  /** the clip's title, or what kind of clip it is ("Pentakill") */
  title: string
  durationS: number
  createdAt: number
  /** from the game the clip belongs to; all optional (a clip can have no saved game) */
  champion?: { name: string; id: string }
  kda?: [number, number, number]
  win?: boolean
  mode?: string
  /** your quip of that game */
  quip?: string
  ddragonVersion?: string
}

/** The message that goes with a clip: its title, champion, K/D/A and result, optionally the quip. The video itself is the attachment. */
export function buildClipPayload(input: ClipPayloadInput): DiscordPayload {
  const fields: DiscordEmbedField[] = []
  if (input.champion) fields.push({ name: 'Champion', value: escapeDiscord(input.champion.name), inline: true })
  if (input.kda) fields.push({ name: 'K / D / A', value: input.kda.join(' / '), inline: true })
  if (input.win !== undefined) fields.push({ name: 'Result', value: input.win ? 'Victory' : 'Defeat', inline: true })
  const minutes = Math.floor(input.durationS / 60)
  const length = `${minutes}:${String(Math.round(input.durationS % 60)).padStart(2, '0')}`
  const embed: DiscordEmbed = {
    title: cut(`🎬 ${escapeDiscord(input.title.trim() || 'Clip')}`, DISCORD_LIMITS.title),
    color: input.win === undefined ? 0xb58bff : input.win ? WIN_COLOR : LOSS_COLOR,
    fields,
    footer: { text: cut(`ratioAI · ${input.mode ? `${MODE_LABEL[input.mode] ?? input.mode} · ` : ''}${length}`, DISCORD_LIMITS.footer) },
    timestamp: new Date(input.createdAt).toISOString()
  }
  if (input.quip?.trim()) embed.description = cut(`*${escapeDiscord(input.quip.trim())}*`, 1000)
  if (input.champion && input.ddragonVersion)
    embed.thumbnail = { url: `${DDRAGON}/cdn/${input.ddragonVersion}/img/champion/${input.champion.id}.png` }
  return { username: 'ratioAI', allowed_mentions: { parse: [] }, embeds: [embed] }
}

/** A file name Discord and every file system accept: "pentakill-lux.mp4". */
export function clipFileName(title: string, extension: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60)
  return `${base || 'clip'}.${extension.replace(/^\./, '').toLowerCase()}`
}

/**
 * The body of a webhook message with one attached file, the way Discord wants it:
 * multipart/form-data with the message as `payload_json` and the file as `files[0]`.
 */
export function clipUploadForm(payload: DiscordPayload, file: { name: string; type: string; data: Uint8Array }): FormData {
  const form = new FormData()
  form.append('payload_json', JSON.stringify(payload))
  form.append('files[0]', new Blob([file.data as BlobPart], { type: file.type }), file.name)
  return form
}

const AUTO_RANK = ['auto:penta', 'auto:quadra', 'auto:ace', 'auto:triple', 'auto:firstBlood', 'auto:death', 'auto:gameEnd']

/** The automatic clip of a game most worth showing: a pentakill before a quadra before an ace …, the longer one on a tie. */
export function bestAutoClip<T extends { kind: string; durationMs: number; createdAt: number }>(clips: readonly T[]): T | null {
  const auto = clips.filter((clip) => AUTO_RANK.includes(clip.kind))
  if (!auto.length) return null
  return [...auto].sort(
    (a, b) => AUTO_RANK.indexOf(a.kind) - AUTO_RANK.indexOf(b.kind) || b.durationMs - a.durationMs || b.createdAt - a.createdAt
  )[0]
}
