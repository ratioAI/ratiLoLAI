/**
 * Screenshots of the web demo for the README (docs/screenshots). Needs the web build and an
 * internet connection (the demo loads champion data and icons from Data Dragon):
 *
 *   npm run build:web
 *   npm run screenshots
 *
 * Runs the built demo in hidden Electron windows, so nothing else has to be installed.
 */
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const out = join(root, 'docs', 'screenshots')
const SHOTS = [
  // the loading-screen panel with one stranger of every kind of encounter
  { file: 'loading-encounters.png', hash: '/overlay/loading?demo', width: 1040, height: 340, wait: 5000 },
  { file: 'achievements.png', hash: '/games/achievements', width: 1320, height: 900, wait: 7000 },
  // every achievement lit, zoomed out a little so several constellations are in view
  { file: 'constellations.png', hash: '/games/map?demo-unlocked', width: 1320, height: 840, wait: 9000, zoom: 4 },
  // Clips (1.3): the library, the editor with text, a sticker, the stats overlay and music, the export dialog
  { file: 'clips-library.png', hash: '/clips', width: 1320, height: 840, wait: 7000 },
  {
    file: 'clips-editor.png',
    hash: '/clips/edit/200',
    width: 1320,
    height: 840,
    wait: 7000,
    run: `(async () => {
      const button = (text) => [...document.querySelectorAll('button')].find((element) => element.textContent.trim().startsWith(text))
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      button('Text').click(); await pause(300)
      button('PENTAKILL').click(); await pause(300)
      button('Stickers').click(); await pause(300)
      document.querySelector('.grid.grid-cols-6 button').click(); await pause(300)
      button('Stats').click(); await pause(300)
      document.querySelector('input[type=checkbox]').click(); await pause(300)
      button('Music').click(); await pause(300)
      button('Nebula').click()
    })()`,
    after: 2500
  },
  {
    file: 'clips-export.png',
    hash: '/clips/edit/199',
    width: 1320,
    height: 840,
    wait: 7000,
    run: `[...document.querySelectorAll('button')].find((element) => element.textContent.trim() === 'Export').click()`,
    after: 1500
  }
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function shoot(shot) {
  const win = new BrowserWindow({
    width: shot.width,
    height: shot.height,
    // the Clips shots click through the page first; a hidden window does not always repaint after that
    show: !!shot.run,
    useContentSize: true,
    backgroundColor: '#07050f',
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false }
  })
  // the demo's own router can cut the first load short; the page is there all the same
  await win.loadFile(join(root, 'dist-web', 'index.html'), { hash: shot.hash }).catch(() => undefined)
  await sleep(shot.wait)
  if (shot.zoom) {
    await win.webContents.executeJavaScript(`(async () => {
      const canvas = document.querySelector('canvas.cursor-grab')
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      for (let i = 0; i < ${shot.zoom}; i++) {
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, bubbles: true, cancelable: true }))
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    })()`)
    await sleep(2500)
  }
  // a few clicks before the picture is taken (the Clips editor and its export dialog)
  if (shot.run) {
    await win.webContents.executeJavaScript(shot.run).catch((error) => console.error(shot.file, error))
    await sleep(shot.after ?? 1500)
  }
  const image = await win.webContents.capturePage()
  writeFileSync(join(out, shot.file), image.toPNG())
  console.log(`docs/screenshots/${shot.file}`)
  win.destroy()
}

// one window after the other: closing the last one must not end the app
app.on('window-all-closed', () => undefined)

app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true })
  try {
    for (const shot of SHOTS) await shoot(shot)
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
  app.quit()
})
