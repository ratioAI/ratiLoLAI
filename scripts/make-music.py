#!/usr/bin/env python3
"""
Makes the three built-in music loops of the Clips editor (src/renderer/public/music).

Everything is synthesized here from sine, saw and noise generators: there are no samples and no
borrowed melodies, so the result can be given away freely. The loops are dedicated to the public
domain (CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/).

    python3 scripts/make-music.py        # needs numpy and ffmpeg

Each loop is a whole number of bars and its tails wrap around, so it repeats without a click.
"""
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 44100
OUT = Path(__file__).resolve().parent.parent / "src" / "renderer" / "public" / "music"
NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def freq(name: str) -> float:
    """'A3' -> 220.0"""
    semitone = NOTE[name[0]] + (1 if "#" in name else 0) + 12 * (int(name[-1]) - 4) - 9
    return 440.0 * 2 ** (semitone / 12)


def env(length: int, attack: float, release: float) -> np.ndarray:
    out = np.ones(length)
    a = max(1, int(attack * RATE))
    r = max(1, int(release * RATE))
    out[:a] = np.linspace(0, 1, a)
    out[-r:] *= np.linspace(1, 0, r)
    return out


def saw(f: float, seconds: float, detune: float = 0.0) -> np.ndarray:
    t = np.arange(int(seconds * RATE)) / RATE
    # a few harmonics instead of a raw saw: softer, no aliasing
    return sum(np.sin(2 * np.pi * (f * (1 + detune)) * k * t) / k for k in range(1, 9)) * 0.5


def sine(f: float, seconds: float) -> np.ndarray:
    return np.sin(2 * np.pi * f * np.arange(int(seconds * RATE)) / RATE)


def kick(seconds: float = 0.28) -> np.ndarray:
    t = np.arange(int(seconds * RATE)) / RATE
    return np.sin(2 * np.pi * (45 + 90 * np.exp(-t * 28)) * t) * np.exp(-t * 11)


def hat(rng: np.random.Generator, seconds: float = 0.05) -> np.ndarray:
    n = int(seconds * RATE)
    noise = rng.standard_normal(n)
    return (noise - np.concatenate(([0], noise[:-1]))) * np.exp(-np.arange(n) / RATE * 70) * 0.5


def clap(rng: np.random.Generator, seconds: float = 0.16) -> np.ndarray:
    n = int(seconds * RATE)
    return rng.standard_normal(n) * np.exp(-np.arange(n) / RATE * 26) * 0.6


class Loop:
    def __init__(self, bpm: float, bars: int):
        self.beat = 60.0 / bpm
        self.length = int(round(bars * 4 * self.beat * RATE))
        self.left = np.zeros(self.length)
        self.right = np.zeros(self.length)

    def add(self, sound: np.ndarray, at_beat: float, gain: float = 1.0, pan: float = 0.0) -> None:
        start = int(round(at_beat * self.beat * RATE)) % self.length
        index = (start + np.arange(len(sound))) % self.length  # tails wrap to the beginning
        np.add.at(self.left, index, sound * gain * (1 - max(0.0, pan)))
        np.add.at(self.right, index, sound * gain * (1 + min(0.0, pan)))

    def write(self, name: str) -> None:
        mix = np.stack([self.left, self.right], axis=1)
        mix = np.tanh(mix / (np.abs(mix).max() + 1e-9) * 1.4) * 0.82
        OUT.mkdir(parents=True, exist_ok=True)
        wav = OUT / f"{name}.wav"
        with wave.open(str(wav), "wb") as handle:
            handle.setnchannels(2)
            handle.setsampwidth(2)
            handle.setframerate(RATE)
            handle.writeframes((mix * 32767).astype("<i2").tobytes())
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), "-c:a", "aac", "-b:a", "96k", str(OUT / f"{name}.m4a")],
            check=True,
        )
        wav.unlink()
        print(f"{name}.m4a  {self.length / RATE:.1f} s")


def chord_notes(root: str, minor: bool, octave: int) -> list[float]:
    base = freq(f"{root}{octave}")
    return [base, base * 2 ** ((3 if minor else 4) / 12), base * 2 ** (7 / 12)]


def nebula_drift() -> None:
    """Slow and wide: pads and a falling arpeggio. 80 BPM, 8 bars, A minor."""
    loop = Loop(80, 8)
    chords = [("A", True), ("F", False), ("C", False), ("G", False)]
    for bar in range(8):
        root, minor = chords[bar % 4]
        notes = chord_notes(root, minor, 3)
        for i, f in enumerate(notes):
            tone = (saw(f, 4 * loop.beat, 0.004) + saw(f, 4 * loop.beat, -0.004)) * env(int(4 * loop.beat * RATE), 0.6, 1.2)
            loop.add(tone, bar * 4, 0.10, pan=(i - 1) * 0.5)
        loop.add(sine(notes[0] / 2, 3.6 * loop.beat) * env(int(3.6 * loop.beat * RATE), 0.05, 0.6), bar * 4, 0.42)
        for step in range(8):
            f = notes[[2, 1, 0, 1][step % 4]] * 2
            pluck = sine(f, 0.5) * np.exp(-np.arange(int(0.5 * RATE)) / RATE * 6)
            loop.add(pluck, bar * 4 + step * 0.5, 0.16, pan=0.6 if step % 2 else -0.6)
        loop.add(kick(), bar * 4, 0.5)
        loop.add(kick(), bar * 4 + 2.5, 0.32)
    loop.write("nebula-drift")


def pentakill_rush() -> None:
    """Fast and driving: bass eighths, sixteenth arpeggio, four on the floor. 140 BPM, 16 bars, E minor."""
    rng = np.random.default_rng(5)
    loop = Loop(140, 16)
    chords = [("E", True), ("C", False), ("G", False), ("D", False)]
    for bar in range(16):
        root, minor = chords[(bar // 2) % 4]
        notes = chord_notes(root, minor, 3)
        for step in range(8):
            bass = saw(notes[0] / 2, 0.2) * env(int(0.2 * RATE), 0.005, 0.08)
            loop.add(bass, bar * 4 + step * 0.5, 0.36)
        for step in range(16):
            f = notes[[0, 1, 2, 1, 2, 0, 1, 2][step % 8]] * (4 if step % 8 > 4 else 2)
            pluck = saw(f, 0.14) * np.exp(-np.arange(int(0.14 * RATE)) / RATE * 22)
            loop.add(pluck, bar * 4 + step * 0.25, 0.12, pan=0.5 if step % 2 else -0.5)
        for beat in range(4):
            loop.add(kick(0.22), bar * 4 + beat, 0.62)
            loop.add(hat(rng), bar * 4 + beat + 0.5, 0.3, pan=0.2)
        loop.add(clap(rng), bar * 4 + 1, 0.3)
        loop.add(clap(rng), bar * 4 + 3, 0.3)
    loop.write("pentakill-rush")


def victory_lap() -> None:
    """Bright and bouncy: plucked major arpeggio with claps. 110 BPM, 8 bars, C major."""
    rng = np.random.default_rng(11)
    loop = Loop(110, 8)
    chords = [("C", False), ("G", False), ("A", True), ("F", False)]
    for bar in range(8):
        root, minor = chords[bar % 4]
        notes = chord_notes(root, minor, 4)
        for step in range(8):
            f = notes[[0, 2, 1, 2, 0, 2, 1, 0][step]] * (2 if step in (3, 5) else 1)
            pluck = (sine(f, 0.4) + 0.4 * sine(f * 2, 0.4)) * np.exp(-np.arange(int(0.4 * RATE)) / RATE * 8)
            loop.add(pluck, bar * 4 + step * 0.5, 0.22, pan=0.4 if step % 2 else -0.4)
        bass_env = env(int(1.6 * loop.beat * RATE), 0.01, 0.3)
        loop.add(sine(notes[0] / 4, 1.6 * loop.beat) * bass_env, bar * 4, 0.45)
        loop.add(sine(notes[0] / 4, 1.6 * loop.beat) * bass_env, bar * 4 + 2, 0.45)
        for beat in range(4):
            loop.add(kick(0.24), bar * 4 + beat, 0.5 if beat % 2 == 0 else 0.3)
            loop.add(hat(rng), bar * 4 + beat + 0.5, 0.26)
        loop.add(clap(rng), bar * 4 + 1, 0.34)
        loop.add(clap(rng), bar * 4 + 3, 0.34)
    loop.write("victory-lap")


if __name__ == "__main__":
    nebula_drift()
    pentakill_rush()
    victory_lap()
    sys.exit(0)
