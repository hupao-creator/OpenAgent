// Scratch diagnostic: reproduce the bart-generation-visuals timeout with more
// reporting — renderer console, layout-error banner, and a status timeline.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  const result = spawnSync(electron, [...(process.env.DIAG_SWITCHES?.split(' ').filter(Boolean) ?? []), fileURLToPath(import.meta.url)], {
    cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: 'inherit'
  })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, nativeTheme } = await import('electron')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  const window = new BrowserWindow({ width: 1180, height: 780, useContentSize: true, show: true,
    alwaysOnTop: true,
    backgroundColor: '#41454b', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const contents = window.webContents
  contents.on('console-message', (event, level, message) =>
    console.log('DIAG_CONSOLE', level ?? event.level, message ?? event.message))
  contents.on('render-process-gone', (_event, details) => console.log('DIAG_GONE', JSON.stringify(details)))
  contents.on('preload-error', (_event, file, error) => console.log('DIAG_PRELOAD', file, String(error)))
  try {
    await window.loadFile(path.join(desktop, 'out/bart-lab/isolation.html'), { search: '?overview-regressions' })
    await contents.executeJavaScript(`(() => {
      window.__diag = []
      addEventListener('error', event => window.__diag.push('error: ' + (event.error?.stack || event.message)))
      addEventListener('unhandledrejection', event => window.__diag.push('rejection: ' + String(event.reason?.stack || event.reason)))
    })()`)
    for (let index = 0; index < 500; index += 1) {
      if (await contents.executeJavaScript('Boolean(window.bartOverview && document.querySelector(".bart-logo[data-worker-ready]"))')) break
      await delay(8)
    }
    console.log('DIAG_READY', await contents.executeJavaScript('Boolean(window.bartOverview)'))
    console.log('DIAG_REQUESTED_ANIMATIONS', await contents.executeJavaScript(
      'document.getAnimations().length'))
    await contents.executeJavaScript('window.bartOverview.create()')
    const started = performance.now()
    const snapshots = []
    while (performance.now() - started < 15000) {
      const snapshot = await contents.executeJavaScript(`(() => {
        const status = window.bartOverview.status()
        return { ready: status.ready, skipped: status.skipped, busy: status.busy, sealed: status.sealed,
          works: status.works, cards: status.cards.length,
          animations: document.getAnimations().length,
          alert: document.querySelector('.overview-layout-error')?.textContent ?? null,
          diag: window.__diag }
      })()`)
      snapshots.push({ at: Math.round(performance.now() - started), ...snapshot })
      if (snapshot.ready || snapshot.skipped) break
      await delay(250)
    }
    const last = snapshots.at(-1)
    console.log('DIAG_TIMELINE', JSON.stringify(snapshots.map(({ at, ready, skipped, busy, works, animations, alert: hasAlert }) =>
      ({ at, ready: Boolean(ready), skipped: Boolean(skipped), busy, works, animations, hasAlert: Boolean(hasAlert) }))))
    console.log('DIAG_FINAL', JSON.stringify(last))
    console.log('DIAG_DIAG', JSON.stringify(last.diag))
    console.log('DIAG_ENV', JSON.stringify(await contents.executeJavaScript(`({
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      scheme: matchMedia('(prefers-color-scheme: dark)').matches,
      worker: typeof Worker !== 'undefined',
      offscreen: typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function',
      visibility: document.visibilityState, hidden: document.hidden, focused: document.hasFocus()
    })`)))
    console.log('DIAG_DONE')
    window.destroy(); app.exit(0)
  } catch (error) {
    console.log('DIAG_FAILED', String(error))
    window.destroy(); app.exit(1)
  }
})
