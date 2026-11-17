/**
 * The hype announcer's sounds, made on the spot with WebAudio: no recordings, no licences, a few
 * kilobytes of code, and they fit the app's psychedelic style. Your own file in the sounds folder
 * (userData/sounds/<trigger>.mp3|wav|ogg) replaces the built-in sound of that trigger. A short line
 * from the system's offline voice (speechSynthesis) can follow.
 */
import { voiceLine, type Announcement, type Trigger } from '@shared/announcer'
import { api } from './api'

type Sound = (ctx: AudioContext, out: AudioNode, t: number) => number

let context: AudioContext | null = null
let master: GainNode | null = null
let reverb: ConvolverNode | null = null

/** A decaying noise burst as the impulse response: a big, soft hall. */
function hall(ctx: AudioContext, seconds = 2.6): AudioBuffer {
  const length = Math.round(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.2)
  }
  return buffer
}

/** Sets up the audio graph (call once at start, so the first sound in a game plays without delay). */
export function prepareAudio(): AudioContext | null {
  if (context) return context
  try {
    context = new AudioContext({ latencyHint: 'interactive' })
  } catch {
    return null
  }
  master = context.createGain()
  master.gain.value = 0.6
  master.connect(context.destination)
  reverb = context.createConvolver()
  reverb.buffer = hall(context)
  const wet = context.createGain()
  wet.gain.value = 0.35
  reverb.connect(wet).connect(master)
  return context
}

const midi = (note: number): number => 440 * Math.pow(2, (note - 69) / 12)

/** A gain envelope: attack to `peak`, hold, exponential release. */
function envelope(ctx: AudioContext, t: number, attack: number, hold: number, release: number, peak: number): GainNode {
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(peak, t + attack)
  gain.gain.setValueAtTime(peak, t + attack + hold)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release)
  return gain
}

/** Sends a node to the dry output and the hall. */
function wire(node: AudioNode, out: AudioNode, wet = true): void {
  node.connect(out)
  if (wet && reverb) node.connect(reverb)
}

/** Organ voice: a few sine partials, like drawbars. */
function organ(ctx: AudioContext, out: AudioNode, note: number, t: number, length: number, peak = 0.12): void {
  const env = envelope(ctx, t, 0.08, length, 0.9, peak)
  wire(env, out)
  for (const [ratio, level] of [
    [1, 1],
    [2, 0.5],
    [3, 0.3],
    [4, 0.22],
    [0.5, 0.4]
  ]) {
    const osc = ctx.createOscillator()
    osc.frequency.value = midi(note) * ratio
    const partial = ctx.createGain()
    partial.gain.value = level
    osc.connect(partial).connect(env)
    osc.start(t)
    osc.stop(t + length + 1.2)
  }
}

/** Brassy synth: detuned saws through a filter that opens with the note. */
function brass(ctx: AudioContext, out: AudioNode, note: number, t: number, length: number, peak = 0.09): void {
  const env = envelope(ctx, t, 0.03, length, 0.35, peak)
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.Q.value = 3
  filter.frequency.setValueAtTime(400, t)
  filter.frequency.exponentialRampToValueAtTime(3200, t + 0.12)
  filter.frequency.exponentialRampToValueAtTime(1400, t + length + 0.3)
  filter.connect(env)
  wire(env, out)
  for (const detune of [-9, 0, 8]) {
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.value = midi(note)
    osc.detune.value = detune
    osc.connect(filter)
    osc.start(t)
    osc.stop(t + length + 0.5)
  }
}

/** Short bright blip. */
function blip(ctx: AudioContext, out: AudioNode, note: number, t: number, peak = 0.1): void {
  const env = envelope(ctx, t, 0.005, 0.05, 0.25, peak)
  wire(env, out)
  const osc = ctx.createOscillator()
  osc.type = 'triangle'
  osc.frequency.value = midi(note)
  osc.connect(env)
  osc.start(t)
  osc.stop(t + 0.4)
}

/** Ascending organ crescendo for a pentakill, `root` shifts the key (premade pentas sound different). */
const pentaSound =
  (root: number): Sound =>
  (ctx, out, t) => {
    const steps = [0, 4, 7, 12, 16, 19, 24]
    steps.forEach((step, i) => organ(ctx, out, root + step, t + i * 0.22, 2.2 - i * 0.22, 0.05 + i * 0.012))
    // the final chord swells in
    for (const step of [0, 7, 12, 16, 24]) organ(ctx, out, root + step, t + 1.55, 1.3, 0.06)
    for (let i = 0; i < 8; i++) blip(ctx, out, root + 36 + ((i * 5) % 12), t + 1.6 + i * 0.07, 0.03)
    return 4
  }

const SOUNDS: Record<Trigger, Sound> = {
  myPenta: pentaSound(48),
  premadePenta: pentaSound(53),
  myQuadra: (ctx, out, t) => {
    ;[0, 4, 7, 12].forEach((step, i) => organ(ctx, out, 55 + step, t + i * 0.18, 1.2 - i * 0.15, 0.07))
    return 2.2
  },
  myTriple: (ctx, out, t) => {
    ;[67, 71, 74].forEach((note, i) => blip(ctx, out, note, t + i * 0.11, 0.12))
    return 0.8
  },
  allyAce: (ctx, out, t) => {
    // fanfare: G C E G, the last one held
    ;[
      [55, 0, 0.12],
      [60, 0.14, 0.12],
      [64, 0.28, 0.12],
      [67, 0.42, 0.9]
    ].forEach(([note, at, length]) => brass(ctx, out, note, t + at, length))
    brass(ctx, out, 48, t + 0.42, 0.9, 0.05)
    return 1.9
  },
  enemyAce: (ctx, out, t) => {
    ;[
      [67, 0, 0.18],
      [63, 0.2, 0.18],
      [60, 0.4, 0.18],
      [55, 0.6, 0.8]
    ].forEach(([note, at, length]) => brass(ctx, out, note, t + at, length, 0.07))
    return 1.8
  },
  myFirstBlood: (ctx, out, t) => {
    // gong: inharmonic partials, a slight downward bend, a long tail
    for (const [ratio, level, decay] of [
      [1, 1, 3.5],
      [2.76, 0.5, 2.2],
      [5.4, 0.3, 1.4],
      [8.93, 0.18, 0.9]
    ]) {
      const env = envelope(ctx, t, 0.01, 0.02, decay, 0.16 * level)
      wire(env, out)
      const osc = ctx.createOscillator()
      osc.frequency.setValueAtTime(72 * ratio * 1.02, t)
      osc.frequency.exponentialRampToValueAtTime(72 * ratio, t + 0.6)
      osc.connect(env)
      osc.start(t)
      osc.stop(t + decay + 0.2)
    }
    return 3.6
  },
  myDeathMilestone: (ctx, out, t) => {
    // sad trombone: three wahs bending down, the last one long with vibrato
    const notes: [number, number, number][] = [
      [58, 0, 0.32],
      [57, 0.42, 0.32],
      [56, 0.84, 0.32],
      [55, 1.26, 1.1]
    ]
    for (const [note, at, length] of notes) {
      const start = t + at
      const env = envelope(ctx, start, 0.04, length, 0.2, 0.11)
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.Q.value = 6
      // the "wah": the filter opens and closes with the note
      filter.frequency.setValueAtTime(300, start)
      filter.frequency.linearRampToValueAtTime(1500, start + 0.12)
      filter.frequency.linearRampToValueAtTime(500, start + length)
      filter.connect(env)
      wire(env, out, false)
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(midi(note) * 1.03, start)
      osc.frequency.linearRampToValueAtTime(midi(note) * 0.97, start + length)
      if (length > 1) {
        const lfo = ctx.createOscillator()
        lfo.frequency.value = 6
        const depth = ctx.createGain()
        depth.gain.value = 9
        lfo.connect(depth).connect(osc.frequency)
        lfo.start(start + 0.25)
        lfo.stop(start + length + 0.3)
      }
      osc.connect(filter)
      osc.start(start)
      osc.stop(start + length + 0.3)
    }
    return 2.7
  },
  deathStreak: (ctx, out, t) => {
    // slide whistle down, then a soft bonk
    const env = envelope(ctx, t, 0.02, 0.5, 0.15, 0.08)
    wire(env, out)
    const osc = ctx.createOscillator()
    osc.frequency.setValueAtTime(1400, t)
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.65)
    osc.connect(env)
    osc.start(t)
    osc.stop(t + 0.8)
    const bonk = envelope(ctx, t + 0.68, 0.003, 0.02, 0.3, 0.2)
    wire(bonk, out, false)
    const low = ctx.createOscillator()
    low.frequency.setValueAtTime(160, t + 0.68)
    low.frequency.exponentialRampToValueAtTime(60, t + 0.95)
    low.connect(bonk)
    low.start(t + 0.68)
    low.stop(t + 1.1)
    return 1.2
  },
  victory: (ctx, out, t) => {
    ;[
      [60, 0, 0.14],
      [64, 0.15, 0.14],
      [67, 0.3, 0.14],
      [72, 0.45, 0.8]
    ].forEach(([note, at, length]) => brass(ctx, out, note, t + at, length, 0.08))
    for (const step of [0, 4, 7]) organ(ctx, out, 60 + step, t + 0.45, 0.9, 0.04)
    return 1.9
  },
  defeat: (ctx, out, t) => {
    ;[
      [64, 0, 0.3],
      [62, 0.32, 0.3],
      [60, 0.64, 0.3],
      [59, 0.96, 0.9]
    ].forEach(([note, at, length]) => organ(ctx, out, note, t + at, length, 0.07))
    return 2.2
  }
}

/** Your own sounds, decoded once per trigger (null: there is none, use the built-in one). */
const custom = new Map<Trigger, AudioBuffer | null>()

/** Forgets the decoded custom sounds (after you changed the sounds folder). */
export function reloadCustomSounds(): void {
  custom.clear()
}

async function customBuffer(ctx: AudioContext, trigger: Trigger): Promise<AudioBuffer | null> {
  if (custom.has(trigger)) return custom.get(trigger) ?? null
  let buffer: AudioBuffer | null = null
  try {
    const file = await api.getAnnouncerSound(trigger)
    if (file) buffer = await ctx.decodeAudioData(file.data.slice().buffer as ArrayBuffer)
  } catch {
    buffer = null
  }
  custom.set(trigger, buffer)
  return buffer
}

/** The system's offline English voice, if there is one. */
function speak(text: string, volume: number, delayMs: number): void {
  if (typeof speechSynthesis === 'undefined') return
  const voices = speechSynthesis.getVoices().filter((voice) => voice.lang.toLowerCase().startsWith('en'))
  const voice = voices.find((candidate) => candidate.localService) ?? voices[0]
  const utterance = new SpeechSynthesisUtterance(text)
  if (voice) utterance.voice = voice
  utterance.lang = voice?.lang ?? 'en-US'
  utterance.volume = Math.max(0, Math.min(1, volume))
  utterance.rate = 1.05
  utterance.pitch = 0.9
  setTimeout(() => {
    speechSynthesis.cancel()
    speechSynthesis.speak(utterance)
  }, delayMs)
}

/** Plays an announcement: your own sound or the built-in one, then (optionally) the spoken line. */
export async function playAnnouncement(announcement: Announcement, options: { volume: number; voice: boolean }): Promise<void> {
  const ctx = prepareAudio()
  if (!ctx || !master) return
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
  master.gain.setValueAtTime(Math.max(0, Math.min(1, options.volume)), ctx.currentTime)
  const t = ctx.currentTime + 0.03
  const own = await customBuffer(ctx, announcement.trigger)
  let seconds: number
  if (own) {
    const source = ctx.createBufferSource()
    source.buffer = own
    source.connect(master)
    source.start(t)
    seconds = own.duration
  } else {
    seconds = SOUNDS[announcement.trigger](ctx, master, t)
  }
  // the line comes in while the sound fades out (your own clips probably have their own voice)
  if (options.voice && !own) speak(voiceLine(announcement, announcement.time), options.volume, Math.max(300, (seconds - 1.2) * 1000))
}
