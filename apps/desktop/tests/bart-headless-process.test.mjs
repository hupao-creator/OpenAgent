import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { startHeadless } from './bart-headless/headless.mjs'

const roots = []
const processGroups = new Set()
const fixture = fileURLToPath(
  new URL('./fixtures/headless-process-tree.mjs', import.meta.url)
)

afterEach(async () => {
  if (process.platform !== 'win32') {
    for (const leaderPid of processGroups) {
      try {
        process.kill(-leaderPid, 'SIGKILL')
      } catch {
        // The implementation already removed the process group.
      }
    }
  }
  processGroups.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('Bart headless acceptance process lifecycle', () => {
  it('cancels startup and drains its detached process group', async () => {
    const input = await fixtureInput('never-ready')
    const controller = new AbortController()
    const opening = startHeadless({ ...input, signal: controller.signal })
    const rejected = expect(opening).rejects.toThrow('cancel startup')
    await expect.poll(async () => readPids(input.pidFile).catch(() => null)).not.toBeNull()
    const pids = await readPids(input.pidFile)
    processGroups.add(pids.leaderPid)
    controller.abort(new Error('cancel startup'))
    await rejected
    await expectProcessGone(pids.leaderPid)
    await expectProcessGone(pids.grandchildPid)
    processGroups.delete(pids.leaderPid)
  })

  it('kills a TERM-ignoring descendant after the leader exits during close', async () => {
    const input = await fixtureInput('ready')
    const headless = await startHeadless(input)
    const pids = await readPids(input.pidFile)
    processGroups.add(pids.leaderPid)
    expect(processIsAlive(pids.grandchildPid)).toBe(true)

    await headless.close()

    await expectProcessGone(pids.leaderPid)
    await expectProcessGone(pids.grandchildPid)
    processGroups.delete(pids.leaderPid)
  })

  it('cleans the detached group when the leader exits before startup completes', async () => {
    const input = await fixtureInput('exit-before-ready')

    await expect(startHeadless(input)).rejects.toThrow('exited during startup')

    const pids = await readPids(input.pidFile)
    processGroups.add(pids.leaderPid)
    await expectProcessGone(pids.leaderPid)
    await expectProcessGone(pids.grandchildPid)
    processGroups.delete(pids.leaderPid)
  })
})

async function fixtureInput(mode) {
  const root = await mkdtemp(join(tmpdir(), 'openagent-headless-process-'))
  roots.push(root)
  const pidFile = join(root, 'pids.json')
  return {
    electronBinary: process.execPath,
    electronMain: fixture,
    desktopRoot: dirname(fixture),
    repositoryRoot: root,
    userData: join(root, 'user-data'),
    openAgentHome: join(root, 'openagent-home'),
    processLog: join(root, 'headless.log'),
    pidFile,
    environment: {
      ...process.env,
      OPENAGENT_TEST_HEADLESS_MODE: mode,
      OPENAGENT_TEST_HEADLESS_PID_FILE: pidFile
    },
    startupTimeoutMs: 2_000,
    shutdownGraceMs: 75,
    shutdownKillTimeoutMs: 2_000
  }
}

async function readPids(path) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  expect(value).toEqual({
    leaderPid: expect.any(Number),
    grandchildPid: expect.any(Number)
  })
  return value
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function expectProcessGone(pid) {
  await expect.poll(() => processIsAlive(pid), { timeout: 2_000 }).toBe(false)
}
