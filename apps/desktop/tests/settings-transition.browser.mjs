import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Run after perf:renderer:build and perf:renderer:serve. Check interpolated CSS
// geometry; settings-transition.electron.mjs separately checks compositor pixels.
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
    { name: 'button-moved-under-settings', width: 1369, height: 994, moveButton: true, close: '返回' },
    { name: 'resize-open', width: 1369, height: 994, resize: { width: 950, height: 700 }, close: '返回' },
    { name: 'resize-opening', width: 1369, height: 994, resize: { width: 760, height: 650 }, duringOpening: true, close: 'Escape' }
  ]) {
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    const openingFrames = await page.evaluate(async () => {
      const button = document.querySelector('[data-settings-trigger]')
      const rect = button.getBoundingClientRect()
      // Click the icon itself: the reveal must still be anchored to its button.
      button.focus()
      button.querySelector('svg').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise(resolve => queueMicrotask(resolve))
      const root = document.querySelector('.settings-page')
      const animation = root.getAnimations()[0]
      animation.pause()
      const rootRect = root.getBoundingClientRect()
      const frames = [0, .05, .12, .25, .5, .9].map(fraction => {
        animation.currentTime = Number(animation.effect.getTiming().duration) * fraction
        const [radius, x, y] = getComputedStyle(root).clipPath.match(/[\d.]+/g).map(Number)
        return { fraction, radius: radius / 100 * Math.hypot(rootRect.width, rootRect.height) / Math.SQRT2,
          x: x / 100 * rootRect.width + rootRect.left, y: y / 100 * rootRect.height + rootRect.top,
          button: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } }
      })
      animation.currentTime = 0
      animation.play()
      return frames
    })
    if (!scenario.duringOpening) await page.waitForSelector('.settings-page[data-phase=open]')
    if (scenario.resize) {
      await page.setViewportSize(scenario.resize)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    await page.waitForSelector('.settings-page[data-phase=open]')
    const anchor = scenario.resize ? await page.evaluate(() => {
      const rect = document.querySelector('[data-settings-trigger]').getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }) : openingFrames[0].button
    if (scenario.moveButton) {
      await page.locator('[data-settings-trigger]').evaluate(button => {
        button.style.transition = 'none'
        button.style.transform = 'translate(-180px, 100px)'
      })
    }
    // Sample the same open/close cycle, including the first closing frame.
    const frames = await page.evaluate(({ close, anchor }) => {
      const root = document.querySelector('.settings-page')
      if (close === 'Escape') root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      else [...root.querySelectorAll('button')].find((button) => button.textContent.trim() === close || button.getAttribute('aria-label') === close).click()
      const animations = root.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      for (const animation of animations) animation.pause()
      const rect = document.querySelector('[data-settings-trigger]').getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      const samples = [0, .1, .25, .5, .65, .75, .85, .9, .95].map((fraction) => {
        for (const animation of animations) animation.currentTime = Number(animation.effect.getTiming().duration) * fraction
        const style = getComputedStyle(root)
        const [radius, x, y] = style.clipPath.match(/[\d.]+/g).map(Number)
        return { fraction, radius: radius / 100 * Math.hypot(rootRect.width, rootRect.height) / Math.SQRT2,
          x: x / 100 * rootRect.width + rootRect.left, y: y / 100 * rootRect.height + rootRect.top,
          opacity: Number(style.opacity), anchor,
          button: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, radius: Math.min(rect.width, rect.height) / 2 } }
      })
      for (const animation of animations) animation.currentTime = Number(animation.effect.getTiming().duration) * .65
      return samples
    }, { close: scenario.close, anchor })
    observations.push({ scenario, openingFrames, frames })
    await page.screenshot({ path: path.join(output, `${scenario.name}-handoff.png`) })
    await page.evaluate(() => {
      // Replay the close slowly for the recording; leave decorative loops alone.
      for (const animation of document.querySelector('.settings-page').getAnimations({ subtree: true })) {
        if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
          animation.currentTime = 0
          animation.playbackRate = .25
          animation.play()
        }
      }
    })
    await page.waitForSelector('.settings-page', { state: 'detached' })
    assert.equal(await page.getByRole('button', { name: '设置', exact: true }).evaluate((button) => document.activeElement === button), true)
    if (scenario.moveButton) await page.locator('[data-settings-trigger]').evaluate(button => {
      button.style.transform = ''
      button.style.transition = ''
    })
  }
} finally {
  await context.close()
  await browser.close()
  await writeFile(path.join(output, 'frames.json'), JSON.stringify(observations, null, 2))
}
for (const { scenario, openingFrames, frames } of observations) {
  if (scenario.moveButton) {
    assert.ok(Math.hypot(frames[0].button.x - frames[0].anchor.x, frames[0].button.y - frames[0].anchor.y) > 100,
      'the background button must actually move before checking the shared center')
  }
  for (const frame of openingFrames) {
    assert.ok(Math.hypot(frame.x - frame.button.x, frame.y - frame.button.y) < 1, `${scenario.name}: opening center must stay on the clicked button`)
  }
  for (const frame of frames) {
    assert.ok(Math.hypot(frame.x - frame.anchor.x, frame.y - frame.anchor.y) < 1, `${scenario.name}: closing center must share the opening anchor (updated only on resize)`)
    if (frame.opacity > .05 && frame.opacity < .95) {
      assert.ok(frame.radius <= frame.button.radius + 1, `${scenario.name}: page fades before reaching button (${frame.radius}px vs ${frame.button.radius}px)`)
    }
  }
}
console.log(`Settings opening/closing geometry, fade handoff and focus passed in ${observations.length} scenarios. Evidence: ${output}`)
