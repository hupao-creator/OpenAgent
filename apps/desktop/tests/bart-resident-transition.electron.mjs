// Real Dock and Worker: native pixels must keep changing while the Host is busy.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  const result = spawnSync(electron, [fileURLToPath(import.meta.url)], {
    cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: 'inherit'
  })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, nativeTheme } = await import('electron')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const output = await mkdtemp(path.join(tmpdir(), 'bart-resident-transitions-'))
app.whenReady().then(async () => {
const root = path.join(desktop, 'out/bart-lab')
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream' }).end(body) }
  catch { response.writeHead(404).end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
nativeTheme.themeSource = 'light'
const window = new BrowserWindow({ width: 1180, height: 780, useContentSize: true, show: true, alwaysOnTop: true,
  webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true } })
window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
const contents = window.webContents
const errors = []
contents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
const run = code => contents.executeJavaScript(code)
const doc = 'document.querySelector("iframe").contentDocument'
const status = () => run(`(() => { const d = ${doc}, logo = d?.querySelector('.bart-logo'); return {
  role: logo?.dataset.role, worker: logo?.dataset.residentReady,
  reply: Boolean(d?.querySelector('.bart-reply-target')), visible: d?.visibilityState,
  fallback: d?.querySelector('.bart-role-stage:not(.bart-reply-stage)') ? getComputedStyle(d.querySelector('.bart-role-stage:not(.bart-reply-stage)')).visibility : null
} })()`)
const wait = async (read, accepts, timeout = 12000) => {
  const deadline = performance.now() + timeout
  let value
  while (performance.now() < deadline) { value = await read(); if (accepts(value)) return value; await delay(10) }
  throw new Error(`Timed out: ${JSON.stringify(value)}`)
}
const choose = name => run(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(name)}).click()`)
try {
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`)
  window.show(); window.focus()
  await wait(status, value => value.worker === 'true')
  await choose('运行中')
  await wait(status, value => value.role === 'running')
  await delay(700)
  await choose('思考 · 混合')
  await wait(status, value => value.role === 'reasoning')
  const frames = []
  const started = performance.now()
  contents.beginFrameSubscription(false, image => {
    // The middle of the workbench contains Bart and the external widgets;
    // inspector controls and DOM status indicators are outside this region.
    const size = image.getSize(), sx = size.width / 1180, sy = size.height / 780
    const crop = image.crop({ x: Math.round(190 * sx), y: Math.round(230 * sy), width: Math.round(570 * sx), height: Math.round(330 * sy) })
    frames.push({ at: performance.now() - started, hash: createHash('sha256').update(crop.toBitmap()).digest('hex') })
  })
  // Admission happened above; all ensuing frames belong to the Worker.
  await run('(() => { const end = performance.now() + 850; while (performance.now() < end) {} })()')
  contents.endFrameSubscription()
  const active = frames.filter(frame => frame.at > 35 && frame.at < 520)
  assert.ok(new Set(active.map(frame => frame.hash)).size >= 8, `Handoff froze during Host block: ${JSON.stringify(frames)}`)
  assert.equal((await status()).fallback, 'hidden')
  await writeFile(path.join(output, 'reasoning.png'), (await contents.capturePage()).toPNG())
  await choose('长工具名')
  await wait(status, value => value.role === 'tool')
  await delay(650)
  await writeFile(path.join(output, 'tool.png'), (await contents.capturePage()).toPNG())
  await choose('最终答复')
  await wait(status, value => value.reply)
  await delay(650)
  await writeFile(path.join(output, 'reply.png'), (await contents.capturePage()).toPNG())
  const badge = await run(`(() => { const d = ${doc}, button = d.querySelector('.bart-reply-target'); return {
    background: getComputedStyle(button).backgroundColor, count: getComputedStyle(button.querySelector('.bart-reply-count')).visibility,
    label: button.getAttribute('aria-label') } })()`)
  assert.equal(badge.background, 'rgba(0, 0, 0, 0)')
  assert.equal(badge.count, 'hidden')
  assert.equal(badge.label, '打开 Bart 的最新答复')
  await run(`${doc}.querySelector('.bart-reply-target').click()`)
  await wait(() => run("document.body.textContent.includes('答复定位')"), Boolean)
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ frames, badge, errors }, null, 2))
  console.log('BART_RESIDENT_TRANSITIONS', JSON.stringify({ output, changingFrames: new Set(active.map(frame => frame.hash)).size }))
} catch (error) {
  console.error(error)
  console.error('BART_RESIDENT_TRANSITIONS_OUTPUT', output)
  process.exitCode = 1
} finally { window.destroy(); server.close(); app.exit(process.exitCode ?? 0) }

})
