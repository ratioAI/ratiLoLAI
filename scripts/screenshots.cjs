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
  { file: 'constellations.png', hash: '/games/map?demo-unlocked', width: 1320, height: 840, wait: 9000, zoom: 4 }
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function shoot(shot) {
  const win = new BrowserWindow({
    width: shot.width,
    height: shot.height,
    show: false,
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
