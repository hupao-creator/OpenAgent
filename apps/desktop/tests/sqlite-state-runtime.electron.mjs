// Native SQLite acceptance against the production bundle and electron-builder app.
// First run `pnpm --dir apps/desktop run pack:local:mac`, then this script.
// OPENAGENT_SQLITE_PACKAGED_EXECUTABLE overrides the default macOS package path.
// Every run owns fresh HOME/userData/evidence; no real user's state is opened.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

assert.notEqual(process.platform, 'win32', 'This native process-group regression requires POSIX')
const runFile = promisify(execFile)
const tests = dirname(fileURLToPath(import.meta.url))
const desktop = dirname(tests)
const main = join(desktop, 'out/main/index.js')
const bootstrap = join(tests, 'fixtures/sqlite-runtime-bootstrap.cjs')
const inspector = join(tests, 'fixtures/sqlite-runtime-inspect.cjs')
const initializationCrash = join(tests, 'fixtures/sqlite-runtime-initialization-crash.cjs')
const electron = createRequire(import.meta.url)('electron')
const packaged = process.env.OPENAGENT_SQLITE_PACKAGED_EXECUTABLE || join(desktop, 'dist/mac-arm64/Agent Workspace.app/Contents/MacOS/Agent Workspace')
const asar = process.env.OPENAGENT_SQLITE_PACKAGED_ASAR || resolve(dirname(packaged), '../Resources/app.asar')
const configuredRoot = process.env.OPENAGENT_SQLITE_EVIDENCE_ROOT
const root = configuredRoot ? resolve(configuredRoot) : await mkdtemp(join(tmpdir(), 'oa-sqlite-native-'))
if (configuredRoot) await mkdir(root) // A consumed root must never be silently reused.
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const manifest = {
  startedAt: new Date().toISOString(), main, mainSha256: await hash(main),
  packaged, packagedExecutableSha256: await hash(packaged), asar, asarSha256: await hash(asar),
  runnerSha256: await hash(fileURLToPath(import.meta.url)), bootstrapSha256: await hash(bootstrap), inspectorSha256: await hash(inspector),
  initializationCrashSha256: await hash(initializationCrash),
  cases: []
}
const saveManifest = () => writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
await saveManifest()
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
async function until(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await pause(40)
  }
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
async function events(path) {
  try { return (await readFile(join(path, 'native.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function environment(caseRoot) {
  for (const name of ['home', 'user-data', 'bin']) await mkdir(join(caseRoot, name))
  const shell = join(caseRoot, 'bin/environment-shell')
  await writeFile(shell, '#!/bin/sh\nexec /usr/bin/env -0\n', { mode: 0o700 })
  await writeFile(join(caseRoot, 'bin/codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(tests, 'fixtures/fake-codex-app-server.mjs'))} "$@"\n`, { mode: 0o700 })
  for (const name of ['claude']) await writeFile(join(caseRoot, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:LANG|LC_\w+|TZ|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|__CF_USER_TEXT_ENCODING)$/.test(key))),
    HOME: join(caseRoot, 'home'), SHELL: shell,
    PATH: `${join(caseRoot, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    OPENAGENT_DEV_CWD: caseRoot, OPENAGENT_HEADLESS: '1', OPENAGENT_HEADLESS_PORT: '0',
    OPENAGENT_HEADLESS_USER_DATA: join(caseRoot, 'user-data'),
    OPENAGENT_HEADLESS_HOME: join(caseRoot, 'home/.OpenAgent-headless'),
    OPENAGENT_SQLITE_MAIN: main, OPENAGENT_SQLITE_CASE_ROOT: caseRoot,
    FAKE_CODEX_LOG: join(caseRoot, 'native-codex.jsonl')
  }
}
async function processTable() {
  const { stdout } = await runFile('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,command='], { maxBuffer: 8 * 1024 * 1024 })
  return stdout.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/)
    return match ? [{ pid: +match[1], ppid: +match[2], started: match[3], command: match[4] }] : []
  })
}
const identity = row => `${row.pid}:${row.started}`
async function start(caseRoot, env, packagedMode, sequence) {
  const child = spawn(packagedMode ? packaged : electron, packagedMode ? [] : [bootstrap], {
    cwd: desktop, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = '', exit, spawnError
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.once('error', error => { spawnError = error })
  child.once('exit', (code, signal) => { exit = { code, signal } })
  const logPath = join(caseRoot, `process-${sequence}.log`)
  const groupAlive = () => {
    try { process.kill(-child.pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }
  const stop = async signal => {
    const known = new Map()
    const remember = table => {
      let changed = true
      while (changed) {
        changed = false
        const parents = new Set(table.filter(row => known.has(identity(row))).map(row => row.pid))
        for (const row of table) {
          if ((known.size === 0 && row.pid === child.pid) || parents.has(row.ppid)) {
            if (!known.has(identity(row))) { known.set(identity(row), row); changed = true }
          }
        }
      }
      return table.filter(row => known.has(identity(row)))
    }
    remember(await processTable())
    if (groupAlive()) process.kill(-child.pid, signal)
    // Native SIGKILL cannot run application cleanup. Reap only the exact
    // test-owned descendant identities observed before killing the parent.
    if (signal === 'SIGKILL') {
      for (const row of remember(await processTable())) {
        try { process.kill(row.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    try {
      await until(async () => exit && !groupAlive() && remember(await processTable()).length === 0, `complete process tree exit (${signal})`)
      if (signal === 'SIGTERM') assert.equal(exit.code, 0, output)
    } finally { await writeFile(logPath, output) }
    return { ...exit, observedProcessCount: known.size }
  }
  try {
    await until(() => {
      if (spawnError) throw spawnError
      assert.equal(exit, undefined, `Native app exited before headless readiness: ${output}`)
      return /OpenAgent headless control listening on http:\/\/127\.0\.0\.1:(\d+)/.test(output)
    }, 'production app startup')
  } catch (error) { await stop('SIGKILL'); throw error }
  const port = Number(output.match(/OpenAgent headless control listening on http:\/\/127\.0\.0\.1:(\d+)/)[1])
  return {
    child, stop,
    async invoke(channel, payload) {
      const response = await fetch(`http://127.0.0.1:${port}/invoke/${encodeURIComponent(channel)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(15_000)
      })
      const body = await response.json()
      if (!response.ok || body.ok !== true) throw new Error(`${channel}: ${JSON.stringify(body)}`)
      return body.result
    }
  }
}
async function databasePath(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isFile() && /\.sqlite(?:3)?$/.test(entry.name)) return path
    if (entry.isDirectory()) { const found = await databasePath(path); if (found) return found }
  }
}
async function inspect(caseRoot) {
  const path = await databasePath(join(caseRoot, 'user-data'))
  assert.ok(path, 'The real app must persist a SQLite database')
  const { stdout } = await runFile(electron, [inspector, path], {
    env: { ELECTRON_RUN_AS_NODE: '1', HOME: join(caseRoot, 'home') }, maxBuffer: 2 * 1024 * 1024
  })
  const result = JSON.parse(stdout.trim())
  assert.equal(result.version.user_version, 6)
  assert.equal(result.pageSize.page_size, caseRoot.endsWith('initial-schema-interrupted') ? 4096 : 8192)
  assert.equal(result.journal.journal_mode, 'wal')
  assert.deepEqual(result.integrity, [{ integrity_check: 'ok' }])
  assert.ok(result.records.some(record => record.key.startsWith('thread:')))
  assert.ok(result.order.some(record => record.kind === 'thread'))
  return { path, ...result }
}
async function interruptInitialSchema(caseRoot, env) {
  let exitCode
  try {
    await runFile(electron, [initializationCrash], { env, timeout: 15_000 })
  } catch (error) {
    exitCode = error.code
    await writeFile(join(caseRoot, 'initialization-process.log'), `${error.stdout || ''}${error.stderr || ''}`)
  }
  assert.equal(exitCode, 93, 'The real Electron process must abruptly exit before first schema COMMIT')
  const boundary = JSON.parse(await readFile(join(caseRoot, 'initialization-boundary.json'), 'utf8'))
  assert.ok(boundary.versions.electron, 'Initialization crash must occur in Electron')
  assert.equal(boundary.inTransactionVersion.user_version, 6)
  assert.deepEqual(boundary.inTransactionSchema, [{ name: 'entity_order' }, { name: 'records' }])
  const path = join(caseRoot, 'user-data/openagent-state-v6/state.sqlite')
  const { stdout } = await runFile(electron, [inspector, path, '--initial-empty'], {
    env: { ELECTRON_RUN_AS_NODE: '1', HOME: join(caseRoot, 'home') }, timeout: 15_000
  })
  const recovered = JSON.parse(stdout.trim())
  assert.equal(recovered.version.user_version, 0)
  assert.deepEqual(recovered.schema, [], 'Uncommitted initial schema must disappear completely')
  assert.equal(recovered.journal.journal_mode, 'wal')
  assert.deepEqual(recovered.integrity, [{ integrity_check: 'ok' }])
  return { exitCode, boundary, recovered }
}
async function writeMarker(app, marker) {
  const state = await app.invoke('state:load')
  await app.invoke('app:update-settings', { ...state.settings, bart: { ...state.settings.bart, routingGuidance: marker } })
}
async function assertMarker(app, marker) {
  assert.equal((await app.invoke('state:load')).settings.bart.routingGuidance, marker)
}

for (const mode of ['initial-schema-interrupted', 'prepare-exit', 'statement', 'before-commit', 'after-commit', 'packaged-ack-kill']) {
  const caseRoot = join(root, mode)
  await mkdir(caseRoot)
  const env = await environment(caseRoot)
  const packagedMode = mode === 'packaged-ack-kill'
  const initialSchemaInterrupted = mode === 'initial-schema-interrupted'
  const result = { mode, pass: false, launches: [] }
  let app
  try {
    if (initialSchemaInterrupted) result.initialization = await interruptInitialSchema(caseRoot, env)
    app = await start(caseRoot, env, packagedMode, 1)
    result.launches.push(app.child.pid)
    await writeMarker(app, `${mode}:baseline`)
    await assertMarker(app, `${mode}:baseline`)
    result.baseline = await inspect(caseRoot)
    if (packagedMode || initialSchemaInterrupted) {
      await writeMarker(app, `${mode}:candidate`)
      await assertMarker(app, `${mode}:candidate`)
    } else {
      await writeFile(join(caseRoot, 'armed-fault'), mode)
      await assert.rejects(writeMarker(app, `${mode}:candidate`), error => {
        result.rejectedCommit = error.message
        assert.match(error.message, mode === 'statement' ? /NOT NULL constraint failed: records\.body/ : /SQLite|worker|Worker|outcome|未知|确定/)
        return true
      })
      await assertMarker(app, `${mode}:baseline`)
      const log = await events(caseRoot)
      assert.ok(log.some(event => event.event === 'fault-injected' && event.fault === mode))
      if (mode === 'statement') {
        result.rollback = await inspect(caseRoot)
        assert.equal(result.rollback.settings.bart.routingGuidance, `${mode}:baseline`)
        await writeMarker(app, `${mode}:candidate`)
      } else if (mode === 'prepare-exit') {
        const injected = log.find(event => event.event === 'fault-injected' && event.fault === mode)
        await until(async () => (await events(caseRoot)).some(event => event.event === 'worker-exit' && event.threadId === injected.threadId && event.code !== 0), 'real preparation Worker termination')
        const workersBeforeRetry = (await events(caseRoot)).filter(event => event.event === 'worker-created').length
        const state = await app.invoke('state:load')
        await assert.rejects(app.invoke('app:update-settings', {
          ...state.settings, locale: state.settings.locale === 'en-US' ? 'zh-CN' : 'en-US'
        }), error => {
          result.rejectedSubsequentWrite = error.message
          assert.match(error.message, /SQLite worker exited.*reopen required/)
          return true
        })
        assert.equal((await events(caseRoot)).filter(event => event.event === 'worker-created').length, workersBeforeRetry, 'Failed owner must not silently replace the preparation Worker')
        await assertMarker(app, `${mode}:baseline`)
        result.afterPreparationFailure = await inspect(caseRoot)
        assert.deepEqual(result.afterPreparationFailure.settings, result.baseline.settings)
      } else {
        await until(async () => (await events(caseRoot)).some(event => event.event === 'worker-exit' && event.code === (mode === 'before-commit' ? 91 : 92)), 'worker died at exact COMMIT boundary')
      }
    }
    if (initialSchemaInterrupted) {
      result.initialShutdown = await app.stop('SIGTERM')
      assert.equal(result.initialShutdown.code, 0)
    } else {
      result.crash = await app.stop('SIGKILL')
      assert.equal(result.crash.signal, 'SIGKILL')
    }
    app = undefined
    const recoveredDatabase = await inspect(caseRoot)
    if (initialSchemaInterrupted) result.afterFirstShutdown = recoveredDatabase
    else result.afterKill = recoveredDatabase
    const recoveredMarker = `${mode}:${mode === 'before-commit' || mode === 'prepare-exit' ? 'baseline' : 'candidate'}`
    assert.equal(recoveredDatabase.settings.bart.routingGuidance, recoveredMarker)
    app = await start(caseRoot, env, packagedMode, 2)
    result.launches.push(app.child.pid)
    await assertMarker(app, recoveredMarker)
    // Reopening must not leave the persistence connection read-only.
    await writeMarker(app, `${mode}:resumed`)
    result.normalExit = await app.stop('SIGTERM')
    app = undefined
    result.finalDatabase = await inspect(caseRoot)
    assert.equal(result.finalDatabase.settings.bart.routingGuidance, `${mode}:resumed`)
    if (!packagedMode) {
      result.events = await events(caseRoot)
      const quit = result.events.findLast(event => event.event === 'will-quit')
      assert.ok(quit, 'Normal shutdown must reach native will-quit')
      assert.equal(quit.activeWorkers, 0, 'SQLite worker must be closed and terminated before native quit')
      assert.ok(result.events.some(event => event.event === 'worker-close-request'))
      if (initialSchemaInterrupted) {
        const normalQuits = result.events.filter(event => event.event === 'will-quit')
        assert.equal(normalQuits.length, 2, 'First recovered startup and reopen must both shut down normally')
        assert.ok(normalQuits.every(event => event.activeWorkers === 0))
      }
    }
    result.pass = true
    console.log(`PASS SQLite native ${mode}`)
  } catch (error) {
    result.error = error.stack || String(error)
    await writeFile(join(caseRoot, 'failed-before-cleanup.json'), JSON.stringify(result, null, 2) + '\n')
    if (app) { result.cleanup = await app.stop('SIGKILL').catch(cleanup => String(cleanup)) }
    console.error(`FAIL SQLite native ${mode}: ${error.message}`)
    process.exitCode = 1
  }
  await writeFile(join(caseRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  manifest.cases.push({ mode, pass: result.pass, result: join(caseRoot, 'result.json') })
  await saveManifest()
}
console.log(`SQLite native evidence: ${root}`)
