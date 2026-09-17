import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runGit } from '../src/main/process-runner'

const processTreeLeaderFixture = fileURLToPath(
  new URL('./fixtures/process-tree-leader.mjs', import.meta.url)
)

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${pid} termination timed out`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('process tree termination', () => {
  it.skipIf(process.platform === 'win32').each(['timeout', 'abort'] as const)(
    'cleans a live descendant when the Git leader exits before %s',
    async cancellation => {
      const root = await mkdtemp(join(tmpdir(), 'openagent-git-leader-exit-'))
      const marker = join(root, 'ready.json')
      const controller = new AbortController()
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
      const command = [process.execPath, processTreeLeaderFixture, '--exit-before-cancel', marker]
        .map(quote).join(' ')
      const operation = runGit(root, ['-c', `alias.fixture=!${command}`, 'fixture'], {
        signal: controller.signal,
        timeoutMs: 1_500,
        terminationGraceMs: 100
      }).then(() => null, error => error)
      let descendantPid: number | undefined
      try {
        let record: { leaderPid: number; descendantPid: number } | undefined
        const deadline = Date.now() + 5_000
        while (!record) {
          try {
            record = JSON.parse(await readFile(marker, 'utf8'))
          } catch (error) {
            if (Date.now() >= deadline) throw error
            await new Promise(resolve => setTimeout(resolve, 25))
          }
        }
        descendantPid = record.descendantPid
        await waitForProcessExit(record.leaderPid, 1_000)
        expect(isProcessAlive(descendantPid)).toBe(true)
        if (cancellation === 'abort') controller.abort(new Error('fixture git abort'))
        const result = await operation
        expect(result).toBeInstanceOf(Error)
        expect(result.message).toContain(cancellation === 'abort' ? 'fixture git abort' : '超时')
        await waitForProcessExit(descendantPid, 2_000)
      } finally {
        controller.abort()
        await operation
        if (descendantPid !== undefined && isProcessAlive(descendantPid)) {
          try { process.kill(descendantPid, 'SIGKILL') } catch { /* Already exited. */ }
          await waitForProcessExit(descendantPid, 2_000)
        }
        await rm(root, { recursive: true, force: true })
      }
    },
    10_000
  )
})
