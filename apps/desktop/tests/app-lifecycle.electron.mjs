// Real native before-quit dispatch, isolated startup gates and whole-tree exit.
// No Renderer automation, state injection, hidden IPC or application watchdog.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

assert.notEqual(process.platform, 'win32', 'This ps-based native regression requires POSIX')
const runFile = promisify(execFile)
const tests = dirname(fileURLToPath(import.meta.url))
const main = resolve(tests, '../out/main/index.js')
const bootstrap = join(tests, 'fixtures/app-lifecycle-bootstrap.cjs')
const fixture = join(tests, 'fixtures/fake-codex-app-server.mjs')
const require = createRequire(import.meta.url)
const electron = require('electron')
const configuredRoot = process.env.OPENAGENT_LIFECYCLE_EVIDENCE_ROOT
const root = configuredRoot ? resolve(configuredRoot) : await mkdtemp(join(tmpdir(), 'oa-lifecycle-'))
if (configuredRoot) await mkdir(root) // Refuse to reuse a consumed evidence root.
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const modes = ['fresh-1', 'fresh-2', 'fresh-3', 'directories', 'telemetry', 'service-load', 'headless-listen', 'second-term']
const manifest = {
  startedAt: new Date().toISOString(), main, mainSha256: await hash(main),
  bootstrapSha256: await hash(bootstrap), fixtureSha256: await hash(fixture), cases: []
}
await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

async function processTable() {
  const { stdout } = await runFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], {
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/)
    return match ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], stat: match[4], started: match[5], command: match[6] }] : []
  })
}
const identity = row => `${row.pid}:${row.started}`
function rememberTree(table, known, parent) {
  let changed = true
  while (changed) {
    changed = false
    const liveParents = new Set(table.filter(row => known.has(identity(row))).map(row => row.pid))
    const groupHasOwner = table.some(row => known.has(identity(row)) && row.pgid === parent.pgid)
    for (const row of table) {
      if (row.pid === parent.pid && identity(row) === identity(parent) || liveParents.has(row.ppid) || groupHasOwner && row.pgid === parent.pgid) {
        if (!known.has(identity(row))) { known.set(identity(row), row); changed = true }
      }
    }
  }
  return table.filter(row => known.has(identity(row)))
}
async function lifecycle(caseRoot) {
  try {
    return (await readFile(join(caseRoot, 'native-lifecycle.jsonl'), 'utf8'))
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
async function until(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`)
    await pause(50)
  }
}

for (const mode of modes) {
  const caseRoot = join(root, mode)
  await mkdir(caseRoot)
  for (const name of ['home', 'user-data', 'bin']) await mkdir(join(caseRoot, name))
  const shell = join(caseRoot, 'bin/environment-shell')
  await writeFile(shell, '#!/bin/sh\nexec /usr/bin/env -0\n', { mode: 0o700 })
  await writeFile(join(caseRoot, 'bin/codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 })
  for (const provider of ['claude']) {
    await writeFile(join(caseRoot, 'bin', provider), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  }
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:LANG|LC_\w+|TZ|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|__CF_USER_TEXT_ENCODING)$/.test(key)
  ))
  Object.assign(environment, {
    HOME: join(caseRoot, 'home'), SHELL: shell,
    PATH: `${join(caseRoot, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    OPENAGENT_DEV_CWD: caseRoot,
    OPENAGENT_LIFECYCLE_MAIN: main,
    OPENAGENT_LIFECYCLE_CASE_ROOT: caseRoot,
    OPENAGENT_LIFECYCLE_CASE: mode,
    OPENAGENT_HEADLESS: mode === 'headless-listen' ? '1' : '0',
    OPENAGENT_HEADLESS_USER_DATA: join(caseRoot, 'user-data'),
    OPENAGENT_HEADLESS_HOME: join(caseRoot, 'home/.OpenAgent-headless'),
    OPENAGENT_HEADLESS_PORT: '0',
    FAKE_CODEX_LOG: join(caseRoot, 'native-codex.jsonl')
  })
  const child = spawn(electron, [bootstrap], { env: environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = createWriteStream(join(caseRoot, 'stdout.log'), { flags: 'wx' })
  const stderr = createWriteStream(join(caseRoot, 'stderr.log'), { flags: 'wx' })
  child.stdout.pipe(stdout)
  child.stderr.pipe(stderr)
  let exit
  const exited = new Promise(resolveExit => {
    child.once('exit', (code, signal) => { exit = { code, signal }; resolveExit(exit) })
  })
  const known = new Map()
  const result = { mode, pid: child.pid, signals: [], samples: [], pass: false }
  let parent
  try {
    await until(async () => {
      const table = await processTable()
      parent = table.find(row => row.pid === child.pid)
      return !!parent
    }, 5_000, 'Electron process identity')
    assert.ok(parent.command.includes(bootstrap), 'Only signal the exact spawned bootstrap')
    assert.equal(parent.pgid, parent.pid, 'Expected the test-owned detached process group')
    known.set(identity(parent), parent)
    const fresh = mode.startsWith('fresh-')
    await until(async () => {
      assert.equal(exit, undefined, 'Electron exited before reaching the test boundary')
      rememberTree(await processTable(), known, parent)
      return (await lifecycle(caseRoot)).some(entry => entry.event === (fresh ? 'window-ready' : 'gate-entered'))
    }, 20_000, `${mode} boundary`)
    const table = await processTable()
    assert.ok(table.some(row => identity(row) === identity(parent) && row.command.includes(bootstrap)))
    result.preTermTree = rememberTree(table, known, parent)
    const started = Date.now()
    process.kill(parent.pid, 'SIGTERM')
    result.signals.push({ signal: 'SIGTERM', elapsedMs: 0, purpose: 'acceptance' })
    if (!fresh) {
      await until(async () => (await lifecycle(caseRoot)).some(entry => entry.event === 'before-quit'), 2_000, 'first quit dispatch')
      await pause(250)
      assert.equal(exit, undefined, 'Quit escaped a startup operation that was still held')
      if (mode === 'second-term') {
        const current = await processTable()
        assert.ok(current.some(row => identity(row) === identity(parent)))
        process.kill(parent.pid, 'SIGTERM')
        result.signals.push({ signal: 'SIGTERM', elapsedMs: Date.now() - started, purpose: 'explicit second-signal semantics control; not C14' })
      } else {
        await writeFile(join(caseRoot, 'release-startup'), '')
      }
    }
    let nextSample = 0
    await until(async () => {
      const live = rememberTree(await processTable(), known, parent)
      const elapsedMs = Date.now() - started
      if (elapsedMs >= nextSample || live.length === 0) {
        result.samples.push({ elapsedMs, live })
        nextSample = elapsedMs + 1_000
      }
      return live.length === 0
    }, 30_000, 'entire Electron/native process tree exit after signal')
    await exited
    result.elapsedMs = Date.now() - started
    result.exit = exit
    result.lifecycle = await lifecycle(caseRoot)
    if (mode === 'second-term') {
      assert.equal(result.signals.length, 2)
      assert.equal(result.lifecycle.some(entry => entry.event === 'gate-released'), false)
      assert.equal(result.lifecycle.some(entry => entry.event === 'will-quit'), false)
      assert.equal(exit.signal, 'SIGTERM')
    } else {
      assert.equal(result.signals.length, 1)
      assert.equal(exit.code, 0)
      assert.ok(result.lifecycle.some(entry => entry.event === 'will-quit'))
      assert.ok(result.lifecycle.some(entry => entry.event === 'quit' && entry.code === 0))
      if (!fresh) assert.equal(result.lifecycle.some(entry => entry.event === 'window-created'), false)
    }
    // 有窗口的用例必须走到生产的 show 边界，但任何用例都不许把窗口放上屏。
    if (fresh) {
      assert.equal(result.lifecycle.filter(entry => entry.event === 'window-show-requested').length, 1,
        'a fresh start must reach the production show boundary')
    }
    assert.equal(result.lifecycle.some(entry => entry.event === 'window-visible'), false,
      'the native lifecycle regression must stay off screen')
    result.pass = true
    console.log(`PASS ${mode}: ${result.elapsedMs}ms, ${known.size} processes, ${result.signals.length} TERM`)
  } catch (error) {
    result.error = error.stack || String(error)
    console.error(`FAIL ${mode}: ${error.message}`)
    // Failure is recorded before cleanup. Cleanup never converts a failure to PASS.
    await writeFile(join(caseRoot, 'failed-before-cleanup.json'), JSON.stringify(result, null, 2) + '\n')
    const table = await processTable()
    const live = parent ? rememberTree(table, known, parent) : []
    result.cleanup = live.map(row => ({ ...row, signal: 'SIGKILL' }))
    for (const row of live) {
      const current = await processTable()
      if (current.some(candidate => identity(candidate) === identity(row))) {
        try { process.kill(row.pid, 'SIGKILL') } catch (failure) { if (failure.code !== 'ESRCH') throw failure }
      }
    }
    await exited
    process.exitCode = 1
  } finally {
    await writeFile(join(caseRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n')
    manifest.cases.push({ mode, pass: result.pass, result: join(caseRoot, 'result.json'), elapsedMs: result.elapsedMs })
    await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
}
console.log(`Native lifecycle evidence: ${root}`)
