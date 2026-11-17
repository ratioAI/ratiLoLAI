# Changelog

## 1.2.0

Four new features, all built on official interfaces only (LCU, Live Client Data API, Riot API, your own game database) – nothing reads the game's memory or draws anything new over the game.

### Nemesis & old friends on the loading screen
- Every stranger you met in your saved games gets a badge and a cheeky one-liner on the loading-screen panel: **Nemesis**, **Victim**, **Lucky charm**, **Jinx**, **Rival** or a familiar face (*Last time: 2/14/3 Yasuo, 12 days ago*), plus a note when they changed their Riot ID. You and your premades never get one, and the rows don't get taller.
- Profile page: *Your history with this player* with a link to your shared games.

### Achievements as constellations
- 28 achievements in six categories (combat, augments, team, endurance, cosmos and a few secret ones). Unlocks are worked out from your whole game history on the first start and after every game from then on; each one keeps the date of the game that earned it.
- Every achievement is a constellation in the sky of the star map (toggle *Constellations*): faint while locked, lit in bronze, silver, gold or cosmic colours once unlocked. Hover for details, click to open the game.
- *Games → Achievements* lists all of them with progress bars (e.g. 63/100) and sorting.
- A new achievement draws its constellation star by star after the game, as a toast and on the game page.

### Discord webhook
- After every game a summary lands in your friends' channel: result, both teams with K/D/A and quips, MVP and troll, the best highlights and new achievements.
- Your own webhook URL, stored encrypted like the API key and never shown again. Choose the modes, optionally only games with premades; strangers appear only as their champion by default. Test button in Settings, *Post to Discord* on every game page.

### Hype announcer
- Sounds for your triple/quadra/pentakill, a premade's pentakill, first blood, aces, victory and defeat – and a sad trombone for your 5th, 10th and 15th death.
- Made live with WebAudio (no recordings), optional spoken line from the system's offline voice, cooldown and priority so it never spams. Every trigger can be switched off, previewed or replaced by your own sound file (*Open sound folder*).
- Off by default. Audio only, from the app's window – works with the window minimized.

### Under the hood
- `games.db` is now versioned (`PRAGMA user_version`) with migrations; per-player K/D/A and multikills are backfilled from your saved games on the first start.
- The augment tier lookup used by the quips moved into `shared/`, so the main process can build the Discord message.
- Admin tab (development builds only): encounter lobbies, achievement unlock/reset/animation, Discord message preview, every announcer sound and fights in the simulated game.
