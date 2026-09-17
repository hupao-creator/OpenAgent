// Pixel checks on real Overview creation, including the production Worker and
// texture compositing. Phase names alone cannot prove a morph or a face exists.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  const result = spawnSync(electron, [fileURLToPath(import.meta.url)], {
    cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: 'inherit'
  })
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, nativeTheme } = await import('electron')
const output = await mkdtemp(path.join(tmpdir(), 'bart-generation-visuals-'))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(read, accepts) {
  const deadline = performance.now() + 15000
  let value
  while (performance.now() < deadline) {
    value = await read()
    if (accepts(value)) return value
    await delay(8)
  }
  throw new Error(`Timed out: ${JSON.stringify(value)}`)
}

// Find connected dark bodies, then count bright eye pixels strictly inside
// their silhouettes. Text/background highlights cannot masquerade as eyes.
function bodies(image, cardSurface = false) {
  const { width, height } = image.getSize(), pixels = image.toBitmap()
  const seen = new Uint8Array(width * height), found = []
  const dark = i => pixels[i * 4] < 27 && pixels[i * 4 + 1] < 27 && pixels[i * 4 + 2] < 27
  const body = i => dark(i) || (cardSurface && pixels[i * 4] > 90 && pixels[i * 4 + 1] > 90 && pixels[i * 4 + 2] > 90)
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || !body(start)) continue
    const queue = [start]; seen[start] = 1
    let left = width, right = 0, top = height, bottom = 0
    for (let at = 0; at < queue.length; at++) {
      const index = queue[at], x = index % width, y = Math.floor(index / width)
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y)
      for (const next of [x ? index - 1 : -1, x + 1 < width ? index + 1 : -1,
        y ? index - width : -1, y + 1 < height ? index + width : -1]) {
        if (next >= 0 && !seen[next] && body(next)) { seen[next] = 1; queue.push(next) }
      }
    }
    if (queue.length < 25) continue
    let eyes = 0
    for (let y = top + 1; !cardSurface && y < bottom; y++) for (let x = left + 1; x < right; x++) {
      const index = y * width + x
      if (pixels[index * 4] < 180 || pixels[index * 4 + 1] < 180 || pixels[index * 4 + 2] < 180) continue
      // All four cardinal rays must encounter this body's dark silhouette.
      const enclosed = [[-1, 0], [1, 0], [0, -1], [0, 1]].every(([dx, dy]) => {
        for (let xx = x + dx, yy = y + dy; xx >= left && xx <= right && yy >= top && yy <= bottom; xx += dx, yy += dy) {
          if (dark(yy * width + xx)) return true
        }
        return false
      })
      if (enclosed) eyes++
    }
    found.push({ left, top, width: right - left + 1, height: bottom - top + 1, area: queue.length, eyes })
  }
  return found.sort((a, b) => b.area - a.area)
}

app.whenReady().then(async () => {
nativeTheme.themeSource = 'dark'
const window = new BrowserWindow({ width: 1180, height: 780, useContentSize: true, show: true,
  alwaysOnTop: true,
  backgroundColor: '#41454b', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
const contents = window.webContents
const status = () => contents.executeJavaScript('window.bartOverview.status()')
try {
  await window.loadFile(path.join(desktop, 'out/bart-lab/isolation.html'), { search: '?overview-regressions' })
  await wait(() => contents.executeJavaScript('Boolean(window.bartOverview && document.querySelector(".bart-logo[data-worker-ready]"))'), Boolean)
  await contents.executeJavaScript('window.bartOverview.create()')
  const initial = await wait(status, value => value.ready || value.skipped)
  assert.ok(initial.ready, JSON.stringify(initial))
  const plan = initial.ready, card = plan.cards[0], camera = plan.camera?.at(-1) ?? { x: 0, y: 0 }
  const clip = { x: Math.floor(card.x + camera.x - 20), y: Math.floor(card.y + camera.y - 20),
    width: Math.ceil(card.width + 40), height: Math.ceil(card.height + 40) }
  const phase = name => plan.phases.find(value => value.name === name).at
  const samples = []
  async function capture(label, at) {
    await delay(Math.max(0, plan.origin + at - Date.now()))
    const image = await contents.capturePage(clip)
    const entry = { label, at, elapsed: Date.now() - plan.origin, size: image.getSize(), image }
    samples.push(entry)
    return entry
  }
  const inflated = await capture('inflated', phase('morph:0') + 55)
  const stretched = await capture('stretched', phase('morph:0') + 105)
  await capture('settled-card', phase('morph:0') + 240)
  const cursorA = await capture('caret-a', phase('reveal:0') + 350)
  const cursorB = await capture('caret-b', phase('reveal:0') + 750)
  // Keep PNG encoding and pixel analysis out of the short morph capture window.
  for (const sample of samples) {
    sample.bodies = bodies(sample.image, ['stretched', 'settled-card'].includes(sample.label))
    await writeFile(path.join(output, `${sample.label}.png`), sample.image.toPNG())
    delete sample.image
  }
  await writeFile(path.join(output, 'pixels.json'), JSON.stringify({ plan, clip, samples }, null, 2))
  const ratio = inflated.size.width / clip.width
  assert.ok(inflated.bodies[0]?.width > 100 * ratio, `No inflated body: ${JSON.stringify(inflated)}`)
  assert.ok(inflated.bodies[0]?.eyes >= 8 * ratio, `Morph lost its eyes: ${JSON.stringify(inflated)}`)
  assert.ok(stretched.bodies[0]?.width > inflated.bodies[0].width * 1.35, `No expanding silhouette: ${JSON.stringify(stretched)}`)
  for (const cursor of [cursorA, cursorB]) {
    const body = cursor.bodies.find(value => value.width >= 10 * ratio && value.width <= 28 * ratio && value.height >= 10 * ratio && value.height <= 28 * ratio)
    assert.ok(body && body.eyes >= 4 * ratio, `Typesetting Bart has no face: ${JSON.stringify(cursor)}`)
  }
  const finished = await wait(status, value => !value.busy && !value.works && !value.sealed)
  assert.deepEqual(finished.hidden, [])
  const resources = await contents.executeJavaScript('window.bartOverview.inspect()')
  assert.equal(resources.textures, 0)
  console.log('BART_GENERATION_VISUALS', JSON.stringify({ output, samples, passed: true }))
  window.destroy(); app.exit(0)
} catch (error) {
  console.error('BART_GENERATION_VISUALS_FAILED', output, error)
  window.destroy(); app.exit(1)
}
})
