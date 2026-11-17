/**
 * Builds the sound helper of Clips (native/audio, Rust) and puts ratio-audio.exe into
 * resources/bin, where the app looks for it and from where it goes into the installer.
 * Needs Rust on Windows: https://rustup.rs
 *
 *   npm run build:audio
 */
const { spawnSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
if (process.platform !== 'win32') {
  console.error('ratio-audio only builds on Windows (WASAPI process loopback).')
  process.exit(1)
}
const built = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(root, 'native', 'audio', 'Cargo.toml')], {
  stdio: 'inherit',
  shell: true
})
if (built.status !== 0) process.exit(built.status ?? 1)
const exe = join(root, 'native', 'audio', 'target', 'release', 'ratio-audio.exe')
if (!existsSync(exe)) {
  console.error(`not found: ${exe}`)
  process.exit(1)
}
mkdirSync(join(root, 'resources', 'bin'), { recursive: true })
copyFileSync(exe, join(root, 'resources', 'bin', 'ratio-audio.exe'))
console.log('resources/bin/ratio-audio.exe')
