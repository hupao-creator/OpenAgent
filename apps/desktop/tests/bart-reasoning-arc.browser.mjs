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
      await arc.locator('textPath').filter({ hasText: suffix }).waitFor()
      const sample = await arc.evaluate(async (svg) => {
        await document.fonts.ready
        const text = svg.querySelector('text')
        const last = text.getNumberOfChars() - 1
        const endpoint = text.getEndPositionOfChar(last)
        const extent = text.getExtentOfChar(last)
        const curve = svg.querySelector('path')
        const target = curve.getPointAtLength(curve.getTotalLength() * 0.8)
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
        `${name}: newest glyph stays at the same upper-right endpoint`)
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
  assert.deepEqual(errors, [], 'Lab has no runtime errors')
  await writeFile(path.join(output, 'results.json'), JSON.stringify(samples, null, 2))
  console.log(`Passed ${samples.length} real-browser arc cases. Evidence: ${output}`)
} finally {
  await browser.close()
}
