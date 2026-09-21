// Observe unpaused compositor output. Seeking WAAPI/currentTime or reading
// computed clip-path every frame hides the Retina/backdrop-filter regression.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import { createServer } from 'vite'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const evidenceRoot = process.env.OPENAGENT_SETTINGS_EVIDENCE_ROOT || resolve('output/playwright/settings-compositor')
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, 'run-'))
const server = await createServer({
  configFile: join(desktop, 'benchmarks/vite.renderer-bench.config.ts'),
  server: { host: '127.0.0.1', port: 0 }
})
await server.listen()
const url = `${server.resolvedUrls.local[0]}renderer.html?mode=overview&harness=codex&threads=3&turns=1`
const results = []
const coldLandings = []

// Keep the first installation probe cold. The isolation suite's open/close
// warmup has already narrowed this roster and cannot catch its landing jump.
async function coldLanding(page, scale) {
  const result = await page.evaluate(async () => {
    const samples = [], started = performance.now()
    performance.clearMarks('bart-cross-page-ready')
    performance.clearMarks('bart-cross-page-skipped')
    const finished = new Promise(resolve => {
      const sample = now => {
        const canvas = document.querySelector('[data-bart-cross-page-flight]')
        const flying = Boolean(canvas && !canvas.hidden)
        const seat = document.querySelector('.bart-host-body .bart-logo')
        const rect = (flying ? canvas : seat)?.getBoundingClientRect()
        if (rect) samples.push({ at: now - started, flying, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
        if (now - started < 2200) requestAnimationFrame(sample)
        else resolve()
      }
      requestAnimationFrame(sample)
    })
    document.querySelector('[data-settings-trigger]').click()
    await finished
    return { samples,
      ready: performance.getEntriesByName('bart-cross-page-ready').at(-1)?.detail,
      skipped: performance.getEntriesByName('bart-cross-page-skipped').at(-1)?.detail,
      sealed: document.querySelector('.app-shell').hasAttribute('data-bart-scene'),
      open: Boolean(document.querySelector('.settings-page[data-phase=open]')) }
  })
  const evidence = { scale, ...result, coverage: 'incomplete' }
  coldLandings.push(evidence)
  assert.ok(result.open && !result.sealed, 'cold settings must restore native ownership')
  if (result.skipped) {
    // A slow machine may decline this optional scene within its 250ms budget.
    // Report that explicitly; it is fallback coverage, not smooth-flight proof.
    assert.equal(result.ready, undefined, 'an admitted scene must not fail during landing')
    evidence.coverage = 'admission-fallback'
    return
  }
  assert.ok(result.ready, 'cold flight must admit or explicitly report its fallback')
  const firstNative = result.samples.findIndex((sample, index) => index > 0 && !sample.flying && result.samples[index - 1].flying)
  assert.ok(firstNative > 0, 'cold flight handoff must be observed')
  const before = result.samples[firstNative - 1], after = result.samples[firstNative], final = result.samples.at(-1)
  const displacement = Math.hypot(final.x - before.x, final.y - before.y)
  const jump = Math.hypot(after.x - before.x, after.y - before.y)
  assert.ok(displacement > 80, 'the first probe must narrow the roster and move its landing seat')
  assert.ok(jump < displacement / 2, `cold roster snapped ${jump.toFixed(1)}px at handoff`)
  assert.ok(result.samples.slice(firstNative).some(sample => {
    const distance = Math.hypot(sample.x - before.x, sample.y - before.y)
    return distance > displacement * .2 && distance < displacement * .8
  }), 'native Bart must travel through intermediate roster positions after landing')
  Object.assign(evidence, { coverage: 'cold-flight', jump, displacement })
}

try {
  for (const scale of [2, 1]) {
    const env = { ...process.env, SETTINGS_RENDERER_URL: url }
    delete env.ELECTRON_RUN_AS_NODE
    const application = await _electron.launch({
      args: [`--force-device-scale-factor=${scale}`, join(desktop, 'tests/fixtures/settings-transition-bootstrap.cjs')], env, colorScheme: null
    })
    try {
      const page = await application.firstWindow()
      await page.locator('[data-settings-trigger]').waitFor()
      await page.locator('.bart-dock .bart-logo[data-worker-ready]').waitFor()
      await page.waitForTimeout(400)
      await coldLanding(page, scale)
      await page.keyboard.press('Escape')
      await page.locator('.settings-page').waitFor({ state: 'detached' })
      // Give even a busy CI compositor enough frames. Author longer durations
      // at creation; leave playbackRate=1 and never seek/pause the animation.
      await page.evaluate(() => {
        const animate = Element.prototype.animate
        Element.prototype.animate = function (frames, options) {
          if (this.closest('.settings-page') && typeof options === 'object') {
            options = { ...options, duration: Number(options.duration) * 4 }
          }
          return animate.call(this, frames, options)
        }
      })
      // Settle the toolbar's entrance before measuring the real button.
      await page.waitForTimeout(400)
      const geometry = await page.locator('[data-settings-trigger]').evaluate(button => {
        const rect = button.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
          width: innerWidth, height: innerHeight, scale: devicePixelRatio }
      })
      assert.equal(geometry.scale, scale)
      const cdp = await page.context().newCDPSession(page)
      for (const input of ['keyboard', 'mouse']) {
        let phase = 'opening'
        const frames = []
        const receive = event => {
          frames.push({ phase, data: event.data })
          void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
        }
        cdp.on('Page.screencastFrame', receive)
        await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 })
        if (input === 'keyboard') await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
        else await page.getByRole('button', { name: '设置', exact: true }).click()
        await page.locator('.settings-page[data-phase=open]').waitFor()
        await page.waitForTimeout(500)
        phase = 'closing'
        if (input === 'keyboard') await page.keyboard.press('Escape')
        else await page.getByRole('button', { name: '返回', exact: true }).click()
        await page.locator('.settings-page').waitFor({ state: 'detached' })
        await cdp.send('Page.stopScreencast')
        cdp.off('Page.screencastFrame', receive)

        // Decode only after the motion, in Main. The dark settings material has
        // a blue tint; the neutral Overview has none. At y=100 a substantial
        // circular slice centered on the gear must still cover the gear's x.
        // A Retina center incorrectly halved to the top middle cannot do so.
        const slices = await application.evaluate(({ nativeImage }, { frames, geometry }) => frames.flatMap((frame, index) => {
          const image = nativeImage.createFromBuffer(Buffer.from(frame.data, 'base64'))
          const { width } = image.getSize()
          const pixels = image.toBitmap() // BGRA, independent of device scale.
          const pixelScale = width / geometry.width
          const y = Math.round(100 * pixelScale)
          let start = -1, last = -1, best = [0, 0]
          for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4
            const blue = pixels[offset], green = pixels[offset + 1], red = pixels[offset + 2]
            if (blue - red <= 4 || blue - green <= 2) continue
            if (start < 0 || x - last > 8 * pixelScale) start = x
            last = x
            if (last - start > best[1] - best[0]) best = [start, last]
          }
          const [left, right] = best.map(value => value / pixelScale)
          const span = right - left
          // Exclude the fully covered viewport, tiny text/icons and the last
          // button-sized disk. Require real partial circles in both directions.
          return span > 160 && span < geometry.width - 100
            ? [{ index, phase: frame.phase, left, right }] : []
        }), { frames, geometry })
        const result = { scale, input, geometry, capturedFrames: frames.length, slices }
        results.push(result)
        for (let index = 0; index < frames.length; index++) {
          if (!process.env.SETTINGS_CAPTURE_ALL && !slices.some(slice => slice.index === index)) continue
          await writeFile(join(evidence, `${scale}x-${input}-${frames[index].phase}-${index}.png`), Buffer.from(frames[index].data, 'base64'))
        }
      }
    } finally { await application.close() }
  }
} finally {
  await server.close()
  await writeFile(join(evidence, 'frames.json'), JSON.stringify(results, null, 2))
  await writeFile(join(evidence, 'cold-landings.json'), JSON.stringify(coldLandings, null, 2))
}
for (const result of results) {
  for (const phase of ['opening', 'closing']) {
    const slices = result.slices.filter(slice => slice.phase === phase)
    assert.ok(slices.length > 0, `${result.scale}x ${result.input}: no ${phase} intermediate frames captured; evidence ${evidence}`)
    for (const slice of slices) assert.ok(slice.right >= result.geometry.x - 3,
      `${result.scale}x ${result.input} ${phase}: rendered circle ends at x=${slice.right}, before gear x=${result.geometry.x}; evidence ${evidence}`)
  }
}
console.log(`Settings compositor pixels passed for mouse/keyboard at 1x/2x. Evidence: ${evidence}`)
console.log('Cold settings landing:', JSON.stringify(coldLandings.map(({ samples, ...result }) => ({ ...result, samples: samples.length }))))
