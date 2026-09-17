import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const roots = []
const fixture = fileURLToPath(new URL('./fixtures/harness-health-stages.mjs', import.meta.url))
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'])('does not start Bart after ordinary acceptance receives %s', async signal => {
  const { result, report } = await run('ordinary', signal)
  expect(result.code).toBe(1)
  expect(result.stdout).not.toContain('bart-started')
  expect(report.aborted).toBe(true)
  expect(report.status).toBe('aborted')
  expect(report.stages).toEqual([
    { name: 'ordinary', status: 'failed', exitCode: 1 },
    { name: 'bart', status: 'not-run', error: expect.stringContaining(signal) }
  ])
})

it('continues to Bart after a normal ordinary test failure', async () => {
  const { result, report } = await run('failure')
  expect(result.code).toBe(1)
  expect(result.stdout).toContain('bart-started')
  expect(report.status).toBe('failed')
  expect(report.stages).toEqual([
    { name: 'ordinary', status: 'failed', exitCode: 1 },
    { name: 'bart', status: 'passed', exitCode: 0 }
  ])
})

it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'])('does not swallow %s during the Bart stage', async signal => {
  const { result } = await run('bart', signal)
  expect(result.signal).toBe(signal)
})

async function run(mode, signal) {
  const root = await mkdtemp(join(tmpdir(), 'harness-health-signals-'))
  roots.push(root)
  const pending = promisify(execFile)(process.execPath, [fixture, mode, root], { timeout: 4000, killSignal: 'SIGKILL' })
  let output = ''
  let sent = false
  pending.child.stdout.on('data', chunk => {
    output += chunk
    if (signal && !sent && output.includes(`${mode}-ready`)) {
      sent = true
      pending.child.kill(signal)
    }
  })
  const result = await pending.catch(error => error)
  const [directory] = await readdir(root)
  const report = JSON.parse(await readFile(join(root, directory, 'results.json'), 'utf8'))
  return { result, report }
}
