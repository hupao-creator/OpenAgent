// Electron Main owns capture and tracing. No renderer rAF sampler can run during
// the deliberate renderer block. Callback arrival times are NOT presentation times.
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { calibrateClock, CaptureUnavailable, ENVIRONMENT_EXIT, progress, requireCapture, requireCoverage, requireProgress } from './bart-capture-metrics.mjs'

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

const { app, BrowserWindow, contentTracing, screen, nativeImage, nativeTheme } = await import('electron')
// The M0/card fixtures declare a light window background. Do not inherit an OS
// day/night switch halfway through paired measurements. Full settings exercises
// the dark window; this affects only this test process, never the system setting.
nativeTheme.themeSource = process.argv[2] === '--settings' ? 'dark' : 'light'
const output = process.env.BART_ISOLATION_OUTPUT ?? await mkdtemp(path.join(tmpdir(), 'bart-isolation-'))
await mkdir(output, { recursive: true })
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null
const deadline = (promise, ms, label) => {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })])
    .finally(() => clearTimeout(timer))
}

function regionMetrics(frames, name, start, end) {
  const selected = frames.filter(frame => frame.at >= start && frame.at <= end)
  const changes = selected.filter((frame, index) => index === 0 || frame.hash[name] !== selected[index - 1].hash[name])
  const gaps = changes.slice(1).map((frame, index) => frame.at - changes[index].at)
  const holds = gaps.concat(changes.length ? [changes[0].at - start, end - changes.at(-1).at] : [end - start])
  return { samples: selected.length, changes: changes.length, unique: new Set(selected.map(frame => frame.hash[name])).size,
    repeatedRatio: selected.length ? 1 - changes.length / selected.length : 1,
    callbackGapP95: percentile(gaps, .95), callbackGapP99: percentile(gaps, .99), maxObservedHold: Math.max(...holds) }
}

async function verifyMessageArrival(contents, output) {
  await deadline((async () => {
    while (!(await contents.executeJavaScript('Boolean(window.bartMessage && document.querySelector(".bart-logo[data-worker-ready]"))'))) await delay(30)
  })(), 10000, 'Message resident ready')
  await delay(800)
  const rect = await contents.executeJavaScript('document.querySelector(".bart-message").getBoundingClientRect().toJSON()')
  const frames = [], images = []
  let origin = performance.now(), saved = -Infinity
  contents.beginFrameSubscription(false, image => {
    const at = performance.now() - origin, size = image.getSize(), sx = size.width / 1180, sy = size.height / 780
    const region = image.crop({ x: Math.round(rect.x*sx), y: Math.round(rect.y*sy), width: Math.round(rect.width*sx), height: Math.round(rect.height*sy) })
    const pixels = region.toBitmap()
    let ink = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 210 && pixels[i+1] > 210 && pixels[i+2] > 210) ink++
    const negative = image.crop({ x: Math.round(70*sx), y: Math.round(440*sy), width: Math.round(160*sx), height: Math.round(36*sy) }).toBitmap()
    frames.push({ at, ink, hash: { text: createHash('sha256').update(pixels).digest('hex'), negative: createHash('sha256').update(negative).digest('hex') } })
    if (at - saved > 100 && at < 900) { saved = at; images.push({ at, data: pixels, size: region.getSize() }) }
  })
  await delay(100)
  origin = performance.now()
  await contents.executeJavaScript('window.bartMessage.start()')
  await delay(60)
  const blockedAt = performance.now() - origin, blockMs = Number(process.argv[3] ?? 2000)
  await contents.executeJavaScript(`window.bartMessage.block(${blockMs})`)
  const finishedAt = performance.now() - origin
  contents.endFrameSubscription()
  const motion = regionMetrics(frames, 'text', 210, 530)
  const negative = regionMetrics(frames, 'negative', blockedAt + 400, finishedAt - 75)
  const early = Math.min(...frames.filter(frame => frame.at >= 60 && frame.at <= 160).map(frame => frame.ink))
  const late = Math.max(...frames.filter(frame => frame.at >= 650 && frame.at <= 1200).map(frame => frame.ink))
  await writeFile(path.join(output, 'message.json'), JSON.stringify({ motion, negative, early, late, frames }, null, 2))
  await Promise.all(images.map((image, i) => writeFile(path.join(output, `message-${i}-${Math.round(image.at)}.png`), nativeImage.createFromBitmap(image.data, image.size).toPNG())))
  if (motion.unique < 4 || motion.maxObservedHold >= 100 || late < early + 100 || negative.maxObservedHold < blockMs - 650) throw new Error(`Message arrival depends on Renderer: ${JSON.stringify({ motion, negative, early, late })}`)
  console.log('BART_MESSAGE', JSON.stringify({ output, motion, negative, early, late }))
}

async function verifyResidentInterventions(contents, output) {
  const results = []
  for (const state of ['processing', 'allow', 'deny', 'answer']) {
    const frames = [], images = []
    const started = performance.now()
    let lastSaved = -Infinity
    contents.beginFrameSubscription(false, image => {
      const at = performance.now() - started
      const size = image.getSize(), sx = size.width / 1180, sy = size.height / 780
      const region = image.crop({ x: Math.round(735 * sx), y: Math.round(295 * sy), width: Math.round(160 * sx), height: Math.round(140 * sy) })
      const pixels = region.toBitmap()
      let purple = 0
      for (let offset = 0; offset < pixels.length; offset += 4) {
        // Electron bitmap is BGRA on this desktop; the answer token is #6f5bdd.
        if (pixels[offset] > 150 && pixels[offset + 1] > 40 && pixels[offset + 1] < 120 && pixels[offset + 2] > 70 && pixels[offset + 2] < 170) purple++
      }
      const negative = image.crop({ x: Math.round(70 * sx), y: Math.round(440 * sy), width: Math.round(160 * sx), height: Math.round(36 * sy) }).toBitmap()
      frames.push({ at, purple, hash: { character: createHash('sha256').update(pixels).digest('hex'), negative: createHash('sha256').update(negative).digest('hex') } })
      if (at - lastSaved >= 180) { lastSaved = at; images.push({ at, data: pixels, size: region.getSize() }) }
    })
    await contents.executeJavaScript(`window.bartIsolation.intervention('${state}')`)
    const blockedAt = performance.now() - started
    await contents.executeJavaScript('window.bartIsolation.block(2000)')
    const finishedAt = performance.now() - started
    await delay(100)
    contents.endFrameSubscription()
    await Promise.all(images.map((image, index) => writeFile(path.join(output, `${state}-${index}-${Math.round(image.at)}.png`),
      nativeImage.createFromBitmap(image.data, image.size).toPNG())))
    const negative = regionMetrics(frames, 'negative', blockedAt + 400, finishedAt - 75)
    const motion = regionMetrics(frames, 'character', blockedAt + 80, blockedAt + 1050)
    const answer = { early: Math.max(0, ...frames.filter(frame => frame.at < blockedAt + 400).map(frame => frame.purple)),
      arriving: Math.max(0, ...frames.filter(frame => frame.at > blockedAt + 650 && frame.at < blockedAt + 1400).map(frame => frame.purple)),
      finished: Math.max(0, ...frames.filter(frame => frame.at > blockedAt + 1650).map(frame => frame.purple)) }
    results.push({ state, blockedAt, finishedAt, negative, motion, answer, frames })
    await writeFile(path.join(output, 'residents.json'), JSON.stringify(results, null, 2))
    if (negative.maxObservedHold < 1400 || motion.unique < 8 || motion.maxObservedHold >= 100) throw new Error(`Resident ${state} froze during its active Worker clip: ${JSON.stringify({ negative, motion })}`)
    if (state === 'answer' && (answer.early > 2 || answer.arriving < 8 || answer.finished > 2)) throw new Error(`Delayed answer token failed to execute autonomously: ${JSON.stringify(answer)}`)
  }
  await writeFile(path.join(output, 'residents.json'), JSON.stringify(results, null, 2))
  console.log('BART_RESIDENTS', JSON.stringify({ output, results: results.map(({ frames, ...result }) => ({ ...result, frames: frames.length })) }))
}

async function verifyProductionGeneration(contents, output) {
  await deadline((async () => {
    while (!(await contents.executeJavaScript('Boolean(window.bartProduction)'))) await delay(30)
  })(), 10000, 'Production scene mount')
  await contents.executeJavaScript('window.bartProduction.start()')
  let status
  await deadline((async () => {
    while (!(status = await contents.executeJavaScript('window.bartProduction.status()')).ready) await delay(30)
  })(), 15000, 'Production batch ready')
  const ready = status.ready
  if (ready.cards.some(card => card.height < 150) || ready.duration < 4500) throw new Error('Production fixture must contain complete cards and body text')
  console.log('BART_PRODUCTION_READY', JSON.stringify({ ...ready, camera: ready.camera.length }))
  const elapsed = await contents.executeJavaScript('performance.timeOrigin + performance.now() - performance.getEntriesByName("bart-generation-ready").at(-1).detail.origin')
  const frames = [], images = []
  const started = performance.now() - elapsed
  let lastSaved = -Infinity
  contents.beginFrameSubscription(false, image => {
    const at = performance.now() - started, size = image.getSize(), sx = size.width / 1180, sy = size.height / 780
    const hash = {}
    for (const [name, rect] of Object.entries({ scene: [60, 70, 800, 540], native: [77, 100, 10, 380], negative: [930, 440, 160, 36] })) {
      const [x,y,w,h] = rect
      hash[name] = createHash('sha256').update(image.crop({ x: Math.round(x*sx), y: Math.round(y*sy), width: Math.round(w*sx), height: Math.round(h*sy) }).toBitmap()).digest('hex')
    }
    frames.push({ at, hash })
    if (at - lastSaved >= 200) { lastSaved = at; images.push({ at, data: image.toBitmap(), size }) }
  })
  const startDelay = Number(process.argv[4] ?? 1400), blockMs = Number(process.argv[3] ?? 5000)
  await delay(Math.max(0, startDelay - (performance.now() - started)))
  const blockedAt = performance.now() - started
  await contents.executeJavaScript(`window.bartProduction.block(${blockMs})`)
  const unblockedAt = performance.now() - started
  await delay(Math.max(100, ready.duration + 200 - (performance.now() - started)))
  contents.endFrameSubscription()
  const after = await contents.executeJavaScript('window.bartProduction.status()')
  const resources = await contents.executeJavaScript('window.bartProduction.inspect()')
  await Promise.all(images.map((image, index) => writeFile(path.join(output, `production-${index}-${Math.round(image.at)}.png`), nativeImage.createFromBitmap(image.data, image.size).toPNG())))
  const relay = ready.phases.find(phase => phase.name === 'fly:1').at
  const native = regionMetrics(frames, 'native', relay + 35, relay + 320)
  const negative = regionMetrics(frames, 'negative', blockedAt + 400, unblockedAt - 75)
  const moving = ready.phases.filter(phase => phase.name.startsWith('fly:') || phase.name.startsWith('morph:') || phase.name === 'return').map(phase => {
    const end = ready.phases.find(next => next.at > phase.at)?.at ?? ready.duration
    const from = Math.max(blockedAt, phase.at) + 70, to = Math.min(unblockedAt, end) - 70
    return { phase: phase.name, from, to, metrics: regionMetrics(frames, 'scene', from, to) }
  }).filter(item => item.to - item.from >= 100)
  const report = { output, ready, blockedAt, unblockedAt, native, negative, moving, after, resources, frames }
  await writeFile(path.join(output, 'production.json'), JSON.stringify(report, null, 2))
  if (relay > blockedAt && relay + 360 < unblockedAt && (native.unique < 5 || native.maxObservedHold >= 100)) throw new Error('Native camera stopped at the offscreen relay')
  if (negative.maxObservedHold < blockMs - 650) throw new Error('Production negative control failed to detect Renderer blocking')
  if (moving.some(item => item.metrics.unique < 3 || item.metrics.maxObservedHold >= 100)) throw new Error('Production generation froze within an active segment')
  if (!after.handoff || after.inert || after.state || after.cards.some(card => card.visibility !== 'visible' || card.opacity !== '1') || resources.textures !== 0) throw new Error('Production handoff left stale pixels, hidden DOM, locks or textures')
  if (after.cards[1].rect.top < 70 || after.cards[1].rect.bottom > 610) throw new Error('Offscreen card was not framed by the prepared camera')
  console.log('BART_PRODUCTION', JSON.stringify({ output, blockedAt, unblockedAt, native, negative, moving,
    after: { ...after, ready: undefined }, resources, frames: frames.length }))
}

async function verifyCrossPageFlight(contents, output) {
  await deadline((async () => {
    while (!(await contents.executeJavaScript('Boolean(window.bartCrossPage)'))) await delay(30)
  })(), 10000, 'Cross-page scene mount')
  const results = []
  for (const direction of ['to-seat', 'to-dock']) {
    await contents.executeJavaScript(`window.bartCrossPage.fly('${direction}')`)
    let status
    await deadline((async () => {
      while (!(status = await contents.executeJavaScript('window.bartCrossPage.status()')).ready) await delay(20)
    })(), 12000, `Cross-page ${direction} ready`).catch(error => { console.error('CROSS_PAGE_STATUS', status); throw error })
    const ready = status.ready
    const elapsed = await contents.executeJavaScript('performance.timeOrigin + performance.now() - performance.getEntriesByName("bart-cross-page-ready").at(-1).detail.origin')
    const started = performance.now() - elapsed, frames = [], images = []
    let lastSaved = -Infinity
    contents.beginFrameSubscription(false, image => {
      const at = performance.now() - started, size = image.getSize(), sx = size.width / 1180, sy = size.height / 780
      const hash = {}
      for (const [name, rect] of Object.entries({ scene: [500, 30, 430, 740], negative: [930, 440, 160, 36] })) {
        const [x,y,w,h] = rect
        hash[name] = createHash('sha256').update(image.crop({ x: Math.round(x*sx), y: Math.round(y*sy), width: Math.round(w*sx), height: Math.round(h*sy) }).toBitmap()).digest('hex')
      }
      frames.push({ at, hash })
      if (at - lastSaved >= 160) { lastSaved = at; images.push({ at, data: image.toBitmap(), size }) }
    })
    // Readiness publishes a plan before the Renderer commits the visible
    // compositor layer. Match the camera fixture's native capture admission.
    await deadline((async () => { while (frames.length < 2) await delay(10) })(), 500, 'Cross-page capture reattachment')
    const blockedAt = performance.now() - started, blockMs = Number(process.argv[3] ?? 2000)
    if (blockedAt > ready.duration * .25) throw new Error('Cross-page capture missed the beginning of the flight')
    await contents.executeJavaScript(`window.bartCrossPage.block(${blockMs})`)
    const unblockedAt = performance.now() - started
    await delay(120)
    contents.endFrameSubscription()
    await Promise.all(images.map((image, index) => writeFile(path.join(output, `cross-page-${direction}-${index}-${Math.round(image.at)}.png`), nativeImage.createFromBitmap(image.data, image.size).toPNG())))
    const after = await contents.executeJavaScript('window.bartCrossPage.status()')
    const resources = await contents.executeJavaScript('window.bartCrossPage.inspect()')
    const moving = regionMetrics(frames, 'scene', Math.max(blockedAt, 50), ready.duration - 60)
    const negative = regionMetrics(frames, 'negative', blockedAt + 400, unblockedAt - 75)
    results.push({ direction, ready, blockedAt, unblockedAt, moving, negative, after, resources, frames })
    await writeFile(path.join(output, 'cross-page.json'), JSON.stringify(results, null, 2))
    if (moving.unique < 5 || moving.maxObservedHold >= 100 || negative.maxObservedHold < blockMs - 650) throw new Error('Cross-page Worker flight froze or negative control did not freeze')
    if (after.flying || after.sealed || resources.textures !== 0 ||
      (direction === 'to-seat' ? after.seatVisible : after.dockVisible) !== 'visible') throw new Error('Cross-page flight did not hand off native ownership')
  }
  console.log('BART_CROSS_PAGE', JSON.stringify({ output, results: results.map(({ frames, ...result }) => ({ ...result, frames: frames.length })) }))
}

async function verifyCameraFlight(contents, output) {
  await deadline((async () => {
    while (!(await contents.executeJavaScript('Boolean(window.bartCamera)'))) await delay(30)
  })(), 10000, 'Eye-dive scene mount')
  // Warm Main's native readback before submitting the short shot.
  let sampled = 0
  contents.beginFrameSubscription(false, () => { sampled++ })
  await deadline((async () => { while (sampled < 3) await delay(20) })(), 5000, 'Camera capture calibration')
  contents.endFrameSubscription()
  const results = []
  for (const direction of [true, false]) {
    await contents.executeJavaScript(`window.bartCamera.fly(${direction})`)
    let status
    await deadline((async () => {
      while (!(status = await contents.executeJavaScript('window.bartCamera.status()')).ready) await delay(20)
    })(), 12000, `Eye-dive ${direction} ready`).catch(error => { console.error('CROSS_PAGE_STATUS', status); throw error })
    const ready = status.ready
    const elapsed = await contents.executeJavaScript('performance.timeOrigin + performance.now() - performance.getEntriesByName("bart-camera-ready").at(-1).detail.origin')
    const started = performance.now() - elapsed, frames = [], images = []
    let lastSaved = -Infinity
    contents.beginFrameSubscription(false, image => {
      const at = performance.now() - started, size = image.getSize(), sx = size.width / 1180, sy = size.height / 780
      const hash = {}
      for (const [name, rect] of Object.entries({ scene: [0, 90, 1180, 690], negative: [10, 5, 160, 36] })) {
        const [x,y,w,h] = rect
        hash[name] = createHash('sha256').update(image.crop({ x: Math.round(x*sx), y: Math.round(y*sy), width: Math.round(w*sx), height: Math.round(h*sy) }).toBitmap()).digest('hex')
      }
      frames.push({ at, hash })
      if (at - lastSaved >= 160) { lastSaved = at; images.push({ at, data: image.toBitmap(), size }) }
    })
    // Re-subscribing after the previous shot needs a fresh native capture. Do
    // not freeze the Renderer before it has published the newly shown canvas.
    // These are Main content frames, not Renderer rAF or a presentation claim.
    await deadline((async () => { while (frames.length < 2) await delay(10) })(), 500, 'Camera capture reattachment')
    const blockedAt = performance.now() - started, blockMs = Number(process.argv[3] ?? 2000)
    if (blockedAt > ready.duration * .25) throw new Error('Camera capture missed the beginning of the shot')
    await contents.executeJavaScript(`window.bartCamera.block(${blockMs})`)
    const unblockedAt = performance.now() - started
    await delay(120)
    contents.endFrameSubscription()
    await Promise.all(images.map((image, index) => writeFile(path.join(output, `camera-${direction}-${index}-${Math.round(image.at)}.png`), nativeImage.createFromBitmap(image.data, image.size).toPNG())))
    const after = await contents.executeJavaScript('window.bartCamera.status()')
    const resources = await contents.executeJavaScript('window.bartCamera.inspect()')
    const moving = regionMetrics(frames, 'scene', Math.max(blockedAt, direction ? 50 : ready.duration * .45), ready.duration * (direction ? .65 : .96))
    const negative = regionMetrics(frames, 'negative', blockedAt + 400, unblockedAt - 75)
    results.push({ direction, ready, blockedAt, unblockedAt, moving, negative, after, resources, frames })
    await writeFile(path.join(output, 'camera.json'), JSON.stringify(results, null, 2))
    if (moving.unique < 5 || moving.maxObservedHold >= 100 || negative.maxObservedHold < blockMs - 650) throw new Error('Eye-dive Worker flight froze or negative control did not freeze')
    if (after.active || after.sealed || after.inert || after.inside !== direction || resources.textures !== 0 || after.visibility !== 'visible' || after.opacity !== '1') throw new Error('Eye-dive flight did not hand off native ownership')
  }
  console.log('BART_CAMERA', JSON.stringify({ output, results: results.map(({ frames, ...result }) => ({ ...result, frames: frames.length })) }))
}

async function verifyInterruption(contents, output, camera) {
  const api = camera ? 'bartCamera' : 'bartCrossPage'
  const mark = camera ? 'bart-camera-redirect' : 'bart-cross-page-redirect'
  const command = inside => `window.${api}.fly(${camera ? inside : JSON.stringify(inside ? 'to-seat' : 'to-dock')})`
  await deadline((async () => {
    while (!(await contents.executeJavaScript(`Boolean(window.${api} && document.querySelector('.bart-logo[data-worker-ready]'))`))) await delay(20)
  })(), 10000, 'Interruption residents ready')
  await delay(250)
  const results = []
  let seated = false
  for (const { reversals, initial } of [{ reversals: 1, initial: true }, { reversals: 3, initial: true },
    { reversals: 1, initial: false }, { reversals: 3, initial: false }]) {
    if (seated !== !initial) {
      await contents.executeJavaScript(command(!initial))
      await deadline((async () => {
        while (true) {
          const status = await contents.executeJavaScript(`window.${api}.status()`)
          if (camera ? !status.active && status.inside === !initial : !status.flying && status.seatVisible === 'visible') break
          await delay(20)
        }
      })(), 4000, 'Opposite native seat')
      seated = !initial
    }
    const frames = [], images = []
    let saved = -Infinity
    contents.beginFrameSubscription(false, image => {
      const at = performance.now(), size = image.getSize(), sx = size.width / 1180, sy = size.height / 780
      const hash = {}
      const regions = camera ? { scene: [0, 90, 1180, 690], negative: [10, 5, 160, 36] } :
        { scene: [300, 50, 630, 720], negative: [930, 440, 160, 36] }
      for (const [name, [x, y, w, h]] of Object.entries(regions)) hash[name] = createHash('sha256').update(image.crop({
        x: Math.round(x*sx), y: Math.round(y*sy), width: Math.round(w*sx), height: Math.round(h*sy) }).toBitmap()).digest('hex')
      frames.push({ at, hash })
      if (at - saved > 80 && images.length < 24) { saved = at; images.push({ at, data: image.toBitmap(), size }) }
    })
    await contents.executeJavaScript(command(initial))
    let ready
    await deadline((async () => {
      while (!(ready = (await contents.executeJavaScript(`window.${api}.status()`)).ready)) await delay(10)
    })(), 10000, 'Original interruption route')
    const elapsed = await contents.executeJavaScript(`performance.timeOrigin + performance.now() - ${ready.origin}`)
    // An exit starts with the session filling the viewport. Interrupt after
    // the eye has visibly pulled back, rather than reversing that static hold.
    await delay(Math.max(0, ready.duration * (camera && !initial ? .66 : .32) - elapsed))
    const boundaries = []
    let target = initial
    for (let i = 0; i < reversals; i++) {
      target = !target
      boundaries.push(await contents.executeJavaScript(`(() => {
        const selector = ${JSON.stringify(camera ? '.pg-camera-canvas' : '[data-bart-cross-page-flight]')};
        const before = document.querySelector(selector);
        const matrix = before && getComputedStyle(before).transform;
        ${command(target)};
        const after = document.querySelector(selector);
        return { sameCanvas: Boolean(before && before === after && !after.hidden), matrix,
          nextMatrix: after && getComputedStyle(after).transform };
      })()`))
      if (i + 1 < reversals) await delay(65)
    }
    const redirected = await contents.executeJavaScript(`performance.getEntriesByName('${mark}').at(-1)?.detail`)
    if (!redirected) throw new Error('Direction change restarted or discarded the scene')
    const observedAt = performance.now()
    const currentElapsed = await contents.executeJavaScript(`performance.timeOrigin + performance.now() - ${redirected.origin}`)
    const origin = observedAt - currentElapsed
    const sampled = frames.length
    await deadline((async () => { while (frames.length < sampled + 2) await delay(5) })(), 500, 'Redirect compositor publication')
    const blockedAt = performance.now(), blockMs = Number(process.argv[3] ?? 2000)
    await contents.executeJavaScript(`window.${api}.block(${blockMs})`)
    const unblockedAt = performance.now()
    await delay(100)
    contents.endFrameSubscription()
    const after = await contents.executeJavaScript(`window.${api}.status()`)
    const resources = await contents.executeJavaScript(`window.${api}.inspect()`)
    // Returning into the eye reveals the full, stationary session before the
    // program endpoint. Measure the visible travel, not that intended hold.
    const movingEnd = camera && !initial ? origin + redirected.duration * .4 : origin + redirected.duration - 55
    const moving = regionMetrics(frames, 'scene', blockedAt + 25, movingEnd)
    const negative = regionMetrics(frames, 'negative', blockedAt + 350, unblockedAt - 75)
    const report = { reversals, initial, ready, redirected, boundaries, after, resources, moving, negative, blockedAt, unblockedAt, frames }
    results.push(report)
    await writeFile(path.join(output, 'interruption.json'), JSON.stringify(results, null, 2))
    await Promise.all(images.map((image, index) => writeFile(path.join(output, `interrupt-${initial}-${reversals}-${index}.png`), nativeImage.createFromBitmap(image.data, image.size).toPNG())))
    if (boundaries.some(boundary => !boundary.sameCanvas)) throw new Error('Reversal discarded its visible surface')
    if (!camera) for (const boundary of boundaries) {
      const numbers = value => value?.match(/matrix\((.*)\)/)?.[1].split(',').map(Number)
      const a = numbers(boundary.matrix), b = numbers(boundary.nextMatrix)
      if (!a || !b || Math.max(...a.map((n, i) => Math.abs(n - b[i]))) > 1) throw new Error(`Flight jumped at interruption: ${JSON.stringify(boundary)}`)
    }
    if (moving.unique < 4 || moving.maxObservedHold >= 100 || negative.maxObservedHold < blockMs - 600) throw new Error(`Interrupted motion froze: ${JSON.stringify({ moving, negative })}`)
    if (after.sealed || resources.textures || (camera ? after.active || after.inside !== target || after.inert : after.flying || (target ? after.seatVisible : after.dockVisible) !== 'visible')) throw new Error('Interrupted scene did not hand off to its latest destination')
    seated = target
  }
  if (!camera) {
    // The original source becomes the destination after reversing a to-dock
    // flight. Moving only that seat must invalidate the retained geometry.
    await contents.executeJavaScript(command(false))
    await deadline((async () => { while (!(await contents.executeJavaScript(`window.${api}.status()`)).ready) await delay(10) })(), 1000, 'Invalidation flight')
    await delay(140)
    await contents.executeJavaScript(command(true))
    await contents.executeJavaScript(`document.querySelector('.bart-host-character').style.translate = '20px 0'`)
    await deadline((async () => { while ((await contents.executeJavaScript(`window.${api}.status()`)).flying) await delay(5) })(), 150, 'Redirect source invalidation')
    if ((await contents.executeJavaScript(`window.${api}.inspect()`)).textures !== 0) throw new Error('Invalidated source kept its assets')
  }
  console.log('BART_INTERRUPTION', JSON.stringify({ output, camera, results: results.map(({ frames, ...result }) => ({ ...result, frames: frames.length })) }))
}

async function verifySettingsScene(contents, output) {
  await deadline((async () => { while (!(await contents.executeJavaScript('Boolean(window.bartSettings)'))) await delay(20) })(), 10000, 'Settings mount')
  const read = () => contents.executeJavaScript('window.bartSettings.status()')
  const settled = action => deadline((async () => {
    let status
    for (;;) { status = await read(); if (!status.active && !status.sealed && (action === 'close' ? !status.phase : status.phase === 'open')) return status; await delay(20) }
  })(), 12000, `Settings ${action} native recovery`)
  // One explicit cold setup cycle, not a retry of a measured failure. Production
  // may decline an optional flight under its 250ms admission budget; in that
  // case the native page must still recover without ownership or texture leaks.
  const warm = []
  for (const action of ['open', 'close']) {
    await contents.executeJavaScript(`window.bartSettings.act('${action}')`)
    const status = await settled(action)
    const resources = await contents.executeJavaScript('window.bartSettings.inspect()')
    if (resources.textures) throw new Error('Settings warmup/fallback leaked textures')
    warm.push({ action, status, resources })
  }
  const clock = await calibrateClock(contents)
  const results = [], blockMs = Number(process.argv[3] ?? 2000)
  const report = () => writeFile(path.join(output, 'settings.json'), JSON.stringify({ clock, warm, results }, null, 2))
  for (const action of ['open', 'host', 'target', 'close']) {
    const frames = [], images = [], before = await read(), map = before.map
    const flowAction = action === 'host' || action === 'target'
    const captureStart = performance.now() + clock.offset
    let lastSaved = -Infinity
    // Keep this subscription alive through calibration, action and recovery.
    contents.beginFrameSubscription(false, image => {
      const at = performance.now() + clock.offset, size = image.getSize(), sx = size.width / 1180, sy = size.height / 780, hash = {}
      const regions = { scene: [0, 80, 1180, 700], negative: [10, 5, 160, 36], heartbeat: [185, 5, 110, 32] }
      if (map) Object.assign(regions, { host: [map.x + 10, map.y + 8, map.width - 20, 115], flow: [map.x + 20, map.y + 125, map.width - 40, 55] })
      for (const [name, [x,y,w,h]] of Object.entries(regions)) hash[name] = createHash('sha256').update(image.crop({
        x: Math.round(x*sx), y: Math.round(y*sy), width: Math.round(w*sx), height: Math.round(h*sy) }).toBitmap()).digest('hex')
      frames.push({ at, hash })
      if (images.length < 10 && at - lastSaved >= 550) {
        lastSaved = at
        const preview = image.resize({ width: 1180 })
        images.push({ at, data: preview.toBitmap(), size: preview.getSize() })
      }
    })
    try {
      // Two 550ms dispatch visual periods. At the observed ~30Hz capture cadence
      // this supplies ~33 samples, independently of the display's 120Hz refresh.
      await delay(1100)
      const calibration = frames.filter(frame => frame.at >= captureStart)
      const entry = { action, calibration: { ...progress(calibration, 'heartbeat'), durationMs: performance.now() + clock.offset - captureStart }, frames }
      results.push(entry)
      await report()
      requireCapture(calibration, 20, `Settings ${action} capture calibration`)
      const reference = flowAction ? requireProgress(calibration, 'flow', 10, `Settings ${action} unblocked control`) : undefined
      entry.reference = reference
      const measurement = await deadline(contents.executeJavaScript(`window.bartSettings.measure('${action}', ${blockMs})`), 12000 + blockMs, `Settings ${action} measurement`)
      if (measurement.skipped) {
        const after = await settled(action), resources = await contents.executeJavaScript('window.bartSettings.inspect()')
        Object.assign(entry, { ...measurement, after, resources })
        if (resources.textures || after.sealed || after.active || (action !== 'close' && after.dispatch !== 'true')) throw new Error('Declined settings flight failed native recovery')
        if (/Bart (preparation exceeded its budget|cross-page admission expired|scene sealing exceeded its budget)/.test(measurement.skipped.reason)) {
          throw new CaptureUnavailable(`Settings ${action}: production declined optional flight (${JSON.stringify(measurement.skipped)}); native fallback recovered but isolation was not measured`)
        }
        throw new Error(`Settings ${action} preparation failed: ${JSON.stringify(measurement.skipped)}`)
      }
      const { ready, blockedAt, unblockedAt } = measurement
      Object.assign(entry, measurement)
      if (!Number.isFinite(measurement.blockedMs) || measurement.blockedMs < blockMs) throw new Error(`Settings ${action}: renderer did not execute the requested block`)
      const after = await settled(action)
      // An explicit recovery window catches a Worker that updates before or
      // during the block but never resumes afterwards. Do not use draw counters.
      // Closing the native page can rebuild the capture pipeline after DOM has
      // settled. Admit three independent compositor images first; never wait
      // for product pixels to change, which would hide a frozen Worker.
      const recoveryRequested = performance.now() + clock.offset
      await deadline((async () => {
        while (progress(frames.filter(frame => frame.at >= recoveryRequested), 'heartbeat').opportunities < 3) await delay(10)
      })(), 12000, 'Settings recovery capture admission').catch(error => { throw new CaptureUnavailable(error.message) })
      const recoveryStart = performance.now() + clock.offset
      await delay(1100)
      contents.endFrameSubscription()
      const resources = await contents.executeJavaScript('window.bartSettings.inspect()')
      const select = (start, end) => frames.filter(frame => frame.at >= start + clock.uncertainty && frame.at <= end - clock.uncertainty)
      const movingFrames = select(Math.max(ready.origin + 50, blockedAt), ready.origin + ready.duration - 70)
      const negativeFrames = select(blockedAt + blockMs * .08, unblockedAt - blockMs * .015)
      const flowStart = Math.max(ready.origin + 900, blockedAt + blockMs * .08)
      const flowEnd = unblockedAt - blockMs * .015
      const flowFrames = select(flowStart, flowEnd)
      const recovery = select(recoveryStart, recoveryStart + 1100)
      Object.assign(entry, { after, resources, recoveryRequested, recoveryStart, flowStart, flowEnd,
        moving: progress(movingFrames, flowAction ? 'host' : 'scene'), negative: progress(negativeFrames, 'negative'),
        flow: flowAction ? progress(flowFrames, 'flow') : undefined,
        recovered: flowAction ? progress(recovery, 'flow') : undefined })
      await report()
      await Promise.all(images.map((image, index) => writeFile(path.join(output, `settings-${action}-${index}.png`), nativeImage.createFromBitmap(image.data, image.size).toPNG())))
      if (after.sealed || resources.textures !== 0 || (action === 'close' ? after.phase !== undefined : after.phase !== 'open' || after.dispatch !== 'true')) throw new Error('Settings scene failed to restore native state')
      if (blockedAt - ready.origin > ready.duration * .25) throw new CaptureUnavailable(`Settings ${action}: renderer frame admission missed the first quarter (${blockedAt - ready.origin}ms)`)
      requireCapture(movingFrames, 6, `Settings ${action} motion capture`)
      if (entry.moving.unique < 6) throw new Error(`Settings ${action} movement froze`)
      requireCapture(negativeFrames, 20, `Settings ${action} negative capture`)
      requireCoverage(negativeFrames, blockedAt + blockMs * .08, unblockedAt - blockMs * .015, `Settings ${action} blocked capture`, entry.calibration)
      if (entry.negative.unique !== 1) throw new CaptureUnavailable(`Settings ${action}: delivered control frames straddled the recorded renderer block; image age is not bounded by IPC clock calibration`)
      requireProgress(recovery, 'negative', 10, `Settings ${action} renderer recovery`)
      requireCoverage(recovery, recoveryStart, recoveryStart + 1100, `Settings ${action} recovery capture`, entry.calibration)
      if (flowAction) {
        requireProgress(flowFrames, 'flow', 10, `Settings ${action} blocked dispatch`, reference)
        requireProgress(recovery, 'flow', 10, `Settings ${action} recovered dispatch`, reference)
      }
    } finally { contents.endFrameSubscription(); await report() }
  }
  console.log('BART_SETTINGS', JSON.stringify({ output, clock, results: results.map(({ frames, ...value }) => ({ ...value, frames: frames.length })) }))
  await writeFile(path.join(output, 'outcome.json'), JSON.stringify({ status: 'passed' }))
}

app.whenReady().then(async () => {
let window
let tracing = false
try {
  const launchedAt = performance.now()
  window = new BrowserWindow({ width: 1180, height: 780, useContentSize: true, show: true,
    // Keep the foreground blocking test visible to the OS. Explicit hide/show
    // below still verifies background suspension, with normal throttling.
    alwaysOnTop: true,
    // Same opaque window as production: no native material is expected to show.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#20211f' : '#f8f7f4',
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true } })
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  const contents = window.webContents
  contents.on('console-message', (_event, ...details) => {
    const detail = details[0]
    if (typeof detail === 'object' ? detail.level >= 2 : detail >= 2) console.error('renderer:', ...details)
  })
  const entry = process.env.BART_ISOLATION_ENTRY ?? path.join(desktop, 'out/bart-lab/isolation.html')
  await window.loadFile(entry, process.argv[2] === '--message' ? { search: '?message' } : process.argv[2] === '--settings' ? { search: '?settings' } : process.argv[2] === '--camera' ? { search: '?camera' } : process.argv[2] === '--generation' ? { search: '?production' } : process.argv[2] === '--cross-page' ? { search: '?cross-page' } : undefined)
  const loadMs = performance.now() - launchedAt
  window.show(); window.focus()
  if (process.argv[2] === '--message') {
    await contentTracing.startRecording({ included_categories: ['cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline'] })
    tracing = true
    await verifyMessageArrival(contents, output)
    await contentTracing.stopRecording(path.join(output, 'trace.json'))
    tracing = false
    window.destroy(); app.exit(0); return
  }
  if (process.argv[2] === '--settings') {
    await contentTracing.startRecording({ included_categories: ['cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline'] })
    tracing = true
    await verifySettingsScene(contents, output)
    await contentTracing.stopRecording(path.join(output, 'trace.json'))
    tracing = false
    window.destroy(); app.exit(0); return
  }
  if (process.argv[2] === '--camera') {
    await contentTracing.startRecording({ included_categories: ['cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline'] })
    tracing = true
    if (process.argv.includes('--interrupt')) await verifyInterruption(contents, output, true)
    else await verifyCameraFlight(contents, output)
    await contentTracing.stopRecording(path.join(output, 'trace.json'))
    tracing = false
    window.destroy(); app.exit(0); return
  }
  if (process.argv[2] === '--cross-page') {
    await contentTracing.startRecording({ included_categories: ['cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline'] })
    tracing = true
    if (process.argv.includes('--interrupt')) await verifyInterruption(contents, output, false)
    else await verifyCrossPageFlight(contents, output)
    await contentTracing.stopRecording(path.join(output, 'trace.json'))
    tracing = false
    window.destroy(); app.exit(0); return
  }
  if (process.argv[2] === '--generation') {
    await contentTracing.startRecording({ included_categories: ['cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline'] })
    tracing = true
    await verifyProductionGeneration(contents, output)
    await contentTracing.stopRecording(path.join(output, 'trace.json'))
    tracing = false
    window.destroy(); app.exit(0); return
  }
  await deadline((async () => {
    while (!(await contents.executeJavaScript('Boolean(window.bartIsolation)'))) await delay(50)
  })(), 10000, 'Lab mount')
  await deadline((async () => {
    while (!(await contents.executeJavaScript(`document.querySelectorAll('.bart-logo[data-worker-ready="true"]').length === 39 && Boolean(document.querySelector('.bart-reply-target'))`))) await delay(30)
  })(), 10000, 'Resident surfaces ready')
  const residentReadyMs = performance.now() - launchedAt
  // Keep capture delivery active after the finite scene reaches its terminal
  // frame. This independent compositor pulse lies outside every inspected ROI;
  // resident pixels and the frozen Renderer control still decide the result.
  await contents.executeJavaScript(`(() => {
    const pulse = document.createElement('div'); pulse.setAttribute('aria-hidden', 'true');
    pulse.style.cssText = 'position:fixed;inset:0;width:1180px;height:780px;pointer-events:none;background:linear-gradient(to right,transparent calc(100% - 12px),#5d8068 0);z-index:100000';
    document.body.append(pulse);
    pulse.animate([{ opacity: .4 }, { opacity: 1 }], { duration: 900, direction: 'alternate', iterations: Infinity });
  })()`)
  await writeFile(path.join(output, 'mounted.png'), (await contents.capturePage()).toPNG())
  const firstCapturedMs = performance.now() - launchedAt
  if (process.argv[2] === '--residents') {
    await contentTracing.startRecording({ included_categories: ['cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline'] })
    tracing = true
    await verifyResidentInterventions(contents, output)
    await contentTracing.stopRecording(path.join(output, 'trace.json'))
    tracing = false
    window.destroy(); app.exit(0); return
  }
  const nativeFocusAvailable = await contents.executeJavaScript(`(() => {
    const button = document.querySelector('.thread-overview-item-open'); button.focus();
    return document.activeElement === button;
  })()`)
  const prepared = await deadline(contents.executeJavaScript('window.bartIsolation.prepare()'), 30000, 'Resource preparation')
  const loadedResources = await contents.executeJavaScript('window.bartIsolation.inspect()')
  console.log('BART_PREPARED', JSON.stringify(prepared))
  const regions = {
    scene: { x: 25, y: 70, width: 680, height: 410 },
    icons: { x: 930, y: 110, width: 205, height: 190 },
    settings: { x: 735, y: 295, width: 160, height: 140 },
    occlusion: { x: 737, y: 267, width: 46, height: 24 },
    scrollText: { x: 965, y: 120, width: 75, height: 165 },
    clip: { x: 960, y: 340, width: 180, height: 15 },
    reply: { x: 608, y: 463, width: 176, height: 57 },
    negative: { x: 70, y: 440, width: 160, height: 36 }
  }
  const bodyBlock = prepared.revealBlocks.filter(block => block.rect.height > 30 && block.rect.width > 100)[0]
  if (!bodyBlock) throw new Error('Real card body reveal was not prepared')
  regions.body = bodyBlock.rect
  prepared.cards.forEach((rect, index) => { regions[`card${index}`] = { ...rect, width: Math.min(rect.width, 700 - rect.x) } })
  const frames = [], images = []
  const captureEnabled = process.env.BART_TRACE_ONLY !== '1'
  const start = performance.now()
  let lastSaved = -Infinity
  if (captureEnabled) contents.beginFrameSubscription(false, image => {
    const at = performance.now() - start
    // Analyse at one captured pixel per CSS pixel. The DPR-2 window and
    // full-resolution mounted/held/handoff images remain unchanged. Copying an
    // entire Retina frame into JS on every sample can pressure Main's GC and
    // disturb capture while Chromium's compositor continues submitting.
    const sampled = image.resize({ width: 1180, height: 780, quality: 'good' })
    const size = sampled.getSize(), scaleX = size.width / 1180, scaleY = size.height / 780
    const pixels = sampled.toBitmap()
    const hash = {}
    let bodyInk = 0
    for (const [name, rect] of Object.entries(regions)) {
      // Read each captured bitmap once. Per-region nativeImage crops allocate
      // extra full raster copies and can introduce GC pauses in the sampler.
      const x = Math.floor(rect.x * scaleX), y = Math.floor(rect.y * scaleY)
      const width = Math.floor(rect.width * scaleX), height = Math.floor(rect.height * scaleY)
      const digest = createHash('sha256')
      for (let row = y; row < y + height; row++) {
        const line = pixels.subarray((row * size.width + x) * 4, (row * size.width + x + width) * 4)
        digest.update(line)
        if (name === 'body') for (let index = 0; index < line.length; index += 4) {
          if (line[index] < 210 && line[index + 1] < 210 && line[index + 2] < 210) bodyInk++
        }
      }
      hash[name] = digest.digest('hex')
    }
    frames.push({ at, hash, bodyInk })
    if (at - lastSaved >= 250) { lastSaved = at; images.push({ at, data: pixels, size }) }
  })
  await contentTracing.startRecording({ included_categories: ['cc', 'viz', 'gpu', 'blink', 'blink.user_timing', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'benchmark'] })
  tracing = true
  const startedAt = performance.now() - start
  await contents.executeJavaScript('window.bartIsolation.play()')
  const beforeBlock = await contents.executeJavaScript(`(() => {
    const card = document.querySelector('.thread-overview-item'); card.querySelector('button').focus();
    return { status: window.bartIsolation.status(), cardCanFocus: card.contains(document.activeElement),
      cardHittable: card.contains(document.elementFromPoint(200, 180)) };
  })()`)
  await delay(Number(process.argv[3] ?? 160))
  const blockMs = Number(process.argv[2] ?? 5000)
  // Chromium owns a continuous native wheel gesture, including its phase and
  // latching. Independent sendInputEvent wheels can await a new Host hit test.
  contents.debugger.attach('1.3')
  let layers
  contents.debugger.on('message', (_event, method, params) => { if (method === 'LayerTree.layerTreeDidChange') layers = params.layers })
  await contents.debugger.sendCommand('LayerTree.enable')
  await delay(50)
  await writeFile(path.join(output, 'layers.json'), JSON.stringify(layers ?? [], null, 2))
  const scrolling = contents.debugger.sendCommand('Input.synthesizeScrollGesture', {
    x: 1040, y: 185, yDistance: -190, speed: 100, gestureSourceType: 'mouse', preventFling: true
  })
  await deadline((async () => {
    while ((await contents.executeJavaScript('document.querySelector("[data-scroll]").scrollTop')) < 1) await delay(20)
  })(), 3000, 'Native scroll gesture start')
  await contents.executeJavaScript('window.bartIsolation.reply(true)')
  const blockStart = performance.now() - start
  const blocked = await contents.executeJavaScript(`window.bartIsolation.block(${blockMs})`)
  const blockEnd = performance.now() - start
  await scrolling
  contents.debugger.detach()
  await delay(Math.max(300, prepared.duration - (performance.now() - start - startedAt) + 200))
  const state = await contents.executeJavaScript('window.bartIsolation.status()')
  await writeFile(path.join(output, 'held.png'), (await contents.capturePage()).toPNG())
  const handoffAt = performance.now() - start
  await contents.executeJavaScript('window.bartIsolation.release()')
  const handedOff = await contents.executeJavaScript('window.bartIsolation.status()')
  const restoredInteraction = await contents.executeJavaScript(`(() => {
    const card = document.querySelector('.thread-overview-item'); card.querySelector('button').focus();
    return { focused: card.contains(document.activeElement), hittable: card.contains(document.elementFromPoint(200, 180)) };
  })()`)
  await delay(300)
  await writeFile(path.join(output, 'handoff.png'), (await contents.capturePage()).toPNG())
  if (captureEnabled) contents.endFrameSubscription()
  await contentTracing.stopRecording(path.join(output, 'trace.json'))
  tracing = false
  const releasedResources = await contents.executeJavaScript('window.bartIsolation.inspect()')
  window.hide()
  await delay(300)
  const hiddenBefore = await contents.executeJavaScript('window.bartIsolation.inspect()')
  await delay(400)
  const hiddenAfter = await contents.executeJavaScript('window.bartIsolation.inspect()')
  window.show(); window.focus()
  await delay(200)
  const resumed = await contents.executeJavaScript('window.bartIsolation.inspect()')
  const warm = await contents.executeJavaScript('window.bartIsolation.prepare()')
  await contents.executeJavaScript('window.bartIsolation.play()')
  const staleHandoff = await contents.executeJavaScript(`(() => {
    const released = window.bartIsolation.staleRelease();
    return { released, status: window.bartIsolation.status() };
  })()`)
  await contents.executeJavaScript('window.bartIsolation.invalidate(); window.bartIsolation.release()')
  const invalidated = await contents.executeJavaScript('window.bartIsolation.status()')
  const finalResources = await contents.executeJavaScript('window.bartIsolation.inspect()')
  const stress = await contents.executeJavaScript('window.bartIsolation.stress()')
  await Promise.all(images.map((image, index) => writeFile(path.join(output, `frame-${String(index).padStart(4, '0')}-${Math.round(image.at)}.png`),
    nativeImage.createFromBitmap(image.data, image.size).toPNG())))
  const trace = JSON.parse(await readFile(path.join(output, 'trace.json'), 'utf8'))
  const traceNames = [...new Set(trace.traceEvents.filter(event => /present|FrameSequence|BeginFrame|DrawFrame/i.test(event.name)).map(event => event.name))]
  const draws = trace.traceEvents.filter(event => event.name === 'DirectRenderer::DrawFrame').map(event => event.ts).sort((a, b) => a - b)
  const drawGaps = draws.slice(1).map((time, index) => (time - draws[index]) / 1000)
  const presentationSubmissions = { samples: draws.length, p50: percentile(drawGaps, .5), p95: percentile(drawGaps, .95),
    p99: percentile(drawGaps, .99), max: Math.max(...drawGaps), gapsOver100: drawGaps.filter(gap => gap >= 100).length }
  const metrics = Object.fromEntries(Object.keys(regions).map(name => [name, regionMetrics(frames, name,
    // A pre-block Canvas2D frame may already be queued in the GPU. Let only the
    // negative control drain that queue; active Worker regions get no exclusion.
    blockMs ? blockStart + (name === 'negative' ? 400 : 75) : startedAt + 100,
    blockMs ? blockEnd - 75 : startedAt + prepared.duration - 100)]))
  const reveals = prepared.phases.filter(phase => phase.name.startsWith('reveal:')).map(phase => {
    const index = Number(phase.name.split(':')[1]), next = prepared.phases.find(item => item.at > phase.at)
    return { name: phase.name, ...regionMetrics(frames, `card${index}`, startedAt + phase.at + 100, startedAt + next.at - 100) }
  })
  const continuousMotion = prepared.phases.filter(phase => /^(fly:|morph:|return$)/.test(phase.name)).map(phase => {
    const next = prepared.phases.find(item => item.at > phase.at)
    return { name: phase.name, ...regionMetrics(frames, 'scene', startedAt + phase.at + 75, startedAt + next.at - 75) }
  })
  const report = { output, electron: process.versions.electron, chrome: process.versions.chrome,
    startup: { loadMs, residentReadyMs, firstCapturedMs }, nativeFocusAvailable, restoredInteraction,
    display: screen.getDisplayMatching(window.getBounds()), prepared, startedAt, blockMs, blocked, blockStart, blockEnd,
    handoffAt, state, handedOff, beforeBlock, reveals, continuousMotion,
    warm: { preparedMs: warm.preparedMs, prewarmMs: warm.prewarmMs, sealedMs: warm.sealedMs }, staleHandoff, invalidated,
    resources: { loaded: loadedResources, released: releasedResources, hiddenBefore, hiddenAfter, resumed, final: finalResources, stress },
    metrics, traceNames, presentationSubmissions, captureEnabled, capturePixelRatio: 1, frames }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log('BART_ISOLATION', JSON.stringify({ ...report, prepared: { ...prepared, revealBlocks: prepared.revealBlocks.length }, frames: frames.length }))
  // The 100ms content detector alone is not a fluidity budget. At 120Hz the
  // calibrated P99 compositor submission budget is two refresh periods (~16.7ms).
  // Trace timestamps have integer-microsecond precision. Round the two-refresh
  // budget to that precision and subtract timestamps before converting units;
  // otherwise a valid 16,667µs pair fails against 120.0006Hz by less than 1µs.
  const submissionBudget = Math.ceil(2_000_000 / Math.max(60, report.display.displayFrequency)) / 1000
  if (presentationSubmissions.p99 === null || presentationSubmissions.p99 > submissionBudget) throw new Error(`Compositor P99 exceeded ${submissionBudget.toFixed(2)}ms: ${presentationSubmissions.p99}`)
  if (captureEnabled && blockMs && metrics.negative.maxObservedHold < blockMs - 600) throw new Error('Negative control did not expose the intentional freeze')
  if (captureEnabled && continuousMotion.some(phase => phase.maxObservedHold >= 100)) throw new Error('An active motion region froze for 100ms; see actual frames and trace before accepting isolation')
  if (captureEnabled && metrics.icons.maxObservedHold >= 100) throw new Error('Continuously active resident content froze for 100ms')
  if (captureEnabled && (metrics.scene.unique < 5 || metrics.icons.unique < 5 || metrics.settings.unique < 5)) throw new Error('Worker content did not keep producing visible frames during the renderer block')
  if (captureEnabled && metrics.occlusion.unique !== 1) throw new Error('Worker scene escaped the settings occlusion boundary')
  if (captureEnabled && metrics.clip.unique !== 1) throw new Error('Small Logos escaped the native scrolling clip')
  if (captureEnabled && blockMs && (metrics.scrollText.unique < 5 || state.scrollTop < 50)) throw new Error('Native clipped scrolling stopped during the renderer block')
  if (beforeBlock.cardCanFocus || beforeBlock.cardHittable || !beforeBlock.status.coveredInert) throw new Error('Covered business DOM retained interaction ownership')
  if (!nativeFocusAvailable || !restoredInteraction.focused || !restoredInteraction.hittable) throw new Error('Native business interaction did not recover after handoff')
  if (handedOff.owned || handedOff.coveredInert || handedOff.state !== 'handed-off') throw new Error('Host handoff retained a scene lock')
  if (releasedResources.textureBytes !== 0 || releasedResources.textures !== 0) throw new Error('Host handoff retained scene textures')
  if (hiddenAfter.visible || hiddenAfter.draws !== hiddenBefore.draws) throw new Error('Hidden surfaces continued drawing')
  if (!resumed.visible || resumed.draws <= hiddenAfter.draws) throw new Error('Resident surfaces did not resume')
  if (staleHandoff.released || !staleHandoff.status.owned) throw new Error('An old Host handoff released the new scene')
  if (invalidated.owned || invalidated.coveredInert || invalidated.state !== 'aborted-to-current-dom') throw new Error('A changed business revision did not recover current DOM')
  if (finalResources.textureBytes || finalResources.surfaces !== releasedResources.surfaces) throw new Error('A superseded scene retained resources')
  // 39 character surfaces plus the scene; the static reply owns no Worker surface.
  if (stress.rounds.some(round => round.rejected !== 8 || round.peak.surfaces !== 96) ||
      stress.final.surfaces !== releasedResources.surfaces || stress.final.pixels !== releasedResources.pixels) throw new Error('Surface budget or repeated resource cleanup failed')
  if (captureEnabled && reveals.some(phase => phase.unique < 5)) throw new Error('A known card reveal stopped at a phase boundary')
  if (state.state !== 'waiting-host') throw new Error('Scene did not reach its terminal state')
  if (captureEnabled) {
    const before = frames.filter(frame => frame.at > startedAt + 900 && frame.at < startedAt + bodyBlock.start - 150)
    const after = frames.filter(frame => frame.at > startedAt + bodyBlock.end + 150 && frame.at < handoffAt)
    const beforeInk = percentile(before.map(frame => frame.bodyInk), .5), afterInk = percentile(after.map(frame => frame.bodyInk), .5)
    if (beforeInk === null || afterInk === null || afterInk < 100 || beforeInk > afterInk * .1) throw new Error(`Body appeared before its reveal: ${beforeInk} → ${afterInk}`)
  }
  window.destroy()
  app.exit(0)
} catch (error) {
  console.error(error instanceof CaptureUnavailable ? 'BART_ENVIRONMENT_INCONCLUSIVE' : 'BART_ISOLATION_FAILED', output, error)
  await writeFile(path.join(output, 'outcome.json'), JSON.stringify({ status: error instanceof CaptureUnavailable ? 'environment-inconclusive' : 'failed', error: String(error) }, null, 2))
  if (tracing) await contentTracing.stopRecording(path.join(output, 'failed-trace.json'))
  window?.destroy()
  app.exit(error instanceof CaptureUnavailable ? ENVIRONMENT_EXIT : 1)
}

})
