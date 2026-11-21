# Changelog

## 1.3.3

- **Readable everywhere.** Panels, the side bar and the title bar let far less of the moving background through (they were 74–78 % opaque, bright swirls and stars showed behind the text). Cards in a colour of their own – *MVP*, *Most to blame*, both team tables of a game, the teams on the Live page, *Your history with this player*, discovered achievements – had almost no background at all; their tint now lies on top of the panel colour.
- **Nothing is deleted with one click any more.** Deleting a clip, several clips or a whole-game recording asks first and says how much goes; so does removing the Riot API key or the Discord webhook. A clip the filter hides is no longer part of the selection.
- **Hotkeys are set by pressing them** (click the field, press the combination; Backspace turns it off). They used to be typed, and a typo like `Strg+F9` was saved and then simply did nothing in the game. Letters and digits need Ctrl or Alt, so a hotkey can never swallow what you type in chat.
- Clip editor: the last change is saved when you leave (it was dropped when you went back within a moment), a failed save says so, a finished game no longer pulls you out of the editor, a slider drag or a typed word is one undo step, and shortcuts stay quiet while a dialog is open. Dialogs close with Esc.
- Pages say *loading* or *could not be loaded* (with *Try again*) instead of "nothing here yet" or a blank page; filters and searches that match nothing say so. The Live page's *Import* shows what it imported or why not. Switching to another champion no longer shows the last one's build for a moment.
- Recorder: a whole game that could not be joined into one file (disk full) lost its segments to the cleanup seconds later – they are kept now, like any whole-game recording. An error while finishing a recording no longer leaves the recorder stuck on "recording" until the next start. Clips are attached to their game even when the summary arrives before the recorder is done.
- One way to write dates and numbers: dates read `21 Nov 2026, 16:43` everywhere (they followed the Windows region and came out German next to English text), times ago read the same on every page, percentages always have their space.
- Keyboard: the tier list can be sorted and opened with Tab and Enter, the favourite star and *remove augment* are reachable, tooltips open on focus, and the focused control always shows a ring.
- A hotkey Windows refuses – another program holds it – is named in the settings and in `overlay.log` instead of silently doing nothing.
- Exports: a game that starts and is over again at once (a dodge) no longer runs two exports in one temporary folder; the editor's export dialog no longer shows another export's *Done* as its own.
- Sturdier in the background: one bad answer from the game can no longer end the live polling (overlay, timers and automatic clips died with it), a crashed capture page is started again, a running export is cancelled when the app closes, a second start of the app ends at once, the settings file is written safely, and a file dropped on the window can no longer load in it.

- **Augment overlay: only the static tier, only the frame.** The frames show the champion's tier list as it is before the game (curated combos, pick rate, archetype fit) in the colour of each card's tier – nothing else. Riot does not allow apps that dictate decisions from the running game, so the frames are no longer lifted for combos with the augments you already own (the same goes for the augment panel on the Live page: no more "Combos with your augments"), no card glows as the best pick, and no crest, label or note is drawn on the card – League shows its own tier and description there now.
- Augment overlay: with the Maestro Headliner (four cards) the fourth card gets its frame too; the frame shader only had three slots.
- ARAM: Mayhem page: your most picked augments show how often you took them, no win rate any more – Riot's policy says *"Products cannot display win rates for Augments"*. README › *Is this allowed?* says honestly what ratioAI reads, what it leaves out in game, the grey areas, and that it is not a registered Riot product yet.
- **Loading screen: hidden players stay hidden.** A stranger whose name the game session leaves out is hidden by the game (streamer mode, *Hide My Name*). ratioAI used to look their name up through the client – and fill it in from the running game – and then load their win rate and encounter badge. Riot does not allow identifying or analysing hidden players, so they now show as *Hidden*, with nothing looked up about them. You and your premades are never hidden.
- **Highlight videos**: one click on a game's page turns its best clips into one video, cut to the moments that matter, with fades, a title, a label per clip (*Clutch triple kill*, *Game-winning ace* …) and the best S-tier moment in slow motion – exported for Discord in the background, then *Play*, *Edit* or *Share to Discord*. *Clips › Month recap* does the same for a whole month: at most two clips per game, champions mixed, opened by the second-best moment and ending on the best, with a built-in loop under the game's sound.
- **Which clips are worth watching**: every clip gets a highlight score from 0 to 100 (tier S, A, B, C on the thumbnail, *Sort › Most worth watching* in the library). It is built like an editor would judge a clip: what you did (kills, assists, multikills, aces, solo kills, the size of the fight – 50 %), how loud it got against the rest of the game (the fight, the announcer and your friends on voice chat – 20 %), clutch (you won it on low health and lived, or alone – 15 %) and stakes (a fight won far behind, a swing in the gold lead, the fight that ended the game – 15 %); a favourite, a shared clip, a bookmark or your own hotkey clip are lifted, a pentakill is always S tier. Two clips of the same fight count once. The recorder now keeps what this needs per recording: the game clock, Riot's live kill feed and your health from the live API; the sound is measured once per clip with FFmpeg after the game (never during one). Clips from before this version are judged by their kind, sound and what you did with them.
- **Will to win on the leaderboard and in Discord**: the leaderboard has a *Ø will* column (your team's average will to win in each player's games), and the will-to-win panel of a game has *Send to Discord*: both teams as bars, the verdict and each factor. It is only sent when you press it; strangers who were away are always named by their champion.
- ARAM: Mayhem since "Journey to Stardom" (26.21–26.23): the map skin's own augment pool is known (Riot's `KIWI_JADE` list: 44 extra augments and classic item upgrades), so those cards are recognised and framed by their tier. The game's Headliner is read off the cards and levels (Maestro's four cards, Pentakill's HEAVY/POWER/THRASH and DOOM at level 18, Superfans' level-21 augment), so the scanner knows when a selection comes; up to eight picked augments are kept. `overlay.log` writes `game context:` lines; the client's game session is kept in `logs/live-session.json`.
- **Will to win**: the game summary now rates how much your team – and the enemy – wanted to win, from 0 (*Checked out*) to 100 (*All in*). It rates effort, not skill or the result, and compares every team with what a typical team does in the same spot: teamplay (kill participation), fighting spirit (kills won while 1.5k+ gold behind, against the share expected at that gap) and closing drive (turrets and inhibitors taken while 1.5k+ ahead), times the share of the team that actually played (champions standing on one spot for 3+ minutes count as away), minus 15–25 points for a surrender. Everything comes from Riot's match data; 50 is a typical ARAM: Mayhem team (calibrated on 90 teams). Older games get it when you open them, as long as the League client still has them.
- Augment overlay: silver augments are recognised again. Their frames fade towards the bottom right, so the frames only flashed up while the cards faded in (or never showed) and then disappeared.
- Augment overlay: one look without cards (hover glow, tooltip, animation) no longer hides the frames; they go after two misses in a row.

## 1.3.2

**Augment overlay on every screen** – the card frames now find and frame the cards no matter how the screen is set up.

- Any resolution and aspect ratio: 720p to 4K, 16:9, 16:10 laptops, 21:9 ultrawide, 4:3. The recognition checks which layout the game shows instead of assuming 16:9, remembers it per monitor and writes it to the log.
- Multi-monitor: screen sources are paired with monitors by Windows' display id, then by aspect ratio, and only as a last resort by order. A wrong guess used to scan the wrong monitor or draw the frames on the other screen.
- Mixed Windows scaling (e.g. 100 % + 125 %): the frames window is created on the game screen and its size is checked after every move, so it no longer ends up too big, too small or shifted.
- Capture pixels are converted to screen coordinates per axis, and frames are never put on a guessed monitor anymore when the remembered one is gone.
- Plugging in, removing or rescaling a monitor during a game resets the recognition and the overlay right away.
- Crest, label, note, border and glow scale with the cards, so they look the same on 720p, 1440p and 4K.
- League's window mode is read from the client: exclusive fullscreen (nothing can be drawn over it), windowed mode and a black screen capture are shown as a notice in the header and in Settings › Diagnostics, with how to fix it.
- The overlay page is rebuilt on its own after a crash (e.g. a GPU driver reset).
- `overlay.log` now lists the monitors (position, size, scaling), League's window mode, the detected card layout and where the frames were placed; *Test screen recognition* shows scaling and layout per screen.

## 1.3.1

- Clips: the FFmpeg build is published now, so *Download* in Settings › Clips works (FFmpeg 8.1, LGPL build, verified by SHA-256).

## 1.3.0

**Clips** – a free replacement for Medal inside ratioAI. Games are recorded in full quality without a paywall or a watermark, clips are made by hotkey or on their own, an editor turns them into montages, GIFs and memes, and you share them through your Discord webhook or keep them on disk. Everything runs locally: no servers, no cloud, no running costs. Off by default.

### Recorder
- Records only through Windows' own interfaces: Windows Graphics Capture for the League window (Desktop Duplication as the fallback), WASAPI process loopback for the sound. No hook, no injection, no memory reading. Only the game window is captured, never the desktop.
- **The whole sound of the moment**: by default a clip has everything your PC plays – the game, your friends on Discord, your music – so it sounds like it did when it happened. Only ratioAI's own sounds are left out (clip previews, the click). *Only the game* is still available in Settings › Clips; the microphone (your own voice) is optional.
- Hardware encoders only (AV1 → HEVC → H.264 on NVIDIA, AMD, Intel), frames stay on the GPU, FFmpeg and the sound helper run at below-normal priority, and a busy encoder drops frames in the recording, never in the game. Without a hardware encoder the recorder stays off.
- **Instant replay** (the last 10–300 seconds, saved by hotkey) or **whole game** (kept as one file; *Keep* or *Delete* on the game page, deleted after a week otherwise).
- Hotkeys: clip (<kbd>Alt</kbd>+<kbd>F9</kbd>), bookmark for a clip after the game (<kbd>Alt</kbd>+<kbd>F10</kbd>), screenshot (<kbd>Alt</kbd>+<kbd>F11</kbd>). They are only held while a recording runs and may not collide with the augment hotkey.
- **Automatic clips** from the live event feed: your triple, quadra and pentakills, first blood, an ace of your team, optionally your death at the end of a team fight and the end of the game. Overlapping moments become one clip.
- Three quality profiles (Compact up to 1080p60, High up to 1440p60, Original) with the megabytes per minute shown, 60 or 30 fps, a storage limit with a cleanup that never touches clips or favorites.
- FFmpeg (LGPL build) is downloaded on first use, verified by SHA-256 and runs as its own program; it is not part of the installer.
- A small red dot with the space in use in the header of the main window while recording; nothing new is drawn over the game. Optional click sound when a clip was saved (off).

### Library
- New tab **Clips**: a grid with hover previews, filters for champion, mode, date, kind and favorites, search, sorting and multi-select delete.
- Every clip knows its game: champion, K/D/A and result on the clip, the clips of a game on its page, one click to the summary.
- Player with keyboard shortcuts (<kbd>Space</kbd>, <kbd>J</kbd>/<kbd>K</kbd>/<kbd>L</kbd>, arrow keys for single frames), rename, favorite, show in folder.
- Whole-game recordings can be played and cut into clips.

### Editor & export
- Timeline with waveform: trim, split, delete, slow motion (0.5× and 0.25×), several clips in a row as a montage with cut, fade or glitch.
- Formats 16:9, 9:16 (with a movable crop) and 1:1.
- Meme text top and bottom, text boxes with fades, suggestions from the game (your quip, PENTAKILL, 0/10 POWERSPIKE, MVP or troll crown), a stats overlay (champion icon, K/D/A, result), emoji stickers or your own pictures.
- Music: your own audio files or three built-in loops, with volume, start, fades and the game's sound turned down under the music. ratioAI ships and downloads no chart music.
- Export presets: **Discord** (fits under 20 MB on its own, drops to 720p when needed; the limit can be raised for boosted servers), **High quality MP4**, **9:16 Short**, **GIF** (two passes with its own palette), **WebM**. Progress, cancel, runs in the background and never during a game. Copy the file, show it in its folder or save it elsewhere.
- Projects are saved per clip, with undo and redo.

### Sharing
- *Share to Discord* sends a clip through your webhook with an embed (title, champion, K/D/A, result, optionally your quip). A file that is too large is exported smaller and sent again on its own.
- Option: add the game's best automatic clip under the game summary (off by default).

### Under the hood
- `games.db` version 4: tables `recordings`, `clips`, `edits` and `clip_posts`. Settings schema 7 with the new block `recorder` (sound source `all` or `game`).
- `native/audio`: a small Rust helper for the sound (`npm run build:audio`), process loopback of everything but ratioAI or of the game only; built by the release workflow and checked by CI on Windows.
- Admin tab (development builds only): encoder test, reload FFmpeg, record without a game, a test recording for the simulated game's automatic clips, the ring buffer and *Clip now*.

### Removed
- The **hype announcer** (1.2) is gone, with its settings, sound folder and admin card. Its stored settings are dropped on the first start.

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
