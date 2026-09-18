import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Run the Lab first. These checks observe production DOM in Chromium while the
// real input stream runs; the clock-controlled Dock tests cover exact deadlines.
const url = process.env.BART_LAB_URL || 'http://127.0.0.1:4177/'
const output = path.resolve('output/playwright/bart-cadence')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const evidence = {}

async function slider(label, value) {
  const control = page.getByRole('slider', { name: label, exact: true })
  const min = Number(await control.getAttribute('min'))
  const step = Number(await control.getAttribute('step'))
  await control.press('Home')
  for (let n = min; n < value; n += step) await control.press('ArrowRight')
  assert.equal(await control.inputValue(), String(value))
}

async function restartWith(label) {
  const previous = await page.frameLocator('iframe').locator('main').elementHandle()
  await page.getByRole('button', { name: label, exact: true }).click()
  // Configuration crosses postMessage into the iframe. Do not sample a detached
  // previous scene just because the outer button has already returned.
  await previous.waitForElementState('hidden')
  await previous.dispose()
  await page.frameLocator('iframe').locator('.cadence-source').waitFor()
}

async function sample(duration) {
  return page.frameLocator('iframe').locator('main').evaluate(async (main, duration) => {
    const start = performance.now()
    const entries = []
    const decorations = new Set()
    const sizes = new Set()
    let previous
    while (performance.now() - start < duration) {
      const dock = main.querySelector('.bart-dock')
      const name = main.querySelector('.bart-role-tool-name')?.textContent ?? ''
      const text = main.querySelector('textPath')?.textContent.trim() ?? ''
      const role = dock.dataset.role
      const key = JSON.stringify([role, name, text, dock.dataset.layout])
      const decoration = main.querySelector('.bart-role-stage[data-role]')
      if (decoration) decorations.add(decoration)
      const box = main.querySelector('.bart-bot > path').getBBox()
      sizes.add(`${box.width},${box.height}`)
      if (key !== previous) {
        entries.push({ at: performance.now() - start, role, name, text,
          source: main.querySelector('.cadence-source')?.textContent })
        previous = key
      }
      await new Promise(requestAnimationFrame)
    }
    return { entries, decorationCount: decorations.size, bodySizes: [...sizes] }
  }, duration)
}

function assertCadence(trace, minimum, message) {
  // The first sample can start partway through the first interval. Frame
  // observation can vary by one or two refreshes, so leave a 50ms margin.
  for (let i = 2; i < trace.entries.length; i++) {
    assert.ok(trace.entries[i].at - trace.entries[i - 1].at >= minimum - 50, message)
  }
  assert.equal(trace.bodySizes.length, 1, 'Bart keeps its body geometry')
}

function fragments(trace) {
  return { ...trace, entries: trace.entries.filter((entry, index, all) =>
    index === 0 || entry.role !== all[index - 1].role || entry.name !== all[index - 1].name) }
}

try {
  await page.goto(url)
  await page.getByRole('button', { name: /展示节奏/ }).click()
  const preview = page.frameLocator('iframe')
  await preview.locator('.cadence-source').waitFor()
  await page.getByRole('button', { name: '适合画布', exact: true }).click()
  assert.equal(await page.getByRole('slider', { name: '最短展示时间' }).inputValue(), '800')
  assert.equal(await page.getByRole('slider', { name: '思考文字刷新' }).inputValue(), '150')

  evidence.smoothed = fragments(await sample(2700))
  assert.ok(evidence.smoothed.entries.length >= 2 && evidence.smoothed.entries.length <= 5,
    'fast source events produce only a few visible replacements')
  assertCadence(evidence.smoothed, 800, 'ordinary fragments keep their minimum visible interval')

  await slider('最短展示时间', 0)
  await restartWith('重放当前场景')
  evidence.immediate = fragments(await sample(2700))
  assert.ok(evidence.immediate.entries.length > evidence.smoothed.entries.length * 3,
    '0ms gives an observable comparison with immediate switching')

  await slider('最短展示时间', 400)
  await restartWith('连续工具')
  evidence.tools = await sample(2200)
  assertCadence(evidence.tools, 400, 'tool names respect the custom minimum')
  assert.ok(evidence.tools.entries.length >= 3, 'new tool names continue to arrive')
  assert.equal(evidence.tools.decorationCount, 1, 'consecutive tools keep their decoration instance')

  await slider('事件输入间隔', 20)
  await restartWith('连续思考')
  evidence.reasoning = await sample(1200)
  assertCadence(evidence.reasoning, 150, 'reasoning text updates at the configured cadence')
  assert.ok(evidence.reasoning.entries.length >= 4 && evidence.reasoning.entries.length <= 10)
  assert.equal(evidence.reasoning.decorationCount, 1, 'reasoning segments keep one decoration')
  await page.screenshot({ path: path.join(output, 'reasoning-controls.png') })

  await slider('最短展示时间', 2000)
  await restartWith('快速完成')
  const started = Date.now()
  await preview.locator('.bart-reply-stage').waitFor({ timeout: 1500 })
  evidence.finalReplyMs = Date.now() - started
  assert.ok(evidence.finalReplyMs < 1000, 'final answer bypasses even a 2000ms display hold')
  assert.equal(await preview.locator('.bart-dock').getAttribute('data-role'), 'idle')
  await page.screenshot({ path: path.join(output, 'final-reply.png') })

  await slider('事件输入间隔', 80)
  await restartWith('输入接管后恢复')
  await preview.locator('.bart-dock[data-layout="input"]').waitFor()
  evidence.recovery = await preview.locator('main').evaluate((main) => new Promise((resolve, reject) => {
    const dock = main.querySelector('.bart-dock')
    const observer = new MutationObserver(() => {
      if (dock.dataset.layout !== 'mark') return
      clearTimeout(timeout)
      observer.disconnect()
      resolve({ role: dock.dataset.role, text: main.querySelector('textPath')?.textContent.trim() })
    })
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Input never yielded')) }, 5000)
    observer.observe(dock, { attributes: true, attributeFilter: ['data-layout'] })
  }))
  assert.equal(evidence.recovery.role, 'reasoning', 'return uses the current reasoning snapshot')
  assert.match(evidence.recovery.text, /第 25 段/, 'return skips everything covered by the input')
  assert.deepEqual(errors, [], 'Lab has no runtime errors')
  console.log(`Bart cadence browser checks passed. Evidence: ${output}`)
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2))
  await browser.close()
}
