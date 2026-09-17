// Overview → 设置页 Bart 飞行的真实性采样：真实 Electron 窗口、真实渲染器进程。
//
// 目的（issue #206）：把「跳过同值 SVG 属性写入」的收益量出来，并给出同一场景下的
// 帧间隔与飞行采样帧数。计数器在页面里拦 SVGElement.setAttribute，把「拟写入值与
// 元素当前值完全相等」的调用单独计数——那正是优化要省掉的那部分；基线版本每次都会
// 真的写下去，因此该计数就是减少量。拦截本身对两个版本的开销相同。
//
// 用法：node tests/bart-flight-write-cost.electron.mjs [轮数]
// 需要先 pnpm perf:renderer:build。输出一行 BART_WRITE_COST <json>。
import { app, BrowserWindow } from 'electron'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.dirname(testDirectory)
// Two builds can be kept side by side and measured alternately, so a rebuild
// never sits between the numbers being compared.
const benchRoot = process.env.BART_BENCH_ROOT ?? path.join(desktopRoot, 'out/renderer-benchmark')
const rounds = Math.max(1, Number(process.argv[2]) || 1)

if (!existsSync(path.join(benchRoot, 'renderer.html'))) {
  console.error(`benchmark build missing at ${benchRoot}; run pnpm perf:renderer:build first`)
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const requested = path.join(benchRoot, path.normalize(decodeURIComponent(url.pathname)))
  if (!requested.startsWith(benchRoot) || !existsSync(requested) || statSync(requested).isDirectory()) {
    response.writeHead(404).end('not found')
    return
  }
  response.writeHead(200, {
    'content-type': MIME[path.extname(requested)] ?? 'application/octet-stream'
  })
  createReadStream(requested).pipe(response)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

/** 采样器与被计数器：装进页面主世界，优化前后的测量方式完全一致。 */
const INSTRUMENT = `(() => {
  const setAttribute = SVGElement.prototype.setAttribute
  const getAttribute = SVGElement.prototype.getAttribute
  const counters = { svg: 0, svgSameValue: 0, bart: 0, bartSameValue: 0 }
  SVGElement.prototype.setAttribute = function (name, value) {
    const next = String(value)
    const bart = this.closest('.bart-logo') !== null
    counters.svg += 1
    if (bart) counters.bart += 1
    if (getAttribute.call(this, name) === next) {
      counters.svgSameValue += 1
      if (bart) counters.bartSameValue += 1
    }
    return setAttribute.call(this, name, next)
  }
  window.__bartCost = {
    counters,
    reset() {
      counters.svg = 0
      counters.svgSameValue = 0
      counters.bart = 0
      counters.bartSameValue = 0
    },
    async sample(milliseconds) {
      const ticks = []
      let flightFrames = 0
      const sampleStart = performance.now()
      await new Promise((resolve) => {
        const tick = (now) => {
          if (document.querySelector('[data-bart-cross-page-flight]')) flightFrames += 1
          if (now - sampleStart >= milliseconds) { resolve(); return }
          ticks.push(now)
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      const gaps = ticks.slice(1).map((now, index) => now - ticks[index])
      gaps.sort((a, b) => a - b)
      return {
        frames: ticks.length,
        flightFrames,
        intervalP95: gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.95))] : null,
        intervalMax: gaps.length ? gaps[gaps.length - 1] : null
      }
    }
  }
})()`

const OPEN_SETTINGS = `(() => {
  const button = document.querySelector('[data-settings-trigger]')
  if (!button) return false
  button.click()
  return true
})()`

async function measure(contents) {
  await contents.executeJavaScript(INSTRUMENT)
  await contents.executeJavaScript(`window.__bartCost.reset()`)
  const opened = await contents.executeJavaScript(OPEN_SETTINGS)
  if (!opened) throw new Error('the settings button was not on the Overview')
  const sample = await contents.executeJavaScript(`window.__bartCost.sample(1400)`)
  const counters = await contents.executeJavaScript(`window.__bartCost.counters`)
  const settled = await contents.executeJavaScript(`({
    settingsOpen: Boolean(document.querySelector('.settings-page[data-phase=open]')),
    seat: Boolean(document.querySelector('.bart-host-body .bart-logo')),
    blurred: getComputedStyle(document.querySelector('.settings-page')).backdropFilter
  })`)
  return { counters, sample, settled }
}

async function runRound(index) {
  // 窗口不上屏：真实 Electron 渲染进程 + 关闭后台节流，避免窗口可见性影响 rAF 节奏，
  // 也不会在运行者屏幕上弹窗。
  const window = new BrowserWindow({
    width: 1369,
    height: 994,
    show: false,
    webPreferences: { backgroundThrottling: false }
  })
  const url = `${origin}/renderer.html?mode=overview&harness=codex&threads=24&turns=4`
  let loaded = false
  for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300))
    loaded = await window.loadURL(url).then(() => true, () => false)
  }
  if (!loaded) throw new Error(`the benchmark page did not load from ${url}`)
  const contents = window.webContents
  await contents.executeJavaScript(`document.fonts.ready.then(() => true)`)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const result = await measure(contents)
  window.destroy()
  return { round: index, ...result }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  try {
    const results = []
    for (let index = 1; index <= rounds; index += 1) {
      results.push(await runRound(index))
    }
    console.log(`BART_WRITE_COST ${JSON.stringify({ origin, rounds: results })}`)
    app.exit(0)
  } catch (error) {
    console.log(`BART_WRITE_COST ${JSON.stringify({ ok: false, message: String(error?.stack ?? error) })}`)
    app.exit(1)
  }
}).finally(() => server.close())
