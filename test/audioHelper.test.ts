import { describe, expect, it } from 'vitest'
import { AudioHelper } from '../src/main/recorder/helper'

/** An AudioHelper whose commands are caught instead of going to ratio-audio.exe; it answers "listening". */
function fakeHelper() {
  const helper = new AudioHelper('/no/ratio-audio.exe', () => undefined)
  const sent: Record<string, unknown>[] = []
  const inner = helper as unknown as { send(command: Record<string, unknown>): boolean; onData(chunk: string): void }
  inner.send = (command) => {
    sent.push(command)
    setImmediate(() => inner.onData(JSON.stringify({ event: 'listening', pipe: command.pipe }) + '\n'))
    return true
  }
  return { helper, sent }
}

describe('AudioHelper', () => {
  it('records everything the PC plays but ratioAI itself: the helper gets ratioAI’s process id to leave out', async () => {
    const { helper, sent } = fakeHelper()
    const pipe = await helper.start({ pid: 77, source: 'all', game: true, mic: false, micVolume: 0.8 })
    expect(pipe).toMatch(/^\\\\\.\\pipe\\ratio-audio-/)
    expect(sent).toEqual([{ cmd: 'start', pipe, source: 'all', pid: process.pid, game: true, mic: false, micVolume: 0.8 }])
  })

  it('records only the game process when asked to', async () => {
    const { helper, sent } = fakeHelper()
    await helper.start({ pid: 77, source: 'game', game: true, mic: true, micVolume: 0.5 })
    expect(sent[0]).toMatchObject({ cmd: 'start', source: 'game', pid: 77, mic: true, micVolume: 0.5 })
  })
})
