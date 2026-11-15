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
const worstAug = (ctx: LineContext): string => (ctx.augs.includes('D') ? 'D' : 'C')

/** A whole line (with a tail) must fit the quip column in one or two short rows. */
export const MAX_QUIP = 64

/** Lines per trait as [your team, enemy team]. Keep them short: one sentence, two at most. */
const LINES: Record<TraitId, [Line[], Line[]]> = {
  mvp: [[], []], // see MVP below, the own team's line depends on the result
  troll: [[], []], // see TROLL below
  killThief: [
    [
      (ctx) => `${ctx.p.kills} Kills mit ${pct(ctx.dmgShare)} Schaden. Lasthit-Weltmeister.`,
      (ctx) => `Schaden machen andere, die Kills nimmt er: ${ctx.p.kills}.`,
      (ctx) => `${pct(ctx.killShare)} der Kills, ${pct(ctx.dmgShare)} Schaden. Der Geier.`,
      (ctx) => `${ctx.p.kills} Kills. Kommt, wenn's was zu holen gibt.`,
      (ctx) => `${ctx.p.kills} Kills, null Skrupel. Kill-Dieb des Jahres.`,
      (ctx) => `Hat ${ctx.p.kills} Kills geklaut. Anzeige läuft.`,
      (ctx) => `${ctx.p.kills} Kills, fast alle fremdfinanziert.`,
      (ctx) => `Erntet ${ctx.p.kills} Kills, die andere gesät haben.`
    ],
    [
      (ctx) => `${ctx.p.kills} Kills mit wenig Schaden. Hat abgestaubt.`,
      () => `Der Aasgeier im Gegnerteam.`,
      (ctx) => `Hat uns ${ctx.p.kills}× im letzten Moment erwischt.`,
      () => `Kam immer pünktlich zum Lasthit.`
    ]
  ],
  killer: [
    [
      (ctx) => `${ctx.p.kills} Kills. Der Respawn-Timer schob Überstunden.`,
      (ctx) => `${ctx.p.kills} Kills. Gegner im Akkord zum Brunnen geschickt.`,
      (ctx) => `Kill-Maschine: ${ctx.p.kills} Stück, keiner wurde gefragt.`,
      (ctx) => `${ctx.p.kills} Kills. Die Lane war sein Jagdrevier.`,
      (ctx) => `${ctx.p.kills} Kills. Die Gegner sahen mehr Grau als Farbe.`,
      (ctx) => `${ctx.p.kills} Kills. Für die Gegner ein Horrorfilm.`,
      (ctx) => `${ctx.p.kills} Kills. Jeder Death-Recap zeigt sein Gesicht.`,
      (ctx) => `${ctx.p.kills} Kills. Die Gegner träumen heute von ihm.`
    ],
    [
      (ctx) => `${ctx.p.kills} Kills gegen uns. Bitte nie wieder.`,
      (ctx) => `Hat uns ${ctx.p.kills}× zum Brunnen geschickt. Unhöflich.`,
      (ctx) => `${ctx.p.kills} Kills. Unsere Death-Recaps sind voll von ihm.`,
      (ctx) => `${ctx.p.kills} Kills. Wir hatten keine Antwort.`
    ]
  ],
  damage: [
    [
      (ctx) => `${ctx.dmg} Schaden. Die Tastatur braucht Urlaub.`,
      () => `Schadensquelle Nr. 1. Bitte Abstand halten.`,
      (ctx) => `${ctx.dmg} Schaden. Die Healthbars brauchen Therapie.`,
      (ctx) => `Hat geballert, als gäbe es kein Morgen: ${ctx.dmg}.`,
      (ctx) => `${pct(ctx.dmgShare)} des Teamschadens. Der Rest hat gekitzelt.`,
      (ctx) => `Wandelnde Artillerie: ${ctx.dmg} Schaden.`,
      (ctx) => `${ctx.dmg} Schaden. Die Gegner stehen noch unter Schock.`
    ],
    [
      (ctx) => `${ctx.dmg} Schaden. Ihr Hauptgeschütz – und es traf.`,
      (ctx) => `${pct(ctx.dmgShare)} ihres Schadens kam von ihm. Leider.`,
      (ctx) => `${ctx.dmg} Schaden. Unsere Healthbars weinen noch.`,
      (ctx) => `Hat uns mit ${ctx.dmg} Schaden eingeäschert.`
    ]
  ],
  feeder: [
    [
      (ctx) => `${ctx.p.deaths} Tode. Der graue Bildschirm ist sein Zuhause.`,
      (ctx) => `${ctx.p.deaths}× gestorben. Erstaunlich konsequent.`,
      () => `Kennt den Weg vom Brunnen zur Lane blind.`,
      (ctx) => `${ctx.p.deaths} Tode. Hat „Leben“ als Vorschlag verstanden.`,
      (ctx) => `Gold-Lieferdienst: ${ctx.p.deaths} Bestellungen zugestellt.`,
      (ctx) => `${ctx.p.deaths} Tode. Der Respawn-Timer kennt ihn beim Namen.`,
      (ctx) => `${ctx.p.deaths} Tode. Ein All-you-can-eat-Buffet für die Gegner.`,
      (ctx) => `${ctx.p.deaths} Tode. Der Brunnen hat ihn öfter gesehen als wir.`,
      () => `Stirbt so zuverlässig wie die Minions.`,
      (ctx) => `${ctx.p.deaths} Tode. Die Gegner sagen danke für das Gold.`
    ],
    [
      (ctx) => `Hat uns ${ctx.p.deaths} Kills geschenkt. Danke!`,
      (ctx) => `${ctx.p.deaths} Tode – unser bester Mann bei denen.`,
      (ctx) => `Freundliche Gold-Lieferung, ${ctx.p.deaths}× zugestellt.`,
      (ctx) => `${ctx.p.deaths} Tode. Unser Lieblingsgegner.`,
      (ctx) => `${ctx.p.deaths}× gestorben. Wir haben mitgezählt.`
    ]
  ],
  immortal: [
    [
      (ctx) => `Nur ${ctx.p.deaths} Tode. Hat er überhaupt mitgespielt?`,
      (ctx) => `${ctx.p.deaths} Tode. Überlebenskünstler mit Diplom.`,
      () => `Stirbt seltener als ein Baron-Buff.`,
      (ctx) => `Nur ${ctx.p.deaths} Tode. Unsterblich oder einfach feige?`,
      (ctx) => `${ctx.p.deaths} Tode. Der Brunnen hat ihn vermisst.`,
      (ctx) => `Nur ${ctx.p.deaths} Tode. Die Gegner suchen ihn noch.`
    ],
    [
      (ctx) => `Nur ${ctx.p.deaths} Tode. Den haben wir nie erwischt.`,
      (ctx) => `Glitschig wie Seife: ${ctx.p.deaths} Tode.`,
      (ctx) => `${ctx.p.deaths} Tode. Wir haben's versucht. Ehrlich.`
    ]
  ],
  kda: [
    [
      (ctx) => `KDA ${ctx.kda}. Sauberer geht's kaum.`,
      (ctx) => `KDA ${ctx.kda}. Spielt ARAM, als wär's Ranked.`,
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists}. Kann man so einrahmen.`,
      (ctx) => `KDA ${ctx.kda}. Mama wäre stolz.`,
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists}. Fürs Bewerbungsfoto.`,
      (ctx) => `KDA ${ctx.kda}. Vorbildlich, fast schon langweilig.`
    ],
    [
      (ctx) => `KDA ${ctx.kda}. Leider ziemlich gut.`,
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists} – der hat aufgepasst.`,
      (ctx) => `KDA ${ctx.kda}. Wir gratulieren widerwillig.`
    ]
  ],
  tank: [
    [
      (ctx) => `${ctx.tank} Schaden gefressen. Frontline mit Appetit.`,
      (ctx) => `${ctx.tank} eingesteckt. Ein Sandsack mit Beinen.`,
      () => `Stand vorne und hat die Prügel kassiert.`,
      (ctx) => `${ctx.tank} Schaden geschluckt. Hat noch Hunger.`,
      (ctx) => `Menschliches Schutzschild: ${ctx.tank} eingesteckt.`
    ],
    [
      (ctx) => `${ctx.tank} eingesteckt. Ein Kühlschrank mit Beinen.`,
      () => `Unser Schaden ist an ihm abgeprallt.`,
      (ctx) => `${ctx.tank} Schaden gefressen. Stand trotzdem noch.`
    ]
  ],
  healer: [
    [
      () => `Heilt mehr, als die Krankenkasse zahlt.`,
      () => `Ohne seine Schilde wären alle früher grau.`,
      () => `Der stille Held mit dem Pflasterkoffer.`,
      () => `Hat das Team öfter geflickt als einen Fahrradschlauch.`,
      () => `Ein Lazarett auf zwei Beinen.`
    ],
    [
      () => `Hat ihr Team ständig zusammengeflickt. Nervig.`,
      () => `Ihr Sanitäter. Hätten wir zuerst umhauen sollen.`,
      () => `Hat alles weggeheilt, was wir gemacht haben.`
    ]
  ],
  assists: [
    [
      (ctx) => `${ctx.p.assists} Assists. Teilt gern – vor allem fremde Kills.`,
      () => `Assist-König: immer dabei, nie im Rampenlicht.`,
      (ctx) => `${ctx.p.assists} Assists. Der Wingman, den alle wollen.`,
      (ctx) => `${ctx.p.assists} Assists. Bei jedem Fight dabei, nie am Ende.`,
      (ctx) => `${ctx.p.assists} Assists. Die Vorlage war seine Kunst.`
    ],
    [(ctx) => `${ctx.p.assists} Assists – bei jedem Kill gegen uns dabei.`, (ctx) => `${ctx.p.assists} Assists. Überall, wo's wehtat.`]
  ],
  ghost: [
    [
      (ctx) => `${ctx.kp} % Kill-Beteiligung. War er im selben Spiel?`,
      (ctx) => `${ctx.kp} % Kill-Beteiligung – in einer einzigen Lane.`,
      () => `Hat die Teamfights aus sicherer Ferne verfolgt.`,
      (ctx) => `${ctx.kp} % KP. Vermutlich die ganze Zeit im Shop.`,
      (ctx) => `${ctx.kp} % Kill-Beteiligung. Ein Phantom.`,
      () => `War körperlich anwesend. Mehr nicht.`,
      (ctx) => `${ctx.kp} % KP. Hat sich das Spiel eher angeschaut.`
    ],
    [
      () => `Hielt sich aus den Teamfights raus.`,
      (ctx) => `${ctx.kp} % Kill-Beteiligung. Danke fürs Zuschauen.`,
      () => `Hatte offenbar Wichtigeres zu tun.`
    ]
  ],
  augAllS: [
    [
      () => `Nur S-Tier-Augments. Hat offensichtlich ratioAI benutzt.`,
      () => `Augments wie aus dem Lehrbuch. ratioAI nickt.`,
      () => `Perfekte Augments. Der Rest war Formsache.`,
      () => `Nur S-Tier gewählt. Ein Mann mit Plan.`
    ],
    [
      () => `Perfekte Augments – nutzt der etwa ratioAI?`,
      () => `Nur Top-Augments. Verdächtig gut informiert.`,
      () => `S-Tier überall. Da hat wohl jemand gespickt.`
    ]
  ],
  augBad: [
    [
      (ctx) => `Hat ein ${worstAug(ctx)}-Tier-Augment genommen. Mutig.`,
      () => `Die Augment-Wahl war … eine Entscheidung.`,
      () => `Augments nach Bauchgefühl. Der Bauch lag daneben.`,
      () => `Augments ausgewürfelt? Sieht ganz so aus.`,
      () => `ratioAI hat geweint, als es die Augments sah.`,
      (ctx) => `Ein ${worstAug(ctx)}-Augment. Mit voller Absicht.`
    ],
    [
      () => `Schwache Augments. Wir sagen nichts.`,
      () => `Augment-Wahl eher Glückssache.`,
      (ctx) => `Hat ein ${worstAug(ctx)}-Tier-Augment genommen. Danke.`
    ]
  ],
  solid: [
    [
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists} – solide. Darf wieder mit.`,
      () => `Zuverlässig wie ein Schweizer Uhrwerk.`,
      () => `Fünf Sterne, würde wieder mitspielen.`,
      (ctx) => `Ehrliche Arbeit: ${ctx.dmg} Schaden, ${ctx.kp} % KP.`,
      () => `Keine Glanzleistung, kein Totalausfall.`,
      () => `Hat seinen Job gemacht. Ohne Drama.`
    ],
    [
      () => `Solider Gegner. Hat's uns schwer gemacht.`,
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists} – ordentlich, leider.`,
      () => `Ordentlicher Gegner. Zu ordentlich.`
    ]
  ],
  meh: [
    [
      (ctx) => `${ctx.p.kills}/${ctx.p.deaths}/${ctx.p.assists}. Keine Schlagzeilen.`,
      () => `War da. Hat Dinge gemacht. Manche sinnvoll.`,
      () => `Durchschnitt – aber mit Stil.`,
      () => `Weder Held noch Schurke. Statist.`,
      () => `Hat existiert. Mehr gibt's nicht zu sagen.`,
      () => `So unauffällig, dass es fast Kunst ist.`,
      () => `Spielte mit. Man hat's kaum gemerkt.`,
      () => `Die Definition von „war auch dabei“.`
    ],
    [
      () => `Ein ganz normaler Gegner. Keine Gefahr.`,
      () => `Kam, sah und … war halt da.`,
      () => `Hat mitgespielt, ohne aufzufallen.`,
      () => `Füllmaterial im Gegnerteam.`,
      () => `Hätte auch ein Bot sein können.`
    ]
  ]
}

/** The own team's MVP and troll lines depend on the result; [win, loss, enemy team]. */
const MVP: [Line[], Line[], Line[]] = [
  [
    () => `Hat das Team getragen. Rückenschmerzen inklusive.`,
    (ctx) => `${ctx.p.kills} Kills. Die Gegner haben Anzeige erstattet.`,
    () => `Kam, sah, zerlegte. Der Rest durfte zugucken.`,
    () => `Bitte ab sofort nur noch mit „Chef“ ansprechen.`,
    (ctx) => `KDA ${ctx.kda}. Das Team schuldet ihm ein Abendessen.`,
    () => `Ist nicht ins Spiel gegangen – es kam zu ihm.`,
    (ctx) => `${ctx.dmg} Schaden. Der Rest war Deko.`,
    () => `Vier Mitspieler, ein Hauptdarsteller.`,
    () => `Hat den Sieg bestellt und selbst geliefert.`,
    () => `Die anderen vier waren Begleitpersonal.`
  ],
  [
    () => `Hat alles gegeben. Das Team leider nichts.`,
    (ctx) => `${ctx.dmg} Schaden – umsonst. Danke, Team.`,
    () => `Ein Mann, eine Mission, vier Zuschauer.`,
    () => `Hätte ein besseres Team verdient. Deutlich besseres.`,
    (ctx) => `KDA ${ctx.kda}. Der Rest hat's trotzdem verbockt.`,
    () => `Allein gegen zehn. Fünf davon im eigenen Team.`,
    () => `Ein Held ohne Happy End.`,
    () => `Hat gekämpft wie ein Löwe. Mit vier Schafen.`
  ],
  [
    () => `Der gefährlichste Gegner. Bitte zuerst fokussieren.`,
    (ctx) => `${ctx.p.kills} Kills gegen uns. Wir legen Beschwerde ein.`,
    (ctx) => `${ctx.dmg} Schaden. Hat das sehr persönlich genommen.`,
    () => `Ihr bester Mann – leider auch gegen uns.`,
    () => `Hat uns im Alleingang auseinandergenommen.`,
    () => `Hat unser Team als Trainingspuppe benutzt.`,
    () => `Unser größtes Problem. Mit Abstand.`
  ]
]
const TROLL: [Line[], Line[], Line[]] = [
  [
    () => `Wurde durchgetragen. Trinkgeld nicht vergessen.`,
    () => `Passagier erster Klasse. Bitte angeschnallt bleiben.`,
    () => `Hat bewiesen: Man gewinnt auch zu viert.`,
    () => `Gewonnen – trotz ihm, nicht wegen ihm.`,
    () => `Hat beim Sieg zugeschaut. Aus nächster Nähe.`,
    () => `Freifahrt zum Sieg. Danke an die Busfahrer.`,
    () => `Glück gehabt, dass die anderen da waren.`,
    () => `Statistisch gesehen eher ein Handicap.`
  ],
  [
    () => `Hauptverdächtiger. Die Ermittlungen laufen.`,
    () => `Hat für die Gegner gespielt. Wusste es nur nicht.`,
    (ctx) => `${ctx.p.deaths} Tode, ${pct(ctx.dmgShare)} Schaden. Fall abgeschlossen.`,
    () => `Schuldig in allen Anklagepunkten.`,
    () => `Der Grund, warum wir hier sind.`,
    () => `Nächstes Mal bitte im Ladebildschirm bleiben.`,
    () => `Ein Sicherheitsrisiko mit Champion.`,
    () => `Hat die Niederlage persönlich organisiert.`,
    () => `Das Gegnerteam lässt herzlich danken.`
  ],
  [
    () => `Ihr schwächstes Glied. Danke für die Zusammenarbeit.`,
    () => `Hat bei denen den Schnitt ordentlich gedrückt.`,
    (ctx) => `${ctx.p.deaths} Tode. Gern wieder im Gegnerteam.`,
    () => `Unser heimlicher sechster Mann.`,
    () => `Hat für uns gespielt. Unbezahlt.`,
    () => `Ein Geschenk an unser Team.`
  ]
]

/** Short second sentences for a clearly visible second trait. */
const TAILS: Partial<Record<TraitId, Line[]>> = {
  killer: [(ctx) => `Dazu ${ctx.p.kills} Kills.`, (ctx) => `Plus ${ctx.p.kills} Kills.`],
  damage: [(ctx) => `Dazu ${ctx.dmg} Schaden.`, (ctx) => `Und ${ctx.dmg} Schaden.`],
  feeder: [(ctx) => `Aber ${ctx.p.deaths} Tode.`, (ctx) => `Leider ${ctx.p.deaths}× tot.`, (ctx) => `Nur die ${ctx.p.deaths} Tode …`],
  immortal: [(ctx) => `Bei nur ${ctx.p.deaths} Toden.`, () => `Und kaum tot.`],
  tank: [(ctx) => `Und ${ctx.tank} eingesteckt.`],
  healer: [() => `Und nebenbei Heiler.`, () => `Plus Dauer-Heilung.`],
  augAllS: [() => `ratioAI approved.`, () => `Augments: ratioAI-Niveau.`],
  augBad: [() => `Die Augments: fragwürdig.`, () => `Nur die Augments – autsch.`, () => `Augments? Reden wir nicht drüber.`],
  ghost: [(ctx) => `Bei ${ctx.kp} % KP.`]
}

/** The first line of `pool`, starting at a hashed position, that hasn't been used in this game yet. */
function pick(pool: Line[], ctx: LineContext, seed: number, used: Set<string>, fits = (_: string) => true): string | null {
  for (let i = 0; i < pool.length; i++) {
    const line = pool[(seed + i) % pool.length](ctx)
    if (!used.has(line) && fits(line)) return line
  }
  return null
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
  const used = new Set<string>()
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
      const result = summary.win ? 0 : 1
      const pool =
        topTrait === 'mvp' ? MVP[ally ? result : 2] : topTrait === 'troll' ? TROLL[ally ? result : 2] : LINES[topTrait][ally ? 0 : 1]
      // the same line twice in one game reads like a bug, so take the next free one
      let line = pick(pool, ctx, hash(player.puuid + summary.gameId + topTrait), used) ?? pool[0](ctx)
      used.add(line)
      // a clearly visible second trait that doesn't clash gets a short tail (own team only)
      const second = ranked.slice(1).find(([id, weight]) => weight >= 2.4 && TAILS[id] && !clash(topTrait, id))
      if (ally && second) {
        const tail = pick(
          TAILS[second[0]]!,
          ctx,
          hash(player.puuid + summary.gameId + second[0]),
          used,
          (text) => line.length + 1 + text.length <= MAX_QUIP
        )
        if (tail) {
          used.add(tail)
          line += ` ${tail}`
        }
      }
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
