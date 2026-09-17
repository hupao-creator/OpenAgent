#!/usr/bin/env node
/** Build orchestration only. Always run dependency-ordered incremental builds;
 * existing dist files alone never establish source freshness. Use only the CLI:
 * TypeScript 7 does not expose the legacy JavaScript compiler API.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCachedBuild } from './cached-build.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesRoot = join(repoRoot, 'packages')
const cachePath = join(repoRoot, 'node_modules/.cache/openagent-package-outputs.json')
const lockPath = join(repoRoot, 'node_modules/.cache/openagent-package-build.lock')

/**
 * Concurrent invocations are normal now (every harness package's `test` runs
 * this script, and `pnpm -r test` runs those in parallel). Serialize the whole
 * pass: two instances would race on the shared output snapshot and on the same
 * package's tsc build info. A fresh-outputs pass is cheap, so waiting is fine.
 */
function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    return error.code !== 'ESRCH'
  }
}

function acquireBuildLock() {
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + 15 * 60_000
  while (true) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
      return
    } catch {
      // Held by another invocation. Recover an abandoned lock immediately by
      // checking the owner process instead of waiting out a wall-clock age.
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
        if (!processAlive(owner.pid)) rmSync(lockPath, { recursive: true, force: true })
      } catch {
        // Unparseable or vanished holder: steal a stale orphan, keep waiting
        // on one that was written just now by a live process.
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 60_000) {
            rmSync(lockPath, { recursive: true, force: true })
          }
        } catch { /* vanished; retry immediately */ }
      }
    }
    if (Date.now() > deadline) {
      throw new Error('build-packages: 等待构建锁超时（可能存在并发构建）')
    }
    const spinStart = Date.now()
    while (Date.now() - spinStart < 250) { /* brief blocking wait */ }
  }
}

if (process.env.OPENAGENT_SKIP_PACKAGE_BUILD === '1') {
  // Callers that have just run a full build pass (the root test chain) reuse
  // it; package-level `test` scripts still build when run standalone.
  process.exit(0)
}

// Active Vite watchers need stable files and CSS HMR. Only disposable/production
// builds may replace complete output directories from an artifact cache.
if (process.env.OPENAGENT_LIVE_BUILD !== '1') {
  runCachedBuild('packages')
  process.exit(0)
}

acquireBuildLock()
try {
  await main()
} finally {
  rmSync(lockPath, { recursive: true, force: true })
}

async function main() {

function runPnpm(args) {
  const pnpmPath = process.env.npm_execpath
  const useNode = pnpmPath && /pnpm(?:\.c?js)?$/i.test(pnpmPath)
  const result = spawnSync(useNode ? process.execPath : 'pnpm', useNode ? [pnpmPath, ...args] : args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: !useNode && process.platform === 'win32'
  })
  if (result.error || result.status !== 0) {
    throw new Error(`build-packages: 构建失败（${result.error?.message ?? result.signal ?? `exit ${result.status}`}）`)
  }
}

// Record actual outputs rather than guessing .js/.d.ts names from source or
// parsing compiler state. Missing/modified internal modules and assets count,
// not just package.json exports. All workspace packages emit under dist/.
function outputs(root) {
  const result = []
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      const name = prefix + entry.name
      if (entry.isDirectory()) visit(path, `${name}/`)
      else if (entry.isFile()) result.push([name, createHash('sha256').update(readFileSync(path)).digest('hex')])
    }
  }
  const dist = join(root, 'dist')
  if (existsSync(dist)) visit(dist)
  return result
}

let previous = {}
try { previous = JSON.parse(readFileSync(cachePath, 'utf8')) } catch { /* No trusted output snapshot: rebuild. */ }
if (!previous || typeof previous !== 'object' || Array.isArray(previous)) previous = {}
const packages = []
for (const directory of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  const root = join(packagesRoot, directory.name)
  const packagePath = join(root, 'package.json')
  if (!existsSync(packagePath)) continue
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (!metadata.name?.startsWith('@openagent/')) continue
  packages.push({ name: metadata.name, root })
}
if (packages.length === 0) throw new Error('build-packages: 未发现 @openagent/* workspace 包')
const invalid = packages.filter(({ name, root }) =>
  existsSync(join(root, 'tsconfig.build.json')) &&
  JSON.stringify(previous[name]) !== JSON.stringify(outputs(root))
)
if (invalid.length) {
  // tsc owns config parsing, inheritance and cache locations (including JSONC).
  // Its public clean command invalidates incremental state before re-emitting.
  runPnpm([...invalid.flatMap(({ name }) => ['--filter', name]), '-r', 'exec',
    'tsc', '--build', 'tsconfig.build.json', '--clean'])
}
runPnpm(['--filter', '@openagent/*', '-r', 'run', 'build'])
const current = Object.fromEntries(packages.map(({ name, root }) => [name, outputs(root)]))
mkdirSync(dirname(cachePath), { recursive: true })
writeFileSync(cachePath, JSON.stringify(current))
}
