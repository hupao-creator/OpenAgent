import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodexMainPlugin } from '../../../packages/harness-codex/src/main'
import { CodexAppServer } from '../../../packages/harness-codex/src/main/runtime/app-server'
import {
  decodeCodexState
} from '../../../packages/harness-codex/src/shared/state'
import type { CodexThreadSettings } from '../../../packages/harness-codex/src/shared/types'
import { inspectManagedWorktree, WorktreeManager } from '../src/main/services/worktree-manager'
import type { AgentThreadRecord } from '@openagent/contracts'
import { createAgentOpenContext } from '@openagent/test-kit'

const exec = promisify(execFile)
const fixture = resolve('tests/fixtures/fake-codex-app-server.mjs')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('Codex managed-worktree Git permissions', () => {
  it('grants only the linked gitdir, object store, and packed-refs lock', async () => {
    await chmod(fixture, 0o755)
    const root = await temporaryDirectory('codex-managed-worktree-')
    const repository = join(root, 'repository')
    const dataRoot = join(root, 'data')
    const logPath = join(root, 'app-server.jsonl')
    const arbitrarySettingsRoot = join(root, 'settings-root-not-in-grant')
    const arbitraryConfigRoot = join(root, 'config-root-not-in-grant')
    await exec('git', ['init', repository])
    await exec('git', ['config', 'user.name', 'OpenAgent Test'], { cwd: repository })
    await exec('git', ['config', 'user.email', 'openagent@example.invalid'], { cwd: repository })
    await writeFile(join(repository, 'README.md'), 'managed worktree\n')
    await exec('git', ['add', 'README.md'], { cwd: repository })
    await exec('git', ['commit', '-m', 'initial'], { cwd: repository })

    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'codex-managed-worktree-thread',
      requested: { enabled: true, name: 'git-permissions' }
    })
    const snapshot = await inspectManagedWorktree(preparation.worktree)
    const managedRoots = [
      snapshot.gitDirectory,
      join(snapshot.commonDirectory, 'objects'),
      join(snapshot.commonDirectory, 'packed-refs.lock')
    ]
    const authorizationSignals: AbortSignal[] = []
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_SPLIT_MESSAGES: '1',
        FAKE_CODEX_CONFIG_WRITABLE_ROOT: arbitraryConfigRoot
      }),
      dataRoot,
      temporaryWorkspaceRoot: dataRoot
    })
    const settings: CodexThreadSettings = {
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [arbitrarySettingsRoot],
        networkAccess: true,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true
      }
    }
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'codex-managed-worktree-thread',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Managed Codex worktree',
      tags: [],
      cwd: repository,
      worktree: preparation.worktree,
      settings,
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: (next) => { record = next }
      }),
      managedWorkspaceWrite: {
        grant: async signal => {
          authorizationSignals.push(signal)
          return manager.authorizeManagedWorkspaceWrite({
            ownerThreadId: record.id,
            worktree: record.worktree!,
            signal
          })
        }
      }
    })

    await manager.admitManagedWorktreeExecution({
      ownerThreadId: record.id,
      worktree: record.worktree!
    })
    await handle.send({
      executionId: 'managed-worktree-execution',
      input: { parts: [{ kind: 'text', text: 'Commit the requested change.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => decodeCodexState(record.sessionState).turns[0]?.status === 'completed')

    // A completed Codex turn may legitimately advance detached HEAD. The next
    // turn must request a fresh grant, not retain the creation baseline.
    await writeFile(join(preparation.worktree.cwd!, 'SECOND.md'), 'second turn\n')
    await exec('git', ['add', 'SECOND.md'], { cwd: preparation.worktree.cwd })
    await exec('git', [
      '-c', 'user.name=OpenAgent Test',
      '-c', 'user.email=openagent@example.invalid',
      'commit', '-m', 'advance detached head'
    ], { cwd: preparation.worktree.cwd })
    await manager.admitManagedWorktreeExecution({
      ownerThreadId: record.id,
      worktree: record.worktree!
    })
    await handle.send({
      executionId: 'managed-worktree-execution-2',
      input: { parts: [{ kind: 'text', text: 'Continue from the new detached HEAD.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => decodeCodexState(record.sessionState).turns[1]?.status === 'completed')

    const messages = await readLog(logPath)
    const threadStart = messages.find((message) => message.method === 'thread/start')
    const turnStart = messages.find((message) => message.method === 'turn/start')
    expect(threadStart).toMatchObject({
      params: {
        cwd: preparation.worktree.cwd,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        config: {
          sandbox_workspace_write: {
            writable_roots: managedRoots
          }
        },
        developerInstructions: expect.stringContaining(
          'Standard git add and git commit are available'
        )
      }
    })
    expect(turnStart).toMatchObject({
      params: {
        cwd: preparation.worktree.cwd,
        sandboxPolicy: {
          type: 'workspaceWrite',
          // The base checkout was present in Plugin settings above, but a
          // managed Thread may only receive Core-verified extra roots.
          writableRoots: managedRoots,
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true
        }
      }
    })
    expect(messages.filter(message => message.method === 'turn/start')).toHaveLength(2)
    expect(JSON.stringify([threadStart, turnStart])).not.toContain(arbitrarySettingsRoot)
    expect(JSON.stringify([threadStart, turnStart])).not.toContain(arbitraryConfigRoot)
    expect(authorizationSignals).toHaveLength(2)
    expect(authorizationSignals[0]).not.toBe(authorizationSignals[1])

    await handle.dispose()
  }, 15_000)

  it.each([
    ['managed', true],
    ['non-managed', false]
  ] as const)(
    '%s application config keeps only the roots authorized for that workspace',
    async (_label, managed) => {
      await chmod(fixture, 0o755)
      const root = await temporaryDirectory(`codex-config-roots-${managed ? 'managed' : 'plain'}-`)
      const logPath = join(root, 'app-server.jsonl')
      const cwd = join(root, 'workspace')
      const configRoot = join(root, 'config-extra')
      const settingsRoot = join(root, 'settings-extra')
      const verifiedRoots = [
        join(root, 'verified-gitdir'),
        join(root, 'verified-objects'),
        join(root, 'verified-packed-refs.lock')
      ]
      await mkdir(cwd, { recursive: true })
      const server = new CodexAppServer(fixture, {
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_CONFIG_WRITABLE_ROOT: configRoot,
        FAKE_CODEX_STATUS_STUCK: '1'
      })

      try {
        await server.startTurn({
          executionId: `execution-config-roots-${managed ? 'managed' : 'plain'}`,
          cwd,
          ...(managed
            ? {
                workspaceWriteGrant: {
                  kind: 'managed-linked-worktree' as const,
                  cwd,
                  headOid: 'a'.repeat(40),
                  writableRoots: verifiedRoots
                }
              }
            : {}),
          inputs: [{ type: 'text', text: 'Inspect sandbox roots.', text_elements: [] }],
          settings: {
            approvalPolicy: 'never',
            sandboxPolicy: {
              type: 'workspaceWrite',
              writableRoots: [settingsRoot],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false
            }
          },
          toolMode: 'exclusive',
          signal: new AbortController().signal,

          emit: () => undefined
        })

        const messages = await readLog(logPath)
        const threadStart = messages.find((message) => message.method === 'thread/start')
        const turnStart = messages.find((message) => message.method === 'turn/start')
        expect(threadStart).toMatchObject({
          params: {
            config: {
              sandbox_workspace_write: {
                writable_roots: managed ? verifiedRoots : [configRoot]
              }
            }
          }
        })
        expect(turnStart).toMatchObject({
          params: {
            sandboxPolicy: {
              type: 'workspaceWrite',
              writableRoots: managed ? verifiedRoots : [settingsRoot]
            }
          }
        })
        if (managed) {
          expect(JSON.stringify([threadStart, turnStart])).not.toContain(configRoot)
          expect(JSON.stringify([threadStart, turnStart])).not.toContain(settingsRoot)
        }
      } finally {
        await server.dispose()
      }
    }
  )

  it.each([
    ['read-only non-native', false, { sandbox: 'read-only' as const }],
    ['native workspace-write', true, {}]
  ])('does not request a Core grant for %s worktrees', async (_label, native, settings) => {
    await chmod(fixture, 0o755)
    const root = await temporaryDirectory('codex-no-managed-grant-')
    const dataRoot = join(root, 'data')
    const executionCwd = join(root, 'execution')
    const logPath = join(root, 'app-server.jsonl')
    await mkdir(executionCwd, { recursive: true })
    let authorizations = 0
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_SPLIT_MESSAGES: '1'
      }),
      dataRoot,
      temporaryWorkspaceRoot: dataRoot
    })
    const effectiveSettings: CodexThreadSettings = native
      ? {
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: ['/tmp/native-extra'],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false
          }
        }
      : settings
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: `codex-no-managed-grant-${native ? 'native' : 'readonly'}`,
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex no managed grant',
      tags: [],
      cwd: root,
      worktree: { baseCwd: root, native, cwd: executionCwd },
      settings: effectiveSettings,
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: (next) => { record = next }
      }),
      managedWorkspaceWrite: {
        grant: async () => {
          authorizations += 1
          throw new Error('unexpected managed workspace authorization')
        }
      }
    })

    await handle.send({
      executionId: 'no-managed-grant-execution',
      input: { parts: [{ kind: 'text', text: 'Answer without managed Git access.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => decodeCodexState(record.sessionState).turns[0]?.status === 'completed')

    expect(authorizations).toBe(0)
    const messages = await readLog(logPath)
    expect(messages.some(message => message.method === 'turn/start')).toBe(true)
    if (native) {
      expect(messages.find(message => message.method === 'turn/start')).toMatchObject({
        params: {
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: ['/tmp/native-extra']
          }
        }
      })
    }
    const threadStart = messages.find(message => message.method === 'thread/start')
    expect(threadStart).not.toMatchObject({
      params: {
        config: { sandbox_workspace_write: expect.anything() },
        developerInstructions: expect.stringContaining('managed detached linked worktree')
      }
    })
    await handle.dispose()
  })

  it('settles failed without starting native Codex when Core rejects the grant', async () => {
    await chmod(fixture, 0o755)
    const root = await temporaryDirectory('codex-rejected-managed-grant-')
    const dataRoot = join(root, 'data')
    const executionCwd = join(root, 'execution')
    const logPath = join(root, 'app-server.jsonl')
    await mkdir(executionCwd, { recursive: true })
    let authorizations = 0
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, FAKE_CODEX_LOG: logPath }),
      dataRoot,
      temporaryWorkspaceRoot: dataRoot
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'codex-rejected-managed-grant',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex rejected managed grant',
      tags: [],
      cwd: root,
      worktree: { baseCwd: root, native: false, cwd: executionCwd },
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: (next) => { record = next }
      }),
      managedWorkspaceWrite: {
        grant: async () => {
          authorizations += 1
          throw new Error('Core rejected stale managed worktree')
        }
      }
    })

    await handle.send({
      executionId: 'rejected-managed-grant-execution',
      input: { parts: [{ kind: 'text', text: 'This must never reach Codex.' }] },
      signal: new AbortController().signal
    })

    expect(authorizations).toBe(1)
    expect(decodeCodexState(record.sessionState).turns[0]).toMatchObject({
      status: 'failed',
      error: 'Core rejected stale managed worktree'
    })
    expect(await readLog(logPath)).toEqual([])
    await handle.dispose()
  })

  it('fails closed without starting native Codex when the bound capability is missing', async () => {
    await chmod(fixture, 0o755)
    const root = await temporaryDirectory('codex-missing-managed-grant-')
    const dataRoot = join(root, 'data')
    const executionCwd = join(root, 'execution')
    const logPath = join(root, 'app-server.jsonl')
    await mkdir(executionCwd, { recursive: true })
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({ ...process.env, FAKE_CODEX_LOG: logPath }),
      dataRoot,
      temporaryWorkspaceRoot: dataRoot
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'codex-missing-managed-grant',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex missing managed grant',
      tags: [],
      cwd: root,
      worktree: { baseCwd: root, native: false, cwd: executionCwd },
      settings: {},
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread(createAgentOpenContext({
      sessionState: plugin.sessionState,
      getRecord: () => record,
      setRecord: (next) => { record = next }
    }))

    await handle.send({
      executionId: 'missing-managed-grant-execution',
      input: { parts: [{ kind: 'text', text: 'This must never reach Codex.' }] },
      signal: new AbortController().signal
    })

    expect(decodeCodexState(record.sessionState).turns[0]).toMatchObject({
      status: 'failed',
      error: 'Codex managed workspace-write 缺少 Core capability'
    })
    expect(await readLog(logPath)).toEqual([])
    await handle.dispose()
  })

  it('Thread Read reuses the managed-workspace grant and normalizes cwd to the source turn', async () => {
    await chmod(fixture, 0o755)
    const root = await temporaryDirectory('codex-read-managed-worktree-')
    const repository = join(root, 'repository')
    const dataRoot = join(root, 'data')
    const logPath = join(root, 'app-server.jsonl')
    await exec('git', ['init', repository])
    await exec('git', ['config', 'user.name', 'OpenAgent Test'], { cwd: repository })
    await exec('git', ['config', 'user.email', 'openagent@example.invalid'], { cwd: repository })
    await writeFile(join(repository, 'README.md'), 'managed worktree\n')
    await exec('git', ['add', 'README.md'], { cwd: repository })
    await exec('git', ['commit', '-m', 'initial'], { cwd: repository })

    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'codex-read-managed-thread',
      requested: { enabled: true, name: 'read-grant' }
    })
    const snapshot = await inspectManagedWorktree(preparation.worktree)
    const managedRoots = [
      snapshot.gitDirectory,
      join(snapshot.commonDirectory, 'objects'),
      join(snapshot.commonDirectory, 'packed-refs.lock')
    ]
    const grantSignals: AbortSignal[] = []
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_SPLIT_MESSAGES: '1'
      }),
      dataRoot,
      temporaryWorkspaceRoot: dataRoot
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'codex-read-managed-thread',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex read managed worktree',
      tags: [],
      cwd: repository,
      worktree: preparation.worktree,
      settings: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: (next) => { record = next }
      }),
      managedWorkspaceWrite: {
        grant: async signal => {
          grantSignals.push(signal)
          return manager.authorizeManagedWorkspaceWrite({
            ownerThreadId: record.id,
            worktree: record.worktree!,
            signal
          })
        }
      }
    })

    await manager.admitManagedWorktreeExecution({
      ownerThreadId: record.id,
      worktree: record.worktree!
    })
    await handle.send({
      executionId: 'read-managed-source',
      input: { parts: [{ kind: 'text', text: 'Commit the requested change.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => decodeCodexState(record.sessionState).turns[0]?.status === 'completed')

    await expect(handle.read('Summarize the Thread.', new AbortController().signal))
      .resolves.toBe('First update.\n\nSecond update.')

    const messages = await readLog(logPath)
    const paramsOf = (message: Record<string, unknown>): Record<string, unknown> =>
      message.params as Record<string, unknown>
    const inputText = (params: Record<string, unknown>): string =>
      String((params.input as { text: string }[])[0]!.text)
    const sourceStart = paramsOf(messages.find((message) => message.method === 'thread/start')!)
    const sourceTurn = paramsOf(messages.filter((message) => message.method === 'turn/start')[0]!)
    const readFork = paramsOf(messages.find((message) => message.method === 'thread/fork')!)
    const readTurn = paramsOf(messages.filter((message) => message.method === 'turn/start').at(-1)!)

    expect(readFork).toMatchObject({
      cwd: preparation.worktree.cwd,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      ephemeral: true,
      config: { sandbox_workspace_write: { writable_roots: managedRoots } },
      developerInstructions: expect.stringContaining('Standard git add and git commit are available')
    })
    // The fork base and turn settings are identical to the source request,
    // including the Core-granted writable roots and the worktree instructions.
    expect(readFork.config).toEqual(sourceStart.config)
    expect(readFork.developerInstructions).toBe(sourceStart.developerInstructions)
    expect(readTurn.sandboxPolicy).toEqual(sourceTurn.sandboxPolicy)
    expect(readTurn.cwd).toEqual(sourceTurn.cwd)
    // The fork reuses the source's request construction (and therefore its write
    // permission), so the behavioral constraint has to be in the prompt:
    // `ephemeral` only stops the fork being persisted, it does not stop tool calls.
    expect(inputText(readTurn)).toContain('Do not modify files, run commands')
    expect(inputText(readTurn)).toContain('Summarize the Thread.')
    expect(inputText(sourceTurn)).toBe('Commit the requested change.')
    // One grant for the source send, one for the read: the read reuses the same
    // Thread-bound Core capability rather than a bespoke root set.
    expect(grantSignals).toHaveLength(2)

    await handle.dispose()
  }, 15_000)

  it('degrades to the isolated snapshot when a read cannot acquire the managed-workspace grant', async () => {
    await chmod(fixture, 0o755)
    const root = await temporaryDirectory('codex-read-grant-fallback-')
    const repository = join(root, 'repository')
    const dataRoot = join(root, 'data')
    const logPath = join(root, 'app-server.jsonl')
    await exec('git', ['init', repository])
    await exec('git', ['config', 'user.name', 'OpenAgent Test'], { cwd: repository })
    await exec('git', ['config', 'user.email', 'openagent@example.invalid'], { cwd: repository })
    await writeFile(join(repository, 'README.md'), 'managed worktree\n')
    await exec('git', ['add', 'README.md'], { cwd: repository })
    await exec('git', ['commit', '-m', 'initial'], { cwd: repository })

    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'codex-read-grant-fallback',
      requested: { enabled: true, name: 'read-fallback' }
    })
    const grantSignals: AbortSignal[] = []
    const plugin = createCodexMainPlugin({
      resolveExecutable: async () => fixture,
      environment: async () => ({
        ...process.env,
        FAKE_CODEX_LOG: logPath,
        FAKE_CODEX_SPLIT_MESSAGES: '1'
      }),
      dataRoot,
      temporaryWorkspaceRoot: dataRoot
    })
    let record: AgentThreadRecord<'codex', CodexThreadSettings> = {
      id: 'codex-read-grant-fallback',
      harnessId: 'codex',
      archived: false,
      revision: 0,
      title: 'Codex read grant fallback',
      tags: [],
      cwd: repository,
      worktree: preparation.worktree,
      settings: { sandbox: 'workspace-write', approvalPolicy: 'never' },
      sessionState: null,
      observation: { latestExecution: null, backgroundWork: null },
      createdAt: 1,
      updatedAt: 1
    }
    const handle = await plugin.openThread({
      ...createAgentOpenContext({
        sessionState: plugin.sessionState,
        getRecord: () => record,
        setRecord: (next) => { record = next }
      }),
      managedWorkspaceWrite: {
        grant: async signal => {
          grantSignals.push(signal)
          // The source send authorizes; the read does not. The snapshot fallback
          // answers in an isolated temporary workspace, so a rejected grant has
          // to degrade to it instead of failing the read.
          if (grantSignals.length > 1) {
            throw new Error('managed workspace-write grant unavailable')
          }
          return manager.authorizeManagedWorkspaceWrite({
            ownerThreadId: record.id,
            worktree: record.worktree!,
            signal
          })
        }
      }
    })

    await manager.admitManagedWorktreeExecution({
      ownerThreadId: record.id,
      worktree: record.worktree!
    })
    await handle.send({
      executionId: 'read-grant-source',
      input: { parts: [{ kind: 'text', text: 'Commit the requested change.' }] },
      signal: new AbortController().signal
    })
    await waitFor(() => decodeCodexState(record.sessionState).turns[0]?.status === 'completed')

    await expect(handle.read('Summarize the Thread.', new AbortController().signal))
      .resolves.toBe('First update.\n\nSecond update.')
    expect(grantSignals).toHaveLength(2)

    const messages = await readLog(logPath)
    const paramsOf = (message: Record<string, unknown>): Record<string, unknown> =>
      message.params as Record<string, unknown>
    // No fork: the degraded path answers from the persisted snapshot instead.
    expect(messages.some((message) => message.method === 'thread/fork')).toBe(false)
    const readTurn = paramsOf(messages.filter((message) => message.method === 'turn/start').at(-1)!)
    expect(String((readTurn.input as { text: string }[])[0]!.text)).toContain('Snapshot:')

    await handle.dispose()
  }, 15_000)
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

async function readLog(path: string): Promise<readonly Record<string, unknown>[]> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.trim()
    ? text.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const startedAt = Date.now()
  while (!(await check())) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for Codex test')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
