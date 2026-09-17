// Real production components, observed from the user action rather than readiness.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  const result = spawnSync(electron, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: 'inherit'
  })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, contentTracing, screen, nativeTheme } = await import('electron')
const output = await mkdtemp(path.join(tmpdir(), 'bart-regressions-'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async (read, accepts, ms = 8000) => {
  const deadline = performance.now() + ms
  let value
  while (performance.now() < deadline) {
    value = await read()
    if (accepts(value)) return value
    await delay(8)
  }
  throw new Error(`Timed out: ${JSON.stringify(value)}`)
}
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
const gaps = (events, begin, end) => {
  const timestamps = events.filter(event => event.ts >= begin && event.ts <= end).map(event => event.ts / 1000).sort((a,b) => a-b)
  const intervals = timestamps.slice(1).map((time, i) => time - timestamps[i])
  const holds = timestamps.length ? [timestamps[0] - begin / 1000, end / 1000 - timestamps.at(-1)] : [(end - begin) / 1000]
  return { frames: timestamps.length, p50: quantile(intervals, .5), p95: quantile(intervals, .95), max: Math.max(...intervals, ...holds) }
}

app.whenReady().then(async () => {
nativeTheme.themeSource = 'dark'
const window = new BrowserWindow({ width: 1180, height: 780, useContentSize: true, show: true,
  // Native occlusion correctly suspends Worker RAF. Keep this foreground
  // performance fixture above unrelated desktop windows throughout the run.
  alwaysOnTop: true,
  // Same opaque window as production: no native material is expected to show.
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#20211f' : '#f8f7f4',
  webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true } })
window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
const contents = window.webContents
const read = api => contents.executeJavaScript(`window.${api}.status()`)
const entry = path.join(desktop, 'out/bart-lab/isolation.html')
let tracing = false
try {
  await window.loadFile(entry, { search: '?settings' }); window.show(); window.focus()
  await wait(() => contents.executeJavaScript('Boolean(window.bartSettings && document.querySelector(".bart-logo[data-worker-ready]"))'), Boolean)
  await delay(150)
  await contentTracing.startRecording({ included_categories: ['cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline', 'benchmark'] })
  tracing = true
  const settings = []
  for (const [probeMs, missing] of [[3600, true], [120, false], [0, false]]) {
    await contents.executeJavaScript(`window.bartSettings.probe(${probeMs}, ${missing}); window.bartSettings.act('open')`)
    const observations = []
    const ready = await wait(async () => { const value = await read('bartSettings'); observations.push(value); return value }, value => value.ready || value.errors, 1000)
    assert.ok(ready.ready, JSON.stringify(ready))
    assert.ok(ready.ready.preparationMs <= 250, 'Flight admission exceeded its deadline')
    assert.ok(observations.every(value => !value.active || value.hostVisibility === 'hidden'), 'Destination appeared before landing')
    if (probeMs === 3600) assert.equal(ready.probeCompleted, 0, 'Flight waited for installation detection')
    const rail = ready.rail, roster = ready.roster
    await delay(280)
    const during = await read('bartSettings')
    assert.equal(during.active, true)
    assert.equal(during.rail, rail, 'Background probe moved the landing seat')
    assert.deepEqual(during.roster, roster, 'Background probe changed the in-flight roster')
    const landed = await wait(() => read('bartSettings'), value => !value.active && value.phase === 'open')
    assert.equal(landed.hostVisibility, 'visible')
    assert.equal(landed.sealed, false)
    assert.equal(landed.errors, undefined)
    await wait(() => read('bartSettings'), value => value.probeCompleted > 0)
    const settled = await read('bartSettings')
    assert.equal(settled.roster.includes('pi'), !missing)
    assert.equal(settled.ready.origin, ready.ready.origin, 'Late probe replayed the flight')
    await contents.executeJavaScript("window.bartSettings.act('close')")
    const returning = await wait(() => read('bartSettings'), value => value.ready || value.errors, 1000)
    assert.ok(returning.ready, JSON.stringify(returning))
    await wait(() => read('bartSettings'), value => value.phase === undefined && !value.active)
    settings.push({ probeMs, ready, during, landed, settled, returning })
  }
  await contentTracing.stopRecording(path.join(output, 'flight-trace.json')); tracing = false
  const trace = JSON.parse(await readFile(path.join(output, 'flight-trace.json'), 'utf8')).traceEvents
  const refreshRate = screen.getDisplayMatching(window.getBounds()).displayFrequency
  const budget = 1000 / refreshRate
  const exported = trace.filter(event => event.name === 'WorkerAnimationFrameProvider::BeginFrame' && event.ph === 'X')
  const presented = trace.filter(event => event.name === 'CommitPresentedFrameToCA' && event.ph === 'X')
  const cadence = trace.filter(event => event.name === 'bart-cross-page-ready' && event.ph === 'I').map(mark => {
    const detail = JSON.parse(mark.args.data.detail)
    // Exclude admission/terminal handoff. The Worker advances the active flight on
    // each frame; native CA commits are measured independently of capture callbacks.
    const start = mark.ts + 50000, end = mark.ts + (detail.duration - 50) * 1000
    return { direction: detail.direction, milliseconds: (end - start) / 1000,
      workerFrames: gaps(exported, start, end), nativeCommits: gaps(presented, start, end) }
  })
  await writeFile(path.join(output, 'settings.json'), JSON.stringify({ refreshRate, budget, settings, cadence }, null, 2))
  assert.equal(cadence.length, 6)
  for (const flight of cadence) {
    assert.ok(flight.workerFrames.frames >= flight.milliseconds / budget * .88, `Flight output below display cadence: ${JSON.stringify(flight)}`)
    assert.ok(flight.nativeCommits.frames >= flight.milliseconds / budget * .88, `Native commits below display cadence: ${JSON.stringify(flight)}`)
    // Travel now runs on a compositor transform. Worker callback jitter is
    // diagnostic for character redraws, not a measure of the moving layer.
    // Retain the native throughput guard and reject a 50ms submission hold;
    // the blocking cases separately require actual pixels to keep moving.
    assert.ok(flight.nativeCommits.max < 50, `Flight presentation stalled: ${JSON.stringify(flight)}`)
  }
  console.log('BART_FLIGHT_CADENCE', JSON.stringify({ output, refreshRate, cadence }))

  // The real page's close gesture must retain Bart while its reveal collapses.
  await contents.executeJavaScript("window.bartSettings.act('open')")
  await wait(() => read('bartSettings'), value => Boolean(value.ready))
  await delay(210)
  await contents.executeJavaScript("window.bartSettings.act('close')")
  const reversed = await wait(() => read('bartSettings'), value => value.redirect || value.errors, 1000)
  assert.ok(reversed.redirect, JSON.stringify(reversed))
  assert.equal(reversed.active, true, 'Settings close cut the live flight')
  assert.equal(reversed.sealed, true)
  const returned = await wait(() => read('bartSettings'), value => !value.active && value.phase === undefined)
  assert.equal(returned.sealed, false)
  assert.equal((await contents.executeJavaScript('window.bartSettings.inspect()')).textures, 0)
  await writeFile(path.join(output, 'settings-interruption.json'), JSON.stringify({ reversed, returned }, null, 2))

  // Reopen is a real keyboard command, even after the clipped page reports
  // closed while its returning Bart still owns the native seats.
  for (const at of [120, 410]) {
    await contents.executeJavaScript("window.bartSettings.act('open')")
    await wait(() => read('bartSettings'), value => value.phase === 'open' && !value.active)
    await contents.executeJavaScript("window.bartSettings.act('close')")
    await wait(() => read('bartSettings'), value => Boolean(value.ready))
    await delay(at)
    await contents.executeJavaScript("window.bartSettings.act('reopen')")
    const reopening = await wait(() => read('bartSettings'), value => value.redirect?.direction === 'to-seat' || value.errors)
    assert.equal(reopening.redirect?.direction, 'to-seat', JSON.stringify(reopening))
    assert.equal(reopening.active, true)
    const reopened = await wait(() => read('bartSettings'), value => value.phase === 'open' && !value.active)
    assert.equal(reopened.hostVisibility, 'visible')
    assert.equal(reopened.errors, undefined)
    await contents.executeJavaScript("window.bartSettings.act('close')")
    await wait(() => read('bartSettings'), value => !value.active && value.phase === undefined)
  }

  // A late stage grant must never replay a transition that already settled.
  await contents.executeJavaScript("window.bartSettings.probe(0); window.bartSettings.holdStage(700)")
  await contents.executeJavaScript("window.bartSettings.act('open')")
  const expired = await wait(() => read('bartSettings'), value => Boolean(value.errors), 1000)
  assert.equal(expired.active, false)
  assert.equal(expired.ready, undefined)
  await delay(800)
  const afterExpiry = await read('bartSettings')
  assert.equal(afterExpiry.ready, undefined)
  assert.equal(afterExpiry.sealed, false)
  assert.equal(afterExpiry.hostVisibility, 'visible')
  await writeFile(path.join(output, 'admission.json'), JSON.stringify({ expired, afterExpiry }, null, 2))

  await window.loadFile(entry, { search: '?overview-regressions' })
  await wait(() => contents.executeJavaScript('Boolean(window.bartOverview && document.querySelector(".bart-logo[data-worker-ready]"))'), Boolean)
  assert.equal((await read('bartOverview')).cards.length, 0)
  const overview = []
  for (let index = 0; index < 3; index++) {
    // Both first arrival and a keyed filter remount must bind the real camera.
    if (index === 1) { await contents.executeJavaScript('window.bartOverview.filter()'); await delay(300) }
    await contents.executeJavaScript('window.bartOverview.create()')
    const ready = await wait(() => read('bartOverview'), value => value.ready || value.skipped, 12000)
    assert.ok(ready.ready, JSON.stringify(ready))
    assert.ok(ready.transform?.startsWith('translate('), 'Overview camera did not bind its new plane')
    assert.equal(ready.cards.length, index + 1)
    await delay(140)
    await writeFile(path.join(output, `generation-${index}.png`), (await contents.capturePage()).toPNG())
    await contents.executeJavaScript('window.bartOverview.block(2000)')
    const settled = await wait(() => read('bartOverview'), value => !value.busy && !value.works && !value.sealed, 12000)
    assert.deepEqual(settled.hidden, [])
    assert.ok(settled.cards.every(card => card.visibility === 'visible'))
    assert.ok(settled.cards.every(card => card.rect.x >= 0 && card.rect.y >= 30), 'Cards remained underneath the toolbar')
    const resources = await contents.executeJavaScript('window.bartOverview.inspect()')
    assert.equal(resources.textures, 0)
    overview.push({ ready, settled, resources })
    await writeFile(path.join(output, `overview-${index}.png`), (await contents.capturePage()).toPNG())
  }
  await writeFile(path.join(output, 'overview.json'), JSON.stringify(overview, null, 2))
  console.log('BART_OVERVIEW_REGRESSIONS', JSON.stringify({ output, cases: overview.length }))
  window.destroy(); app.exit(0)
} catch (error) {
  console.error('BART_REGRESSIONS_FAILED', output, error)
  try {
    console.error('BART_NATIVE_WINDOW', { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(),
      alwaysOnTop: window.isAlwaysOnTop(), page: await contents.executeJavaScript('({ visibility: document.visibilityState, focused: document.hasFocus() })') })
    if (tracing) await contentTracing.stopRecording(path.join(output, 'failed-trace.json'))
    await writeFile(path.join(output, 'failed.png'), (await contents.capturePage()).toPNG())
  } catch (captureError) { console.error('Failure capture unavailable:', captureError) }
  finally { window.destroy(); app.exit(1) }
}

})
