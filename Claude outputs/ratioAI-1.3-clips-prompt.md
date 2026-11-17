# Aufgabe: ratioAI 1.3.0 – Clips (Gameplay-Recorder, Editor, Teilen)

Du arbeitest im Repo `ratiLoLAI` (Electron 38 + React 19 + TypeScript strict + Tailwind 4, Vitest, SQLite über `node:sqlite`).
Lies zuerst README.md, `src/shared/types.ts`, `src/main/index.ts`, `src/main/games.ts` (Migrationen über `PRAGMA user_version`),
`src/main/settings.ts`, `src/main/discord.ts`, `src/shared/discordPayload.ts`, `src/main/lcu/manager.ts`, `src/main/live/liveClient.ts`,
`src/main/overlay.ts` (globale Hotkeys), `src/renderer/src/pages/{Games,Settings,Admin}.tsx` und `src/renderer/src/lib/mockApi.ts`.

**Ziel:** Ein kostenloser Medal-Ersatz direkt in ratioAI. Spiele werden automatisch in hoher Qualität aufgenommen, ohne Bezahlschranke
und ohne Wasserzeichen. Clips entstehen per Hotkey oder automatisch bei Highlights. Ein einfacher Editor macht daraus Clips, Montagen,
GIFs und Memes, die man lokal speichert oder über den vorhandenen Discord-Webhook teilt. Alles läuft lokal: keine eigenen Server,
keine Cloud, also keine laufenden Kosten.

Was Medal macht und wo wir besser sind (zur Orientierung):
- Medal: Instant Replay (die letzten X Sekunden per Hotkey), automatische Clips, Bibliothek, Editor mit Effekten, Musik, Text und
  Montagen, Upload mit Link. Gratis-Nutzer bekommen aber Wasserzeichen und Outro auf heruntergeladenen Clips und eine begrenzte
  Upload-Qualität und -Länge. Die volle Qualität kostet ein Abo.
- ratioAI: volle Qualität, kein Wasserzeichen, kein Outro, kein Upload-Limit außer Discords eigenem, Clips mit den Spieldaten von
  ratioAI verknüpft (Champion, K/D/A, MVP, Quips, Erfolge).

## Harte Regeln (gelten für alles)

- **Vanguard-sicher:** Aufnahme nur über Betriebssystem-Schnittstellen: Windows Graphics Capture (WGC) oder Desktop Duplication
  (DXGI) für das Bild, WASAPI für den Ton. **Kein** Hooking und keine Injection in den Spielprozess (also nicht wie OBS „Game Capture“),
  kein Speicherlesen. Spiel-Events nur über die Live Client Data API (127.0.0.1:2999) und das LCU.
- **Performance im Spiel:**
  - Nur Hardware-Encoder (NVENC, AMF, QSV); ohne Hardware-Encoder ist die Aufnahme aus, mit einem Hinweis. Kein Software-Encoding
    (x264) während des Spiels.
  - Bild bleibt auf der GPU (Capture → GPU-Upload → Encoder ohne Umweg über die CPU).
  - Recorder-Prozess mit Priorität „Below normal“.
  - Kann der Encoder nicht mithalten, werden Frames verworfen; das Spiel wird **nie** ausgebremst.
  - Keine neue Poll-Schleife: Auto-Clips hängen sich an das bestehende Live-Polling.
  - Ziel: unter 3 % FPS-Verlust. Messe das und schreibe die Messung ins README.
- **Kein neues Overlay im Spiel.** Rückmeldung beim Clip-Speichern höchstens als kurzer, abschaltbarer Klick-Sound aus dem
  Hauptfenster (Standard: aus).
- **Datenschutz:**
  - Aufgenommen wird nur das League-Spielfenster, nie der ganze Desktop (keine Benachrichtigungen, keine anderen Fenster).
  - Ton standardmäßig nur vom Spielprozess (WASAPI Process Loopback, ab Windows 10 2004), damit Discord-Voice **nicht** im Clip
    landet.
  - Mikrofon optional, Standard aus.
- **Architektur:**
  - Logik als reine, getestete Funktionen in `src/shared/`, I/O im Main-Prozess, typisierte IPC über `RcApi`/`RcEvents`.
  - **Jede neue API-Methode auch in `mockApi.ts`**: die Web-Demo zeigt eine Beispiel-Bibliothek mit Demo-Clips. Dafür ein paar
    Sekunden Testvideo, das ffmpeg aus `testsrc` erzeugt, nichts Urheberrechtliches.
  - Admin-Tools im Dev-Admin-Tab (nur `import.meta.env.DEV`).
- **Lizenzen:**
  - FFmpeg nur als **LGPL-Build** (ohne x264/x265/GPL-Teile) und als eigene `.exe` neben der App, nicht gelinkt. Lizenztext und
    Quell-Link in „Third-party licenses“.
  - Keine urheberrechtlich geschützte Musik, Schriften oder Sticker mitliefern (siehe Schritt 3).
  - Riot erlaubt Gameplay-Videos; Data-Dragon-Icons dürfen in Overlays der Clips verwendet werden.
- **Settings:** `SCHEMA` auf 6, neuer Block `recorder` mit Defaults und im Merge.
- **UI** auf Englisch, Psychedelic-Kosmos-Look, keine Beschreibungszeilen unter Reiter-Überschriften.
- Nach jedem Schritt: `npm run typecheck`, `npm test`, `npm run build`, `npm run build:web` grün, dann ein eigener Commit.

---

## Schritt 0 – Fundament: FFmpeg, Encoder-Erkennung, Datenbank

1. **FFmpeg bereitstellen:** nicht ins Installer-Paket (zu groß). Beim ersten Aktivieren von Clips eine feste FFmpeg-Version
   herunterladen, prüfen und entpacken nach `userData/ffmpeg/`:
   - herunterladen aus einem eigenen GitHub-Release-Asset des Repos (LGPL-Build mit `nvenc`, `amf`, `qsv`/`libvpl`),
   - SHA-256 prüfen (fest im Code),
   - Fortschrittsanzeige in den Settings.
2. **Encoder-Erkennung** (`main/recorder/encoders.ts`): vorhandene GPU-Encoder testen, mit einem kurzen Encode eines `testsrc`-Bilds.
   - Reihenfolge: AV1 (RTX 40/50, RX 7000+, Arc) → HEVC → H.264.
   - Ergebnis cachen, im Settings-Abschnitt anzeigen („NVIDIA AV1 ✓“).
3. **Capture-Quelle:** prüfen, ob die gebündelte FFmpeg-Version `gfxcapture` (Windows Graphics Capture, Fenster-Capture) kann.
   - Sonst `ddagrab` (Desktop Duplication) auf dem Spielbildschirm, zugeschnitten auf das Spielfenster.
   - Das Spielfenster „League of Legends (TM) Client“ wird über seinen Titel/Prozess gefunden. Den Bildschirm kennt die App schon
     (`overlay.gameDisplayId`).
4. **Ton-Helfer:** FFmpeg kann unter Windows kein WASAPI-Loopback. Deshalb ein kleiner Helfer `ratio-audio.exe`:
   - C#/.NET 8 NativeAOT oder Rust, eigener Ordner `native/audio/`, Build über ein npm-Script.
   - Er nimmt per WASAPI Process Loopback nur den Ton des Spielprozesses (optional zusätzlich das Mikrofon) und schreibt PCM
     (48 kHz, Stereo) über eine Named Pipe an FFmpeg.
   - Steuerung über stdin/stdout mit JSON-Zeilen.
5. **Datenbank:** Migration v4 in `games.ts`:
   - `recordings (id, game_id, started_at, ended_at, dir, bytes, kept)`
   - `clips (id, game_id, recording_id, created_at, start_ms, end_ms, file, thumb, kind, title, favorite, bytes)`
     - `kind`: `manual` | `auto:penta` | `auto:ace` | … | `bookmark`
   - `edits (clip_id, project_json, updated_at)`
   - Tests: Migration auf einer v3-Datenbank, idempotent.
6. **Settings `recorder`:**
   - `{ enabled: false, mode: 'replay' | 'session', replaySeconds: 30, quality: 'compact' | 'high' | 'original', fps: 60 | 30, encoder: 'auto' | <id>, audio: { game: true, mic: false, micVolume }, hotkeys: { clip: 'Alt+F9', bookmark: 'Alt+F10', screenshot: 'Alt+F11' }, autoClips: Record<AutoClipKind, boolean>, storage: { folder, maxGb: 30, keepSessionsDays: 7 }, clipSound: false }`
   - Standardmäßig **aus**.

**Admin:** Encoder-Test, FFmpeg neu laden, „Aufnahme ohne Spiel“ (nimmt 20 s `testsrc` oder den Desktop auf, um die Pipeline zu testen).

---

## Schritt 1 – Recorder: Replay-Buffer, Hotkeys, Auto-Clips

**Shared (rein, getestet), `src/shared/recorder.ts`:**
- **Qualitätsprofile:** Auflösung, FPS, Encoder-Parameter im Constant-Quality-Modus:
  - NVENC `-rc vbr -cq`, AMF `-rc qvbr`, QSV `-global_quality`.
  - Keyframe-Abstand = 1 s (für sekundengenaues Schneiden ohne Neu-Encoding).
  - Geschätzte MB pro Minute für die UI.
  - Richtwerte zum Kalibrieren:

    | Profil | Format | Bitrate | Speicher |
    |---|---|---|---|
    | „Kompakt“ | 1080p60 AV1/HEVC | ca. 6–8 Mbit/s | ca. 45–60 MB/min |
    | „Hoch“ | 1440p60 | ca. 12–16 Mbit/s | |
    | „Original“ | native Auflösung | höher | |

- `ffmpegRecordArgs(profile, source, audioPipe, outDir)`: baut die FFmpeg-Argumente für die Aufnahme in **2-Sekunden-Segmente**
  (segment muxer, fragmented MP4 oder MPEG-TS) in einen Ringordner. Snapshot-Tests.
- `segmentsFor(range, segments)`: welche Segmente ein Clip [Start, Ende] braucht.
- `autoClipWindows(events, ctx)`: aus Live-Events Clip-Zeitfenster ableiten (Vorlauf/Nachlauf je Art), überlappende zusammenführen.
  - Arten: eigener Triple/Quadra/Penta, First Blood, Ace des eigenen Teams, „Tod nach X Sekunden Kampf“ optional, Spielende.
  - Dafür `RawLive.events` wieder um `EventID`, `KillStreak`, `AcingTeam`, `Recipient`, `Assisters` erweitern und die vollen Events
    intern weiterreichen. Das gab es kurz in 1.2 für den (entfernten) Ansager: Commit `7af76f6`, Datei `liveClient.ts`, Funktion
    `parseLiveEvents` – wiederverwenden.
  - Nur Events mit `EventID > zuletzt gesehen`, beim App-Start mitten im Spiel nichts nachholen.
- `cleanupPlan(files, quota, now)`: was gelöscht wird, wenn der Speicher voll ist. Reihenfolge:
  1. alte Replay-Segmente,
  2. Session-Aufnahmen älter als `keepSessionsDays` (außer „behalten“),
  3. nie Clips oder Favoriten.

**Main, `src/main/recorder/`:**
- **Start/Stop automatisch:** Start bei Gameflow `InProgress` (LCU), Stop bei Spielende. Eine laufende Aufnahme beim App-Beenden
  sauber abschließen.
- **Replay-Modus:** der Ringordner hält die letzten `replaySeconds` + Puffer.
  - Hotkey „Clip“ → Segmente per Stream-Copy (ohne Neu-Encoding, sofort) zu einer MP4 zusammenfügen und auf die Sekunde schneiden.
  - Thumbnail erzeugen, in `clips` speichern, an die `game_id` hängen.
- **Session-Modus:** das ganze Spiel bleibt erhalten. Nach dem Spiel in der Game-Summary „Aufnahme behalten / löschen“.
- **Auto-Clips:** im bestehenden Live-Tick → `autoClipWindows` → Clip wird erzeugt, sobald der Nachlauf vorbei ist.
- **Bookmark-Hotkey:** setzt nur eine Marke, der Clip entsteht nach dem Spiel.
- **Screenshot-Hotkey:** PNG aus dem aktuellen Frame.
- Hotkeys über den vorhandenen globalen Shortcut-Mechanismus (`overlay.ts`), konfigurierbar, Konflikte mit dem Augment-Hotkey prüfen.
- **Fehlerfälle:**
  - Encoder bricht ab → eine Wiederholung, dann aus mit Meldung in `diag.log`.
  - Spielfenster nicht gefunden → nichts aufnehmen.
  - Exklusiver Vollbildmodus → Hinweis wie beim Augment-Overlay („Borderless/Windowed“).
- **Event `recorder`** an den Renderer: Status (`idle`, `recording`, `saving`), Speicherverbrauch, letzter Clip.

**UI:**
- Kleiner Aufnahme-Indikator in der Kopfzeile des Hauptfensters (roter Punkt + Speicher), **nicht** im Spiel.
- Settings-Abschnitt „Clips“: an/aus, Modus, Qualität mit MB/min-Anzeige, FPS, Encoder, Ton, Hotkeys, Auto-Clip-Arten,
  Speicherordner, Speicherlimit, „Open folder“.

**Admin:** Event-Simulator für Auto-Clips (mit dem simulierten ARAM-Spiel), Ringpuffer-Anzeige, „Clip jetzt“.
**Tests:** Profile/Args-Snapshots, Segmentauswahl an den Rändern, Auto-Clip-Fenster (Zusammenführen, kein Nachholen beim Start),
Cleanup-Reihenfolge.

---

## Schritt 2 – Bibliothek: Reiter „Clips“

- **Raster mit Thumbnails**
  - Hover spielt eine stumme Vorschau ab (nur im Hauptfenster, nie im Spiel).
  - Filter nach Champion, Modus, Datum, Art (manuell/auto/Bookmark) und Favoriten.
  - Suche, Sortierung, Mehrfachauswahl zum Löschen.
- **Verknüpfung mit den Spielen:**
  - Die Game-Detail-Seite zeigt die Clips des Spiels.
  - Jeder Clip zeigt Champion, K/D/A und Ergebnis aus der Summary.
  - Klick auf „Game“ öffnet die Zusammenfassung.
- **Player:** HTML5-Video über ein eigenes Protokoll (`rcclip://`, nur Lesen aus dem Clip-Ordner, Pfade validieren), mit
  Tastenkürzeln (Leertaste, J/K/L, ←/→ Frame).
- **Speicheranzeige:** belegt / Limit; „Aufräumen“ zeigt vorher, was gelöscht würde.

---

## Schritt 3 – Editor & Export

**Shared (rein, getestet), `src/shared/editProject.ts`:**
- Projektformat `{ clips: [{ clipId, in, out, speed }], crop: '16:9' | '9:16' | '1:1' + Ausschnitt, texts: [...], stickers: [...], overlays: [...], music: { file, offset, volume, duck, fadeIn, fadeOut } | null, transitions, output }`.
- `ffmpegExportArgs(project, preset)`: baut den `filter_complex`:
  - trim/setpts für Geschwindigkeit,
  - crop/scale,
  - drawtext/overlay für Text und Sticker,
  - amix/sidechaincompress für Musik mit Ducking.
  - Snapshot-Tests.
- `bitrateForSize(durationS, targetMB, audioKbps)` für das Discord-Preset.

**Editor (Renderer):**
- **Zeitleiste:** Videospur mit Wellenform, In/Out ziehen, schneiden (Split), Teile löschen, Zeitlupe für Abschnitte
  (0,5× / 0,25×), mehrere Clips hintereinander als Montage mit einfachen Übergängen (Schnitt, Blende, Glitch).
- **Format:** 16:9, 9:16 (TikTok/Shorts/Reels) mit verschiebbarem Ausschnitt, 1:1.
- **Text & Memes:**
  - Klassischer Meme-Text oben/unten (weiß mit schwarzer Kontur) und freie Textboxen mit Ein-/Ausblenden.
  - Schrift: eine **mitgelieferte OFL-Schrift** (z. B. „Anton“ über `@fontsource`). Nicht „Impact“ mitliefern.
  - **Vorschläge aus ratioAI:** der Quip des Spielers aus der Summary als Meme-Text, „PENTAKILL“, „0/10 POWERSPIKE“,
    MVP/Troll-Krone.
- **Stats-Overlay (optional):** Champion-Icon (Data Dragon), K/D/A, Ergebnis.
- **Sticker:** eigene Bilder des Nutzers oder freie Emoji (z. B. Twemoji, CC-BY mit Namensnennung in den Lizenzen).
- **Musik:**
  - **keine Trend- oder Chartmusik mitliefern oder herunterladen** (Urheberrecht; Medal hat dafür Lizenzverträge).
  - Erlaubt sind:
    1. eigene Audiodateien des Nutzers (Import von der Festplatte),
    2. eine kleine eingebaute Auswahl lizenzfreier CC0-Tracks mit dokumentierter Quelle.
  - Beim Teilen mit eigener Musik ein einmaliger Hinweis zur Verantwortung des Nutzers.
  - Lautstärke, Startpunkt im Song, automatisches Leiserdrehen des Spieltons (Ducking), Ein-/Ausblenden.
- **Vorschau:** Live im Editor über Canvas-Compositing (Video + Text + Sticker); Musik über WebAudio synchron.
- **Projekte:** werden in `edits` gespeichert, Undo/Redo.

**Export (Main, FFmpeg, Hardware-Encoder):**

| Preset | Inhalt |
|---|---|
| „Discord“ | passt automatisch unter das Upload-Limit: Standard **20 MB** (Discords Gratis-Limit seit August 2026), einstellbar für geboostete Server. Bitrate aus Länge berechnet, bei Bedarf 720p. |
| „High quality MP4“ | volle Qualität |
| „9:16 Short“ | Hochformat |
| „GIF“ | 2-Pass mit `palettegen`/`paletteuse`, 10–20 fps, Breite 480/640, Zielgröße |
| „WebM“ | |

- Fortschrittsanzeige, Abbrechen, Export im Hintergrund. Nie während eines Spiels starten; ein laufender Export pausiert bei
  Spielstart.
- „Copy file“ in die Zwischenablage, „Show in folder“, „Save as…“.

---

## Schritt 4 – Teilen

- **Discord:** über den vorhandenen Webhook (`main/discord.ts`).
  - `multipart/form-data` mit `payload_json` + `files[0]`.
  - Embed mit Champion, K/D/A, Ergebnis, Titel des Clips und optional dem Quip.
  - Ist die Datei zu groß (HTTP 413) → automatisch mit dem Discord-Preset kleiner exportieren und erneut senden.
  - Fehler wie bisher nur ins Log, nie ein Absturz.
  - Option in den Discord-Settings: „Bester Auto-Clip automatisch an die Spielzusammenfassung hängen“ (Standard aus).
- **Lokal:** Speichern unter beliebigem Ort.
- Keine eigene Cloud und keine Links mit Ablaufdatum: alles bleibt beim Nutzer.

**Tests:** Multipart-Aufbau, 413 → kleiner neu exportieren, Größenberechnung, Dedupe.

---

## Abschluss

- README:
  - Zeile „🎬 Clips“ in der Feature-Tabelle.
  - Unter „Is this allowed?“: Aufnahme nur über Windows-Schnittstellen (WGC/DXGI, WASAPI), keine Injection; Ton nur vom
    Spielprozess.
  - Abschnitt zu FPS-Messung und Speicherbedarf pro Profil.
- Screenshots aus der Web-Demo: Bibliothek, Editor, Export-Dialog.
- `package.json` auf 1.3.0, `docs/CHANGELOG.md`. **Nicht taggen oder releasen.**
- Gib mir am Ende eine kurze Liste:
  - was fertig ist,
  - was bewusst weggelassen wurde,
  - welche GPUs/Encoder getestet wurden,
  - gemessener FPS-Verlust,
  - MB pro Minute je Profil,
  - was ich manuell testen soll.

## Ideen für später (nicht in 1.3 umsetzen, nur im Hinterkopf behalten)

- Monthly Recap (Sturz ins Schwarze Loch → Tesserakt mit den Momenten des Monats). Die Momente können dann die passenden Clips
  abspielen.
- Automatisches „Best of the game“: 30-Sekunden-Montage aus den Auto-Clips eines Spiels.
- Clip zum „Throw of the Century“: Zeitpunkt der größten Goldführung aus der Goldkurve der Summary.
