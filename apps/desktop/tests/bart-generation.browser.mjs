import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const url = new URL('generation.html?regression', process.env.BART_LAB_URL || 'http://127.0.0.1:4177/').href
const output = path.resolve('output/playwright/bart-generation')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = [], evidence = []
page.on('pageerror', error => errors.push(error.message))
const status = () => page.evaluate(() => ({
  ready: performance.getEntriesByName('bart-generation-ready').at(-1)?.detail,
  skipped: performance.getEntriesByName('bart-generation-skipped').at(-1)?.detail,
  state: document.querySelector('[data-generation-state]')?.dataset.generationState,
  pending: document.querySelectorAll('.bart-generation-pending').length
}))
async function ready(scale) {
  await page.goto(url)
  await page.getByRole('combobox', { name: '缩放' }).selectOption(String(scale))
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]') && document.querySelector('.bart-logo[data-worker-ready="true"]'))
  await page.locator('.bart-reply-stage').waitFor({ state: 'visible' })
}
async function start() {
  await page.getByRole('button', { name: '连续生成', exact: true }).click()
  await page.waitForFunction(() => performance.getEntriesByName('bart-generation-ready').length || performance.getEntriesByName('bart-generation-skipped').length)
  const value = await status()
  assert.ok(value.ready, JSON.stringify(value))
  return value.ready
}
async function settled() {
  const { ready: plan } = await status()
  await page.waitForFunction(() => !document.querySelector('[data-generation-state]') && !document.querySelector('.bart-generation-pending'),
    undefined, { timeout: Math.max(30000, (plan?.duration ?? 0) + 5000) })
  await page.locator('.bart-reply-stage').waitFor({ state: 'visible' })
  assert.ok(await page.locator('.thread-overview-item').evaluateAll(cards => cards.every(card =>
    getComputedStyle(card).visibility === 'visible' && getComputedStyle(card).opacity === '1' && !card.inert)))
}
try {
  for (const scale of [.75, 1, 1.4]) {
    await ready(scale)
    const original = await page.locator('[data-thread-id="claude-generation"]').elementHandle()
    const plan = await start()
    console.log(JSON.stringify({ scale, duration: plan.duration }))
    assert.equal(plan.cards.length, 4, 'all three Harnesses and Report are prepared together')
    assert.equal(plan.phases.filter(phase => phase.name.startsWith('reveal:')).length, 4)
    assert.ok(plan.cards.every(card => card.height >= 149 && card.width >= 269))
    assert.ok(plan.sealedMs < 2000)
    await page.waitForTimeout(1100)
    await page.screenshot({ path: path.join(output, `playing-${scale}.png`) })
    await settled()
    assert.ok(await original.evaluate(node => node === document.querySelector('[data-thread-id="claude-generation"]')),
      'native card identity survives the covering scene')
    await page.screenshot({ path: path.join(output, `settled-${scale}.png`) })
    evidence.push({ scale, plan })
  }
  await ready(1)
  const streamingPlan = await start()
  const reveal = streamingPlan.phases.find(phase => phase.name.startsWith('reveal:'))
  await page.waitForFunction(({ origin, at }) => performance.timeOrigin + performance.now() >= origin + at + 50,
    { origin: streamingPlan.origin, at: reveal.at })
  for (let chunk = 0; chunk < 3; chunk++) {
    await page.getByRole('button', { name: 'Claude 新文本到达' }).click()
    await page.waitForTimeout(100)
    const value = await status()
    assert.equal(value.state, 'playing', 'streamed content must not truncate the prepared reveal')
    assert.equal(value.pending, 4, 'the entire batch remains covered until playback finishes')
    assert.equal(value.ready.origin, streamingPlan.origin, 'streamed content must not restart playback')
    assert.equal(value.skipped, undefined)
  }
  await page.screenshot({ path: path.join(output, 'streaming-playing.png') })
  await settled()
  await page.getByText(/Latest committed output\. More streamed content\. More streamed content\./).waitFor()
  const handoffElapsed = await page.evaluate(origin =>
    performance.timeOrigin + performance.getEntriesByName('bart-generation-handoff').at(-1).startTime - origin,
    streamingPlan.origin)
  assert.ok(handoffElapsed >= streamingPlan.duration, 'all reveals and the return complete before native handoff')

  await ready(1)
  await start()
  await page.getByRole('button', { name: '取消动画' }).click()
  await settled()
  await page.getByRole('button', { name: 'Claude 后台任务到达' }).click()
  await page.getByRole('button', { name: '提交卡片扩展' }).click()
  await page.getByText('后台任务 1', { exact: true }).waitFor()
  assert.ok(await page.locator('[data-thread-id="claude-generation"]').evaluate(card => card.getBoundingClientRect().width > 700))
  assert.deepEqual(errors, [])
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ evidence, streaming: { plan: streamingPlan, handoffElapsed }, errors }, null, 2))
  console.log(JSON.stringify({ passed: true, layouts: evidence.length, output }))
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ status: await status(), errors }, null, 2))
  await page.screenshot({ path: path.join(output, 'failure.png') })
  throw error
} finally { await browser.close() }
