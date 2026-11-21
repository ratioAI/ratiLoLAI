import { describe, expect, it } from 'vitest'
import { acceleratorOf, validAccelerator, type KeyPress } from '../src/shared/hotkey'

const press = (code: string, modifiers: Partial<KeyPress> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...modifiers
})

describe('hotkeys recorded by pressing them', () => {
  it('names the combination the way Electron wants it, modifiers in a fixed order', () => {
    expect(acceleratorOf(press('KeyA', { altKey: true, shiftKey: true }))).toBe('Alt+Shift+A')
    expect(acceleratorOf(press('Digit5', { ctrlKey: true }))).toBe('Ctrl+5')
    expect(acceleratorOf(press('Numpad3', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+num3')
    expect(acceleratorOf(press('ArrowUp', { ctrlKey: true }))).toBe('Ctrl+Up')
  })

  it('takes function keys on their own', () => {
    expect(acceleratorOf(press('F9'))).toBe('F9')
    expect(acceleratorOf(press('F12', { shiftKey: true }))).toBe('Shift+F12')
  })

  it('waits while only modifiers are held', () => {
    expect(acceleratorOf(press('ControlLeft', { ctrlKey: true }))).toBeNull()
    expect(acceleratorOf(press('ShiftRight', { shiftKey: true }))).toBeNull()
  })

  it('never makes a hotkey out of a key you type with', () => {
    expect(acceleratorOf(press('KeyA'))).toBeNull()
    expect(acceleratorOf(press('KeyA', { shiftKey: true }))).toBeNull()
    expect(acceleratorOf(press('Space'))).toBeNull()
  })

  it('every recorded name is a valid one', () => {
    for (const code of ['KeyZ', 'Digit0', 'Numpad9', 'F24', 'Space', 'Minus', 'Backslash', 'NumpadAdd', 'PageDown'])
      expect(validAccelerator(acceleratorOf(press(code, { ctrlKey: true }))!), code).toBe(true)
  })
})

describe('hotkeys typed by hand in older versions', () => {
  it('accepts what globalShortcut accepts', () => {
    for (const name of ['Alt+Shift+A', 'F9', 'Ctrl+F10', 'CommandOrControl+Shift+Z', 'ctrl+alt+num1', 'Ctrl++', 'Alt+PrintScreen'])
      expect(validAccelerator(name), name).toBe(true)
  })

  it('rejects what could never be registered', () => {
    for (const name of ['Strg+F9', 'Ctrl+', 'Ctrl+Shift', 'F25', 'Alt+Shift+AB', 'Umschalt+A', ''])
      expect(validAccelerator(name), name).toBe(false)
  })
})
