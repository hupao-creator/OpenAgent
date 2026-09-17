#!/usr/bin/env node
// Existing development source/asset regression, extracted from the former Actions job.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
const root = process.cwd()
const desktop = join(root, 'apps/desktop')
const require = createRequire(join(desktop, 'package.json'))
const { chromium } = require('playwright')
const descriptor = join(root, 'packages/harness-codex/src/shared/descriptor.ts')
const css = join(root, 'packages/harness-codex/src/renderer/codex-renderer.css')
const distCss = join(root, 'packages/harness-codex/dist/renderer/codex-renderer.css')
const main = join(desktop, 'out/main/index.js')
const html = join(desktop, 'src/renderer/__ci_dev_probe__.html')
const script = join(desktop, 'src/renderer/__ci_dev_probe__.js')
const originalDescriptor = await readFile(descriptor, 'utf8')
const originalCss = await readFile(css, 'utf8')
const marker = 'Codex CI development probe'
assert.equal(originalDescriptor.split("displayName: 'Codex'").length, 2)
await writeFile(html, '<!doctype html><body><script type="module" src="/__ci_dev_probe__.js"></script></body>', { flag: 'wx' })
await writeFile(script, `
import descriptor from '@openagent/harness-codex/manifest'
import ${JSON.stringify(`/@fs${distCss}`)}
document.body.textContent = descriptor.displayName
if (import.meta.hot) {
  import.meta.hot.accept('@openagent/harness-codex/manifest', (module) => {
    if (module) document.body.textContent = module.default.displayName
  })
}
`, { flag: 'wx' })
let output = ''
let exit
let browser
let interrupted = false
const child = spawn(process.execPath, [resolve(root, 'scripts/dev.mjs')], {
  cwd: root,
  env: process.env,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe']
})
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8').on('data', text => { output = (output + text).slice(-40_000) })
}
child.on('error', error => { output += `\n${error.stack}` })
const closed = new Promise(resolveExit => child.once('close', (code, signal) => {
  exit = { code, signal }
  resolveExit(exit)
}))
const stop = () => {
  interrupted = true
  child.kill('SIGTERM')
  void browser?.close().catch(() => {})
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
async function until(check, label) {
  const end = Date.now() + 90_000
  while (!(await check())) {
    assert.equal(interrupted, false, 'Development verification interrupted')
    assert.equal(exit, undefined, `Development process exited during ${label}: ${JSON.stringify(exit)}\n${output}`)
    if (Date.now() > end) throw new Error(`Timed out: ${label}\n${output}`)
    await new Promise(done => setTimeout(done, 100))
  }
}
try {
  // Strip the complete buffered text: an ANSI sequence can cross chunks.
  const serverUrl = () => stripVTControlCharacters(output).match(/http:\/\/localhost:\d+\//)?.[0]
  await until(() => Boolean(serverUrl()), 'development server startup')
  const url = serverUrl()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  page.on('pageerror', error => console.error(`Browser probe: ${error.stack}`))
  const response = await page.goto(`${url}__ci_dev_probe__.html`)
  assert.equal(response?.status(), 200, 'Development probe must be served successfully')
  await page.waitForFunction(() => document.body.textContent === 'Codex', undefined, { timeout: 90_000 })
  await writeFile(descriptor, originalDescriptor.replace("displayName: 'Codex'", `displayName: '${marker}'`))
  await page.waitForFunction(value => document.body.textContent === value, marker, { timeout: 90_000 })
  await until(async () => (await readFile(main, 'utf8').catch(() => '')).includes(marker), 'Main bundle update')
  console.log('PASS plugin TypeScript source -> package output -> browser and Main bundle')
  await page.evaluate(() => { window.__ciDocumentIdentity = 'same-document' })
  await writeFile(css, `${originalCss}\n:root { --openagent-ci-probe: updated; }\n`)
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--openagent-ci-probe').trim() === 'updated', undefined, { timeout: 90_000 })
  assert.equal(await page.evaluate(() => window.__ciDocumentIdentity), 'same-document')
  console.log('PASS plugin CSS source -> copied asset -> CSS HMR without page reload')
  await writeFile(descriptor, originalDescriptor)
  await writeFile(css, originalCss)
  await page.waitForFunction(() => document.body.textContent === 'Codex', undefined, { timeout: 90_000 })
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--openagent-ci-probe').trim() === '', undefined, { timeout: 90_000 })
  await until(async () => {
    try {
      // Vite may clear outDir before emitting. Missing/empty is not restoration.
      const content = await readFile(main, 'utf8')
      return content.length > 0 && !content.includes(marker)
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
  }, 'restored Main bundle')
  console.log('PASS source restoration propagates through development pipeline')
} catch (error) {
  console.error(output)
  throw error
} finally {
  await writeFile(descriptor, originalDescriptor)
  await writeFile(css, originalCss)
  await browser?.close()
  if (!exit) child.kill('SIGTERM')
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL') } catch {}
          reject(new Error('Development coordinator did not stop after SIGTERM'))
        }, 12_000)
      })
    ])
  } finally {
    clearTimeout(timer)
    await unlink(html)
    await unlink(script)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}
assert.equal(interrupted, false, 'Development verification interrupted')
assert.deepEqual(exit, { code: 143, signal: null })
console.log('PASS development coordinator shutdown')
