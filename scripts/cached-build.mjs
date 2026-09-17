import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, statSync, copyFileSync, readlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function command(program, args) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr)
  return result.stdout.trim()
}

export function runCachedBuild(mode) {
  if (!['packages', 'desktop'].includes(mode)) throw new Error(`Unknown build mode: ${mode}`)
  const common = realpathSync(command('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const cache = join(common, 'openagent-build-cache')
  const lock = join(root, 'node_modules/.cache/openagent-package-build.lock')
  mkdirSync(dirname(lock), { recursive: true })
  const deadline = Date.now() + 15 * 60_000
  while (true) {
    try { writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); break } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let stale = false
      try {
        const { pid } = JSON.parse(readFileSync(lock, 'utf8'))
        if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid build lock owner')
        try { process.kill(pid, 0) } catch (error) { stale = error.code === 'ESRCH' }
      } catch { try { stale = Date.now() - statSync(lock).mtimeMs > 60_000 } catch { continue } }
      if (stale) { rmSync(lock, { force: true }); continue }
      if (Date.now() > deadline) throw new Error('Timed out waiting for the workspace build lock')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
  }
  try {
    const cli = process.env.npm_execpath
    const pnpm = cli && /pnpm(?:\.c?js)?$/i.test(cli) ? [process.execPath, [cli]] : ['pnpm', []]
    const version = command(pnpm[0], [...pnpm[1], '--version'])
    const runs = join(root, '.turbo/runs')
    const before = new Set(existsSync(runs) ? readdirSync(runs) : [])
    const targets = mode === 'packages' ? ['build', '--filter=@openagent/*']
      : ['build:main', 'build:preload', 'build:renderer', '--filter=openagent-desktop']
    const env = { ...process.env, TURBO_TELEMETRY_DISABLED: '1',
      OPENAGENT_BUILD_TOOLCHAIN: `${process.version}/${process.platform}/${process.arch}/pnpm@${version}` }
    // electron-vite transpiles its config to a name derived from `Date.now()` and
    // unlinks it once imported, so two target builds starting in the same
    // millisecond make the later import fail. The three desktop targets are small,
    // so serialising them is cheap and is what makes this build deterministic.
    const args = [...pnpm[1], 'exec', 'turbo', 'run', ...targets,
      process.env.OPENAGENT_FORCE_BUILD === '1' ? '--cache=local:w' : '--cache=local:rw',
      `--cache-dir=${cache}`, '--env-mode=strict', '--summarize',
      `--concurrency=${mode === 'packages' ? 4 : 1}`]
    const planned = spawnSync(pnpm[0], [...args, '--dry=json'], { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    if (planned.error || planned.status !== 0) throw new Error(`Build planning failed: ${planned.error?.message || planned.stderr}`)
    const plan = JSON.parse(planned.stdout)
    const hashes = plan.tasks.map(task => [task.taskId, task.hash]).sort()
    const snapshot = join(root, `node_modules/.cache/openagent-build-${mode}.json`)
    function outputs() {
      const files = []
      function visit(path) {
        if (!existsSync(join(root, path))) return
        for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const child = `${path}/${entry.name}`
          if (entry.isDirectory()) visit(child)
          else files.push([child, entry.isSymbolicLink() ? `link:${readlinkSync(join(root, child))}`
            : createHash('sha256').update(readFileSync(join(root, child))).digest('hex')])
        }
      }
      for (const entry of readdirSync(join(root, 'packages')).sort()) {
        visit(`packages/${entry}/dist`)
        const state = `packages/${entry}/node_modules/.cache/tsconfig.build.tsbuildinfo`
        if (existsSync(join(root, state))) files.push([state, createHash('sha256').update(readFileSync(join(root, state))).digest('hex')])
      }
      if (mode === 'desktop') for (const target of ['main', 'preload', 'renderer']) visit(`apps/desktop/out/${target}`)
      return files
    }
    let previous
    try { previous = JSON.parse(readFileSync(snapshot, 'utf8')) } catch { /* First build or invalid snapshot. */ }
    const currentOutputs = outputs()
    if (process.env.OPENAGENT_FORCE_BUILD !== '1' && currentOutputs.length &&
        JSON.stringify(previous) === JSON.stringify({ hashes, outputs: currentOutputs })) {
      // Repeated callers may already be testing these modules. Do not let Turbo
      // restore (or truncate) files while those readers are importing them.
      console.log(`Build ${mode}: inputs and outputs unchanged; keeping existing artifacts`)
      if (process.env.OPENAGENT_BUILD_EVIDENCE_DIR) {
        mkdirSync(process.env.OPENAGENT_BUILD_EVIDENCE_DIR, { recursive: true })
        writeFileSync(join(process.env.OPENAGENT_BUILD_EVIDENCE_DIR, `unchanged-${mode}-${process.pid}-${Date.now()}.json`),
          JSON.stringify({ tasks: plan.tasks.map(task => ({ taskId: task.taskId, hash: task.hash, cache: { status: 'UNCHANGED' } })) }))
      }
      return
    }
    // Always restore into clean output directories, including on cache hits.
    // Dist and compiler state form one cache artifact; never keep only one half.
    for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !existsSync(join(root, 'packages', entry.name, 'package.json'))) continue
      rmSync(join(root, 'packages', entry.name, 'dist'), { recursive: true, force: true })
      rmSync(join(root, 'packages', entry.name, 'node_modules/.cache/tsconfig.build.tsbuildinfo'), { force: true })
    }
    if (mode === 'desktop') {
      for (const target of ['main', 'preload', 'renderer']) rmSync(join(root, 'apps/desktop/out', target), { recursive: true, force: true })
    }
    const result = spawnSync(pnpm[0], args, { cwd: root, stdio: 'inherit', env })
    if (process.env.OPENAGENT_BUILD_EVIDENCE_DIR && existsSync(runs)) {
      mkdirSync(process.env.OPENAGENT_BUILD_EVIDENCE_DIR, { recursive: true })
      for (const name of readdirSync(runs).filter(name => !before.has(name) && name.endsWith('.json'))) {
        copyFileSync(join(runs, name), join(process.env.OPENAGENT_BUILD_EVIDENCE_DIR, name))
      }
    }
    if (result.error || result.status !== 0) throw new Error(`Cached build failed: ${result.error?.message || result.signal || result.status}`)
    writeFileSync(snapshot, JSON.stringify({ hashes, outputs: outputs() }))
  } finally { rmSync(lock, { force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCachedBuild(process.argv[2])
