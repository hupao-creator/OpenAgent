// Scratch probe: does a plain Electron window on this machine receive
// compositor frames? Measures main-thread rAF, worker rAF and a Web Animations
// `finished` promise while the window is visible and while it is minimized.
// Set FRAME_PROBE_DISABLE_OCCLUSION=1 to also run with Chromium's native
// window-occlusion calculation disabled.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  const result = spawnSync(electron, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
  })
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = await import('electron')

if (process.env.FRAME_PROBE_DISABLE_OCCLUSION === '1') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

const onRaf = `new Promise(resolve => {
  let ticks = 0
  const start = performance.now()
  const tick = () => { ticks++; performance.now() - start < 2000 ? requestAnimationFrame(tick) : resolve(ticks) }
  requestAnimationFrame(tick)
  setTimeout(() => resolve(ticks), 4000)
})`
const inWorker = `new Promise(resolve => {
  const src = 'let n = 0; const start = performance.now(); const tick = () => { n++; performance.now() - start < 2000 ? requestAnimationFrame(tick) : postMessage(n) }; requestAnimationFrame(tick); setTimeout(() => postMessage(n), 4000)'
  const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
  worker.onmessage = event => resolve(event.data)
})`
const animation = `new Promise(resolve => {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const running = element.animate([{ opacity: 0 }, { opacity: 1 }], 500)
  const timer = setTimeout(() => resolve('timeout'), 4000)
  running.finished.then(() => { clearTimeout(timer); resolve('finished') }, () => { clearTimeout(timer); resolve('failed') })
})`

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 800, height: 600, show: true, alwaysOnTop: true })
  await window.loadURL('data:text/html,<title>frame probe</title><h1>probe</h1>')
  const contents = window.webContents
  const measure = async label => {
    const value = await contents.executeJavaScript(`(async () => ({
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      raf: await ${onRaf},
      workerRaf: await ${inWorker},
      animation: await ${animation}
    }))()`)
    console.log('FRAME_PROBE', label, JSON.stringify(value))
  }
  console.log('FRAME_PROBE_ENV', JSON.stringify({
    occlusionDisabled: process.env.FRAME_PROBE_DISABLE_OCCLUSION === '1',
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome
  }))
  await measure('visible')
  window.minimize()
  await new Promise(resolve => setTimeout(resolve, 1000))
  await measure('minimized')
  const pump = setInterval(() => { contents.capturePage().catch(() => undefined) }, 40)
  await measure('minimized+pump')
  clearInterval(pump)
  console.log('FRAME_PROBE_DONE')
  window.destroy()
  app.exit(0)
})
