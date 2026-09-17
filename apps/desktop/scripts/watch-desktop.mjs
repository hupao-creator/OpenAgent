#!/usr/bin/env node
/** Keep package JS, declarations and copied assets current before serving the
 * desktop. Package scripts own compilation/copying; this coordinator serializes
 * their builds and registry generation instead of watching only stale dist.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = resolve(desktopRoot, '../../packages')
const forwarded = process.argv.slice(2)
const testMode = forwarded[0] === '--test'
const playgroundMode = forwarded[0] === '--playground'
const singleThreadMode = forwarded[0] === '--single-thread'
const overviewMotionMode = forwarded[0] === '--overview-motion'
const bartTransitionMode = forwarded[0] === '--bart-transition'
const mermaidThreadMode = forwarded[0] === '--mermaid-thread'
if (testMode || playgroundMode || singleThreadMode || overviewMotionMode || bartTransitionMode || mermaidThreadMode) forwarded.shift()
const children = new Set()
const groups = new Set()
const sourceWatchers = new Map()
const watchers = []
let stopping = false
let exitCode = 0
let killTimer
let debounce
let requested = 0
let processed = -1
let building = false
let desktopStarted = false

function liveGroups() {
  for (const pid of groups) {
    try { process.kill(-pid, 0) } catch { groups.delete(pid) }
  }
  return groups.size > 0
}
function finish() {
  if (!stopping || children.size || (process.platform !== 'win32' && liveGroups())) return
  clearTimeout(killTimer)
  process.exit(exitCode)
}
function signalChildren(signal) {
  if (process.platform === 'win32') {
    for (const child of children) {
      if (child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    }
  } else {
    for (const pid of groups) {
      try { process.kill(-pid, signal) } catch { groups.delete(pid) }
    }
  }
}
function shutdown(code) {
  if (stopping) return
  stopping = true
  exitCode = code
  clearTimeout(debounce)
  for (const watcher of [...watchers, ...sourceWatchers.values()]) watcher.close()
  signalChildren('SIGTERM')
  killTimer = setTimeout(() => {
    signalChildren('SIGKILL')
    process.exit(exitCode)
  }, 5000)
  finish()
}
function runPnpm(args) {
  return new Promise((resolveResult) => {
    const pnpmPath = process.env.npm_execpath
    const useNode = pnpmPath && /pnpm(?:\.c?js)?$/i.test(pnpmPath)
    const child = spawn(useNode ? process.execPath : 'pnpm', useNode ? [pnpmPath, ...args] : args, {
      cwd: desktopRoot,
      env: { ...process.env, OPENAGENT_LIVE_BUILD: '1' },
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      shell: !useNode && process.platform === 'win32'
    })
    children.add(child)
    if (child.pid && process.platform !== 'win32') groups.add(child.pid)
    child.once('error', (error) => {
      console.error(`[workspace-watch] ${error.message}`)
    })
    child.once('close', (code) => {
      children.delete(child)
      if (process.platform !== 'win32') liveGroups()
      resolveResult(code ?? 1)
      finish()
    })
  })
}
async function rebuild() {
  if (building || stopping) return
  building = true
  try {
    while (!stopping && processed !== requested) {
      const version = requested
      const code = await runPnpm(['run', 'generate:registry'])
      processed = version
      if (stopping) return
      if (code !== 0) {
        console.error('[workspace-watch] 构建失败；等待下一次源码修改后重试')
        continue
      }
      if (requested !== version) continue
      if (!desktopStarted) {
        desktopStarted = true
        const args = testMode
          ? ['exec', 'vitest', ...forwarded]
          : mermaidThreadMode
            ? ['exec', 'vite', '--config', 'playgrounds/mermaid-thread/vite.config.ts', ...forwarded]
          : bartTransitionMode
            ? ['exec', 'vite', '--config', 'playgrounds/bart-thread-transition/vite.config.ts', ...forwarded]
          : overviewMotionMode
            ? ['exec', 'vite', '--config', 'playgrounds/overview-motion/vite.config.ts', ...forwarded]
          : singleThreadMode
            ? ['exec', 'vite', '--config', 'playgrounds/single-thread/vite.config.ts', ...forwarded]
            : playgroundMode
              ? ['exec', 'vite', '--config', 'playgrounds/thread-detail/vite.config.ts', ...forwarded]
              : ['exec', 'electron-vite', 'dev', '--watch', ...forwarded]
        void runPnpm(args).then((code) => shutdown(code))
      }
    }
  } finally {
    building = false
  }
}
function schedule() {
  if (stopping) return
  requested++
  clearTimeout(debounce)
  debounce = setTimeout(() => { void rebuild().catch(fail) }, 100)
}
function fail(error) {
  console.error(error)
  shutdown(1)
}
function attach(path, options, callback) {
  const watcher = watch(path, options, callback)
  watcher.on('error', fail)
  return watcher
}
function refreshSourceWatchers() {
  const paths = new Map()
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const root = join(packagesRoot, entry.name)
    if (!existsSync(join(root, 'package.json'))) continue
    paths.set(root, false)
    if (existsSync(join(root, 'src'))) paths.set(join(root, 'src'), true)
  }
  for (const [path, watcher] of sourceWatchers) {
    if (!paths.has(path)) { watcher.close(); sourceWatchers.delete(path) }
  }
  for (const [path, recursive] of paths) {
    if (sourceWatchers.has(path)) continue
    sourceWatchers.set(path, attach(path, { recursive }, (_event, filename) => {
      const name = filename?.toString()
      if (recursive || !name || /^(package\.json|tsconfig.*\.json|copy-assets\.mjs)$/.test(name)) schedule()
      if (!recursive && name === 'src') { refreshSourceWatchers(); schedule() }
    }))
  }
}

process.on('SIGINT', () => shutdown(130))
process.on('SIGTERM', () => shutdown(143))
process.on('SIGHUP', () => shutdown(129))
process.on('exit', () => signalChildren('SIGKILL'))
try {
  refreshSourceWatchers()
  watchers.push(attach(packagesRoot, {}, () => { refreshSourceWatchers(); schedule() }))
  watchers.push(attach(desktopRoot, {}, (_event, filename) => {
    if (!filename || filename.toString() === 'package.json') schedule()
  }))
  await rebuild()
} catch (error) {
  fail(error)
}
