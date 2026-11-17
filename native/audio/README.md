# ratio-audio

A small helper for ratioAI's Clips. FFmpeg cannot record what a single program plays on Windows,
so this does it and hands the sound to FFmpeg:

- **Sound of one process only.** WASAPI *process loopback* (Windows 10 2004 or newer) records what
  the game process plays and nothing else: no Discord voice, no browser, no notifications.
  Optionally the default microphone is mixed in.
- **Finding the game window.** Title, process id, position and size of the League window, so
  FFmpeg captures exactly that window.

It only uses operating system interfaces. It never opens the game process, reads its memory or
injects anything: the window is found by its title, and the sound comes from Windows' own audio
engine, which only needs the process id.

## Protocol

JSON lines on stdin (commands) and stdout (events). 48 kHz, stereo, signed 16-bit PCM goes through
a named pipe the helper creates and FFmpeg opens as its audio input.

| stdin | stdout |
|---|---|
| `{"cmd":"find"}` | `{"event":"window","found":true,"pid":1234,"hwnd":65552,"x":0,"y":0,"width":1920,"height":1080,"monitor":0,"minimized":false}` |
| `{"cmd":"start","pid":1234,"pipe":"\\\\.\\pipe\\ratio-audio-1","game":true,"mic":false,"micVolume":0.8}` | `{"event":"listening","pipe":"…"}`, then `{"event":"started"}` once FFmpeg connected, `{"event":"stopped","frames":123}` at the end |
| `{"cmd":"stop"}` | `{"event":"stopped",…}` |
| `{"cmd":"quit"}` (or closing stdin) | the helper exits |

Errors come as `{"event":"error","message":"…"}`.

The stream is driven by the clock: when the game is silent (process loopback delivers nothing
then), silence is written, so the sound never falls behind the picture.

## Build

    npm run build:audio

needs Rust (https://rustup.rs) on Windows and puts `ratio-audio.exe` into `resources/bin/`. The
release workflow does the same on the Windows runner.
