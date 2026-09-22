import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Run the Lab first. These checks sample real Chromium layout: the capsule
// height, the Dock's bottom edge and the character's viewBox are all things
// only a real layout engine can answer.
const url = process.env.BART_LAB_URL || 'http://127.0.0.1:4177/'
const output = path.resolve('output/playwright/bart-input')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const preview = page.frameLocator('iframe')
const evidence = {}

// The character is the resident one whenever it is not morphing, so this is the
// signature that the input state stayed out of the character.
const MARK_VIEW_BOX = '0 0 640 640'

async function measure() {
  return preview.locator('.bart-dock').evaluate((dock) => {
    const rect = (node) => {
      if (!node) return null
      const box = node.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: box.height, width: box.width }
    }
    const svg = dock.querySelector('.bart-dock-logo-motion svg')
    const composer = dock.querySelector('.bart-dock-inline-composer')
      ?? dock.querySelector('.bart-dock-thread-follow-up')
    const strip = composer?.querySelector('.bart-dock-attachment-strip')
    const row = composer?.querySelector('.bart-dock-inline-row')
    return {
      layout: dock.dataset.layout,
      dock: rect(dock),
      // The logo box is deliberately taller than the drawing inside it, so the
      // visible clearance has to be measured on the character itself.
      ink: rect(svg.querySelector('.bart-bot')),
      capsule: rect(composer),
      views: {
        label: svg.getAttribute('data-layout'),
        viewBox: svg.getAttribute('viewBox'),
        expanded: svg.getAttribute('data-expanded')
      },
      attachmentInsideCapsule: Boolean(strip) && strip.parentElement === composer,
      attachmentAboveField: Boolean(strip && row) && strip.getBoundingClientRect().bottom <= row.getBoundingClientRect().top,
      shortcutButtons: dock.querySelectorAll('.bart-dock-action-menu button').length
    }
  })
}

/** React renders across a postMessage, so read until the expected draft lands. */
async function settled(draftLines, label) {
  const deadline = Date.now() + 5000
  let last
  while (Date.now() < deadline) {
    last = await preview.locator('textarea').inputValue().catch(() => '')
    if (last.split('\n').length === draftLines) {
      await settledFrame()
      return measure()
    }
    await page.waitForTimeout(40)
  }
  assert.fail(`${label}: draft never reached ${draftLines} lines, saw ${JSON.stringify(last)}`)
}

async function selectVariant(label, draftLines) {
  await page.getByRole('button', { name: label, exact: true }).click()
  return settled(draftLines, label)
}

/**
 * Evidence should be a settled frame, not the middle of the capsule's fade. The
 * cap is there for anything that animates forever — a sleeping screenshot is
 * worse than a slightly early one.
 */
async function settledFrame() {
  await preview.locator('.bart-dock').evaluate((dock) => Promise.race([
    Promise.all(dock.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))),
    new Promise((resolve) => { setTimeout(resolve, 600) })
  ]))
}

/** The capsule grows on its own clock, so read it until it clears the baseline. */
async function grewPast(baseline, label) {
  const deadline = Date.now() + 4000
  let reading = await measure()
  while (reading.capsule.height <= baseline && Date.now() < deadline) {
    await page.waitForTimeout(60)
    reading = await measure()
  }
  await settledFrame()
  reading = await measure()
  assert.ok(reading.capsule.height > baseline, label)
  return reading
}

/**
 * The Thread follow-up is the Dock's other inline mode: it replaces the draft
 * field with a one-line prompt for an existing Thread.
 */
async function selectFollowUp(label) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await preview.locator('.bart-dock-thread-follow-up').waitFor()
  return measure()
}

/**
 * A mode switch animates, and the capsule can still be showing its previous
 * height when it is first read. The capsule is whole rows plus the field's own
 * inset — 13px top and bottom, 20px per row — so this waits for the height the
 * rows ask for rather than for any settled-looking number.
 */
async function settledCapsule(label, rows) {
  const expected = rows * 20 + 13 * 2
  const deadline = Date.now() + 4000
  let reading = await measure()
  while (Date.now() < deadline) {
    if (reading.capsule && Math.abs(reading.capsule.height - expected) <= 0.5) {
      await settledFrame()
      return measure()
    }
    await page.waitForTimeout(60)
    reading = await measure()
  }
  assert.fail(`${label}: the capsule never reached ${expected}px`)
}

/** The shortcut menu only appears while the Dock is hovered. */
async function reopenInput() {
  await preview.locator('.bart-dock').hover()
  await preview.getByRole('button', { name: '输入 Bart 消息', exact: true }).click()
  await preview.locator('.bart-dock-inline-composer').waitFor()
}

function assertCapsuleIsMarkedUp(reading) {
  assert.equal(reading.layout, 'input', 'the Dock owns the input state')
  assert.equal(reading.views.label, 'mark', 'the character keeps the resident layout')
  assert.equal(reading.views.viewBox, MARK_VIEW_BOX, 'the character keeps the resident viewBox')
  assert.equal(reading.views.expanded, 'false', 'the character does not expand')
}

function contrastAgainst(foreground, background) {
  const color = (value) => value.match(/[\d.]+/g).map(Number)
  const blend = (front, back) => {
    const alpha = front[3] ?? 1
    return back.map((channel, index) => front[index] * alpha + channel * (1 - alpha))
  }
  const lightness = (channels) => channels
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
  const backdrop = blend(color(background), [255, 255, 255])
  const text = blend(color(foreground), backdrop)
  const values = [lightness(backdrop), lightness(text)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}

/**
 * Bart's position frame by frame across one mode switch, with `start` triggering
 * it. The sampler is a rAF loop running in the page while the click arrives from
 * outside, so it covers the first frame of the motion rather than starting after
 * it.
 */
async function framesAcross(start, span = 900) {
  const sampling = preview.locator('.bart-dock').evaluate(async (dock, ms) => {
    const svg = dock.querySelector('.bart-dock-logo-motion svg')
    const frames = []
    const deadline = performance.now() + ms
    while (performance.now() < deadline) {
      const ink = svg.querySelector('.bart-bot').getBoundingClientRect()
      const capsule = dock.querySelector('.bart-dock-inline-composer')
      frames.push({
        inkTop: ink.top,
        inkBottom: ink.bottom,
        capsuleTop: capsule ? capsule.getBoundingClientRect().top : null
      })
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    return frames
  }, span)
  await start()
  return sampling
}

// Only sub-pixel rounding may change the character's screen position.
const displacement = (frames, top) => Math.max(...frames.map(frame => Math.abs(frame.inkTop - top)))

try {
  await page.goto(url)
  await page.locator('.scene-button').filter({ hasText: '输入' }).click()
  await preview.locator('.bart-dock-inline-composer').waitFor()

  // 1. Empty draft: the capsule exists and Bart did not morph into it.
  const empty = await settled(1, 'empty')
  assertCapsuleIsMarkedUp(empty)
  assert.equal(empty.shortcutButtons, 0, 'no shortcut buttons float over the character while typing')
  assert.equal(empty.attachmentInsideCapsule, false, 'no attachment strip without attachments')
  assert.ok(empty.capsule.height > 0, 'the input capsule is visible')
  assert.ok(empty.ink.bottom < empty.capsule.top, 'Bart keeps a visible gap above the capsule')

  // 2. Growth: one line at a time up to the cap, then nothing more.
  const growth = []
  for (const [label, lines] of [['单行草稿', 1], ['三行草稿', 3], ['五行草稿', 5], ['六行草稿 · 超上限', 6]]) {
    const reading = await selectVariant(label, lines)
    assertCapsuleIsMarkedUp(reading)
    assert.ok(reading.ink.bottom < reading.capsule.top, `${label}: Bart stays above the capsule`)
    assert.ok(reading.ink.top >= 0, `${label}: Bart does not leave the viewport`)
    assert.ok(reading.dock.top >= 0, `${label}: the Dock footprint stays in the viewport`)
    growth.push({ lines, capsule: reading.capsule.height, bottom: reading.dock.bottom, inkTop: reading.ink.top })
  }
  evidence.growth = growth

  // 3. The Dock's own box is the pivot: its bottom edge never moves, so the
  //    stored left/top position keeps meaning the same thing.
  const bottom = growth[0].bottom
  for (const entry of growth) {
    assert.ok(Math.abs(entry.bottom - bottom) <= 1, `the Dock bottom edge moved at ${entry.lines} lines`)
  }

  // 4. Growth is monotonic, and 6 lines is the same height as 5.
  const [one, three, five, six] = growth
  assert.ok(one.capsule < three.capsule, 'three lines are taller than one')
  assert.ok(three.capsule < five.capsule, 'five lines are taller than three')
  assert.equal(six.capsule, five.capsule, 'a sixth line stops the capsule growing')

  // 5. Draft growth never carries the character with it.
  for (const entry of growth) {
    assert.ok(Math.abs(entry.inkTop - one.inkTop) <= 1, `Bart moved at ${entry.lines} lines`)
  }

  // 6. Attachments live inside the capsule, above the field.
  const attachments = await selectVariant('带附件', 1)
  assertCapsuleIsMarkedUp(attachments)
  assert.ok(attachments.attachmentInsideCapsule, 'the attachment strip is inside the capsule')
  assert.ok(attachments.attachmentAboveField, 'the attachment strip sits above the field')
  assert.ok(attachments.capsule.height > one.capsule, 'the attachment row makes the capsule taller')
  await settledFrame()
  await page.screenshot({ path: path.join(output, 'capsule-attachments.png') })

  // 7. Typing drives the height, not just the pinned fixtures.
  const field = preview.locator('textarea')
  await selectVariant('空白输入', 1)
  await field.fill('第一行')
  const typedOne = await settled(1, 'typed one line')
  assert.equal(typedOne.capsule.height, one.capsule, 'one typed line keeps the single-row capsule')
  await field.fill(['一', '二', '三', '四'].join('\n'))
  const typedFour = await settled(4, 'typed four lines')
  assert.ok(typedFour.capsule.height > one.capsule, 'typed lines grow the capsule')
  assert.ok(typedFour.capsule.height < five.capsule, 'four lines are shorter than five')
  await field.fill(['一', '二', '三', '四', '五', '六', '七'].join('\n'))
  const typedSeven = await settled(7, 'typed seven lines')
  assert.equal(typedSeven.capsule.height, five.capsule, 'the cap holds however much is typed')

  // 8. Escape closes and keeps the draft; reopening shows it again.
  await field.press('Escape')
  await preview.locator('.bart-dock-inline-composer').waitFor({ state: 'detached' })
  assert.equal((await measure()).layout, 'mark', 'Escape leaves the input state')
  await reopenInput()
  const reopened = await settled(7, 'reopened after Escape')
  assertCapsuleIsMarkedUp(reopened)
  assert.equal(reopened.capsule.height, five.capsule, 'the kept draft still fills the capsule to its cap')

  // 9. A click outside does the same, and the draft survives that too.
  await preview.locator('.bart-preview').click({ position: { x: 10, y: 10 } })
  await preview.locator('.bart-dock-inline-composer').waitFor({ state: 'detached' })
  assert.equal((await measure()).layout, 'mark', 'an outside click leaves the input state')
  await reopenInput()
  const afterOutside = await settled(7, 'reopened after an outside click')
  assert.equal(afterOutside.capsule.height, five.capsule, 'the draft survives an outside click')
  await preview.locator('.bart-dock').hover({ position: { x: 5, y: 5 } })
  await settledFrame()
  await page.screenshot({ path: path.join(output, 'capsule-multiline.png') })

  // 10. A width change alone re-wraps the draft. Fit-to-canvas scaling is turned
  //     off first so the preview takes the window's width; nothing is typed after
  //     the fill, so only the Dock's own width moves.
  await page.getByRole('button', { name: '适合画布' }).click()
  await field.fill('')
  const blank = await settled(1, 'the draft cleared at the full Dock width')
  await field.fill('这一行足够长，只会在 Dock 变窄之后才折行，用它单独观察宽度变化带来的重排')
  const wide = await grewPast(blank.capsule.height, 'the long line wraps at the full Dock width')

  await page.setViewportSize({ width: 1100, height: 1000 })
  const narrow = await grewPast(wide.capsule.height, 'narrowing the Dock re-wraps the draft without editing it')
  evidence.rewrap = { wide: wide.capsule.height, narrow: narrow.capsule.height, dock: [wide.dock.width, narrow.dock.width] }
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.getByRole('button', { name: '适合画布' }).click()

  // 11. The Thread follow-up capsule sits exactly where the draft capsule does.
  //     Both input surfaces use the same independent anchor.
  const gap = (reading) => reading.capsule.top - reading.ink.bottom
  await selectVariant('单行草稿', 1)
  const single = await settledCapsule('the one-line draft capsule', 1)
  await selectFollowUp('Thread 续写')
  const followUp = await settledCapsule('the follow-up capsule', 1)
  assertCapsuleIsMarkedUp(followUp)
  evidence.followUp = {
    gap: gap(followUp), oneLineGap: gap(single), height: followUp.capsule.height,
    followUpTop: followUp.capsule.top, singleTop: single.capsule.top,
    followUpInkBottom: followUp.ink.bottom, singleInkBottom: single.ink.bottom,
    followUpBottom: followUp.capsule.bottom, singleBottom: single.capsule.bottom
  }
  assert.equal(followUp.capsule.height, single.capsule.height, 'the follow-up capsule is the one-line capsule')
  assert.ok(gap(followUp) > 0, 'the follow-up capsule clears Bart')
  assert.ok(Math.abs(gap(followUp) - gap(single)) <= 1, 'the follow-up capsule keeps the same gap above it')

  // 11b. The thread's name is drawn above the capsule's top edge, so whatever
  //      clips the capsule's contents cannot be the capsule itself: the label
  //      would be cut off with the rest of what overflows. Hit-testing it is
  //      what tells the difference — a clipped element is still in the layout
  //      and still has a box, but nothing is painted at that box.
  const route = await preview.locator('.bart-dock-thread-follow-up').evaluate((capsule) => {
    const label = capsule.querySelector('.bart-dock-thread-follow-up-route')
    const box = label.getBoundingClientRect()
    return {
      top: box.top,
      width: box.width,
      above: box.bottom <= capsule.getBoundingClientRect().top,
      painted: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === label
    }
  })
  assert.ok(route.width > 0, 'the follow-up shows the thread it is writing to')
  assert.ok(route.above, 'the thread name is drawn above the capsule')
  assert.ok(route.top >= followUp.ink.bottom - 0.5,
    `the thread name clears Bart (label ${route.top}, Bart ${followUp.ink.bottom}, capsule ${followUp.capsule.top})`)
  assert.ok(route.painted, 'the thread name is not clipped away by the capsule')
  const colors = await preview.locator('.bart-dock-thread-follow-up').evaluate((capsule) => {
    const route = capsule.querySelector('.bart-dock-thread-follow-up-route')
    const input = capsule.querySelector('input')
    return {
      routeBackground: getComputedStyle(route).backgroundColor,
      routeText: getComputedStyle(route).color,
      capsuleBackground: getComputedStyle(capsule).backgroundColor,
      placeholder: getComputedStyle(input, '::placeholder').color
    }
  })
  assert.ok(contrastAgainst(colors.routeText, colors.routeBackground) >= 4.5,
    'the thread name stays legible over a light canvas')
  assert.ok(contrastAgainst(colors.placeholder, colors.capsuleBackground) >= 4.5,
    'the follow-up placeholder is legible on the dark capsule')
  await page.screenshot({ path: path.join(output, 'capsule-follow-up.png') })

  // 12. Opening and closing leave Bart at his mark position on every frame.
  await selectVariant('单行草稿', 1)
  await field.focus()
  await field.press('Escape')
  await preview.locator('.bart-dock-inline-composer').waitFor({ state: 'detached' })
  await preview.locator('.bart-dock').hover()
  await settledFrame()
  const markRest = await measure()

  const entry = await framesAcross(async () => {
    await preview.getByRole('button', { name: '输入 Bart 消息', exact: true }).click()
    await preview.locator('.bart-dock-inline-composer').waitFor()
  })
  const inputRest = await settledCapsule('the one-line capsule after the entry', 1)
  assert.ok(displacement(entry, markRest.ink.top) <= 1, 'Bart stays fixed while input opens')
  assert.ok(Math.abs(inputRest.ink.top - markRest.ink.top) <= 1, 'input leaves Bart at rest')

  const exit = await framesAcross(async () => {
    await field.press('Escape')
    await preview.locator('.bart-dock-inline-composer').waitFor({ state: 'detached' })
  })
  await settledFrame()
  const markAgain = await measure()
  assert.ok(displacement(exit, markRest.ink.top) <= 1, 'Bart stays fixed while input closes')
  assert.ok(Math.abs(markAgain.ink.top - markRest.ink.top) <= 1, 'closing leaves Bart at rest')
  evidence.transition = {
    markInkTop: markRest.ink.top,
    inputInkTop: inputRest.ink.top,
    entryFrames: entry.length,
    exitFrames: exit.length,
    entryDisplacement: displacement(entry, markRest.ink.top),
    exitDisplacement: displacement(exit, markRest.ink.top)
  }

  // 13. The attachment strip also opens independently of Bart.
  await reopenInput()
  await selectVariant('带附件', 1)
  await field.focus()
  await field.press('Escape')
  await preview.locator('.bart-dock-inline-composer').waitFor({ state: 'detached' })
  await preview.locator('.bart-dock').hover()
  await settledFrame()
  const attachedMark = await measure()

  const attachedEntry = await framesAcross(async () => {
    await preview.getByRole('button', { name: '输入 Bart 消息', exact: true }).click()
    await preview.locator('.bart-dock-inline-composer').waitFor()
  })
  await settledFrame()
  const attachedRest = await measure()
  assert.ok(attachedRest.capsule.height > one.capsule, 'the entry brought the attachments back')

  const attachedGap = attachedRest.capsule.top - attachedRest.ink.bottom
  assert.ok(displacement(attachedEntry, attachedMark.ink.top) <= 1, 'attachments never lift Bart')
  assert.ok(attachedGap > 0, 'attachments keep their clearance from Bart')
  evidence.attachments = {
    restGap: attachedGap,
    entryFrames: attachedEntry.length,
    displacement: displacement(attachedEntry, attachedMark.ink.top)
  }

  assert.deepEqual(errors, [], 'Lab has no runtime errors')
  console.log(`Bart input browser checks passed. Evidence: ${output}`)
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(evidence, null, 2))
  await browser.close()
}
