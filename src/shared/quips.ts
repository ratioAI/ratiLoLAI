/**
 * A cheeky one-liner for every player of a finished game, picked from how they actually played
 * (relative to their own team). Deterministic per game and player, so it does not change on reload.
 * Friendly roasting – never personal.
 */
import { teamBlame, type GameSummary, type SummaryPlayer } from './summary'

const hash = (s: string): number => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

type Ctx = { p: SummaryPlayer; k: string; dmg: string; tank: string; kp: number; d: number }
type Line = (c: Ctx) => string

const fill = (lines: Line[], c: Ctx, salt: string): string => lines[hash(c.p.puuid + salt) % lines.length](c)

// --- your team ---------------------------------------------------------------------------
const MVP_WIN: Line[] = [
  () => `Hat das Spiel auf dem Rücken getragen – Rückenschmerzen inklusive.`,
  (c) => `${c.p.kills} Kills. Der Gegner hat schon eine einstweilige Verfügung beantragt.`,
  (c) => `${c.dmg} Schaden. Die gegnerischen Healthbars brauchen jetzt eine Therapie.`,
  () => `Ist nicht ins Spiel gegangen, das Spiel ist zu ihm gekommen.`,
  () => `Bitte ab sofort mit „Chef“ ansprechen.`
]
const MVP_LOSS: Line[] = [
  () => `Hat alles gegeben. Das Team hatte leider andere Pläne.`,
  (c) => `${c.dmg} Schaden und trotzdem verloren – ein Held ohne Happy End.`,
  () => `Ein Mann, eine Mission, vier Zuschauer.`,
  () => `Hätte einen besseren Ausgang verdient. Und ein besseres Team.`
]
const TROLL_WIN: Line[] = [
  () => `Wurde heute erfolgreich durchs Spiel getragen – Trinkgeld an den Carry nicht vergessen.`,
  () => `Größter Troll des Teams, aber hey: gewonnen ist gewonnen.`,
  () => `Passagier erster Klasse. Bitte bleiben Sie angeschnallt.`,
  () => `Hat bewiesen, dass man auch zu viert gewinnen kann.`
]
const TROLL_LOSS: Line[] = [
  () => `Hauptverdächtiger. Die Ermittlungen laufen.`,
  () => `Hat heute für das gegnerische Team gespielt – nur keiner hat's ihm gesagt.`,
  (c) => `${c.d} Tode. Der Respawn-Timer kennt ihn schon beim Vornamen.`,
  (c) => `Spenden-Gala: ${c.d} Kills an die Gegner verschenkt.`
]
const FEEDER: Line[] = [
  (c) => `${c.d} Tode. Der Graue Bildschirm ist sein zweites Zuhause.`,
  (c) => `${c.d}× gestorben – erstaunlich konsequent.`,
  () => `Kennt den Weg vom Brunnen in die Lane inzwischen blind.`,
  (c) => `${c.d} Tode. Hat das Konzept „Leben“ eher als Vorschlag verstanden.`
]
const DAMAGE: Line[] = [
  (c) => `${c.dmg} Schaden. Hat geballert, als gäbe es kein Morgen.`,
  (c) => `${c.dmg} Schaden – die Tastatur braucht jetzt Urlaub.`,
  () => `Schadensquelle Nummer eins. Bitte Sicherheitsabstand halten.`
]
const TANK: Line[] = [
  (c) => `Hat ${c.tank} Schaden gefressen. Frontline, Backline, Brotlinie – alles.`,
  (c) => `${c.tank} Schaden eingesteckt. Ein Mensch gewordener Sandsack.`,
  () => `Stand vorne und hat für alle die Prügel eingesteckt. Respekt.`
]
const SUPPORT: Line[] = [
  () => `Heilt mehr, als die Krankenkasse zahlt.`,
  () => `Ohne die Schilde wären alle schon viel früher grau gewesen.`,
  () => `Der stille Held mit dem Pflasterkoffer.`
]
const LOW_KP: Line[] = [
  (c) => `Kill-Beteiligung ${c.kp} %. War er überhaupt im selben Spiel?`,
  (c) => `${c.kp} % Kill-Beteiligung. In ARAM. Mit einer Lane. Beeindruckend.`,
  () => `Hat die Teamfights eher aus der Ferne beobachtet.`
]
const ASSISTS: Line[] = [
  (c) => `${c.p.assists} Assists – teilt gerne, vor allem die Kills der anderen.`,
  () => `Assist-König: immer dabei, nie im Rampenlicht.`
]
const SOLID: Line[] = [
  () => `Solide Leistung – darf nächstes Mal wieder mit.`,
  () => `Zuverlässig wie ein Schweizer Uhrwerk.`,
  () => `Keine Beschwerden. Fünf Sterne, würde wieder mitspielen.`
]
const MEH: Line[] = [
  () => `Unauffällig wie ein Ward im Busch.`,
  () => `War da. Hat Dinge gemacht. Manche davon sogar sinnvoll.`,
  () => `Durchschnitt – aber mit Stil.`,
  () => `Weder Held noch Schurke. Ein Statist mit Potenzial.`
]

// --- enemy team (from your point of view) ---------------------------------------------------
const E_MVP: Line[] = [
  () => `Der gefährlichste Gegner. Nächstes Mal bitte zuerst fokussieren.`,
  (c) => `${c.p.kills} Kills gegen uns. Wir legen offiziell Beschwerde ein.`,
  (c) => `${c.dmg} Schaden. Hat uns persönlich genommen.`
]
const E_FEEDER: Line[] = [
  (c) => `Hat uns ${c.p.deaths} Kills geschenkt. Danke für die Spende!`,
  (c) => `${c.p.deaths} Tode – unser bester Mann im gegnerischen Team.`,
  (c) => `Freundliche Gold-Lieferung, ${c.p.deaths}× pünktlich zugestellt.`
]
const E_TANK: Line[] = [
  (c) => `${c.tank} Schaden eingesteckt. Wie ein Kühlschrank mit Beinen.`,
  () => `Unser Schaden ist an ihm einfach abgeprallt.`
]
const E_DAMAGE: Line[] = [(c) => `${c.dmg} Schaden. Hat ordentlich ausgeteilt.`, (c) => `Ihr Hauptgeschütz – ${c.dmg} Schaden.`]
const E_MEH: Line[] = [
  () => `War auch dabei.`,
  () => `Ein ganz normaler Gegner. Nichts zu befürchten.`,
  () => `Hat mitgespielt, ohne groß aufzufallen.`,
  () => `Kam, sah und … war dann halt da.`
]

/** One line per player puuid. */
export function quips(s: GameSummary): Record<string, string> {
  const out: Record<string, string> = {}
  const troll = teamBlame(s)
  for (const ally of [true, false]) {
    const team = s.players.filter((p) => p.ally === ally)
    const sum = (f: (p: SummaryPlayer) => number) => team.reduce((a, p) => a + f(p), 0) || 1
    const n = team.length || 1
    const best = [...team].sort((a, b) => b.score - a.score)[0]
    for (const p of team) {
      const c: Ctx = {
        p,
        k: String(p.kills),
        dmg: `${(p.damage / 1000).toFixed(1)}k`,
        tank: `${(p.tanked / 1000).toFixed(0)}k`,
        kp: Math.round(((p.kills + p.assists) / sum((x) => x.kills)) * 100),
        d: p.deaths
      }
      const share = (f: (x: SummaryPlayer) => number) => f(p) / sum(f)
      const deathShare = share((x) => x.deaths)
      const salt = String(s.gameId)
      let lines: Line[]
      if (ally) {
        if (p.puuid === s.mvp) lines = s.win ? MVP_WIN : MVP_LOSS
        else if (troll && p.puuid === troll.puuid) lines = s.win ? TROLL_WIN : TROLL_LOSS
        else if (deathShare > 1.45 / n && p.deaths >= 8) lines = FEEDER
        else if (share((x) => x.damage) > 1.4 / n) lines = DAMAGE
        else if (share((x) => x.tanked) > 1.45 / n) lines = TANK
        else if (share((x) => x.support) > 1.6 / n) lines = SUPPORT
        else if (c.kp < 40) lines = LOW_KP
        else if (p.assists > 2.5 * Math.max(1, p.kills)) lines = ASSISTS
        else if (p.score >= 55) lines = SOLID
        else lines = MEH
      } else {
        if (p.puuid === best?.puuid) lines = E_MVP
        else if (deathShare > 1.4 / n && p.deaths >= 8) lines = E_FEEDER
        else if (share((x) => x.tanked) > 1.45 / n) lines = E_TANK
        else if (share((x) => x.damage) > 1.4 / n) lines = E_DAMAGE
        else lines = E_MEH
      }
      out[p.puuid] = fill(lines, c, salt)
    }
  }
  return out
}
