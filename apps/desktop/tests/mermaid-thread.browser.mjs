import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Start `pnpm playground:mermaid` first. Real layout, the dynamic `import('mermaid')`
// and outbound requests exist only in a browser; jsdom cannot tell whether a
// chart widened the Thread or whether a hostile source reached the network.
const url = process.env.MERMAID_LAB_URL || 'http://127.0.0.1:4179/'
const origin = new URL(url).origin
const output = path.resolve('output/playwright/mermaid-thread')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url })
const page = await context.newPage()
// Stamped before any lab module evaluates, so a scene can report how long it
// took from document start to its charts being drawn.
await page.addInitScript(() => {
  window.__labStart = performance.now()
})
const errors = []
/** Every request that leaves the lab's own origin. */
const external = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('request', (request) => {
  const target = new URL(request.url())
  if ((target.protocol === 'http:' || target.protocol === 'https:') && target.origin !== origin) {
    external.push(request.url())
  }
})

/** The Markdown Worker commits asynchronously; `aria-busy` is the readiness
 * signal the Thread rings promise, so the lab is only sampled once it clears. */
async function settle() {
  for (let pass = 0; pass < 40; pass += 1) {
    if (await page.evaluate(() => document.querySelector('.markdown-body[aria-busy="false"]') !== null)) return
    await page.waitForTimeout(150)
  }
  throw new Error('Markdown never settled')
}

async function open(search) {
  await page.goto(`${url}?${search}`)
  await page.locator('.markdown-body').waitFor()
  await settle()
}

function luminance(color) {
  const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** Document start to the last of `count` charts being drawn, in the page. */
async function drawnMs(count) {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.markdown-mermaid svg').length >= expected,
    count
  )
  return Math.round(await page.evaluate(() => performance.now() - window.__labStart))
}

const observed = {}

try {
  // --- A1/A2: diagram types, and ordinary Markdown around them untouched ---
  await open('scene=types')
  await page.locator('.markdown-mermaid svg').first().waitFor()
  await settle()
  const types = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('.markdown-mermaid svg')]
    return {
      hosts: document.querySelectorAll('.markdown-mermaid').length,
      svgs: svgs.length,
      statuses: [...document.querySelectorAll('.markdown-mermaid-status')].map((node) => node.textContent),
      roles: svgs.map((svg) => svg.getAttribute('role')),
      labels: svgs.map((svg) => svg.getAttribute('aria-label')),
      text: svgs.map((svg) => svg.textContent),
      table: Boolean(document.querySelector('.markdown-body table')),
      link: document.querySelector('.markdown-body a')?.getAttribute('href'),
      code: document.querySelector('.markdown-body pre code')?.textContent
    }
  })
  assert.equal(types.hosts, 5, 'A2: five diagrams keep five hosts')
  assert.equal(types.svgs, 5, 'A2: flowchart, sequence, class, state and ER all draw')
  assert.deepEqual(types.statuses, [], 'A2: no diagram falls back')
  assert.deepEqual(types.roles, Array(5).fill('img'), 'A10: each chart is an image to assistive tech')
  assert.deepEqual(types.labels, Array(5).fill('Mermaid 图表'), 'A10: each chart carries a name')
  assert.match(types.text.join('\n'), /开始[\s\S]*校验订单[\s\S]*提交订单[\s\S]*预占库存/, 'A2: Chinese labels survive')
  assert.match(types.text.join('\n'), /订单[\s\S]*支付[\s\S]*待支付[\s\S]*已发货[\s\S]*客户[\s\S]*订单行/, 'A2: every later diagram rendered')
  assert.ok(types.table, 'A1: the table after the diagrams is still a table')
  assert.equal(types.link, 'https://example.invalid/docs', 'A1: ordinary links are untouched')
  assert.equal(types.code.trim(), 'const order = await submit()', 'A1: a `ts` fence stays a code block')
  observed.types = { hosts: types.hosts, svgs: types.svgs }
  await page.screenshot({ path: path.join(output, 'types.png'), fullPage: true })

  // --- A8: same-source charts must not collide ---
  await open('scene=multi')
  const multiMs = await drawnMs(6)
  await settle()
  const multi = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('.markdown-mermaid svg')]
    const ids = svgs.map((svg) => svg.id)
    const inner = svgs.flatMap((svg) => [...svg.querySelectorAll('[id]')].map((node) => node.id))
    return { count: svgs.length, unique: new Set(ids).size, inner: inner.length, innerUnique: new Set(inner).size }
  })
  assert.equal(multi.count, 6, 'A8: six fences draw six charts')
  assert.equal(multi.unique, 6, 'A8: every chart has its own SVG id')
  assert.equal(multi.inner, multi.innerUnique, 'A8: inner markers are unique across charts')
  observed.multi = { ...multi, drawnMs: multiMs }

  // --- A8: a wide chart fits the column, and keeps its size on demand ---
  await open('scene=wide')
  const wideMs = await drawnMs(1)
  await settle()
  const measureWide = () =>
    page.evaluate(() => {
      const svg = document.querySelector('.markdown-mermaid svg')
      const scroll = document.querySelector('.markdown-mermaid-scroll')
      return {
        pageScroll: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        column: document.querySelector('.lab-column').getBoundingClientRect().width,
        drawn: Math.round(svg.getBoundingClientRect().width),
        natural: Number(svg.getAttribute('width')),
        scrollWidth: scroll.scrollWidth,
        scrollClient: scroll.clientWidth,
        fit: document.querySelector('.markdown-mermaid-canvas').dataset.fit
      }
    })
  const wideFit = await measureWide()
  assert.ok(wideFit.natural > wideFit.column, 'A8: the fixture really is wider than the column')
  assert.ok(wideFit.drawn <= wideFit.column, 'A8: fit mode keeps the chart inside the column')
  assert.equal(wideFit.pageScroll, wideFit.viewport, 'A8: a Mermaid chart never widens the Thread')
  assert.equal(wideFit.fit, 'fit')
  await page.getByRole('button', { name: '原始大小' }).click()
  await page.waitForTimeout(400)
  const wideActual = await measureWide()
  assert.equal(wideActual.fit, 'actual')
  assert.ok(Math.abs(wideActual.drawn - wideActual.natural) < 1, 'A8: actual size is the diagram’s own size')
  assert.ok(wideActual.scrollWidth > wideActual.scrollClient, 'A8: the wide chart scrolls inside its block')
  assert.equal(wideActual.pageScroll, wideActual.viewport, 'A8: scrolling happens in the block, not the page')
  // A11: how long the widest chart takes to service a scroll, and the chart is
  // still there afterwards.
  const scroll = await page.evaluate(async () => {
    const block = document.querySelector('.markdown-mermaid-scroll')
    const target = block.scrollWidth - block.clientWidth
    const frames = []
    for (let step = 1; step <= 5; step += 1) {
      const started = performance.now()
      block.scrollLeft = (target * step) / 5
      await new Promise((resolve) => requestAnimationFrame(resolve))
      frames.push(Math.round(performance.now() - started))
    }
    return {
      overflow: target,
      frames,
      landed: Math.round(block.scrollLeft),
      svgPresent: document.querySelector('.markdown-mermaid svg') !== null
    }
  })
  assert.equal(scroll.landed, scroll.overflow, 'A8: the block really scrolled to the far edge')
  assert.ok(scroll.svgPresent, 'A8: scrolling keeps the chart in place')
  observed.wide = { fit: wideFit, actual: wideActual, scroll, drawnMs: wideMs }
  await page.getByRole('button', { name: '适应宽度' }).click()
  await page.waitForTimeout(300)

  // --- A8: the same chart in a narrow Thread ---
  await open('scene=wide&column=narrow')
  await page.locator('.markdown-mermaid svg').first().waitFor()
  await settle()
  const narrow = await page.evaluate(() => ({
    column: document.querySelector('.lab-column').getBoundingClientRect().width,
    drawn: document.querySelector('.markdown-mermaid svg').getBoundingClientRect().width,
    pageScroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }))
  assert.equal(narrow.column, 420, 'A8: the lab really narrowed the column')
  assert.ok(narrow.drawn <= narrow.column, 'A8: the chart follows the narrower column')
  assert.equal(narrow.pageScroll, narrow.viewport, 'A8: no horizontal page overflow when narrow')
  observed.narrow = narrow

  // --- A7: hostile sources execute nothing and reach nobody ---
  external.length = 0
  await open('scene=hostile')
  await page.locator('.markdown-mermaid').first().waitFor()
  await settle()
  await page.waitForTimeout(600)
  const hostile = await page.evaluate(() => {
    const block = document.querySelector('.markdown-mermaid')
    const attributes = [...block.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes].map((attribute) => `${element.tagName.toLowerCase()}.${attribute.name}=${attribute.value}`)
    )
    return {
      hosts: document.querySelectorAll('.markdown-mermaid').length,
      svgs: document.querySelectorAll('.markdown-mermaid svg').length,
      statuses: [...document.querySelectorAll('.markdown-mermaid-status')].map((node) => node.textContent),
      scripts: document.querySelectorAll('.markdown-body script').length,
      imgs: document.querySelectorAll('.markdown-mermaid img').length,
      images: document.querySelectorAll('.markdown-mermaid image').length,
      foreign: document.querySelectorAll('.markdown-mermaid foreignObject').length,
      remoteAttributes: attributes.filter((value) => /(?:href|src|URL)=https?:/i.test(value)),
      onHandlers: attributes.filter((value) => /\son[a-z]+=/i.test(` ${value}`)),
      styles: [...document.querySelectorAll('.markdown-mermaid style')].map((node) => node.textContent),
      bodyDisplay: getComputedStyle(document.body).display,
      bodyHeight: document.body.getBoundingClientRect().height,
      scriptRan: 'oaScriptRan' in window,
      imageRan: 'oaImgRan' in window,
      clicked: 'oaClicked' in window
    }
  })
  assert.ok(hostile.hosts >= 5, 'A7: every hostile fence is rendered somewhere')
  assert.ok(hostile.svgs > 0, 'A7: safe charts among the hostile ones still draw')
  assert.equal(hostile.scripts, 0, 'A7: no script element from the source')
  assert.equal(hostile.imgs + hostile.images, 0, 'A7: no image element from the source')
  assert.equal(hostile.foreign, 0, 'A7: html labels stay disabled')
  assert.deepEqual(hostile.onHandlers, [], 'A7: no inline handler survives')
  assert.deepEqual(hostile.remoteAttributes, [], 'A7: no attribute points at a remote URL')
  assert.ok(hostile.styles.every((text) => !/@import|url\(\s*['"]?https?:/i.test(text ?? '')), 'A7: no remote style import')
  assert.equal(hostile.bodyDisplay, 'block', 'A7: themeCSS injection does not hide the Thread')
  assert.ok(hostile.bodyHeight > 200, 'A7: the Thread is still laid out')
  assert.equal(hostile.scriptRan, false, 'A7: injected script never executed')
  assert.equal(hostile.imageRan, false, 'A7: injected image handler never ran')
  assert.equal(hostile.clicked, false, 'A7: click callback never ran')
  assert.deepEqual(external, [], 'A7: diagram content triggers no network request')
  observed.hostile = {
    svgs: hostile.svgs,
    statuses: hostile.statuses,
    externalRequests: [...external]
  }
  await page.screenshot({ path: path.join(output, 'hostile.png'), fullPage: true })

  // --- A6: failure isolation and retry ---
  await open('scene=error')
  await page.locator('.markdown-mermaid').first().waitFor()
  await settle()
  const failure = await page.evaluate(() => ({
    hosts: document.querySelectorAll('.markdown-mermaid').length,
    svgs: document.querySelectorAll('.markdown-mermaid svg').length,
    statuses: [...document.querySelectorAll('.markdown-mermaid-status')].map((node) => node.textContent),
    retries: document.querySelectorAll('.markdown-mermaid-fallback button').length,
    sources: [...document.querySelectorAll('.markdown-mermaid-source code')].map((node) => node.textContent)
  }))
  assert.equal(failure.hosts, 4, 'A6: the broken fences still occupy their place')
  assert.equal(failure.svgs, 1, 'A6: a broken neighbour does not stop the good chart')
  assert.equal(failure.statuses.length, 3, 'A6: each failure explains itself')
  assert.match(failure.statuses.join('\n'), /语法/, 'A6: syntax errors are named')
  assert.match(failure.statuses.join('\n'), /为空/, 'A6: an empty fence is named')
  assert.match(failure.statuses.join('\n'), /50,000/, 'A6: the size ceiling is named')
  assert.equal(failure.sources.length, 3, 'A6: every refused chart keeps its source')
  assert.equal(failure.retries, 3, 'A6: every refused chart offers a retry')
  await page.locator('.markdown-mermaid-fallback button').first().click()
  await page.locator('.markdown-mermaid-status').first().waitFor()
  await settle()
  assert.ok(
    await page.evaluate(() => document.querySelectorAll('.markdown-mermaid-status').length >= 3),
    'A6: retrying a broken chart reports the failure again instead of drawing nothing'
  )
  observed.error = { ...failure, sources: failure.sources.map((source) => source.length) }

  // --- A6: source switch and copy ---
  await open('scene=types')
  await page.locator('.markdown-mermaid svg').first().waitFor()
  await settle()
  const figure = page.locator('.markdown-mermaid-figure').first()
  await figure.getByRole('button', { name: '图表源码' }).click()
  const sourceText = await figure.locator('.markdown-mermaid-source code').textContent()
  assert.match(sourceText, /^```mermaid\n|^graph TD/, 'A6: the source view shows the message’s own source')
  assert.equal(await figure.locator('.markdown-mermaid-scroll').isVisible(), false, 'A6: the chart is hidden, not destroyed')
  await figure.getByRole('button', { name: '复制源码' }).click()
  await figure.getByRole('button', { name: '已复制' }).waitFor()
  const clipboard = await page.evaluate(() => navigator.clipboard.readText())
  assert.equal(clipboard.trim(), sourceText.trim(), 'A6: copy puts the source on the clipboard')
  await figure.getByRole('button', { name: '图表' }).click()
  assert.equal(await figure.locator('.markdown-mermaid-scroll').isVisible(), true, 'A6: switching back restores the chart')
  assert.equal(await figure.locator('.markdown-mermaid-source').count(), 0, 'A6: the source view is gone again')
  observed.operations = { clipboardMatches: true }

  // --- A8: runtime theme switch redraws the chart ---
  await context.clearCookies()
  await page.emulateMedia({ colorScheme: 'light' })
  await open('scene=types')
  await page.locator('.markdown-mermaid svg').first().waitFor()
  await settle()
  const readFill = () =>
    page.evaluate(() => {
      const node = document.querySelector('.markdown-mermaid svg .node rect, .markdown-mermaid svg .nodeLabel')
      return node ? getComputedStyle(node).fill : null
    })
  const lightFill = await readFill()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(2000)
  const darkFill = await readFill()
  assert.ok(lightFill && darkFill, 'A8: the chart paints a themed node')
  assert.notEqual(lightFill, darkFill, 'A8: switching the OS theme repaints the chart')
  assert.ok(luminance(lightFill) > luminance(darkFill), 'A8: the dark theme is actually darker')
  observed.theme = { light: lightFill, dark: darkFill }

  // --- A3: streaming ---
  await page.emulateMedia({ colorScheme: 'light' })
  await open('scene=stream')
  const readStream = () =>
    page.evaluate(() => ({
      step: document.querySelector('.lab').dataset.step,
      streaming: document.querySelector('.lab').dataset.streaming,
      busy: document.querySelector('.markdown-body').getAttribute('aria-busy'),
      svgs: document.querySelectorAll('.markdown-mermaid svg').length,
      sources: document.querySelectorAll('.markdown-mermaid-source').length,
      status: document.querySelector('.markdown-mermaid-status')?.textContent ?? null,
      text: document.querySelector('.markdown-body').textContent
    }))
  const steps = []
  for (let index = 0; index < 5; index += 1) {
    await page.waitForTimeout(900)
    steps.push(await readStream())
    if (index < 4) await page.getByRole('button', { name: '下一段' }).click()
  }
  assert.equal(steps[0].svgs, 0, 'A3: an open fence draws nothing')
  assert.equal(steps[0].sources, 1, 'A3: an open fence shows its source')
  assert.equal(steps[0].status, '图表生成中…', 'A3: an open fence reads as still generating')
  assert.equal(steps[1].svgs, 0, 'A3: a longer open fence still draws nothing')
  assert.equal(steps[2].svgs, 0, 'A3: the fence is open until its closing line is confirmed')
  assert.equal(steps[3].svgs, 1, 'A3: the confirmed closing line draws the chart')
  assert.equal(steps[3].status, null, 'A3: the drawing status gives way to the chart')
  assert.equal(steps[3].streaming, 'true', 'A3: the chart appears while the message is still streaming')
  assert.equal(steps[4].svgs, 1, 'A4: trailing text keeps the drawn chart')
  assert.match(steps[4].text, /入库后立刻通知仓库/, 'A4: the trailing paragraph still arrives')
  assert.ok(steps.every((step) => step.busy === 'false'), 'A10: every settled streaming chunk clears aria-busy')
  const ids = await page.evaluate(() => [...document.querySelectorAll('.markdown-mermaid svg')].map((svg) => svg.id))
  assert.equal(new Set(ids).size, ids.length, 'A4: the appended chunk does not redraw a second chart')
  observed.stream = steps.map(({ step, streaming, svgs, sources, status, busy }) => ({
    step,
    streaming,
    svgs,
    sources,
    status,
    busy
  }))
  await page.screenshot({ path: path.join(output, 'stream.png'), fullPage: true })

  // --- A3: a fence the message ends without closing still resolves ---
  await open('scene=stream&mode=unterminated')
  await page.locator('.markdown-mermaid').first().waitFor()
  await settle()
  await page.getByRole('button', { name: '结束流式' }).click()
  await settle()
  await page.waitForTimeout(1200)
  assert.equal(
    await page.evaluate(() => document.querySelectorAll('.markdown-mermaid svg').length),
    1,
    'A3: the end of the message makes a never-closed fence renderable'
  )
  observed.unterminated = { svgs: 1 }

  // --- A11: without Mermaid there is no library to load ---
  const library = []
  page.on('request', (request) => {
    if (/deps\/mermaid/.test(request.url())) library.push(request.url())
  })
  await open('scene=types&mermaid=off')
  await page.waitForTimeout(1200)
  const off = await page.evaluate(() => ({
    hosts: document.querySelectorAll('.markdown-mermaid').length,
    previews: document.querySelectorAll('.markdown-body pre code').length,
    busy: document.querySelector('.markdown-body').getAttribute('aria-busy')
  }))
  assert.equal(off.hosts, 0, 'A11: switching Mermaid off removes the chart hosts')
  assert.ok(off.previews >= 5, 'A11: the fences stay readable as source')
  assert.equal(off.busy, 'false', 'A11: the message is ready without any chart work')
  assert.deepEqual(library, [], 'A11: no Mermaid code is fetched when charts are off')
  observed.off = { ...off, libraryRequests: library }

  assert.deepEqual(errors, [], 'the lab has no runtime errors')
  assert.deepEqual(external, [], 'nothing in the lab reached a third party')
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ observed, errors, external }, null, 2))
  console.log(`Passed the real-browser Mermaid acceptance run. Evidence: ${output}`)
} finally {
  await browser.close()
}
