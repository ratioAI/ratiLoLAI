/**
 * A cheeky one-liner for every player of a finished game.
 *
 * Each player gets a set of traits (killer, damage carry, feeder, kill thief, healer, ghost,
 * augment picks and so on), each weighted by how strongly it shows in their numbers. Weights look
 * at the player's own team but also at absolute values, because 20 kills is worth a line even if
 * a teammate did more damage. The strongest trait picks the line and a clearly visible second one
 * can add a short tail. MVP and the team's weakest player always get their own lines.
 * Deterministic per game and player. Friendly roasting, never personal.
 */
import type { Tier } from './types'
import { teamBlame, type GameSummary, type SummaryPlayer } from './summary'

// FNV-1a, so the same game always picks the same lines
const hash = (text: string): number => {
  let hashValue = 2166136261
  for (const char of text) hashValue = Math.imul(hashValue ^ char.charCodeAt(0), 16777619)
  return hashValue >>> 0
}

/** Everything a line can refer to. */
interface LineContext {
  p: SummaryPlayer
  win: boolean
  dmg: string
  tank: string
  kp: number
  kda: string
  dmgShare: number
  killShare: number
  augs: Tier[]
  bestAug: number
}
type Line = (ctx: LineContext) => string
type TraitId =
  | 'mvp'
  | 'troll'
  | 'killThief'
  | 'killer'
  | 'damage'
  | 'feeder'
  | 'immortal'
  | 'kda'
  | 'tank'
  | 'healer'
  | 'assists'
  | 'ghost'
  | 'augAllS'
  | 'augBad'
  | 'solid'
  | 'meh'

const pct = (x: number): string => `${Math.round(x * 100)} %`

/** Lines per trait as [your team, enemy team]. */
const LINES: Record<TraitId, [Line[], Line[]]> = {
  mvp: [
    [
      (ctx) =>
        ctx.win
          ? `Hat das Spiel auf dem Rücken getragen – Rückenschmerzen inklusive.`
          : `Hat alles gegeben. Das Team hatte leider andere Pläne.`,
      (ctx) =>
        ctx.win
          ? `${ctx.p.kills} Kills. Der Gegner hat eine einstweilige Verfügung beantragt.`
          : `${ctx.dmg} Schaden und trotzdem verloren – ein Held ohne Happy End.`,
      (ctx) => (ctx.win ? `Ist nicht ins Spiel gegangen – das Spiel ist zu ihm gekommen.` : `Ein Mann, eine Mission, vier Zuschauer.`),
      (ctx) =>
        ctx.win ? `Bitte ab sofort nur noch mit „Chef“ ansprechen.` : `Hätte einen besseren Ausgang verdient. Und ein besseres Team.`,
      (ctx) =>
        ctx.win ? `KDA ${ctx.kda}. Der Rest des Teams darf sich bedanken.` : `KDA ${ctx.kda} – und die anderen haben's trotzdem verschenkt.`
    ],
    [
      () => `Der gefährlichste Gegner. Nächstes Mal bitte zuerst fokussieren.`,
      (ctx) => `${ctx.p.kills} Kills gegen uns. Wir legen offiziell Beschwerde ein.`,
      (ctx) => `${ctx.dmg} Schaden. Hat das sehr persönlich genommen.`,
      () => `Ihr bester Mann – leider auch gegen uns.`
    ]
  ],
  troll: [
    [
      (ctx) =>
        ctx.win
          ? `Wurde erfolgreich durchs Spiel getragen – Trinkgeld an den Carry nicht vergessen.`
          : `Hauptverdächtiger. Die Ermittlungen laufen.`,
      (ctx) =>
        ctx.win
          ? `Größter Troll des Teams, aber hey: gewonnen ist gewonnen.`
          : `Hat für die Gegner gespielt – nur hat's ihm keiner gesagt.`,
      (ctx) =>
        ctx.win
          ? `Passagier erster Klasse. Bitte bleiben Sie angeschnallt.`
          : `${ctx.p.deaths} Tode, ${pct(ctx.dmgShare)} vom Schaden. Die Beweislast ist erdrückend.`,
      (ctx) =>
        ctx.win ? `Hat bewiesen, dass man auch zu viert gewinnen kann.` : `Wenn ARAM ein Gerichtssaal wäre: schuldig in allen Punkten.`
    ],
    [
      () => `Ihr schwächstes Glied – danke für die Zusammenarbeit.`,
      () => `Hat bei denen den Durchschnitt ordentlich gedrückt.`,
      (ctx) => `${ctx.p.deaths} Tode. Wir hätten ihn gern öfter im Gegnerteam.`
    ]
  ],
  killThief: [
    [
      (ctx) => `${ctx.p.kills} Kills mit ${pct(ctx.dmgShare)} vom Schaden – Lasthit-Weltmeister.`,
      (ctx) => `Schaden machen die anderen, die Kills nimmt er: ${ctx.p.kills} Stück. Effizienz.`,
      (ctx) => `${pct(ctx.killShare)} der Kills, ${pct(ctx.dmgShare)} vom Schaden. Der Geier des Teams.`,
      (ctx) => `${ctx.p.kills} Kills – kommt immer genau dann, wenn's was zu holen gibt.`
    ],
    [(ctx) => `${ctx.p.kills} Kills mit wenig Schaden – hat unsere Leute vor allem abgestaubt.`, () => `Der Aasgeier im Gegnerteam.`]
  ],
  killer: [
    [
      (ctx) => `${ctx.p.kills} Kills. Der Respawn-Timer der Gegner hatte Überstunden.`,
      (ctx) => `${ctx.p.kills} Kills – hat die Gegner im Akkord zum Brunnen geschickt.`,
      (ctx) => `Kill-Maschine: ${ctx.p.kills} Stück, und keiner wurde gefragt.`,
      (ctx) => `${ctx.p.kills} Kills. Die Lane war ab Minute zwei sein Jagdrevier.`
    ],
    [
      (ctx) => `${ctx.p.kills} Kills gegen uns – bitte nicht wieder in die Lane lassen.`,
      (ctx) => `Hat uns ${ctx.p.kills}× zurück zum Brunnen geschickt. Unhöflich.`
    ]
  ],
  damage: [
    [
      (ctx) => `${ctx.dmg} Schaden – ${pct(ctx.dmgShare)} vom Team. Die Tastatur braucht jetzt Urlaub.`,
      () => `Schadensquelle Nummer eins. Bitte Sicherheitsabstand halten.`,
      (ctx) => `${ctx.dmg} Schaden. Die Healthbars der Gegner brauchen eine Therapie.`,
      (ctx) => `Hat geballert, als gäbe es kein Morgen: ${ctx.dmg}.`
    ],
    [
      (ctx) => `${ctx.dmg} Schaden. Ihr Hauptgeschütz – und es hat getroffen.`,
      (ctx) => `${pct(ctx.dmgShare)} ihres Schadens kam von ihm. Respekt, leider.`
    ]
  ],
  feeder: [
    [
      (ctx) => `${ctx.p.deaths} Tode. Der graue Bildschirm ist sein zweites Zuhause.`,
      (ctx) => `${ctx.p.deaths}× gestorben – erstaunlich konsequent.`,
      () => `Kennt den Weg vom Brunnen in die Lane inzwischen blind.`,
      (ctx) => `${ctx.p.deaths} Tode. Hat das Konzept „Leben“ eher als Vorschlag verstanden.`,
      (ctx) => `Gold-Lieferdienst: ${ctx.p.deaths} Bestellungen pünktlich beim Gegner zugestellt.`
    ],
    [
      (ctx) => `Hat uns ${ctx.p.deaths} Kills geschenkt. Danke für die Spende!`,
      (ctx) => `${ctx.p.deaths} Tode – unser bester Mann im gegnerischen Team.`,
      (ctx) => `Freundliche Gold-Lieferung, ${ctx.p.deaths}× zugestellt.`
    ]
  ],
  immortal: [
    [
      (ctx) => `Nur ${ctx.p.deaths} Tode in einem ARAM. Hat er überhaupt mitgespielt – oder ist er unsterblich?`,
      (ctx) => `${ctx.p.deaths} Tode. Überlebenskünstler mit Diplom.`,
      () => `Stirbt seltener als ein Baron-Buff. Respekt.`
    ],
    [
      (ctx) => `Nur ${ctx.p.deaths} Tode – den haben wir einfach nicht erwischt.`,
      (ctx) => `Glitschig wie ein Stück Seife. ${ctx.p.deaths} Tode.`
    ]
  ],
  kda: [
    [
      (ctx) => `KDA ${ctx.kda}. Sauberer geht's kaum.`,
      (ctx) => `KDA ${ctx.kda} – spielt ARAM, als wäre es Ranked.`,
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists}. Das kann man so einrahmen.`
    ],
    [(ctx) => `KDA ${ctx.kda}. Leider ziemlich gut.`, (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists} – der hat aufgepasst.`]
  ],
  tank: [
    [
      (ctx) => `Hat ${ctx.tank} Schaden gefressen. Frontline, Backline, Brotlinie – alles.`,
      (ctx) => `${ctx.tank} Schaden eingesteckt. Ein Mensch gewordener Sandsack.`,
      () => `Stand vorne und hat für alle die Prügel eingesteckt. Respekt.`
    ],
    [(ctx) => `${ctx.tank} Schaden eingesteckt. Wie ein Kühlschrank mit Beinen.`, () => `Unser Schaden ist an ihm einfach abgeprallt.`]
  ],
  healer: [
    [
      () => `Heilt mehr, als die Krankenkasse zahlt.`,
      () => `Ohne seine Schilde wären alle viel früher grau gewesen.`,
      () => `Der stille Held mit dem Pflasterkoffer.`
    ],
    [() => `Hat ihr Team ständig wieder zusammengeflickt. Nervig.`, () => `Ihr Sanitäter – hätten wir zuerst umhauen sollen.`]
  ],
  assists: [
    [
      (ctx) => `${ctx.p.assists} Assists – teilt gerne, vor allem die Kills der anderen.`,
      () => `Assist-König: immer dabei, nie im Rampenlicht.`,
      (ctx) => `${ctx.p.assists} Assists. Der beste Wingman, den man sich wünschen kann.`
    ],
    [(ctx) => `${ctx.p.assists} Assists – war bei jedem Kill gegen uns dabei.`]
  ],
  ghost: [
    [
      (ctx) => `Kill-Beteiligung ${ctx.kp} %. War er überhaupt im selben Spiel?`,
      (ctx) => `${ctx.kp} % Kill-Beteiligung – in ARAM, mit einer einzigen Lane. Beeindruckend.`,
      () => `Hat die Teamfights eher aus der Ferne beobachtet.`
    ],
    [() => `Hat sich aus den Teamfights eher rausgehalten.`, (ctx) => `Kill-Beteiligung ${ctx.kp} %. Danke fürs Zuschauen.`]
  ],
  augAllS: [
    [
      () => `Nur S-Tier-Augments gewählt – hat offensichtlich ratioAI benutzt.`,
      () => `Augment-Auswahl wie aus dem Lehrbuch. ratioAI nickt anerkennend.`,
      () => `Perfekte Augments. Der Rest war dann nur noch Formsache.`
    ],
    [() => `Perfekte Augments – nutzt der etwa auch ratioAI?`, () => `Hat nur Top-Augments erwischt. Verdächtig gut informiert.`]
  ],
  augBad: [
    [
      (ctx) => `Hat ein ${ctx.augs.includes('D') ? 'D' : 'C'}-Tier-Augment genommen. Mutig. Sehr mutig.`,
      () => `Die Augment-Wahl war … eine Entscheidung. ratioAI hätte es gewusst.`,
      () => `Augments nach Bauchgefühl gewählt. Der Bauch lag daneben.`
    ],
    [() => `Hat sich schwache Augments ausgesucht. Wir sagen nichts.`, () => `Augment-Wahl zum Glück eher Glückssache.`]
  ],
  solid: [
    [
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists} – solide. Darf nächstes Mal wieder mit.`,
      () => `Zuverlässig wie ein Schweizer Uhrwerk.`,
      () => `Keine Beschwerden. Fünf Sterne, würde wieder mitspielen.`,
      (ctx) => `Ehrliche Arbeit: ${ctx.dmg} Schaden, ${ctx.kp} % Kill-Beteiligung.`
    ],
    [
      () => `Solider Gegner. Hat uns das Leben schwer gemacht.`,
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists} – ordentlich, leider.`
    ]
  ],
  meh: [
    [
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists} – ehrliche Arbeit, keine Schlagzeilen.`,
      () => `War da. Hat Dinge gemacht. Manche davon sogar sinnvoll.`,
      () => `Durchschnitt – aber mit Stil.`,
      () => `Weder Held noch Schurke. Ein Statist mit Potenzial.`
    ],
    [
      () => `Ein ganz normaler Gegner. Nichts zu befürchten.`,
      () => `Kam, sah und … war dann halt da.`,
      () => `Hat mitgespielt, ohne groß aufzufallen.`
    ]
  ]
}

/** Short second sentences for a clearly visible second trait. */
const TAILS: Partial<Record<TraitId, Line>> = {
  killer: (ctx) => `Und nebenbei ${ctx.p.kills} Kills.`,
  damage: (ctx) => `Dazu ${ctx.dmg} Schaden.`,
  feeder: (ctx) => `Allerdings auch ${ctx.p.deaths} Tode.`,
  immortal: (ctx) => `Bei nur ${ctx.p.deaths} Toden.`,
  tank: (ctx) => `Und ${ctx.tank} Schaden eingesteckt.`,
  healer: () => `Nebenbei das halbe Team geheilt.`,
  augAllS: () => `Augments: nur S-Tier. ratioAI approved.`,
  augBad: () => `Die Augments sprechen allerdings eine andere Sprache.`,
  ghost: (ctx) => `Bei ${ctx.kp} % Kill-Beteiligung.`
}

const RANK: Record<Tier, number> = { 'S+': 6, S: 5, A: 4, B: 3, C: 2, D: 1 }

/** True when the player took at least two augments and all of them are S or S+ for their champion. */
export function ratioApproved(tiers: (Tier | undefined)[]): boolean {
  return tiers.length >= 2 && tiers.every((tier) => !!tier && RANK[tier] >= RANK.S)
}

/**
 * One line per player puuid. `augTiers` holds the tier of each player's augments for their champion
 * (from the renderer's tier list). Without it the augment traits are skipped.
 */
export function quips(summary: GameSummary, augTiers: Record<string, (Tier | undefined)[]> = {}): Record<string, string> {
  const lines: Record<string, string> = {}
  const troll = teamBlame(summary)
  for (const ally of [true, false]) {
    const team = summary.players.filter((player) => player.ally === ally)
    const teamSize = team.length || 1
    const evenShare = 1 / teamSize
    const sum = (stat: (player: SummaryPlayer) => number) => team.reduce((total, player) => total + stat(player), 0) || 1
    const rank = (player: SummaryPlayer, stat: (other: SummaryPlayer) => number) =>
      team.filter((other) => stat(other) > stat(player)).length + 1
    const avgDeaths = sum((other) => other.deaths) / teamSize
    const best = [...team].sort((a, b) => b.score - a.score)[0]
    const worst = ally ? troll : [...team].sort((a, b) => a.score - b.score)[0]

    for (const player of team) {
      const augs = (augTiers[player.puuid] ?? []).filter((tier): tier is Tier => !!tier)
      const ctx: LineContext = {
        p: player,
        win: summary.win,
        dmg: `${(player.damage / 1000).toFixed(1)}k`,
        tank: `${(player.tanked / 1000).toFixed(0)}k`,
        kp: Math.round(((player.kills + player.assists) / sum((other) => other.kills)) * 100),
        kda: ((player.kills + player.assists) / Math.max(1, player.deaths)).toFixed(1),
        dmgShare: player.damage / sum((other) => other.damage),
        killShare: player.kills / sum((other) => other.kills),
        augs,
        bestAug: augs.length ? Math.max(...augs.map((tier) => RANK[tier])) : 0
      }
      const share = (stat: (other: SummaryPlayer) => number) => stat(player) / sum(stat)
      const kdaRatio = (player.kills + player.assists) / Math.max(1, player.deaths)

      // weight per trait, a missing entry means the trait doesn't apply
      const weights: Partial<Record<TraitId, number>> = {}
      if (player.puuid === best?.puuid) weights.mvp = 10
      if (worst && player.puuid === worst.puuid && teamSize > 1) weights.troll = 9
      if (ctx.killShare > 1.3 * evenShare && ctx.dmgShare < 0.95 * evenShare) weights.killThief = 4 + (ctx.killShare - ctx.dmgShare) * 10
      if (rank(player, (other) => other.kills) === 1 && player.kills >= 10) weights.killer = 3 + player.kills / 15
      else if (player.kills >= 15) weights.killer = 2.5 + player.kills / 20
      if (rank(player, (other) => other.damage) === 1) weights.damage = 3 + (ctx.dmgShare - evenShare) * 8
      else if (ctx.dmgShare > 1.35 * evenShare) weights.damage = 3
      if (player.deaths >= 9 && (rank(player, (other) => other.deaths) === 1 || share((other) => other.deaths) > 1.35 * evenShare))
        weights.feeder = 3 + player.deaths / 12
      if (player.deaths <= Math.min(7, avgDeaths * 0.6)) weights.immortal = 2.8
      if (kdaRatio >= 5) weights.kda = 2.6 + kdaRatio / 10
      if (rank(player, (other) => other.tanked) === 1 && share((other) => other.tanked) > 1.25 * evenShare) weights.tank = 2.6
      if (share((other) => other.support) > 1.5 * evenShare && player.support > 5000) weights.healer = 3
      if (player.assists >= 25 && player.assists >= 2.5 * Math.max(1, player.kills)) weights.assists = 2.4
      if (ctx.kp < 40) weights.ghost = 2.5 + (40 - ctx.kp) / 20
      if (ratioApproved(augTiers[player.puuid] ?? [])) weights.augAllS = 2.5
      if (augs.some((tier) => RANK[tier] <= RANK.C)) weights.augBad = augs.includes('D') ? 3.2 : 2.4
      if (player.score >= 55) weights.solid = 1.5
      weights.meh = 1

      // ties are broken by a per-player hash so equal weights don't always pick the same trait
      const ranked = (Object.entries(weights) as [TraitId, number][]).sort(
        (a, b) => b[1] - a[1] || (hash(player.puuid + a[0]) % 7) - (hash(player.puuid + b[0]) % 7)
      )
      const [topTrait] = ranked[0]
      const candidates = LINES[topTrait][ally ? 0 : 1]
      let line = candidates[hash(player.puuid + summary.gameId + topTrait) % candidates.length](ctx)
      // a clearly visible second trait that doesn't clash gets a short tail (own team only)
      const second = ranked.slice(1).find(([id, weight]) => weight >= 2.4 && TAILS[id] && !clash(topTrait, id))
      if (ally && second && line.length < 70) line += ` ${TAILS[second[0]]!(ctx)}`
      lines[player.puuid] = line
    }
  }
  return lines
}

/** Traits that would contradict each other, or say the same thing twice, in one line. */
function clash(a: TraitId, b: TraitId): boolean {
  const groups: TraitId[][] = [
    ['feeder', 'immortal'],
    ['killThief', 'killer', 'damage'],
    ['augAllS', 'augBad'],
    ['ghost', 'killer', 'assists'],
    ['mvp', 'troll']
  ]
  return groups.some((group) => group.includes(a) && group.includes(b))
}
