# Changelog

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
