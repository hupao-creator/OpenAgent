import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { workspaceSuite } from './bart-headless/suites/workspace.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Bart headless workspace proof isolation', () => {
  it.each([false, true])('checks the worker-owned root, including lookalike paths (%s)', async outside => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-headless-workspace-'))
    roots.push(root)
    const openAgentHome = join(root, 'worker-home')
    const temporaryRoot = join(openAgentHome, 'tmp-workspaces')
    const cwd = join(outside ? `${temporaryRoot}-unowned` : temporaryRoot, 'thread')
    await mkdir(temporaryRoot, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'acceptance-proof.txt'), 'isolated-proof')
    const context = {
      token: 'isolated-proof',
      harness: 'codex',
      provider: { permissionTool: 'shell' },
      repositoryRoot: join(root, 'repository'),
      openAgentHome,
      permissiveOptions: () => ({}),
      start: async () => ({ threadId: 'thread' }),
      waitForCompleted: async () => ({ summary: 'WORKSPACE_OK:isolated-proof' }),
      client: { loadState: async () => ({ threads: [{ id: 'thread', cwd }] }) }
    }
    const run = workspaceSuite.cases.find(testCase => testCase.id === 'temporary-workspace').run(context)
    if (outside) await expect(run).rejects.toThrow('owned temporary workspace')
    else await expect(run).resolves.toEqual({ threadId: 'thread', cwd })
  })
})
