import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CaptureUnavailable, ENVIRONMENT_EXIT } from './bart-capture-metrics.mjs'

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  // These checks measure motion; pin the media feature so the host's Reduce
  // Motion setting cannot silently disable the subject under test.
  const result = spawnSync(electron, ['--force-prefers-no-reduced-motion', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: 'inherit'
  })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, nativeTheme, nativeImage } = await import('electron')
const output = await mkdtemp(path.join(tmpdir(), 'bart-handoff-'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(read, accepts, timeout = 6000) {
  const until = performance.now() + timeout
  let value
  do { value = await read(); if (accepts(value)) return value; await delay(8) } while (performance.now() < until)
  throw new Error(`Timed out: ${JSON.stringify(value)}`)
}

// Native compositor pixels, not Canvas readback or DOM visibility alone.
function difference(a, b, rect, region) {
  assert.deepEqual(a.size, b.size)
  const { width, height } = a.size, scale = width / rect.width
  const cx = rect.width / 2 * scale, cy = rect.height / 2 * scale
  const radius = (rect.width - 88) / 2 * scale
  let sum = 0, count = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const r = Math.hypot(x - cx, y - cy) / radius
    if (region === 'halo' ? r < 1.12 || r > 1.7 : r > .6 || y < cy) continue
    const offset = (y * width + x) * 4
    for (let channel = 0; channel < 3; channel++) sum += Math.abs(a.data[offset + channel] - b.data[offset + channel])
    count += 3
  }
  assert.ok(count > 100)
  return sum / count
}
function pixels(image) { return { data: image.toBitmap(), size: image.getSize() } }

app.whenReady().then(async () => {
  // Same opaque window as production: it repaints to the committed theme instead
  // of letting native material show through.
  const windowBackground = () => nativeTheme.shouldUseDarkColors ? '#20211f' : '#f8f7f4'
  const window = new BrowserWindow({ width: 1180, height: 780, useContentSize: true, show: true, alwaysOnTop: true,
    backgroundColor: windowBackground(),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
  nativeTheme.on('updated', () => window.setBackgroundColor(windowBackground()))
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const contents = window.webContents
  const entry = path.join(desktop, 'out/bart-lab/isolation.html')
  const read = api => contents.executeJavaScript(`window.${api}.status()`)
  const rectOfBart = () => contents.executeJavaScript(`(() => {
    const r = document.querySelector('.bart-dock .bart-bot > path').getBoundingClientRect();
    return { x: Math.floor(r.x - 44), y: Math.floor(r.y - 44), width: Math.ceil(r.width + 88), height: Math.ceil(r.height + 88) }
  })()`)
  function record(rect) {
    const frames = []
    contents.beginFrameSubscription(false, image => {
      const size = image.getSize(), sx = size.width / 1180, sy = size.height / 780
      const crop = image.crop({ x: Math.round(rect.x * sx), y: Math.round(rect.y * sy),
        width: Math.round(rect.width * sx), height: Math.round(rect.height * sy) })
      frames.push({ at: performance.now(), ...pixels(crop) })
    })
    return frames
  }
  async function save(name, frame) {
    await writeFile(path.join(output, `${name}.png`), nativeImage.createFromBitmap(frame.data, frame.size).toPNG())
  }
  const reports = []
  try {
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme
      if (!process.argv.includes('--camera')) {
        await window.loadFile(entry, { search: '?settings' }); window.show(); window.focus()
        await wait(() => contents.executeJavaScript('Boolean(window.bartSettings && document.querySelector(".bart-logo[data-worker-ready]"))'), Boolean)
        await delay(250)
        const rect = await rectOfBart(), reference = pixels(await contents.capturePage(rect))
        for (const at of [25, 70, 120, 210]) {
          const frames = record(rect)
          await contents.executeJavaScript(`window.__handoffSamples = []; window.__recordHandoff = true;
            requestAnimationFrame(function record() {
              const dock = document.querySelector('.bart-dock'), cover = document.querySelector('[data-bart-cross-page-flight]');
              const style = getComputedStyle(dock);
              window.__handoffSamples.push({ at: performance.now(), phase: document.querySelector('.settings-page')?.dataset.phase,
                cover: Boolean(cover && !cover.hidden), opacity: style.opacity, visibility: style.visibility });
              if(window.__recordHandoff) requestAnimationFrame(record);
            }); window.bartSettings.act('open')`)
          await wait(() => read('bartSettings'), value => Boolean(value.ready))
          await delay(at)
          const reversedAt = performance.now()
          await contents.executeJavaScript("window.bartSettings.act('close')")
          const reversed = await wait(() => read('bartSettings'), value => Boolean(value.redirect))
          await wait(() => read('bartSettings'), value => !value.phase && !value.active)
          await delay(200); contents.endFrameSubscription()
          const samples = await contents.executeJavaScript('window.__recordHandoff = false; window.__handoffSamples')
          const missing = samples.filter(sample => sample.phase === 'closing' && !sample.cover && (sample.opacity === '0' || sample.visibility === 'hidden'))
          const landed = frames.filter(frame => frame.at > reversedAt + reversed.redirect.duration + 55)
          assert.ok(landed.length > 0, 'No returned Bart frames captured')
          const bodyError = Math.max(...landed.map(frame => difference(frame, reference, rect, 'body')))
          const report = { kind: 'settings', theme, at, missing: missing.length, bodyError, samples }
          reports.push(report)
          await save(`${theme}-settings-${at}-native`, reference)
          await save(`${theme}-settings-${at}-returned`, landed[0])
          if (!process.argv.includes('--diagnose')) {
            assert.equal(missing.length, 0, 'Returned Bart disappeared before settings finished closing')
            assert.ok(bodyError < 4, `Returned Bart body flashed: ${bodyError}`)
          }
        }
        // A second reversal may arrive after the actor lands but before the
        // page uncovers it. The pending landing must not retire this new flight.
        const landing = await contents.executeJavaScript(`new Promise((resolve, reject) => {
          let closeElapsed;
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error('No local settings landing boundary')); }, 6000);
          const observer = new PerformanceObserver(list => {
            const ready = list.getEntries().find(entry => entry.name === 'bart-cross-page-ready');
            if (ready) setTimeout(() => {
              closeElapsed = performance.timeOrigin + performance.now() - ready.detail.origin;
              if (closeElapsed > ready.detail.duration * .25) {
                clearTimeout(timer); observer.disconnect(); resolve({ unavailable: true, closeElapsed }); return;
              }
              window.bartSettings.act('close');
            }, Math.max(0, 70 - (performance.timeOrigin + performance.now() - ready.detail.origin)));
            if (!list.getEntries().some(entry => entry.name === 'bart-cross-page-redirect')) return;
            observer.disconnect();
            const cover = document.querySelector('[data-bart-cross-page-flight]');
            const animation = cover?.getAnimations()[0];
            if (!animation) { clearTimeout(timer); reject(new Error('Redirect has no compositor animation')); return; }
            animation.finished.then(() => {
              clearTimeout(timer);
              const evidence = { closeElapsed, visible: !cover.hidden, playState: animation.playState,
                phase: document.querySelector('.settings-page')?.dataset.phase };
              if (!evidence.visible || evidence.playState !== 'finished' || evidence.phase !== 'closing') {
                reject(new Error('Missed settings landing boundary: ' + JSON.stringify(evidence))); return;
              }
              // Trigger at the boundary in this renderer task. Main waits for
              // durable evidence; it cannot poll and then IPC into a 95ms phase.
              window.bartSettings.act('reopen');
              resolve(evidence);
            }).catch(error => { clearTimeout(timer); reject(error); });
          });
          observer.observe({ type: 'mark' });
          window.bartSettings.act('open');
        })`)
        reports.push({ kind: 'settings-landing-reversal', theme, landing })
        if (landing.unavailable) throw new CaptureUnavailable(`Settings close was scheduled too late to exercise landing while closing: ${landing.closeElapsed}ms`)
        await wait(() => read('bartSettings'), value => value.phase === 'open' && !value.active)
        await contents.executeJavaScript("window.bartSettings.act('close')")
        await wait(() => read('bartSettings'), value => !value.phase && !value.active)
      }
      if (!process.argv.includes('--settings')) {
        await window.loadFile(entry, { search: '?camera' }); window.show(); window.focus()
        await wait(() => contents.executeJavaScript('Boolean(window.bartCamera && document.querySelector(".bart-logo[data-worker-ready]"))'), Boolean)
        await contents.executeJavaScript("document.documentElement.style.setProperty('--paper', 'var(--canvas)')")
        // Settle the fixture's unread answer through the real navigation path.
        // The badge returns only after handoff and overlaps the halo sample ring.
        await contents.executeJavaScript('window.bartCamera.fly(true)')
        await wait(() => read('bartCamera'), value => !value.active && value.inside)
        await contents.executeJavaScript('window.bartCamera.fly(false)')
        await wait(() => read('bartCamera'), value => !value.active && !value.inside)
        assert.equal(await contents.executeJavaScript('Boolean(document.querySelector(".bart-reply-target"))'), false,
          'The read fixture reply must not cover the halo sample')
        await delay(400)
        const rect = await rectOfBart(), baseline = pixels(await contents.capturePage(rect))
        const frames = record(rect)
        await contents.executeJavaScript('window.bartCamera.fly(true)')
        const ready = (await wait(() => read('bartCamera'), value => Boolean(value.ready))).ready
        await delay(ready.duration * .32)
        await contents.executeJavaScript('window.bartCamera.fly(false)')
        const redirected = await contents.executeJavaScript("performance.getEntriesByName('bart-camera-redirect').at(-1)?.detail")
        assert.ok(redirected, 'Camera did not reverse its existing scene')
        const blockedAt = performance.now()
        await contents.executeJavaScript('window.bartCamera.block(1100)')
        const unblockedAt = performance.now()
        await wait(() => read('bartCamera'), value => !value.active && !value.inside)
        await delay(300); contents.endFrameSubscription()
        const terminal = frames.filter(frame => frame.at < unblockedAt - 50 && frame.at > blockedAt + redirected.duration - 50).at(-1)
        assert.ok(terminal, 'No autonomous terminal frame captured')
        const native = pixels(await contents.capturePage(rect))
        const haloError = difference(terminal, native, rect, 'halo'), bodyError = difference(terminal, native, rect, 'body')
        // Include the very first Host handoff frame; a one-frame flash must not
        // disappear into a post-unblock settling allowance.
        const handoffFrames = frames.filter(frame => frame.at > terminal.at)
        assert.ok(handoffFrames.length > 0, 'No native handoff frames captured')
        const handoffHaloError = Math.max(...handoffFrames.map(frame => difference(frame, terminal, rect, 'halo')))
        reports.push({ kind: 'camera', theme, haloError, bodyError, handoffHaloError, ready, redirected,
          blockedAt, unblockedAt, frames: frames.map(({ data: _data, ...frame }) => frame) })
        await save(`${theme}-camera-native-before`, baseline)
        await save(`${theme}-camera-terminal`, terminal)
        await save(`${theme}-camera-native-after`, native)
        if (!process.argv.includes('--diagnose')) {
          assert.ok(haloError < 3 && handoffHaloError < 3, `Camera halo flashed: ${haloError}, ${handoffHaloError}`)
          assert.ok(bodyError < 2, `Camera body changed ink: ${bodyError}`)
        }
      }
    }
    await writeFile(path.join(output, 'results.json'), JSON.stringify(reports, null, 2))
    console.log('BART_HANDOFF_OK', JSON.stringify({ output, reports: reports.map(({ samples: _samples, frames: _frames, ...report }) => report) }))
    window.destroy(); app.exit(0)
  } catch (error) {
    contents.endFrameSubscription()
    console.error(error instanceof CaptureUnavailable ? 'BART_ENVIRONMENT_INCONCLUSIVE' : 'BART_HANDOFF_FAILED', output, error)
    await writeFile(path.join(output, 'outcome.json'), JSON.stringify({ status: error instanceof CaptureUnavailable ? 'environment-inconclusive' : 'failed', error: String(error) }))
    await writeFile(path.join(output, 'results.json'), JSON.stringify(reports, null, 2))
    await writeFile(path.join(output, 'failed.png'), (await contents.capturePage()).toPNG()).catch(() => {})
    window.destroy(); app.exit(error instanceof CaptureUnavailable ? ENVIRONMENT_EXIT : 1)
  }
})
