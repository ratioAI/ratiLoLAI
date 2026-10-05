/**
 * A cheeky line for every player of a finished game.
 *
 * Instead of a fixed if-chain, every player is described by *traits* (top killer, damage carry,
 * feeder, unkillable, kill thief, frontline, healer, assist king, ghost, augment picks …), each
 * with a weight for how strongly it shows in their numbers – relative to their own team AND in
 * absolute terms (20 kills is a story even if a teammate did more damage). The strongest trait
 * becomes the line; a clearly visible second one is added as a short tail. MVP and the team's
 * weakest link always get their own lines. Deterministic per game and player. Friendly roasting –
 * never personal.
 */
import type { Tier } from './types'
import { teamBlame, type GameSummary, type SummaryPlayer } from './summary'

const hash = (s: string): number => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

/** Everything a line can refer to. */
interface Ctx {
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
type Line = (c: Ctx) => string
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

/** Lines per trait – [your team, enemy team]. */
const LINES: Record<TraitId, [Line[], Line[]]> = {
  mvp: [
    [
      (c) =>
        c.win
          ? `Hat das Spiel auf dem Rücken getragen – Rückenschmerzen inklusive.`
          : `Hat alles gegeben. Das Team hatte leider andere Pläne.`,
      (c) =>
        c.win
          ? `${c.p.kills} Kills. Der Gegner hat eine einstweilige Verfügung beantragt.`
          : `${c.dmg} Schaden und trotzdem verloren – ein Held ohne Happy End.`,
      (c) => (c.win ? `Ist nicht ins Spiel gegangen – das Spiel ist zu ihm gekommen.` : `Ein Mann, eine Mission, vier Zuschauer.`),
      (c) => (c.win ? `Bitte ab sofort nur noch mit „Chef“ ansprechen.` : `Hätte einen besseren Ausgang verdient. Und ein besseres Team.`),
      (c) =>
        c.win ? `KDA ${c.kda}. Der Rest des Teams darf sich bedanken.` : `KDA ${c.kda} – und die anderen haben's trotzdem verschenkt.`
    ],
    [
      () => `Der gefährlichste Gegner. Nächstes Mal bitte zuerst fokussieren.`,
      (c) => `${c.p.kills} Kills gegen uns. Wir legen offiziell Beschwerde ein.`,
      (c) => `${c.dmg} Schaden. Hat das sehr persönlich genommen.`,
      () => `Ihr bester Mann – leider auch gegen uns.`
    ]
  ],
  troll: [
    [
      (c) =>
        c.win
          ? `Wurde erfolgreich durchs Spiel getragen – Trinkgeld an den Carry nicht vergessen.`
          : `Hauptverdächtiger. Die Ermittlungen laufen.`,
      (c) =>
        c.win ? `Größter Troll des Teams, aber hey: gewonnen ist gewonnen.` : `Hat für die Gegner gespielt – nur hat's ihm keiner gesagt.`,
      (c) =>
        c.win
          ? `Passagier erster Klasse. Bitte bleiben Sie angeschnallt.`
          : `${c.p.deaths} Tode, ${pct(c.dmgShare)} vom Schaden. Die Beweislast ist erdrückend.`,
      (c) => (c.win ? `Hat bewiesen, dass man auch zu viert gewinnen kann.` : `Wenn ARAM ein Gerichtssaal wäre: schuldig in allen Punkten.`)
    ],
    [
      () => `Ihr schwächstes Glied – danke für die Zusammenarbeit.`,
      () => `Hat bei denen den Durchschnitt ordentlich gedrückt.`,
      (c) => `${c.p.deaths} Tode. Wir hätten ihn gern öfter im Gegnerteam.`
    ]
  ],
  killThief: [
    [
      (c) => `${c.p.kills} Kills mit ${pct(c.dmgShare)} vom Schaden – Lasthit-Weltmeister.`,
      (c) => `Schaden machen die anderen, die Kills nimmt er: ${c.p.kills} Stück. Effizienz.`,
      (c) => `${pct(c.killShare)} der Kills, ${pct(c.dmgShare)} vom Schaden. Der Geier des Teams.`,
      (c) => `${c.p.kills} Kills – kommt immer genau dann, wenn's was zu holen gibt.`
    ],
    [(c) => `${c.p.kills} Kills mit wenig Schaden – hat unsere Leute vor allem abgestaubt.`, () => `Der Aasgeier im Gegnerteam.`]
  ],
  killer: [
    [
      (c) => `${c.p.kills} Kills. Der Respawn-Timer der Gegner hatte Überstunden.`,
      (c) => `${c.p.kills} Kills – hat die Gegner im Akkord zum Brunnen geschickt.`,
      (c) => `Kill-Maschine: ${c.p.kills} Stück, und keiner wurde gefragt.`,
      (c) => `${c.p.kills} Kills. Die Lane war ab Minute zwei sein Jagdrevier.`
    ],
    [
      (c) => `${c.p.kills} Kills gegen uns – bitte nicht wieder in die Lane lassen.`,
      (c) => `Hat uns ${c.p.kills}× zurück zum Brunnen geschickt. Unhöflich.`
    ]
  ],
  damage: [
    [
      (c) => `${c.dmg} Schaden – ${pct(c.dmgShare)} vom Team. Die Tastatur braucht jetzt Urlaub.`,
      () => `Schadensquelle Nummer eins. Bitte Sicherheitsabstand halten.`,
      (c) => `${c.dmg} Schaden. Die Healthbars der Gegner brauchen eine Therapie.`,
      (c) => `Hat geballert, als gäbe es kein Morgen: ${c.dmg}.`
    ],
    [
      (c) => `${c.dmg} Schaden. Ihr Hauptgeschütz – und es hat getroffen.`,
      (c) => `${pct(c.dmgShare)} ihres Schadens kam von ihm. Respekt, leider.`
    ]
  ],
  feeder: [
    [
      (c) => `${c.p.deaths} Tode. Der graue Bildschirm ist sein zweites Zuhause.`,
      (c) => `${c.p.deaths}× gestorben – erstaunlich konsequent.`,
      () => `Kennt den Weg vom Brunnen in die Lane inzwischen blind.`,
      (c) => `${c.p.deaths} Tode. Hat das Konzept „Leben“ eher als Vorschlag verstanden.`,
      (c) => `Gold-Lieferdienst: ${c.p.deaths} Bestellungen pünktlich beim Gegner zugestellt.`
    ],
    [
      (c) => `Hat uns ${c.p.deaths} Kills geschenkt. Danke für die Spende!`,
      (c) => `${c.p.deaths} Tode – unser bester Mann im gegnerischen Team.`,
      (c) => `Freundliche Gold-Lieferung, ${c.p.deaths}× zugestellt.`
    ]
  ],
  immortal: [
    [
      (c) => `Nur ${c.p.deaths} Tode in einem ARAM. Hat er überhaupt mitgespielt – oder ist er unsterblich?`,
      (c) => `${c.p.deaths} Tode. Überlebenskünstler mit Diplom.`,
      () => `Stirbt seltener als ein Baron-Buff. Respekt.`
    ],
    [(c) => `Nur ${c.p.deaths} Tode – den haben wir einfach nicht erwischt.`, (c) => `Glitschig wie ein Stück Seife. ${c.p.deaths} Tode.`]
  ],
  kda: [
    [
      (c) => `KDA ${c.kda}. Sauberer geht's kaum.`,
      (c) => `KDA ${c.kda} – spielt ARAM, als wäre es Ranked.`,
      (c) => `${c.p.kills}/${c.p.deaths}/${c.p.assists}. Das kann man so einrahmen.`
    ],
    [(c) => `KDA ${c.kda}. Leider ziemlich gut.`, (c) => `${c.p.kills}/${c.p.deaths}/${c.p.assists} – der hat aufgepasst.`]
  ],
  tank: [
    [
      (c) => `Hat ${c.tank} Schaden gefressen. Frontline, Backline, Brotlinie – alles.`,
      (c) => `${c.tank} Schaden eingesteckt. Ein Mensch gewordener Sandsack.`,
      () => `Stand vorne und hat für alle die Prügel eingesteckt. Respekt.`
    ],
    [(c) => `${c.tank} Schaden eingesteckt. Wie ein Kühlschrank mit Beinen.`, () => `Unser Schaden ist an ihm einfach abgeprallt.`]
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
      (c) => `${c.p.assists} Assists – teilt gerne, vor allem die Kills der anderen.`,
      () => `Assist-König: immer dabei, nie im Rampenlicht.`,
      (c) => `${c.p.assists} Assists. Der beste Wingman, den man sich wünschen kann.`
    ],
    [(c) => `${c.p.assists} Assists – war bei jedem Kill gegen uns dabei.`]
  ],
  ghost: [
    [
      (c) => `Kill-Beteiligung ${c.kp} %. War er überhaupt im selben Spiel?`,
      (c) => `${c.kp} % Kill-Beteiligung – in ARAM, mit einer einzigen Lane. Beeindruckend.`,
      () => `Hat die Teamfights eher aus der Ferne beobachtet.`
    ],
    [() => `Hat sich aus den Teamfights eher rausgehalten.`, (c) => `Kill-Beteiligung ${c.kp} %. Danke fürs Zuschauen.`]
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
      (c) => `Hat ein ${c.augs.includes('D') ? 'D' : 'C'}-Tier-Augment genommen. Mutig. Sehr mutig.`,
      () => `Die Augment-Wahl war … eine Entscheidung. ratioAI hätte es gewusst.`,
      () => `Augments nach Bauchgefühl gewählt. Der Bauch lag daneben.`
    ],
    [() => `Hat sich schwache Augments ausgesucht. Wir sagen nichts.`, () => `Augment-Wahl zum Glück eher Glückssache.`]
  ],
  solid: [
    [
      (c) => `${c.p.kills}/${c.p.deaths}/${c.p.assists} – solide. Darf nächstes Mal wieder mit.`,
      () => `Zuverlässig wie ein Schweizer Uhrwerk.`,
      () => `Keine Beschwerden. Fünf Sterne, würde wieder mitspielen.`,
      (c) => `Ehrliche Arbeit: ${c.dmg} Schaden, ${c.kp} % Kill-Beteiligung.`
    ],
    [() => `Solider Gegner. Hat uns das Leben schwer gemacht.`, (c) => `${c.p.kills}/${c.p.deaths}/${c.p.assists} – ordentlich, leider.`]
  ],
  meh: [
    [
      (c) => `${c.p.kills}/${c.p.deaths}/${c.p.assists} – ehrliche Arbeit, keine Schlagzeilen.`,
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
  killer: (c) => `Und nebenbei ${c.p.kills} Kills.`,
  damage: (c) => `Dazu ${c.dmg} Schaden.`,
  feeder: (c) => `Allerdings auch ${c.p.deaths} Tode.`,
  immortal: (c) => `Bei nur ${c.p.deaths} Toden.`,
  tank: (c) => `Und ${c.tank} Schaden eingesteckt.`,
  healer: () => `Nebenbei das halbe Team geheilt.`,
  augAllS: () => `Augments: nur S-Tier. ratioAI approved.`,
  augBad: () => `Die Augments sprechen allerdings eine andere Sprache.`,
  ghost: (c) => `Bei ${c.kp} % Kill-Beteiligung.`
}

const RANK: Record<Tier, number> = { 'S+': 6, S: 5, A: 4, B: 3, C: 2, D: 1 }

/** true when every augment the player took is S or S+ for their champion (at least two of them). */
export function ratioApproved(tiers: (Tier | undefined)[]): boolean {
  return tiers.length >= 2 && tiers.every((t) => !!t && RANK[t] >= RANK.S)
}

/**
 * One line per player puuid. `augTiers` – the tier each player's augments have for their champion
 * (from the renderer's tier list); without it augment traits are skipped.
 */
export function quips(s: GameSummary, augTiers: Record<string, (Tier | undefined)[]> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  const troll = teamBlame(s)
  for (const ally of [true, false]) {
    const team = s.players.filter((p) => p.ally === ally)
    const n = team.length || 1
    const even = 1 / n
    const sum = (f: (p: SummaryPlayer) => number) => team.reduce((a, p) => a + f(p), 0) || 1
    const rank = (p: SummaryPlayer, f: (x: SummaryPlayer) => number) => team.filter((x) => f(x) > f(p)).length + 1
    const avgDeaths = sum((x) => x.deaths) / n
    const best = [...team].sort((a, b) => b.score - a.score)[0]
    const worst = ally ? troll : [...team].sort((a, b) => a.score - b.score)[0]

    for (const p of team) {
      const augs = (augTiers[p.puuid] ?? []).filter((t): t is Tier => !!t)
      const c: Ctx = {
        p,
        win: s.win,
        dmg: `${(p.damage / 1000).toFixed(1)}k`,
        tank: `${(p.tanked / 1000).toFixed(0)}k`,
        kp: Math.round(((p.kills + p.assists) / sum((x) => x.kills)) * 100),
        kda: ((p.kills + p.assists) / Math.max(1, p.deaths)).toFixed(1),
        dmgShare: p.damage / sum((x) => x.damage),
        killShare: p.kills / sum((x) => x.kills),
        augs,
        bestAug: augs.length ? Math.max(...augs.map((t) => RANK[t])) : 0
      }
      const share = (f: (x: SummaryPlayer) => number) => f(p) / sum(f)
      const kdaNum = (p.kills + p.assists) / Math.max(1, p.deaths)

      // every trait with how strongly it shows (0 = not at all)
      const w: Partial<Record<TraitId, number>> = {}
      if (p.puuid === best?.puuid) w.mvp = 10
      if (worst && p.puuid === worst.puuid && n > 1) w.troll = 9
      if (c.killShare > 1.3 * even && c.dmgShare < 0.95 * even) w.killThief = 4 + (c.killShare - c.dmgShare) * 10
      if (rank(p, (x) => x.kills) === 1 && p.kills >= 10) w.killer = 3 + p.kills / 15
      else if (p.kills >= 15) w.killer = 2.5 + p.kills / 20
      if (rank(p, (x) => x.damage) === 1) w.damage = 3 + (c.dmgShare - even) * 8
      else if (c.dmgShare > 1.35 * even) w.damage = 3
      if (p.deaths >= 9 && (rank(p, (x) => x.deaths) === 1 || share((x) => x.deaths) > 1.35 * even)) w.feeder = 3 + p.deaths / 12
      if (p.deaths <= Math.min(7, avgDeaths * 0.6)) w.immortal = 2.8
      if (kdaNum >= 5) w.kda = 2.6 + kdaNum / 10
      if (rank(p, (x) => x.tanked) === 1 && share((x) => x.tanked) > 1.25 * even) w.tank = 2.6
      if (share((x) => x.support) > 1.5 * even && p.support > 5000) w.healer = 3
      if (p.assists >= 25 && p.assists >= 2.5 * Math.max(1, p.kills)) w.assists = 2.4
      if (c.kp < 40) w.ghost = 2.5 + (40 - c.kp) / 20
      if (ratioApproved(augTiers[p.puuid] ?? [])) w.augAllS = 2.5
      if (augs.some((t) => RANK[t] <= RANK.C)) w.augBad = augs.includes('D') ? 3.2 : 2.4
      if (p.score >= 55) w.solid = 1.5
      w.meh = 1

      const ranked = (Object.entries(w) as [TraitId, number][]).sort(
        (a, b) => b[1] - a[1] || (hash(p.puuid + a[0]) % 7) - (hash(p.puuid + b[0]) % 7)
      )
      const [first] = ranked[0]
      const pool = LINES[first][ally ? 0 : 1]
      let line = pool[hash(p.puuid + s.gameId + first) % pool.length](c)
      // a second trait that clearly shows (and fits) becomes a short tail – your team only
      const second = ranked.slice(1).find(([id, weight]) => weight >= 2.4 && TAILS[id] && !clash(first, id))
      if (ally && second && line.length < 70) line += ` ${TAILS[second[0]]!(c)}`
      out[p.puuid] = line
    }
  }
  return out
}

/** Traits that would contradict each other (or repeat the same point) in one line. */
function clash(a: TraitId, b: TraitId): boolean {
  const groups: TraitId[][] = [
    ['feeder', 'immortal'],
    ['killThief', 'killer', 'damage'],
    ['augAllS', 'augBad'],
    ['ghost', 'killer', 'assists'],
    ['mvp', 'troll']
  ]
  return groups.some((g) => g.includes(a) && g.includes(b))
}
