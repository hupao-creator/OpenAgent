import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Run after perf:renderer:build and perf:renderer:serve. Real Chromium is needed:
// DOM animation mocks cannot expose the visible radius at the start of fading.
const output = path.resolve(process.env.SETTINGS_EVIDENCE_DIR || 'output/playwright/settings-transition')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1369, height: 994 }, recordVideo: { dir: output, size: { width: 1369, height: 994 } } })
const page = await context.newPage()
const observations = []
try {
  await page.goto(process.env.SETTINGS_PREVIEW_URL || 'http://127.0.0.1:4177/renderer.html?mode=overview&harness=codex&threads=48&turns=24')
  for (const scenario of [
    { name: 'back', width: 1369, height: 994, close: '返回' },
    { name: 'close-small', width: 800, height: 600, close: '返回' },
    { name: 'escape-mobile', width: 600, height: 800, close: 'Escape' },
    { name: 'resize-open', width: 1369, height: 994, resize: { width: 950, height: 700 }, close: '返回' },
    { name: 'resize-opening', width: 1369, height: 994, resize: { width: 760, height: 650 }, duringOpening: true, close: 'Escape' }
  ]) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    if (!scenario.duringOpening) await page.waitForSelector('.settings-page[data-phase=open]')
    if (scenario.resize) {
      await page.setViewportSize(scenario.resize)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    await page.waitForSelector('.settings-page[data-phase=open]')
    // Slow playback for the recording; sample the original animation timeline.
    await page.evaluate((close) => {
      const root = document.querySelector('.settings-page')
      if (close === 'Escape') root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      else [...root.querySelectorAll('button')].find((button) => button.textContent.trim() === close || button.getAttribute('aria-label') === close).click()
      for (const animation of root.getAnimations({ subtree: true })) animation.playbackRate = .25
    }, scenario.close)
    await page.waitForSelector('.settings-page', { state: 'detached' })
    // Replay once with paused frames for precise geometry/opacity evidence.
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    if (!scenario.duringOpening) await page.waitForSelector('.settings-page[data-phase=open]')
    if (scenario.resize) {
      await page.setViewportSize(scenario.resize)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    await page.waitForSelector('.settings-page[data-phase=open]')
    const frames = await page.evaluate((close) => {
      const root = document.querySelector('.settings-page')
      if (close === 'Escape') root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      else [...root.querySelectorAll('button')].find((button) => button.textContent.trim() === close || button.getAttribute('aria-label') === close).click()
      const animations = root.getAnimations({ subtree: true })
      for (const animation of animations) animation.pause()
      const rect = document.querySelector('[data-settings-trigger]').getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      const samples = [.25, .5, .65, .75, .85, .9, .95].map((fraction) => {
        for (const animation of animations) animation.currentTime = Number(animation.effect.getTiming().duration) * fraction
        const style = getComputedStyle(root)
        const [radius, x, y] = style.clipPath.match(/[\d.]+/g).map(Number)
        return { fraction, radius, x: x + rootRect.left, y: y + rootRect.top, opacity: Number(style.opacity), button: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, radius: Math.min(rect.width, rect.height) / 2 } }
      })
      for (const animation of animations) animation.currentTime = Number(animation.effect.getTiming().duration) * .65
      return samples
    }, scenario.close)
    observations.push({ scenario, frames })
    await page.screenshot({ path: path.join(output, `${scenario.name}-handoff.png`) })
    await page.evaluate(() => {
      // The Bart tab keeps decorative loops running inside the page (the dispatch
      // line). They are not part of the close and cannot be finished, so only the
      // finite animations are driven to their end.
      for (const animation of document.querySelector('.settings-page').getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) animation.finish()
      }
    })
    await page.waitForSelector('.settings-page', { state: 'detached' })
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).evaluate((button) => document.activeElement === button), true)
  }
} finally {
  await context.close()
  await browser.close()
  await writeFile(path.join(output, 'frames.json'), JSON.stringify(observations, null, 2))
}
for (const { scenario, frames } of observations) {
  for (const frame of frames) {
    assert.ok(Math.hypot(frame.x - frame.button.x, frame.y - frame.button.y) < 1, `${scenario.name}: closing center must follow the visible button`)
    if (frame.opacity > .05 && frame.opacity < .95) {
      assert.ok(frame.radius <= frame.button.radius + 1, `${scenario.name}: page fades before reaching button (${frame.radius}px vs ${frame.button.radius}px)`)
    }
  }
}
console.log(`Settings close geometry, fade handoff and focus passed in ${observations.length} scenarios. Evidence: ${output}`)
