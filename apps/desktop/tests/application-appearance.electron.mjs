// Real production window, durable settings IPC, cold starts and window reopen.
// Native agent traffic uses the existing deterministic Codex fixture. No model calls.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { _electron } = require('playwright')
const tests = dirname(fileURLToPath(import.meta.url))
const main = resolve(tests, '../out/main/index.js')
const configuredRoot = process.env.OPENAGENT_APPEARANCE_EVIDENCE_ROOT
if (configuredRoot) await mkdir(configuredRoot) // Refuse to reuse a consumed evidence root.
const root = await mkdtemp(join(configuredRoot || tmpdir(), 'oa-appearance-'))
for (const name of ['home', 'user-data', 'bin']) await mkdir(join(root, name))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const shell = join(root, 'bin/shell')
await writeFile(shell, '#!/bin/sh\nexec /usr/bin/env -0\n', { mode: 0o700 })
const codex = join(root, 'bin/codex')
await writeFile(codex, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(join(tests, 'fixtures/fake-codex-app-server.mjs')) + ' "$@"\n', { mode: 0o700 })
const env = { ...process.env, OPENAGENT_APPEARANCE_ROOT: root, OPENAGENT_APPEARANCE_MAIN: main,
  SHELL: shell, PATH: join(root, 'bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin',
  OPENAGENT_HEADLESS: '0', FAKE_CODEX_LOG: join(root, 'codex.jsonl') }
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'OPENAGENT_DEV_RESET_USER_DATA']) delete env[key]
const result = { platform: process.platform, arch: process.arch, main,
  mainSha256: createHash('sha256').update(await readFile(main)).digest('hex'), cases: [], root }
let application
async function assertOffScreen() {
  const visible = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map(window => window.isVisible()))
  assert.ok(visible.length > 0, 'the appearance regression must drive the real window')
  assert.equal(visible.some(Boolean), false, 'the appearance regression must not show its window')
  // 采样只能看见当前状态；show 事件才能抓到“亮了一下又藏起来”的上屏路径。
  const phases = (await readFile(join(root, 'startup.jsonl'), 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line).phase)
  assert.equal(phases.includes('shown'), false, 'the appearance regression must never reach the show boundary')
}
async function start() {
  // Playwright otherwise forces light media, hiding nativeTheme's real behavior.
  application = await _electron.launch({ args: [join(tests, 'fixtures/appearance-bootstrap.cjs')], env, colorScheme: null })
  const page = await application.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.waitForSelector('.app-shell')
  await assertOffScreen()
  return page
}
async function effective(page, expected) {
  await page.waitForFunction(dark => matchMedia('(prefers-color-scheme: dark)').matches === dark, expected)
  const native = await application.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))
  assert.equal(native.dark, expected)
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light dark')
  return native
}
async function save(page, mode) {
  // The fake Codex CLI is found by auto-detection through PATH; the settings page
  // no longer carries a path to point at it.
  await page.evaluate(async ({ mode }) => {
    const state = await window.openAgent.loadState()
    await window.openAgent.updateAppSettings({ ...state.settings, appearance: mode })
  }, { mode })
}
async function screenshot(page, name) {
  await page.screenshot({ path: join(root, name + '.png'), scale: 'css' })
}
async function pageBackgroundAlpha(page) {
  // Sample empty Overview space through the complete production DOM stack.
  // Renderer screenshots exclude the native window background, so a hole left
  // by the page wrapper surfaces here as clear pixels.
  const png = await page.screenshot({ omitBackground: true, clip: { x: 100, y: 100, width: 1, height: 1 }, scale: 'css' })
  return application.evaluate(({ nativeImage }, base64) =>
    nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).toBitmap()[3], png.toString('base64'))
}
async function checkOpaqueBackground(page) {
  const alpha = await pageBackgroundAlpha(page)
  assert.equal(alpha, 255, 'Overview and Bart thread must both paint an opaque background')
}
async function navigateBart(page, inside) {
  const samples = []
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b')
  try {
    await page.waitForFunction(() => document.querySelector('[data-bart-camera-active], [data-bart-camera-error]'))
  } catch (error) {
    result.cameraAtFailure = await page.locator('.app-shell').evaluate(element => ({
      attributes: Object.fromEntries([...element.attributes].filter(attribute => attribute.name.startsWith('data-bart-camera')).map(attribute => [attribute.name, attribute.value])),
      hidden: document.hidden, width: innerWidth, height: innerHeight,
      marks: performance.getEntriesByType('mark').filter(mark => mark.name.startsWith('bart-camera')).map(mark => ({ name: mark.name, startTime: mark.startTime, detail: mark.detail }))
    }))
    throw error
  }
  const failure = await page.locator('.app-shell').getAttribute('data-bart-camera-error')
  if (failure) result.cameraPreparation = await page.evaluate(() => performance.getEntriesByType('mark')
    .filter(mark => mark.name.startsWith('bart-camera')).map(mark => ({ name: mark.name, startTime: mark.startTime, detail: mark.detail })))
  assert.equal(failure, null, `Bart camera preparation failed: ${failure}`)
  await page.waitForSelector('[data-bart-camera-active]')
  // Pause after preparation: screenshot latency must not skip the entire
  // 1.1s animation on a loaded verification machine. The real scene still
  // renders each sampled frame; only the browser clock is controlled.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100))
  // Sample final compositor output, not the Canvas backing bitmap: a clear
  // frame from the Canvas or any ancestor must fail this regression as well.
  const deadline = Date.now() + 15_000
  do {
    assert.ok(Date.now() < deadline, 'Bart navigation must finish')
    samples.push(await pageBackgroundAlpha(page))
    await page.clock.runFor(100)
  } while (await page.locator('[data-bart-camera-active]').count())
  assert.ok(samples.length > 1, 'exercise the real animation, not the preparation failure fallback')
  assert.ok(samples.every(alpha => alpha === 255), 'every animated frame must paint an opaque background')
  await page.clock.resume()
  await page.locator('#bart-thread-view').waitFor({ state: inside ? 'visible' : 'detached' })
  await checkOpaqueBackground(page)
}
async function checkPiLogo(page, mode) {
  const logo = page.locator('.harness-icon-row[aria-label="本地 Agent"] .harness-icon[data-agent="pi"] img')
  await logo.evaluate(image => image.decode())
  const png = await logo.screenshot({ path: join(root, `pi-logo-${mode}.png`) })
  // Inspect the rendered center, excluding rounded corners and the status badge.
  // Loading the SVG alone cannot detect white artwork on its white plate.
  const contrast = await application.evaluate(({ nativeImage }, base64) => {
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
    const { width, height } = image.getSize()
    const pixels = image.toBitmap()
    const values = []
    for (let y = Math.ceil(height * .2); y < height * .8; y++) {
      for (let x = Math.ceil(width * .2); x < width * .8; x++) {
        const offset = (y * width + x) * 4
        values.push((pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3)
      }
    }
    return Math.max(...values) - Math.min(...values)
  }, png.toString('base64'))
  assert.ok(contrast > 80, `Pi logo must remain distinguishable in ${mode}: contrast=${contrast}`)
}
// The window must blur the swap, and the resolved scheme must change between
// the frame captured before the mutation and the one captured after it.
async function switchedAppearance(page, mode) {
  await page.evaluate(() => {
    // Keep one wrapper per page: re-wrapping would nest spies and double-count.
    const native = window.__nativeStartViewTransition
      ?? (window.__nativeStartViewTransition = document.startViewTransition.bind(document))
    window.__appearanceSwap = { calls: 0, skipped: false, darkBefore: null, darkAfter: null, blurred: null }
    document.startViewTransition = callback => {
      window.__appearanceSwap.calls += 1
      window.__appearanceSwap.darkBefore = matchMedia('(prefers-color-scheme: dark)').matches
      const transition = native(async () => {
        await callback()
        window.__appearanceSwap.darkAfter = matchMedia('(prefers-color-scheme: dark)').matches
        window.__appearanceSwap.blurred = document.documentElement.classList.contains('theme-transition')
      })
      // A no-op change withholds the blur either way, so record the skip itself:
      // it is the only observable that separates the fix from the old behavior.
      return {
        finished: transition.finished,
        skipTransition: () => {
          window.__appearanceSwap.skipped = true
          transition.skipTransition()
        }
      }
    }
  })
  await page.getByLabel('外观', { exact: true }).selectOption(mode)
  // darkAfter is written once the browser has run the update callback, which is
  // where the incoming frame is defined; reading earlier would race the swap.
  await page.waitForFunction(() => window.__appearanceSwap.darkAfter !== null)
  const swap = await page.evaluate(() => window.__appearanceSwap)
  await page.waitForTimeout(180)
  // Read the animated pseudo-element, so a detached class or renamed keyframe
  // cannot leave every other assertion passing over an unblurred window.
  const midflight = await page.evaluate(() =>
    getComputedStyle(document.documentElement, '::view-transition-old(root)').filter)
  await screenshot(page, 'swap-blur-midflight')
  await page.waitForFunction(() => !document.documentElement.classList.contains('theme-transition'))
  return { ...swap, midflight }
}
try {
  let page = await start()
  // The clock replaces User Timing with no-op methods. Keep native marks for
  // preparation diagnostics while retaining its controlled timers and now().
  await page.evaluate(() => {
    window.__appearanceUserTiming = Object.fromEntries(['mark', 'clearMarks', 'getEntriesByType', 'getEntriesByName']
      .map(name => [name, performance[name].bind(performance)]))
    const now = performance.now.bind(performance)
    const trace = window.__appearanceCaptureTrace = []
    const record = row => { trace.push(row); if (trace.length > 32) trace.shift(); return row }
    const encode = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const row = record({ operation: 'canvas encode', width: this.width, height: this.height, start: now() })
      try { return encode.apply(this, args) } finally { row.end = now() }
    }
    const decode = HTMLImageElement.prototype.decode
    HTMLImageElement.prototype.decode = function (...args) {
      const row = record({ operation: 'image decode', type: this.src.split(';', 1)[0].slice(0, 40), bytes: this.src.length, start: now() })
      return decode.apply(this, args).finally(() => { row.end = now() })
    }
  })
  await page.clock.install()
  await page.evaluate(() => Object.assign(performance, window.__appearanceUserTiming))
  for (const mode of ['dark', 'light']) {
    await save(page, mode)
    await effective(page, mode === 'dark')
    await page.emulateMedia({ colorScheme: null })
    await checkOpaqueBackground(page)
    await navigateBart(page, true)
    await navigateBart(page, false)
    result.cases.push(`${mode}: opaque Overview and Bart thread survive round-trip navigation`)
  }
  await page.emulateMedia({ colorScheme: null })
  await save(page, 'dark')
  await effective(page, true)
  // UI choices apply immediately and survive both page reopen and a cold start.
  await page.locator('[data-settings-trigger]').click()
  await page.waitForSelector('.settings-page[data-phase=open]')
  assert.equal(await page.getByRole('tab', { name: 'Bart', exact: true }).getAttribute('aria-selected'), 'true')
  await page.getByRole('tab', { name: '通用', exact: true }).click()
  await checkPiLogo(page, 'dark')
  await screenshot(page, 'settings-dark')
  const swap = await switchedAppearance(page, 'light')
  assert.equal(swap.calls, 1)
  assert.equal(swap.darkBefore, true)
  assert.equal(swap.darkAfter, false)
  assert.equal(swap.blurred, true)
  assert.equal(swap.skipped, false)
  assert.match(swap.midflight, /^blur\(/, 'the outgoing frame must be blurred by the scoped keyframes')
  result.cases.push('UI appearance switch blurs the swap and captures the new scheme in its incoming frame')
  // The reverse direction proves the blur is not tied to one direction of travel.
  const swapBack = await switchedAppearance(page, 'dark')
  assert.equal(swapBack.calls, 1)
  assert.equal(swapBack.darkBefore, false)
  assert.equal(swapBack.darkAfter, true)
  assert.equal(swapBack.blurred, true)
  assert.equal(swapBack.skipped, false)
  result.cases.push('the reverse appearance switch blurs too and captures the new scheme in its incoming frame')
  await switchedAppearance(page, 'light')
  assert.equal((await effective(page, false)).source, 'light')
  // A preference resolving to the scheme already in effect must not animate: the
  // two frames are the same picture, so Chromium's own cross-fade has to be skipped.
  await save(page, 'system')
  const osDark = await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  await save(page, osDark ? 'dark' : 'light')
  await effective(page, osDark)
  const hold = await switchedAppearance(page, 'system')
  assert.equal(hold.calls, 1)
  assert.equal(hold.darkBefore, osDark)
  assert.equal(hold.darkAfter, osDark)
  assert.equal(hold.blurred, false)
  assert.equal(hold.skipped, true)
  result.cases.push('a scheme-preserving preference skips Chromium’s cross-fade over the resolved window')
  await save(page, 'light')
  assert.equal((await effective(page, false)).source, 'light')
  await checkPiLogo(page, 'light')
  assert.equal(await page.getByRole('button', { name: '保存更改', exact: true }).count(), 0)
  // The footer that carried the save-state copy and the page's own close button is gone,
  // so the sidebar's back control is the one way out.
  assert.equal(await page.locator('.settings-page-footer').count(), 0)
  assert.equal(await page.locator('.settings-page[data-phase=open]').count(), 1)
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.waitForSelector('.settings-page', { state: 'detached' })
  await page.locator('[data-settings-trigger]').click()
  await page.waitForSelector('.settings-page[data-phase=open]')
  assert.equal(await page.getByRole('tab', { name: 'Bart', exact: true }).getAttribute('aria-selected'), 'true')
  await page.getByRole('tab', { name: '通用', exact: true }).click()
  assert.equal(await page.getByLabel('外观', { exact: true }).inputValue(), 'light')
  await screenshot(page, 'settings-light')
  // Raw IPC callers and stored settings share the same normalization and limit.
  for (const routingGuidance of ['  First rule\nSecond rule\n ', '', ' \n\t ']) {
    const saved = await page.evaluate(async routingGuidance => {
      const { settings } = await window.openAgent.loadState()
      await window.openAgent.updateAppSettings({ ...settings, bart: { ...settings.bart, routingGuidance } })
      return (await window.openAgent.loadState()).settings.bart.routingGuidance
    }, routingGuidance)
    assert.equal(saved, routingGuidance.trim() || null)
  }
  await assert.rejects(page.evaluate(async () => {
    const { settings } = await window.openAgent.loadState()
    await window.openAgent.updateAppSettings({ ...settings, bart: { ...settings.bart, routingGuidance: 'x'.repeat(12_001) } })
  }), /模型路由指导最多 12000 个字符（UTF-16 计数），当前 12001 个。/)
  // Reopen to load the settings saved directly through IPC.
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.waitForSelector('.settings-page', { state: 'detached' })
  await page.locator('[data-settings-trigger]').click()
  await page.waitForSelector('.settings-page[data-phase=open]')
  await page.getByRole('tab', { name: 'Bart', exact: true }).click()
  await page.getByRole('switch', { name: '自定义模型路由指导', exact: true }).check()
  const guidance = page.getByRole('textbox', { name: 'Bart 模型路由指导', exact: true })
  await guidance.fill('x'.repeat(12_001))
  assert.equal((await guidance.inputValue()).length, 12_001)
  assert.equal(await guidance.getAttribute('aria-invalid'), 'true')
  assert.match(await page.getByRole('alert').innerText(), /最多 12000.*当前 12001/)
  await page.getByRole('switch', { name: '自动审批与代答', exact: true }).uncheck()
  await page.waitForFunction(async () => !(await window.openAgent.loadState()).settings.bart.autoIntervention)
  assert.equal((await page.evaluate(() => window.openAgent.loadState())).settings.bart.routingGuidance, null)
  assert.equal(await page.getByRole('button', { name: '重试保存', exact: true }).count(), 0)
  await guidance.fill(' \n\t ')
  await guidance.blur()
  assert.equal(await guidance.getAttribute('aria-invalid'), null)
  assert.equal((await page.evaluate(() => window.openAgent.loadState())).settings.bart.routingGuidance, null)
  // Completing padded text and immediately pressing Escape flushes normalized text.
  await guidance.fill('  Prefer a small model for simple tasks.\n')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.settings-page', { state: 'detached' })
  assert.equal((await page.evaluate(() => window.openAgent.loadState())).settings.bart.routingGuidance,
    'Prefer a small model for simple tasks.')
  await application.close(); application = undefined
  page = await start()
  assert.equal((await effective(page, false)).source, 'light')
  const restored = await page.evaluate(() => window.openAgent.loadState())
  assert.equal(restored.settings.appearance, 'light')
  assert.equal(restored.settings.bart.routingGuidance, 'Prefer a small model for simple tasks.')
  result.cases.push('UI autosave stays open; appearance and immediate-close text survive reopen and cold start')
  result.cases.push('guidance normalizes over IPC; over-limit drafts retain full text and do not block other preferences')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+b' : 'Control+Shift+b')
  const composer = page.getByRole('combobox', { name: '给 Bart 发消息', exact: true })
  await composer.fill('Appearance keeps this unsent draft')
  await composer.evaluate(element => {
    const clipboardData = new DataTransfer()
    clipboardData.items.add(new File(['appearance fixture'], 'theme-note.txt', { type: 'text/plain' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }))
  })
  const attachment = page.locator('.bart-dock-attachment-strip .attachment-chip:not(.pending):not(.failed)')
  await attachment.waitFor()
  const attachmentBefore = await attachment.innerText()
  const before = await page.evaluate(() => window.openAgent.loadState())
  for (const mode of ['dark', 'light', 'system']) {
    await save(page, mode)
    const expected = await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
    const native = await effective(page, expected)
    assert.equal(native.source, mode)
    assert.equal(await composer.inputValue(), 'Appearance keeps this unsent draft')
    assert.equal(await attachment.innerText(), attachmentBefore)
    const after = await page.evaluate(() => window.openAgent.loadState())
    assert.deepEqual(after.threads.map(t => t.id), before.threads.map(t => t.id))
    assert.equal(after.selectedThreadId, before.selectedThreadId)
    assert.deepEqual(after.executions, before.executions)
    await screenshot(page, 'bart-' + mode)
  }
  result.cases.push('live preference changes preserve Bart draft and attachment, Thread identities, selection and executions')
  // Inspect all cold starts before any test theme override is applied.
  for (const mode of ['dark', 'light', 'system']) {
    await save(page, mode)
    const expected = await application.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
    await application.close(); application = undefined
    page = await start()
    const native = await effective(page, expected)
    assert.equal(native.source, mode)
    assert.equal((await page.evaluate(() => window.openAgent.loadState())).settings.appearance, mode)
    const events = (await readFile(join(root, 'startup.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).slice(-2)
    assert.deepEqual(events.map(event => event.phase), ['created', 'ready-to-show'])
    for (const event of events) {
      assert.equal(event.source, mode)
      assert.equal(event.dark, expected)
    }
    result.cases.push('cold start ' + mode + ': native theme established at window creation and first paint')
  }
  if (process.platform === 'darwin') {
    await save(page, 'dark')
    const nextWindow = application.waitForEvent('window')
    await application.evaluate(({ BrowserWindow, app }) => {
      const previous = BrowserWindow.getAllWindows()[0]
      previous.once('closed', () => app.emit('activate'))
      previous.close()
    })
    page = await nextWindow
    await page.waitForSelector('.app-shell')
    await assertOffScreen()
    assert.equal((await effective(page, true)).source, 'dark')
    result.cases.push('macOS window reopen retains saved theme')
  }
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'; result.error = String(error)
  if (application) result.captureTrace = await application.windows()[0]?.evaluate(() => window.__appearanceCaptureTrace ?? [])
  throw error
} finally {
  if (application) await application.close()
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
}
