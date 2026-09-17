import { execFile } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { runGit } from '../src/main/process-runner'
import { WorktreeManager } from '../src/main/services/worktree-manager'

const exec = promisify(execFile)
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('WorktreeManager', () => {
  it.skipIf(process.platform === 'win32')('bounds and kills a hung Git process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-worktree-hung-git-'))
    temporaryDirectories.push(root)
    const startedAt = Date.now()

    await expect(runGit(root, [
      '-c', 'alias.hang=!while :; do :; done', 'hang'
    ], {
      timeoutMs: 50,
      maxOutputBytes: 1024,
      terminationGraceMs: 50
    })).rejects.toThrow('超时')
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('creates a detached isolated worktree, preserves a nested cwd and reuses it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-worktree-test-'))
    temporaryDirectories.push(root)
    const repository = join(root, 'project')
    const nested = join(repository, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    await git(root, ['init', '-b', 'main', repository])
    await writeFile(join(repository, 'README.md'), 'main\n')
    await writeFile(join(nested, 'index.ts'), 'export const source = "main"\n')
    await git(repository, ['add', '.'])
    await git(repository, [
      '-c', 'user.name=OpenAgent Test',
      '-c', 'user.email=openagent@example.test',
      'commit', '-m', 'initial'
    ])

    const manager = new WorktreeManager()
    const worktree = await manager.prepare({
      cwd: nested,
      threadId: '12345678-abcd-4321-abcd-1234567890ab',
      requested: { enabled: true, name: 'feature' }
    })

    expect(worktree).toMatchObject({
      baseCwd: nested,
      name: 'feature',
      native: false
    })
    expect(worktree.cwd).toMatch(/packages[/\\]app$/)
    expect(await readFile(join(worktree.cwd!, 'index.ts'), 'utf8')).toContain('source = "main"')
    await expect(gitOutput(worktree.cwd!, ['symbolic-ref', '--quiet', 'HEAD'])).rejects.toThrow()
    await writeFile(join(worktree.cwd!, 'index.ts'), 'export const source = "worktree"\n')
    expect(await readFile(join(nested, 'index.ts'), 'utf8')).toContain('source = "main"')

    await expect(manager.prepare({
      cwd: nested,
      threadId: '12345678-abcd-4321-abcd-1234567890ab',
      requested: { enabled: true, name: 'feature' },
      existing: worktree
    })).resolves.toEqual(worktree)
  })

  it('does not mint ownership by structurally inspecting an existing worktree', async () => {
    const { repository } = await committedRepository('openagent-worktree-no-proof-existing-')
    const creator = new WorktreeManager()
    const worktree = await creator.prepare({
      cwd: repository,
      threadId: 'existing-proof-owner',
      requested: { enabled: true, name: 'isolated' }
    })

    await expect(new WorktreeManager().prepare({
      cwd: repository,
      threadId: 'existing-proof-owner',
      requested: { enabled: true, name: 'isolated' },
      existing: worktree
    })).rejects.toThrow('Thread-bound Core ownership')
  })

  it('removes the exact durable proof after a successful owned discard', async () => {
    const { root, repository } = await committedRepository('openagent-worktree-discard-proof-')
    const registryPath = join(root, 'openagent-state-v4', 'managed-worktrees.json')
    let gitDirectory = ''
    const manager = new WorktreeManager({
      registryPath,
      beforeDiscardCleanup: async (worktreeRoot) => {
        await rm(gitDirectory, { recursive: true, force: true })
        await rm(join(worktreeRoot, '.git'), { force: true })
        await rm(join(worktreeRoot, 'README.md'), { force: true })
      }
    })
    await manager.rehydratePersistedOwners([])
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'discard-proof-owner',
      requested: { enabled: true, name: 'isolated' }
    })
    gitDirectory = await realpath(await gitOutput(
      preparation.worktree.cwd!,
      ['rev-parse', '--git-dir']
    ).then(path => resolve(preparation.worktree.cwd!, path)))

    await expect(manager.discard(preparation)).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual({
      version: 1,
      entries: []
    })
    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('Thread-bound Core ownership')
  })

  it('rehydrates an exact durable owner proof and prunes no unrelated facts', async () => {
    const { root, repository } = await committedRepository('openagent-worktree-rehydrate-')
    const registryPath = join(root, 'openagent-state-v4', 'managed-worktrees.json')
    const ownerThreadId = 'durable-rehydrate-owner'
    const first = new WorktreeManager({ registryPath })
    await expect(first.rehydratePersistedOwners([])).resolves.toEqual([])
    const preparation = await first.prepareForStart({
      cwd: repository,
      threadId: ownerThreadId,
      requested: { enabled: true, name: 'isolated' }
    })

    const restarted = new WorktreeManager({ registryPath })
    await expect(restarted.rehydratePersistedOwners([{
      ownerThreadId,
      worktree: preparation.worktree
    }])).resolves.toEqual([])
    await expect(restarted.authorizeManagedWorkspaceWrite({
      ownerThreadId,
      worktree: preparation.worktree
    })).resolves.toMatchObject({
      kind: 'managed-linked-worktree',
      cwd: preparation.worktree.cwd,
      headOid: preparation.baselineOid
    })
  })

  it('fails closed when a persisted Thread has no Core ownership proof', async () => {
    const { root, repository } = await committedRepository('openagent-worktree-missing-proof-')
    const creator = new WorktreeManager()
    const preparation = await creator.prepareForStart({
      cwd: repository,
      threadId: 'missing-proof-owner',
      requested: { enabled: true, name: 'isolated' }
    })
    const restarted = new WorktreeManager({
      registryPath: join(root, 'openagent-state-v4', 'managed-worktrees.json')
    })

    const failures = await restarted.rehydratePersistedOwners([{
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    }])
    expect(failures).toHaveLength(1)
    expect(failures[0].error.message).toContain('exact owner/root')
    await expect(restarted.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('Thread-bound Core ownership')
  })

  it('refuses to persist a registry that its own current parser cannot reload', async () => {
    const { root, repository } = await committedRepository('openagent-worktree-registry-cap-')
    const registryPath = join(root, 'openagent-state-v4', 'managed-worktrees.json')
    const manager = new WorktreeManager({ registryPath, maxRegistryEntries: 1 })
    await manager.rehydratePersistedOwners([])
    const first = await manager.prepareForStart({
      cwd: repository,
      threadId: 'registry-cap-first',
      requested: { enabled: true, name: 'first' }
    })

    await expect(manager.prepareForStart({
      cwd: repository,
      threadId: 'registry-cap-second',
      requested: { enabled: true, name: 'second' }
    })).rejects.toThrow('entries 超过安全上限')

    const persisted = JSON.parse(await readFile(registryPath, 'utf8')) as {
      entries: { ownerThreadId: string }[]
    }
    expect(persisted.entries).toEqual([
      expect.objectContaining({ ownerThreadId: first.ownerThreadId })
    ])
    const restarted = new WorktreeManager({ registryPath, maxRegistryEntries: 1 })
    await expect(restarted.rehydratePersistedOwners([{
      ownerThreadId: first.ownerThreadId,
      worktree: first.worktree
    }])).resolves.toEqual([])
  })

  it('revokes process authority even when durable owner pruning fails', async () => {
    const { root, repository } = await committedRepository(
      'openagent-worktree-revoke-prune-failure-'
    )
    const registryPath = join(root, 'openagent-state-v4', 'managed-worktrees.json')
    let rejectPersist = false
    const manager = new WorktreeManager({
      registryPath,
      beforeRegistryPersist: () => {
        if (rejectPersist) throw new Error('fixture registry prune failed')
      }
    })
    await manager.rehydratePersistedOwners([])
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'revoke-prune-failure-owner',
      requested: { enabled: true, name: 'isolated' }
    })
    rejectPersist = true

    await expect(manager.unregisterOwnedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('fixture registry prune failed')
    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('registry 不可用')
  })

  it('revokes every process capability even when durable clear pruning fails', async () => {
    const { root, repository } = await committedRepository(
      'openagent-worktree-clear-prune-failure-'
    )
    let rejectPersist = false
    const manager = new WorktreeManager({
      registryPath: join(root, 'openagent-state-v4', 'managed-worktrees.json'),
      beforeRegistryPersist: () => {
        if (rejectPersist) throw new Error('fixture registry clear failed')
      }
    })
    await manager.rehydratePersistedOwners([])
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'clear-prune-failure-owner',
      requested: { enabled: true, name: 'isolated' }
    })
    rejectPersist = true

    await expect(manager.clearOwnedWorktrees())
      .rejects.toThrow('fixture registry clear failed')
    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('registry 不可用')
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a group-or-world-writable staging trust anchor',
    async () => {
      const { root, repository } = await committedRepository(
        'openagent-worktree-public-staging-'
      )
      const stagingRoot = join(root, '.project-openagent-worktrees')
      await mkdir(stagingRoot, { mode: 0o700 })
      await chmod(stagingRoot, 0o755)

      await expect(new WorktreeManager().prepareForStart({
        cwd: repository,
        threadId: 'public-staging-owner',
        requested: { enabled: true, name: 'isolated' }
      })).rejects.toThrow('不是 owner-only')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'revokes admission after the staging trust anchor loses owner-only mode',
    async () => {
      const { root, repository } = await committedRepository(
        'openagent-worktree-staging-mode-drift-'
      )
      const manager = new WorktreeManager({
        registryPath: join(root, 'openagent-state-v4', 'managed-worktrees.json')
      })
      await manager.rehydratePersistedOwners([])
      const preparation = await manager.prepareForStart({
        cwd: repository,
        threadId: 'staging-mode-drift-owner',
        requested: { enabled: true, name: 'isolated' }
      })
      await chmod(resolve(preparation.worktree.cwd!, '..'), 0o711)

      await expect(manager.admitManagedWorktreeExecution({
        ownerThreadId: preparation.ownerThreadId,
        worktree: preparation.worktree
      })).rejects.toThrow('不是 owner-only')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'fails boundedly when the Core registry path is a FIFO',
    async () => {
      const { root, repository } = await committedRepository(
        'openagent-worktree-registry-fifo-'
      )
      const registryDirectory = join(root, 'openagent-state-v4')
      const registryPath = join(registryDirectory, 'managed-worktrees.json')
      await mkdir(registryDirectory)
      await exec('mkfifo', [registryPath])
      const manager = new WorktreeManager({ registryPath })
      const startedAt = Date.now()

      await expect(manager.rehydratePersistedOwners([])).resolves.toEqual([])
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      await expect(manager.validateManagedWorktree({
        ownerThreadId: 'fifo-registry-owner',
        worktree: { baseCwd: repository, native: false, cwd: repository }
      })).rejects.toThrow('registry 不可用')
    }
  )

  it('prunes a same-owner proof whose canonical root is wrong', async () => {
    const { root, repository } = await committedRepository('openagent-worktree-wrong-root-proof-')
    const registryPath = join(root, 'openagent-state-v4', 'managed-worktrees.json')
    const first = new WorktreeManager({ registryPath })
    await first.rehydratePersistedOwners([])
    const preparation = await first.prepareForStart({
      cwd: repository,
      threadId: 'wrong-root-owner',
      requested: { enabled: true, name: 'isolated' }
    })
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
      entries: Record<string, unknown>[]
    }
    const wrongRoot = join(resolve(registry.entries[0].root as string, '..'), 'wrong-root')
    registry.entries[0] = {
      ...registry.entries[0],
      root: wrongRoot,
      executionCwd: wrongRoot
    }
    await writeFile(registryPath, JSON.stringify({ version: 1, entries: registry.entries }))

    const restarted = new WorktreeManager({ registryPath })
    const failures = await restarted.rehydratePersistedOwners([{
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    }])
    expect(failures).toHaveLength(1)
    expect(failures[0].error.message).toContain('exact owner/root')
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual({
      version: 1,
      entries: []
    })
  })

  it('rejects duplicate trusted Thread owners for one canonical root and prunes both', async () => {
    const { root, repository } = await committedRepository('openagent-worktree-duplicate-owner-')
    const registryPath = join(root, 'openagent-state-v4', 'managed-worktrees.json')
    const first = new WorktreeManager({ registryPath })
    await first.rehydratePersistedOwners([])
    const preparation = await first.prepareForStart({
      cwd: repository,
      threadId: 'duplicate-owner-a',
      requested: { enabled: true, name: 'isolated' }
    })
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
      version: 1
      entries: Record<string, unknown>[]
    }
    registry.entries.push({ ...registry.entries[0], ownerThreadId: 'duplicate-owner-b' })
    await writeFile(registryPath, JSON.stringify(registry))

    const restarted = new WorktreeManager({ registryPath })
    const failures = await restarted.rehydratePersistedOwners([
      { ownerThreadId: 'duplicate-owner-a', worktree: preparation.worktree },
      { ownerThreadId: 'duplicate-owner-b', worktree: preparation.worktree }
    ])
    expect(failures).toHaveLength(2)
    expect(failures.every(failure => failure.error.message.includes('多个可信 Thread owner')))
      .toBe(true)
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toEqual({
      version: 1,
      entries: []
    })
    await expect(restarted.authorizeManagedWorkspaceWrite({
      ownerThreadId: 'duplicate-owner-a',
      worktree: preparation.worktree
    })).rejects.toThrow('Thread-bound Core ownership')
  })

  it('returns an immutable provider-neutral write grant with only required Git roots', async () => {
    const { repository } = await committedRepository('openagent-worktree-grant-')
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'workspace-grant',
      requested: { enabled: true, name: 'isolated' }
    })

    const grant = await manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree,
      expectedHeadOid: preparation.baselineOid
    })
    const gitDirectory = await realpath(await gitOutput(
      preparation.worktree.cwd!,
      ['rev-parse', '--git-dir']
    ).then(path => resolve(preparation.worktree.cwd!, path)))
    const commonDirectory = await realpath(await gitOutput(
      preparation.worktree.cwd!,
      ['rev-parse', '--git-common-dir']
    ).then(path => resolve(preparation.worktree.cwd!, path)))

    expect(grant).toEqual({
      kind: 'managed-linked-worktree',
      cwd: preparation.worktree.cwd,
      headOid: preparation.baselineOid,
      writableRoots: [
        gitDirectory,
        join(commonDirectory, 'objects'),
        join(commonDirectory, 'packed-refs.lock')
      ]
    })
    expect(Object.isFrozen(grant)).toBe(true)
    expect(Object.isFrozen(grant.writableRoots)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'grants the canonical entity directory behind an object-store symlink',
    async () => {
      const { root, repository } = await committedRepository('openagent-worktree-object-link-')
      const commonDirectory = await realpath(join(repository, '.git'))
      const originalObjects = join(commonDirectory, 'objects')
      const canonicalObjects = join(root, 'canonical-object-store')
      await rename(originalObjects, canonicalObjects)
      await symlink(canonicalObjects, originalObjects, 'dir')
      const manager = new WorktreeManager()
      const preparation = await manager.prepareForStart({
        cwd: repository,
        threadId: 'object-link-owner',
        requested: { enabled: true, name: 'isolated' }
      })

      const grant = await manager.authorizeManagedWorkspaceWrite({
        ownerThreadId: preparation.ownerThreadId,
        worktree: preparation.worktree
      })
      expect(grant.writableRoots).toContain(await realpath(canonicalObjects))
      expect(grant.writableRoots).not.toContain(originalObjects)
      expect(new Set(grant.writableRoots).size).toBe(grant.writableRoots.length)
    }
  )

  it('rejects any pre-existing packed-refs.lock instead of granting the path', async () => {
    const { repository } = await committedRepository('openagent-worktree-packed-lock-')
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'packed-lock-owner',
      requested: { enabled: true, name: 'isolated' }
    })
    const commonDirectory = await realpath(await gitOutput(
      preparation.worktree.cwd!,
      ['rev-parse', '--git-common-dir']
    ).then(path => resolve(preparation.worktree.cwd!, path)))
    await writeFile(join(commonDirectory, 'packed-refs.lock'), 'external lock\n')

    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('packed-refs.lock 已存在')
  })

  it('rechecks after durable proof update and rolls back first-grant authority on a race', async () => {
    const { root, repository } = await committedRepository('openagent-worktree-post-proof-race-')
    const registryPath = join(root, 'openagent-state-v4', 'managed-worktrees.json')
    const replacementOid = await detachedCommit(repository)
    let mutate = false
    const manager = new WorktreeManager({
      registryPath,
      afterWorkspaceWriteGrantProofPersisted: async (worktreeRoot) => {
        if (mutate) await git(worktreeRoot, ['reset', '--hard', replacementOid])
      }
    })
    await manager.rehydratePersistedOwners([])
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'post-proof-race-owner',
      requested: { enabled: true, name: 'isolated' }
    })
    mutate = true

    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('worktree HEAD 已变化')
    const persisted = JSON.parse(await readFile(registryPath, 'utf8')) as {
      entries: { initialGrantPending: boolean; currentHeadOid: string }[]
    }
    expect(persisted.entries[0]).toMatchObject({
      initialGrantPending: true,
      currentHeadOid: preparation.baselineOid
    })
    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('worktree HEAD 已变化')
  })

  it('does not expose a grant when the ownership proof update cannot persist', async () => {
    const { root, repository } = await committedRepository('openagent-worktree-proof-write-')
    const registryPath = join(root, 'openagent-state-v4', 'managed-worktrees.json')
    const manager = new WorktreeManager({ registryPath })
    await manager.rehydratePersistedOwners([])
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'proof-write-owner',
      requested: { enabled: true, name: 'isolated' }
    })
    await rm(registryPath)
    await mkdir(registryPath)

    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow()
    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow()
  })

  it('rejects a HEAD changed after creation but before the first write grant', async () => {
    const { repository } = await committedRepository('openagent-worktree-first-grant-head-')
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'first-grant-head',
      requested: { enabled: true, name: 'isolated' }
    })
    const replacementOid = await detachedCommit(repository)
    await git(preparation.worktree.cwd!, ['reset', '--hard', replacementOid])

    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('worktree HEAD 已变化')
  })

  it('does not consume the creation-HEAD baseline during read-only validation', async () => {
    const { repository } = await committedRepository('openagent-worktree-validation-head-')
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'validation-head',
      requested: { enabled: true, name: 'isolated' }
    })

    await expect(manager.validateManagedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).resolves.toEqual({
      kind: 'managed-linked-worktree',
      cwd: preparation.worktree.cwd,
      headOid: preparation.baselineOid,
      repositoryIdentity: expect.any(String)
    })

    const replacementOid = await detachedCommit(repository)
    await git(preparation.worktree.cwd!, ['reset', '--hard', replacementOid])
    await expect(manager.validateManagedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('worktree HEAD 已变化')
    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('worktree HEAD 已变化')
  })

  it('revalidates against an earlier HEAD, cwd, and repository identity token', async () => {
    const { repository } = await committedRepository('openagent-worktree-validation-token-')
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'validation-token',
      requested: { enabled: true, name: 'isolated' }
    })
    // Consume the creation baseline so this test proves the explicit earlier
    // validation token, rather than the first-grant safeguard, owns the check.
    await manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    const first = await manager.validateManagedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    await expect(manager.validateManagedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree,
      expectedHeadOid: first.headOid,
      expectedCwd: first.cwd,
      expectedRepositoryIdentity: `${first.repositoryIdentity}-stale`
    })).rejects.toThrow('repository identity 已变化')
    const replacementOid = await detachedCommit(preparation.worktree.cwd!)
    await git(preparation.worktree.cwd!, ['reset', '--hard', replacementOid])

    await expect(manager.validateManagedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree,
      expectedHeadOid: first.headOid,
      expectedCwd: first.cwd,
      expectedRepositoryIdentity: first.repositoryIdentity
    })).rejects.toThrow('worktree HEAD 已变化')
  })

  it.skipIf(process.platform === 'win32')(
    'does not let a symlink alias or caller HEAD override bypass the creation baseline',
    async () => {
      const { root, repository } = await committedRepository(
        'openagent-worktree-first-grant-alias-'
      )
      const manager = new WorktreeManager()
      const preparation = await manager.prepareForStart({
        cwd: repository,
        threadId: 'first-grant-alias',
        requested: { enabled: true, name: 'isolated' }
      })
      const alias = join(root, 'worktree-alias')
      await symlink(preparation.worktree.cwd!, alias, 'dir')
      const replacementOid = await detachedCommit(repository)
      await git(preparation.worktree.cwd!, ['reset', '--hard', replacementOid])

      await expect(manager.authorizeManagedWorkspaceWrite({
        ownerThreadId: preparation.ownerThreadId,
        worktree: { ...preparation.worktree, cwd: alias },
        expectedHeadOid: replacementOid
      })).rejects.toThrow('expected HEAD 与 Core admitted HEAD 不匹配')
    }
  )

  it('captures a new exact HEAD for a later grant after a legitimate first turn commit', async () => {
    const { repository } = await committedRepository('openagent-worktree-later-grant-head-')
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'later-grant-head',
      requested: { enabled: true, name: 'isolated' }
    })
    const first = await manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    const nextOid = await detachedCommit(preparation.worktree.cwd!)
    await git(preparation.worktree.cwd!, ['reset', '--hard', nextOid])

    const observed = await manager.validateManagedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('worktree HEAD 已变化')
    const admission = await manager.admitManagedWorktreeExecution({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    const second = await manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    expect(first.headOid).toBe(preparation.baselineOid)
    expect(observed.headOid).toBe(nextOid)
    expect(admission.headOid).toBe(nextOid)
    expect(second.headOid).toBe(nextOid)
  })

  it('pins an explicit read-only validation token across a later HEAD race', async () => {
    const { repository } = await committedRepository('openagent-worktree-observe-head-token-')
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'observe-head-token',
      requested: { enabled: true, name: 'isolated' }
    })
    await manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    const observedOid = await detachedCommit(preparation.worktree.cwd!)
    await git(preparation.worktree.cwd!, ['reset', '--hard', observedOid])
    const observed = await manager.validateManagedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    const racedOid = await detachedCommit(preparation.worktree.cwd!)
    await git(preparation.worktree.cwd!, ['reset', '--hard', racedOid])

    await expect(manager.validateManagedWorktree({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree,
      expectedHeadOid: observed.headOid,
      expectedCwd: observed.cwd,
      expectedRepositoryIdentity: observed.repositoryIdentity
    })).rejects.toThrow('worktree HEAD 已变化')
  })

  it('pins a write grant to the HEAD durably admitted for that execution', async () => {
    const { repository } = await committedRepository('openagent-worktree-admit-grant-pin-')
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'admit-grant-pin',
      requested: { enabled: true, name: 'isolated' }
    })
    const replacementOid = await detachedCommit(repository)

    await manager.admitManagedWorktreeExecution({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    await git(preparation.worktree.cwd!, ['reset', '--hard', replacementOid])

    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree,
      expectedHeadOid: replacementOid
    })).rejects.toThrow('expected HEAD 与 Core admitted HEAD 不匹配')
  })

  it('allows a recreated nested execution cwd while retaining the root trust anchor', async () => {
    const { repository } = await committedRepository('openagent-worktree-recreated-cwd-')
    const nested = join(repository, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    const manager = new WorktreeManager()
    const preparation = await manager.prepareForStart({
      cwd: nested,
      threadId: 'recreated-nested-cwd',
      requested: { enabled: true, name: 'isolated' }
    })

    await manager.admitManagedWorktreeExecution({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })
    await rm(preparation.worktree.cwd!, { recursive: true })
    await mkdir(preparation.worktree.cwd!, { recursive: true })

    await expect(manager.admitManagedWorktreeExecution({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).resolves.toMatchObject({ cwd: preparation.worktree.cwd })
    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).resolves.toMatchObject({ cwd: preparation.worktree.cwd })
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a recreated nested execution cwd that escapes through a symlink',
    async () => {
      const { repository } = await committedRepository('openagent-worktree-cwd-escape-')
      const nested = join(repository, 'packages', 'app')
      await mkdir(nested, { recursive: true })
      const manager = new WorktreeManager()
      const preparation = await manager.prepareForStart({
        cwd: nested,
        threadId: 'nested-cwd-escape',
        requested: { enabled: true, name: 'isolated' }
      })
      await manager.admitManagedWorktreeExecution({
        ownerThreadId: preparation.ownerThreadId,
        worktree: preparation.worktree
      })
      await rm(preparation.worktree.cwd!, { recursive: true })
      await symlink(nested, preparation.worktree.cwd!, 'dir')

      await expect(manager.admitManagedWorktreeExecution({
        ownerThreadId: preparation.ownerThreadId,
        worktree: preparation.worktree
      })).rejects.toThrow(/Thread-bound Core ownership|原仓库不匹配|主工作树|隔离工作树/)
    }
  )

  it('rejects an exact-HEAD race between inspection and granting', async () => {
    const { repository } = await committedRepository('openagent-worktree-grant-head-race-')
    const replacementOid = await detachedCommit(repository)
    let mutate = false
    const manager = new WorktreeManager({
      beforeWorkspaceWriteGrantRevalidation: async (root) => {
        if (mutate) await git(root, ['reset', '--hard', replacementOid])
      }
    })
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'grant-head-race',
      requested: { enabled: true, name: 'isolated' }
    })
    mutate = true

    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('worktree HEAD 已变化')
  })

  it('rejects a worktree identity race between inspection and granting', async () => {
    const { repository } = await committedRepository('openagent-worktree-grant-identity-race-')
    let replace = false
    const manager = new WorktreeManager({
      beforeWorkspaceWriteGrantRevalidation: async (root) => {
        if (!replace) return
        const moved = `${root}-original`
        await rename(root, moved)
        await cp(moved, root, { recursive: true })
      }
    })
    const preparation = await manager.prepareForStart({
      cwd: repository,
      threadId: 'grant-identity-race',
      requested: { enabled: true, name: 'isolated' }
    })
    replace = true

    await expect(manager.authorizeManagedWorkspaceWrite({
      ownerThreadId: preparation.ownerThreadId,
      worktree: preparation.worktree
    })).rejects.toThrow('worktree identity 已变化')
  })

  it('refuses to reuse a managed worktree whose detached HEAD became symbolic', async () => {
    const { repository } = await committedRepository('openagent-worktree-symbolic-reuse-')
    const manager = new WorktreeManager()
    const worktree = await manager.prepare({
      cwd: repository,
      threadId: 'symbolic-reuse',
      requested: { enabled: true, name: 'isolated' }
    })
    await git(worktree.cwd!, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

    await expect(manager.prepare({
      cwd: repository,
      threadId: 'symbolic-reuse',
      requested: { enabled: true, name: 'isolated' },
      existing: worktree
    })).rejects.toThrow('不再 detached')
  })

  it('reports a clear error outside a Git repository', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openagent-not-git-'))
    temporaryDirectories.push(directory)
    await expect(new WorktreeManager().prepare({
      cwd: directory,
      threadId: 'conversation',
      requested: { enabled: true }
    })).rejects.toThrow('Git 仓库')
  })

  it('materializes a selected nested cwd that Git does not track', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-worktree-empty-cwd-'))
    temporaryDirectories.push(root)
    const repository = join(root, 'project')
    const nested = join(repository, 'empty', 'nested')
    await git(root, ['init', '-b', 'main', repository])
    await writeFile(join(repository, 'README.md'), 'main\n')
    await git(repository, ['add', '.'])
    await git(repository, [
      '-c', 'user.name=OpenAgent Test',
      '-c', 'user.email=openagent@example.test',
      'commit', '-m', 'initial'
    ])
    await mkdir(nested, { recursive: true })

    const worktree = await new WorktreeManager().prepare({
      cwd: nested,
      threadId: 'empty-cwd-conversation',
      requested: { enabled: true, name: 'empty' }
    })

    expect((await stat(worktree.cwd!)).isDirectory()).toBe(true)
  })

  it('rejects a selected directory that is a file in HEAD before creating a worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-worktree-file-conflict-'))
    temporaryDirectories.push(root)
    const repository = join(root, 'project')
    const selected = join(repository, 'target')
    await git(root, ['init', '-b', 'main', repository])
    await writeFile(selected, 'tracked file\n')
    await git(repository, ['add', '.'])
    await git(repository, [
      '-c', 'user.name=OpenAgent Test',
      '-c', 'user.email=openagent@example.test',
      'commit', '-m', 'initial'
    ])
    await rm(selected)
    await mkdir(selected)

    await expect(new WorktreeManager().prepare({
      cwd: selected,
      threadId: 'file-conflict',
      requested: { enabled: true, name: 'isolated' }
    })).rejects.toThrow('路径包含非目录项')

    const worktreeList = await exec('git', ['worktree', 'list', '--porcelain'], {
      cwd: repository
    })
    expect(worktreeList.stdout.match(/^worktree /gm)).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects an intermediate symlink in HEAD without escaping the worktree',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'openagent-worktree-symlink-'))
      temporaryDirectories.push(root)
      const repository = join(root, 'project')
      const outside = join(root, 'outside')
      const link = join(repository, 'link')
      const selected = join(link, 'nested')
      await git(root, ['init', '-b', 'main', repository])
      await mkdir(outside)
      await symlink(outside, link)
      await git(repository, ['add', '.'])
      await git(repository, [
        '-c', 'user.name=OpenAgent Test',
        '-c', 'user.email=openagent@example.test',
        'commit', '-m', 'initial'
      ])
      await rm(link)
      await mkdir(selected, { recursive: true })

      await expect(new WorktreeManager().prepare({
        cwd: selected,
        threadId: 'symlink-conflict',
        requested: { enabled: true, name: 'isolated' }
      })).rejects.toThrow('路径包含非目录项')

      await expect(stat(join(outside, 'nested'))).rejects.toThrow()
      const worktreeList = await exec('git', ['worktree', 'list', '--porcelain'], {
        cwd: repository
      })
      expect(worktreeList.stdout.match(/^worktree /gm)).toHaveLength(1)
    }
  )

  it('places worktrees beside the main checkout when Git metadata is stored elsewhere', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-worktree-git-dir-'))
    temporaryDirectories.push(root)
    const repository = join(root, 'project')
    const gitDirectory = join(root, 'metadata', 'project.git')
    await mkdir(join(root, 'metadata'), { recursive: true })
    await git(root, [
      'init', '-b', 'main', `--separate-git-dir=${gitDirectory}`, repository
    ])
    await writeFile(join(repository, 'README.md'), 'main\n')
    await git(repository, ['add', '.'])
    await git(repository, [
      '-c', 'user.name=OpenAgent Test',
      '-c', 'user.email=openagent@example.test',
      'commit', '-m', 'initial'
    ])

    const worktree = await new WorktreeManager().prepare({
      cwd: repository,
      threadId: 'separate-git-dir',
      requested: { enabled: true, name: 'isolated' }
    })

    expect(worktree.cwd).toContain(join(root, '.project-openagent-worktrees'))
    expect(worktree.cwd).not.toContain(join(root, 'metadata'))
  })

  it('keeps submodule worktrees outside the superproject Git metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-worktree-submodule-'))
    temporaryDirectories.push(root)
    const source = join(root, 'dependency-source')
    const superproject = join(root, 'superproject')
    await git(root, ['init', '-b', 'main', source])
    await writeFile(join(source, 'README.md'), 'dependency\n')
    await git(source, ['add', '.'])
    await git(source, [
      '-c', 'user.name=OpenAgent Test',
      '-c', 'user.email=openagent@example.test',
      'commit', '-m', 'initial dependency'
    ])
    await git(root, ['init', '-b', 'main', superproject])
    await writeFile(join(superproject, 'README.md'), 'superproject\n')
    await git(superproject, ['add', '.'])
    await git(superproject, [
      '-c', 'user.name=OpenAgent Test',
      '-c', 'user.email=openagent@example.test',
      'commit', '-m', 'initial superproject'
    ])
    await git(superproject, [
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', source, 'dependencies/example'
    ])
    await git(superproject, ['add', '.'])
    await git(superproject, [
      '-c', 'user.name=OpenAgent Test',
      '-c', 'user.email=openagent@example.test',
      'commit', '-m', 'add dependency'
    ])
    const submodule = join(superproject, 'dependencies', 'example')
    expect((await exec('git', ['status', '--porcelain'], { cwd: superproject })).stdout.trim())
      .toBe('')

    const worktree = await new WorktreeManager().prepare({
      cwd: submodule,
      threadId: 'submodule',
      requested: { enabled: true, name: 'isolated' }
    })

    expect(worktree.cwd).toContain(
      join(root, '.superproject-dependencies-example-openagent-worktrees')
    )
    expect(worktree.cwd).not.toContain(join(superproject, '.git'))
    expect((await exec('git', ['status', '--porcelain'], { cwd: superproject })).stdout.trim())
      .toBe('')
  })

  it('refuses to reuse a worktree from another repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-worktree-mismatch-'))
    temporaryDirectories.push(root)
    const base = join(root, 'base')
    const unrelated = join(root, 'unrelated')
    await git(root, ['init', '-b', 'main', base])
    await git(root, ['init', '-b', 'main', unrelated])

    await expect(new WorktreeManager().prepare({
      cwd: base,
      threadId: 'conversation',
      requested: { enabled: true },
      existing: {
        baseCwd: base,
        native: false,
        cwd: unrelated
      }
    })).rejects.toThrow('Thread-bound Core ownership')
  })

  it('preserves unknown files added after Git registers the worktree', async () => {
    const { repository } = await committedRepository('openagent-worktree-after-add-')
    const sentinelContent = 'written after worktree add\n'
    let staging = ''
    let identity: { dev: number; ino: number } | undefined
    const manager = new WorktreeManager({
      afterStagingCreated: async (path) => {
        staging = path
        const metadata = await lstat(path)
        identity = { dev: metadata.dev, ino: metadata.ino }
      },
      afterWorktreeAdd: async (path) => {
        await writeFile(join(path, 'user-sentinel.txt'), sentinelContent)
        throw new Error('injected failure after worktree add')
      }
    })

    let thrown: unknown
    try {
      await manager.prepare({
        cwd: repository,
        threadId: 'conversation-after-add',
        requested: { enabled: true, name: 'isolated' }
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(
      /injected failure after worktree add.*worktree 回滚失败.*未知、修改或忽略内容/
    )
    expect((thrown as Error & { cause?: unknown }).cause).toMatchObject({
      message: 'injected failure after worktree add'
    })
    expect(await readFile(join(staging, 'user-sentinel.txt'), 'utf8')).toBe(sentinelContent)
    const remaining = await lstat(staging)
    expect({ dev: remaining.dev, ino: remaining.ino }).toEqual(identity)
    expect(await gitOutput(repository, ['worktree', 'list', '--porcelain'])).toContain(staging)
    expect(await gitOutput(repository, ['branch', '--list', 'openagent/worktree/*'])).toBe('')
  })

  it.each(['untracked', 'ignored'] as const)(
    'preserves a %s file created in the former check-to-remove window',
    async (kind) => {
      const { repository } = await committedRepository(`openagent-worktree-cleanup-${kind}-`)
      const fileName = kind === 'ignored' ? 'external-sentinel.log' : 'external-sentinel.txt'
      if (kind === 'ignored') {
        await writeFile(join(repository, '.gitignore'), `${fileName}\n`)
        await git(repository, ['add', '.gitignore'])
        await git(repository, [
          '-c', 'user.name=OpenAgent Test',
          '-c', 'user.email=openagent@example.test',
          'commit', '-m', 'ignore audit sentinel'
        ])
      }
      let staging = ''
      const sentinelContent = `${kind} external data\n`
      const manager = new WorktreeManager({
        afterStagingCreated: (path) => {
          staging = path
        },
        beforeWorktreeValidation: () => {
          throw new Error('injected validation failure')
        },
        beforeCleanupStage: async (stage, path) => {
          if (stage === 'worktree-remove') {
            await writeFile(join(path, fileName), sentinelContent)
          }
        }
      })

      let thrown: unknown
      try {
        await manager.prepare({
          cwd: repository,
          threadId: `cleanup-${kind}`,
          requested: { enabled: true, name: 'isolated' }
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toMatch(
        /injected validation failure.*worktree 回滚失败.*清理期间出现未知、修改或忽略内容.*无法原子安全删除/
      )
      expect((thrown as Error & { cause?: unknown }).cause).toMatchObject({
        message: 'injected validation failure'
      })
      expect(await readFile(join(staging, fileName), 'utf8')).toBe(sentinelContent)
      expect((await lstat(staging)).isDirectory()).toBe(true)
      expect((await gitOutput(repository, ['worktree', 'list', '--porcelain']))
        .match(/^worktree /gm)).toHaveLength(2)
      expect(await gitOutput(repository, ['branch', '--list', 'openagent/worktree/*']))
        .toBe('')
    }
  )

  it('preserves both paths when the registered worktree inode changes during cleanup', async () => {
    const { repository } = await committedRepository('openagent-worktree-cleanup-identity-')
    let staging = ''
    let moved = ''
    const sentinelContent = 'replacement directory data\n'
    const manager = new WorktreeManager({
      afterStagingCreated: (path) => {
        staging = path
      },
      beforeWorktreeValidation: () => {
        throw new Error('injected validation failure')
      },
      beforeCleanupStage: async (stage, path) => {
        if (stage !== 'worktree-remove') return
        moved = `${path}-moved`
        await rename(path, moved)
        await mkdir(path)
        await writeFile(join(path, 'external-sentinel.txt'), sentinelContent)
      }
    })

    let thrown: unknown
    try {
      await manager.prepare({
        cwd: repository,
        threadId: 'cleanup-identity',
        requested: { enabled: true, name: 'isolated' }
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(
      /injected validation failure.*worktree 回滚失败.*无法原子安全删除/
    )
    expect((thrown as Error).message).toContain('identity 已变化')
    expect((thrown as Error & { cause?: unknown }).cause).toMatchObject({
      message: 'injected validation failure'
    })
    expect(await readFile(join(staging, 'external-sentinel.txt'), 'utf8')).toBe(sentinelContent)
    expect(await readFile(join(moved, 'README.md'), 'utf8')).toBe('main\n')
    expect((await lstat(staging)).isDirectory()).toBe(true)
    expect((await lstat(moved)).isDirectory()).toBe(true)
    expect(await gitOutput(repository, ['worktree', 'list', '--porcelain'])).toContain(staging)
  })

  it.each(['directory', 'symlink'] as const)(
    'preserves a %s replacement when the staging path identity changes',
    async (replacementKind) => {
      const { root, repository } = await committedRepository(
        `openagent-worktree-${replacementKind}-replacement-`
      )
      const sentinelContent = `${replacementKind} replacement data\n`
      const replacementTarget = join(root, 'replacement-target')
      let staging = ''
      let originalIdentity: { dev: number; ino: number } | undefined
      const manager = new WorktreeManager({
        afterStagingCreated: async (path) => {
          staging = path
          const metadata = await lstat(path)
          originalIdentity = { dev: metadata.dev, ino: metadata.ino }
        },
        beforeWorktreeAdd: async (path) => {
          // Keep the original inode allocated: rmdir + mkdir may reuse it on Linux.
          await rename(path, join(root, 'original-staging'))
          if (replacementKind === 'symlink') {
            await mkdir(replacementTarget)
            await writeFile(join(replacementTarget, 'user-sentinel.txt'), sentinelContent)
            await symlink(replacementTarget, path, 'dir')
          } else {
            await mkdir(path)
            await writeFile(join(path, 'user-sentinel.txt'), sentinelContent)
          }
        }
      })

      await expect(manager.prepare({
        cwd: repository,
        threadId: 'conversation-replacement',
        requested: { enabled: true, name: 'isolated' }
      })).rejects.toThrow(/identity 已变化/)

      const replacementMetadata = await lstat(staging)
      expect(replacementMetadata.isSymbolicLink()).toBe(replacementKind === 'symlink')
      expect({ dev: replacementMetadata.dev, ino: replacementMetadata.ino }).not.toEqual(
        originalIdentity
      )
      expect(await readFile(join(staging, 'user-sentinel.txt'), 'utf8')).toBe(sentinelContent)
      expect(await gitOutput(repository, ['branch', '--list', 'openagent/worktree/*'])).toBe('')
      expect((await gitOutput(repository, ['worktree', 'list', '--porcelain']))
        .match(/^worktree /gm)).toHaveLength(1)
    }
  )

  it('preserves a registered clean worktree when validation fails after checkout', async () => {
    const { repository } = await committedRepository('openagent-worktree-validation-failure-')
    let staging = ''
    const manager = new WorktreeManager({
      afterStagingCreated: (path) => {
        staging = path
      },
      beforeWorktreeValidation: () => {
        throw new Error('injected path validation failure')
      }
    })

    let thrown: unknown
    try {
      await manager.prepare({
        cwd: repository,
        threadId: 'conversation-validation-failure',
        requested: { enabled: true, name: 'isolated' }
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toMatch(
      /injected path validation failure.*worktree 回滚失败.*无法原子安全删除/
    )
    expect((thrown as Error & { cause?: unknown }).cause).toMatchObject({
      message: 'injected path validation failure'
    })

    expect((await lstat(staging)).isDirectory()).toBe(true)
    expect(await gitOutput(repository, ['branch', '--list', 'openagent/worktree/*'])).toBe('')
    expect((await gitOutput(repository, ['worktree', 'list', '--porcelain']))
      .match(/^worktree /gm)).toHaveLength(2)
  })

  it.each([
    ['worktree-remove', 'beforeWorktreeValidation'],
    ['directory-remove', 'beforeWorktreeAdd']
  ] as const)('reports an injected %s cleanup failure and preserves residual ownership evidence',
    async (failedStage, failurePoint) => {
      const { repository } = await committedRepository(`openagent-worktree-${failedStage}-failure-`)
      let staging = ''
      let identity: { dev: number; ino: number } | undefined
      const manager = new WorktreeManager({
        afterStagingCreated: async (path) => {
          staging = path
          const metadata = await lstat(path)
          identity = { dev: metadata.dev, ino: metadata.ino }
        },
        beforeWorktreeAdd: failurePoint === 'beforeWorktreeAdd'
          ? () => { throw new Error('injected creation failure') }
          : undefined,
        beforeWorktreeValidation: failurePoint === 'beforeWorktreeValidation'
          ? () => { throw new Error('injected creation failure') }
          : undefined,
        beforeCleanupStage: (stage) => {
          if (stage === failedStage) throw new Error(`injected ${failedStage} cleanup failure`)
        }
      })

      let thrown: unknown
      try {
        await manager.prepare({
          cwd: repository,
          threadId: `conversation-${failedStage}`,
          requested: { enabled: true, name: 'isolated' }
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('injected creation failure')
      expect((thrown as Error).message).toContain(`injected ${failedStage} cleanup failure`)
      expect((thrown as Error & { cause?: unknown }).cause).toMatchObject({
        message: 'injected creation failure'
      })

      const remaining = await lstat(staging)
      expect({ dev: remaining.dev, ino: remaining.ino }).toEqual(identity)
      expect(await gitOutput(repository, ['branch', '--list', 'openagent/worktree/*'])).toBe('')
      const worktreeList = await gitOutput(repository, ['worktree', 'list', '--porcelain'])
      expect(worktreeList.includes(staging)).toBe(failedStage === 'worktree-remove')
    }
  )

  it.each([
    ['different OID', 'different-oid'],
    ['missing ref', 'missing'],
    ['symbolic ref', 'symbolic'],
    ['same-OID ABA ref', 'same-oid-aba']
  ] as const)(
    'preserves an externally replaced %s before worktree add',
    async (_label, replacement) => {
      const { repository } = await committedRepository(`openagent-worktree-ref-${replacement}-`)
      const replacementOid = await detachedCommit(repository)
      const expectedOid = await gitOutput(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
      let staging = ''
      const privateRef = `refs/heads/external-${replacement}`
      const manager = new WorktreeManager({
        afterStagingCreated: async (path) => {
          staging = path
          if (replacement === 'different-oid') {
            await git(repository, [
              'update-ref', '--no-deref', '--create-reflog', '-m', 'external replacement',
              privateRef, replacementOid
            ])
          } else if (replacement === 'symbolic') {
            await git(repository, ['symbolic-ref', '-m', 'external symbolic replacement', privateRef,
              'refs/heads/main'])
          } else if (replacement === 'same-oid-aba') {
            await git(repository, [
              'update-ref', '--no-deref', '--create-reflog', '-m', 'external same-OID replacement',
              privateRef, expectedOid
            ])
          }
        },
        beforeWorktreeAdd: () => { throw new Error('injected after external ref activity') }
      })

      let thrown: unknown
      try {
        await manager.prepare({
          cwd: repository,
          threadId: `conversation-${replacement}`,
          requested: { enabled: true, name: 'isolated' }
        })
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toContain('injected after external ref activity')
      await expect(lstat(staging)).rejects.toThrow()
      expect((await gitOutput(repository, ['worktree', 'list', '--porcelain']))
        .match(/^worktree /gm)).toHaveLength(1)
      if (replacement === 'different-oid') {
        expect(await gitOutput(repository, ['rev-parse', '--verify', privateRef]))
          .toBe(replacementOid)
      } else if (replacement === 'symbolic') {
        expect(await gitOutput(repository, ['symbolic-ref', privateRef])).toBe('refs/heads/main')
        expect(await gitOutput(repository, ['rev-parse', '--verify', 'refs/heads/main']))
          .toBe(expectedOid)
      } else if (replacement === 'same-oid-aba') {
        expect(await gitOutput(repository, ['rev-parse', '--verify', privateRef])).toBe(expectedOid)
        expect(await gitOutput(repository, ['reflog', 'show', '-1', '--format=%gs', privateRef]))
          .toBe('external same-OID replacement')
      } else {
        await expect(gitOutput(repository, ['rev-parse', '--verify', privateRef])).rejects.toThrow()
      }
    }
  )

  it('checks out the requested OID detached and preserves a different-OID ref replaced after add',
    async () => {
      const { repository } = await committedRepository('openagent-worktree-ref-after-add-')
      const replacementOid = await detachedCommit(repository)
      const expectedOid = await gitOutput(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
      const privateRef = 'refs/heads/external-post-add-replacement'
      let staging = ''
      let checkoutOid = ''
      const manager = new WorktreeManager({
        afterStagingCreated: (path) => {
          staging = path
        },
        afterWorktreeAdd: async (path) => {
          checkoutOid = await gitOutput(path, ['rev-parse', '--verify', 'HEAD^{commit}'])
          await git(repository, [
            'update-ref', '--no-deref', '--create-reflog', '-m', 'external post-add replacement',
            privateRef, replacementOid
          ])
          throw new Error('injected after detached checkout')
        }
      })

      await expect(manager.prepare({
        cwd: repository,
        threadId: 'conversation-ref-after-add',
        requested: { enabled: true, name: 'isolated' }
      })).rejects.toThrow(/injected after detached checkout.*无法原子安全删除/)

      expect(checkoutOid).toBe(expectedOid)
      expect((await lstat(staging)).isDirectory()).toBe(true)
      expect((await gitOutput(repository, ['worktree', 'list', '--porcelain']))
        .match(/^worktree /gm)).toHaveLength(2)
      expect(await gitOutput(repository, ['rev-parse', '--verify', privateRef]))
        .toBe(replacementOid)
    }
  )

  it.each(['sentinel', 'directory', 'symlink'] as const)(
    'preserves a %s path race combined with a different-OID ref replacement',
    async (replacementKind) => {
      const { root, repository } = await committedRepository(
        `openagent-worktree-combined-${replacementKind}-`
      )
      const replacementOid = await detachedCommit(repository)
      const sentinelContent = `${replacementKind} external data\n`
      const replacementTarget = join(root, `${replacementKind}-replacement-target`)
      let staging = ''
      const privateRef = `refs/heads/external-combined-${replacementKind}`
      let originalIdentity: { dev: number; ino: number } | undefined
      const manager = new WorktreeManager({
        afterStagingCreated: async (path) => {
          staging = path
          const metadata = await lstat(path)
          originalIdentity = { dev: metadata.dev, ino: metadata.ino }
          if (replacementKind !== 'sentinel') {
            // Retain the original directory so this fixture guarantees a new inode.
            await rename(path, join(root, 'original-staging'))
            if (replacementKind === 'symlink') {
              await mkdir(replacementTarget)
              await writeFile(join(replacementTarget, 'user-sentinel.txt'), sentinelContent)
              await symlink(replacementTarget, path, 'dir')
            } else {
              await mkdir(path)
              await writeFile(join(path, 'user-sentinel.txt'), sentinelContent)
            }
          } else {
            await writeFile(join(path, 'user-sentinel.txt'), sentinelContent)
          }
          await git(repository, [
            'update-ref', '--no-deref', '--create-reflog', '-m', 'external combined replacement',
            privateRef, replacementOid
          ])
        }
      })

      await expect(manager.prepare({
        cwd: repository,
        threadId: `conversation-combined-${replacementKind}`,
        requested: { enabled: true, name: 'isolated' }
      })).rejects.toThrow(/worktree 回滚失败/)

      expect(await readFile(join(staging, 'user-sentinel.txt'), 'utf8')).toBe(sentinelContent)
      const remaining = await lstat(staging)
      if (replacementKind === 'sentinel') {
        expect({ dev: remaining.dev, ino: remaining.ino }).toEqual(originalIdentity)
      } else {
        expect({ dev: remaining.dev, ino: remaining.ino }).not.toEqual(originalIdentity)
      }
      expect(remaining.isSymbolicLink()).toBe(replacementKind === 'symlink')
      expect(await gitOutput(repository, ['rev-parse', '--verify', privateRef]))
        .toBe(replacementOid)
      expect((await gitOutput(repository, ['worktree', 'list', '--porcelain']))
        .match(/^worktree /gm)).toHaveLength(1)
    }
  )

  it('preserves a branch created concurrently after staging allocation', async () => {
    const { repository } = await committedRepository('openagent-worktree-concurrent-branch-')
    const branch = 'external-concurrent-branch'
    const ref = `refs/heads/${branch}`
    const expectedOid = await gitOutput(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
    let staging = ''
    const manager = new WorktreeManager({
      afterStagingCreated: (path) => {
        staging = path
      },
      beforeWorktreeAdd: async () => {
        await git(repository, ['update-ref', ref, expectedOid])
        throw new Error('injected after concurrent branch')
      },
    })

    await expect(manager.prepare({
      cwd: repository,
      threadId: 'conversation-concurrent-branch',
      requested: { enabled: true, name: 'isolated' }
    })).rejects.toThrow()

    expect(await gitOutput(repository, ['branch', '--list', branch])).toContain(branch)
    await expect(lstat(staging)).rejects.toThrow()
    expect((await gitOutput(repository, ['worktree', 'list', '--porcelain']))
      .match(/^worktree /gm)).toHaveLength(1)
  })
})

async function committedRepository(prefix: string): Promise<{ root: string; repository: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(root)
  const repository = join(root, 'project')
  await git(root, ['init', '-b', 'main', repository])
  await writeFile(join(repository, 'README.md'), 'main\n')
  await git(repository, ['add', '.'])
  await git(repository, [
    '-c', 'user.name=OpenAgent Test',
    '-c', 'user.email=openagent@example.test',
    'commit', '-m', 'initial'
  ])
  return { root, repository }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd })
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim()
}

async function detachedCommit(repository: string): Promise<string> {
  const parent = await gitOutput(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const tree = await gitOutput(repository, ['rev-parse', '--verify', 'HEAD^{tree}'])
  return (await exec('git', [
    '-c', 'user.name=OpenAgent Test',
    '-c', 'user.email=openagent@example.test',
    'commit-tree', tree, '-p', parent, '-m', 'external replacement'
  ], { cwd: repository })).stdout.trim()
}
