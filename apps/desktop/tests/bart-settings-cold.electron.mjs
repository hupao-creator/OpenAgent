// Manual native performance check: build with pnpm perf:renderer:build first.
// Run alone on a display fitting 1180x780. Every run gets a cold Electron profile;
// no settings warmup, slowed animation, seek, or admission fallback counts as a pass.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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
const { app, BrowserWindow, nativeTheme, nativeImage } = await import('electron')
const output = process.env.BART_COLD_OUTPUT || await mkdtemp(path.join(tmpdir(), 'bart-settings-cold-'))
await mkdir(output, { recursive: true })
app.setPath('userData', await mkdtemp(path.join(tmpdir(), 'bart-settings-profile-')))
const build = path.resolve(process.env.BART_BENCH_ROOT || path.join(desktop, 'out/renderer-benchmark'))
assert.ok(existsSync(path.join(build, 'renderer.html')), 'Run pnpm perf:renderer:build first')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }
const server = createServer((request, response) => {
  const file = path.join(build, path.normalize(decodeURIComponent(new URL(request.url, 'http://localhost').pathname)))
  if (!file.startsWith(build + path.sep) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404).end(); return
  }
  response.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' })
  createReadStream(file).pipe(response)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// In this light-theme fixture Bart is the only large connected dark silhouette
// below the toolbar and to the right of the sidebar. Work after capture finishes.
function locateBart(frame) {
  const { width, height } = frame.size, step = 4, scale = width / 1180
  const columns = Math.ceil(width / step), rows = Math.ceil(height / step)
  const mask = new Uint8Array(columns * rows)
  for (let y = Math.ceil(100 * scale / step); y < rows; y++) {
    for (let x = Math.ceil(220 * scale / step); x < columns; x++) {
      const offset = (y * step * width + x * step) * 4
      mask[y * columns + x] = Math.max(frame.pixels[offset], frame.pixels[offset + 1], frame.pixels[offset + 2]) < 65 ? 1 : 0
    }
  }
  let best
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue
    const stack = [index]
    mask[index] = 0
    let count = 0, left = columns, right = 0, top = rows, bottom = 0
    while (stack.length) {
      const cell = stack.pop(), x = cell % columns, y = Math.floor(cell / columns)
      count++; left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
      for (const next of [x ? cell - 1 : -1, x + 1 < columns ? cell + 1 : -1, cell - columns, cell + columns]) {
        if (next >= 0 && next < mask.length && mask[next]) { mask[next] = 0; stack.push(next) }
      }
    }
    if (count * (step / scale) ** 2 > 1000 && (!best || count > best.count)) {
      best = { count, x: (left + right) * step / scale / 2, y: (top + bottom) * step / scale / 2 }
    }
  }
  return best
}

function assess(frames, flight) {
  assert.ok(flight.ready && !flight.skipped && flight.route, `Cold flight was not admitted: ${JSON.stringify(flight)}`)
  const { route, duration } = flight
  const samples = frames.map(frame => ({ at: frame.at, body: locateBart(frame) }))
  const moving = samples.flatMap(sample => {
    // After landing, roster narrowing moves the native seat back across the
    // same x coordinates. It belongs to a different animation and clock.
    if (!sample.body || sample.at > flight.origin + duration) return []
    const next = route.findIndex((point, index) => index > 0 && point.x <= sample.body.x && route[index - 1].x > sample.body.x)
    if (next < 1) return []
    const a = route[next - 1], b = route[next]
    const phase = a.at + (b.at - a.at) * (a.x - sample.body.x) / (a.x - b.x)
    // The eased endpoint becomes nearly stationary: pixel quantization there
    // cannot resolve time. Measure the moving body through the first 65%.
    if (phase < duration * .08 || phase > duration * .65) return []
    return [{ ...sample, phase, lag: sample.at - phase }]
  })
  assert.ok(moving.length >= 8, `Insufficient native flight samples: ${moving.length}`)
  // Callback time is NOT presentation time. A constant pipeline/IPC delay is
  // irrelevant; a growing delay followed by a catch-up jump is the regression.
  const lagSpread = Math.max(...moving.map(sample => sample.lag)) - Math.min(...moving.map(sample => sample.lag))
  return { samples, moving, lagSpread }
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light'
  const window = new BrowserWindow({ width: 1180, height: 780, useContentSize: true, show: true,
    alwaysOnTop: true, backgroundColor: '#f8f7f4', webPreferences: { backgroundThrottling: false } })
  const contents = window.webContents, results = []
  try {
    await window.loadURL(`http://127.0.0.1:${server.address().port}/renderer.html?mode=overview&harness=codex&threads=1&turns=1`)
    await contents.executeJavaScript('document.fonts.ready.then(() => true)')
    await delay(1800)
    for (let round = 0; round < 3; round++) {
      const frames = [], start = performance.now()
      contents.beginFrameSubscription(false, image => {
        frames.push({ at: performance.now() - start, pixels: image.toBitmap(), size: image.getSize() })
      })
      const flight = await contents.executeJavaScript(`(async () => {
        performance.clearMarks('bart-cross-page-ready'); performance.clearMarks('bart-cross-page-skipped')
        const begin = performance.now(), ticks = []
        let route, duration
        const finished = new Promise(resolve => {
          const sample = now => {
            ticks.push(now - begin)
            if (!route) {
              const canvas = document.querySelector('[data-bart-cross-page-flight]')
              const effect = canvas?.getAnimations()[0]?.effect
              if (effect) {
                duration = Number(effect.getTiming().duration)
                route = effect.getKeyframes().map(key => {
                  const center = new DOMMatrix(key.transform).transformPoint({ x: canvas.offsetWidth / 2, y: canvas.offsetHeight / 2 })
                  return { at: key.computedOffset * duration, x: center.x, y: center.y }
                })
              }
            }
            if (now - begin < 1500) requestAnimationFrame(sample); else resolve()
          }
          requestAnimationFrame(sample)
        })
        document.querySelector('[data-settings-trigger]').click()
        await finished
        const ready = performance.getEntriesByName('bart-cross-page-ready').at(-1)?.detail
        return { route, duration, ticks, origin: ready?.origin - performance.timeOrigin - begin,
          ready,
          skipped: performance.getEntriesByName('bart-cross-page-skipped').at(-1)?.detail }
      })()`)
      contents.endFrameSubscription()
      if (process.env.BART_COLD_SAVE_FRAMES) {
        for (let index = 0; index < frames.length; index++) {
          const frame = frames[index]
          await writeFile(path.join(output, `${round}-${index}.png`), nativeImage.createFromBitmap(frame.pixels, frame.size).toPNG())
        }
      }
      // Preserve admission/route/pixel evidence even when sampling is inadequate.
      await writeFile(path.join(output, `capture-${round}.json`), JSON.stringify({ flight,
        frames: frames.map(frame => ({ at: frame.at, size: frame.size, body: locateBart(frame) })) }, null, 2))
      const result = { round, flight, ...assess(frames, flight) }
      results.push(result)
      await writeFile(path.join(output, 'result.json'), JSON.stringify(results, null, 2))
      assert.ok(result.lagSpread < 60, `Bart pixels fell behind then caught up: ${result.lagSpread.toFixed(1)}ms; ${output}`)
      await contents.executeJavaScript('document.querySelector(".settings-page [aria-label=返回]").click()')
      await delay(1700)
    }
    console.log('BART_SETTINGS_COLD', JSON.stringify({ output, lagSpreadMs: results.map(result => result.lagSpread) }))
  } catch (error) {
    console.error('BART_SETTINGS_COLD_FAILED', output, error)
    process.exitCode = 1
  } finally {
    contents.endFrameSubscription(); window.destroy(); server.close(); app.exit(process.exitCode || 0)
  }
})
