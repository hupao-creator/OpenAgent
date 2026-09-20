import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Start `pnpm lab:bart` first. SVG text-path clipping needs a real browser;
// jsdom cannot tell whether the newest glyph actually fits on the path.
const url = process.env.BART_LAB_URL || 'http://127.0.0.1:4177/'
const output = path.resolve('output/playwright/bart-reasoning-arc')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const samples = []

try {
  await page.goto(url)
  const preview = page.frameLocator('iframe')
  await preview.locator('.bart-logo').waitFor()
  // Fit mode keeps the inner viewport near 400px regardless of the Lab shell.
  // Use actual CSS pixels so these cases exercise both production breakpoints.
  const fit = page.getByRole('button', { name: '适合画布', exact: true })
  await fit.click()
  assert.equal(await fit.getAttribute('aria-pressed'), 'false', 'automatic preview scaling is disabled')
  const body = preview.locator('.bart-logo .bart-bot > path:first-child')
  const arc = preview.locator('.bart-role-arc')
  const cases = [
    ['思考', '最后检查窄窗口', 'chinese'],
    ['思考 · 英文', 'retrieval approach', 'english'],
    ['思考 · 混合', 'Unicode 🧠 边界', 'mixed'],
    ['思考 · 短文本', '检查调用链', 'short']
  ]

  for (const [width, compact, logoHeight] of [[1600, false, 210], [760, true, 179]]) {
    await page.setViewportSize({ width, height: 900 })
    // Wait for the Lab's ResizeObserver to update the iframe after resizing.
    await page.waitForFunction(({ compact, logoHeight }) => {
      const frame = document.querySelector('iframe').contentWindow
      const logo = frame.document.querySelector('.bart-logo')
      return (frame.innerWidth <= 720) === compact &&
        Number.parseFloat(frame.getComputedStyle(logo).height) === logoHeight
    }, { compact, logoHeight })
    let bodyWidth
    for (const [label, suffix, name] of cases) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await arc.locator('textPath').filter({ hasText: suffix, visible: true }).waitFor()
      await page.waitForFunction(() => {
        const svg = document.querySelector('iframe').contentDocument.querySelector('.bart-role-arc')
        return svg.querySelector('textPath').getAttribute('startOffset') ===
          svg.querySelector('[data-bart-stream-layer] textPath')?.getAttribute('startOffset')
      })
      const sample = await arc.evaluate(async (svg) => {
        await document.fonts.ready
        const text = svg.querySelector('[data-bart-stream-layer] text') ?? svg.querySelector('text')
        const last = text.getNumberOfChars() - 1
        const endpoint = text.getEndPositionOfChar(last)
        const extent = text.getExtentOfChar(last)
        const curve = svg.querySelector('path')
        const length = curve.getTotalLength()
        const target = curve.getPointAtLength((length + Math.min(length, text.getComputedTextLength())) / 2)
        return {
          previewWidth: window.innerWidth,
          logoHeight: Number.parseFloat(getComputedStyle(document.querySelector('.bart-logo')).height),
          text: text.textContent.trim(),
          fontSize: getComputedStyle(text).fontSize,
          lastGlyphWidth: extent.width,
          lastGlyphHeight: extent.height,
          end: { x: endpoint.x, y: endpoint.y },
          target: { x: target.x, y: target.y }
        }
      })
      assert.equal(sample.previewWidth <= 720, compact, `${name}: actual preview uses the expected breakpoint`)
      assert.equal(sample.logoHeight, logoHeight, `${name}: Bart uses the expected production size`)
      assert.ok(sample.text.endsWith(suffix), `${name}: latest suffix retained`)
      assert.ok(sample.lastGlyphWidth > 0 && sample.lastGlyphHeight > 0,
        `${name}: newest glyph is actually drawn, not clipped beyond the path`)
      assert.ok(Math.hypot(sample.end.x - sample.target.x, sample.end.y - sample.target.y) < 1,
        `${name}: visible text is centered on the locked circular arc`)
      assert.equal(sample.fontSize, '10px', `${name}: no text shrinking or stretching`)
      // Measure body geometry before its existing idle rotation, whose axis-
      // aligned screen bounds vary slightly even for an unchanged outline.
      const size = await body.evaluate((element) => ({ width: element.getBBox().width }))
      bodyWidth ??= size.width
      assert.ok(Math.abs(size.width - bodyWidth) < 0.1, `${name}: Bart keeps its size`)
      samples.push({ viewport: width, name, ...sample })
      await page.screenshot({ path: path.join(output, `${width}-${name}.png`) })
    }
  }
  await page.getByRole('button', { name: '思考 · 流式', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'B · 顺滑推进', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: '重放当前场景', exact: true }).click()
  await arc.locator('[data-bart-stream-layer]').waitFor()
  await page.waitForFunction(() => document.querySelector('iframe').contentDocument
    .querySelector('.bart-dock-reasoning-motion')?.getAnimations().length === 1)
  const continuity = await arc.evaluate(async (svg) => {
    const circle = svg.closest('.bart-role-stage')
    const body = document.querySelector('.bart-dock-reasoning-motion')
    const animation = body.getAnimations()[0]
    const bodyTime = animation?.currentTime
    const before = svg.querySelector('textPath').textContent
    const path = svg.querySelector('path').getAttribute('d')
    await new Promise(resolve => setTimeout(resolve, 850))
    return {
      changed: before !== svg.querySelector('textPath').textContent,
      sameBody: body.getAnimations()[0] === animation,
      advancing: animation?.currentTime > bodyTime,
      circleMoving: circle.getAnimations().length === 1,
      samePath: svg.querySelector('path').getAttribute('d') === path
    }
  })
  assert.deepEqual(continuity, { changed: true, sameBody: true, advancing: true, circleMoving: true, samePath: true },
    'new deltas preserve the current body animation and circular path')
  await page.getByRole('button', { name: '暂停流入', exact: true }).click()
  await page.waitForFunction(() => {
    const svg = document.querySelector('iframe').contentDocument.querySelector('.bart-role-arc')
    return svg.querySelector('textPath').getAttribute('startOffset') ===
      svg.querySelector('[data-bart-stream-layer] textPath')?.getAttribute('startOffset')
  })
  const settled = await arc.evaluate(svg => {
    const source = svg.querySelector('textPath'), layer = svg.querySelector('[data-bart-stream-layer] textPath')
    return source.textContent === layer.textContent && source.getAttribute('startOffset') === layer.getAttribute('startOffset')
  })
  assert.ok(settled, 'the glide settles exactly on the centered source when input pauses')
  await page.getByRole('checkbox', { name: '模拟批量输入', exact: true }).check()
  await page.getByRole('button', { name: '重放当前场景', exact: true }).click()
  await arc.locator('[data-bart-stream-layer]').waitFor()
  const burst = await arc.evaluate(svg => new Promise(resolve => {
    let previous, travel = 0, elapsed = 0, changes = 0, start
    const read = now => {
      start ??= now
      const layer = svg.querySelector('[data-bart-stream-layer] textPath')
      const current = { now, text: layer.textContent, offset: Number(layer.getAttribute('startOffset')) }
      if (previous) {
        if (current.text !== previous.text) changes++
        else {
          // Average over stable text frames: separate frame callbacks can
          // straddle a paint, making a single observed frame misleading.
          travel += Math.abs(current.offset - previous.offset)
          elapsed += now - previous.now
        }
      }
      previous = current
      if (now - start < 1600) requestAnimationFrame(read)
      else resolve({ speed: travel / elapsed * 1000, changes })
    }
    requestAnimationFrame(read)
  }))
  assert.ok(burst.changes >= 3, 'burst fixture delivers multiple real Dock updates')
  assert.ok(burst.speed > 80 && burst.speed <= 125, `burst text stays at the shared readable speed: ${JSON.stringify(burst)}`)
  await page.getByRole('button', { name: '暂停流入', exact: true }).click()
  await page.waitForFunction(() => {
    const svg = document.querySelector('iframe').contentDocument.querySelector('.bart-role-arc')
    const source = svg.querySelector('textPath'), layer = svg.querySelector('[data-bart-stream-layer] textPath')
    return source.textContent === layer.textContent && source.getAttribute('startOffset') === layer.getAttribute('startOffset')
  })
  await page.screenshot({ path: path.join(output, 'burst-settled.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await arc.locator('[data-bart-stream-layer]').waitFor({ state: 'detached' })
  assert.equal(await preview.locator('.bart-dock-reasoning-motion').evaluate(el => el.getAnimations().length), 0)
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await arc.locator('[data-bart-stream-layer]').waitFor()
  await page.getByRole('button', { name: '工具调用', exact: true }).click()
  await arc.waitFor({ state: 'detached' })
  assert.equal(await preview.locator('.bart-dock-reasoning-motion').evaluate(el => el.getAnimations().length), 0)
  // Exercise the real static-eye fallback, not just a mocked readiness flag.
  await page.addInitScript(() => { window.Worker = undefined })
  await page.reload()
  await preview.locator('.bart-logo').waitFor()
  await page.getByRole('button', { name: '思考', exact: true }).click()
  await arc.waitFor()
  const fallback = await preview.locator('.bart-role-avatar').evaluate(el => ({
    visible: getComputedStyle(el).visibility,
    bodyAnimations: document.querySelector('.bart-dock-reasoning-motion').getAnimations().length
  }))
  assert.deepEqual(fallback, { visible: 'visible', bodyAnimations: 0 }, 'fallback eyes stay attached to a still body')
  assert.deepEqual(errors, [], 'Lab has no runtime errors')
  await writeFile(path.join(output, 'results.json'), JSON.stringify(samples, null, 2))
  console.log(`Passed ${samples.length} real-browser arc cases. Evidence: ${output}`)
} finally {
  await browser.close()
}
