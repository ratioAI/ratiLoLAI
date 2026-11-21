/**
 * Turns a key press into the name Electron's globalShortcut understands ("Alt+Shift+A").
 * The settings record hotkeys by pressing them: typed-in names ("Strg+F9") were saved as they
 * were, could not be registered and then simply did nothing in the game.
 */
export interface KeyPress {
  /** KeyboardEvent.code – the physical key, the same on every keyboard layout */
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const NAMED: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  const numpad = /^Numpad(\d)$/.exec(code)
  if (numpad) return `num${numpad[1]}`
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return NAMED[code] ?? null
}

/**
 * The accelerator for a key press, or null while only modifiers are held or the key cannot be a
 * hotkey. Keys you type with (letters, digits, punctuation, Space …) need Ctrl or Alt, so a hotkey
 * can never swallow what you write in the game's chat; function keys work on their own.
 */
export function acceleratorOf(press: KeyPress): string | null {
  const key = keyName(press.code)
  if (!key) return null
  const functionKey = /^F\d+$/.test(key)
  if (!functionKey && !press.ctrlKey && !press.altKey && !press.metaKey) return null
  const parts: string[] = []
  if (press.ctrlKey) parts.push('Ctrl')
  if (press.altKey) parts.push('Alt')
  if (press.shiftKey) parts.push('Shift')
  if (press.metaKey) parts.push('Super')
  parts.push(key)
  return parts.join('+')
}

const MODIFIERS = new Set(['ctrl', 'control', 'alt', 'shift', 'super', 'meta', 'cmd', 'command', 'cmdorctrl', 'commandorcontrol', 'altgr', 'option'])
const KEYS = new Set(
  [
    ...Object.values(NAMED),
    'Plus',
    'Backspace',
    'Delete',
    'Escape',
    'Esc',
    'Return',
    'PrintScreen',
    'CapsLock',
    'NumLock',
    'ScrollLock',
    'MediaPlayPause',
    'MediaNextTrack',
    'MediaPreviousTrack',
    'MediaStop',
    'VolumeUp',
    'VolumeDown',
    'VolumeMute'
  ].map((name) => name.toLowerCase())
)

/** True for a name globalShortcut accepts (also the ones saved by older versions, typed by hand). */
export function validAccelerator(accelerator: string): boolean {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase())
  // "Ctrl++" is the plus key
  if (accelerator.trim().endsWith('++')) parts.splice(-2, 2, 'plus')
  const key = parts.pop()
  if (!key || !parts.every((part) => MODIFIERS.has(part))) return false
  return /^[a-z0-9]$/.test(key) || /^f([1-9]|1\d|2[0-4])$/.test(key) || /^num\d$/.test(key) || KEYS.has(key)
}
