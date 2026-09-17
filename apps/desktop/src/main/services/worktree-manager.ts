import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, realpath, rmdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type {
  AgentWorktree,
  ManagedWorkspaceWriteGrant,
  WorktreeOptions
} from '@openagent/contracts'
import { runGit } from '../process-runner'
import { writePrivateFileAtomically } from './atomic-file'

const MAX_OWNERSHIP_REGISTRY_BYTES = 4 * 1024 * 1024
const MAX_OWNERSHIP_REGISTRY_ENTRIES = 10_000
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const MANAGED_GIT_TIMEOUT_MS = 10_000
const MAX_GIT_POINTER_BYTES = 64 * 1024

function git(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return runGit(cwd, args, {
    signal,
    timeoutMs: MANAGED_GIT_TIMEOUT_MS,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES
  })
}

interface PrepareWorktreeOptions {
  cwd: string
  threadId: string
  requested?: WorktreeOptions
  existing?: AgentWorktree
}

export interface WorktreePreparation {
  worktree: AgentWorktree
  created: boolean
  /** Core-only cleanup authority; never persisted in the public Thread record. */
  ownerThreadId: string
  /**
   * Immutable call-time baseline for Harness-native worktrees: the
   * `HEAD^{commit}` OID captured at the OpenAgent call boundary, verified
   * against the materialized worktree after the Harness finishes initializing.
   */
  baselineOid?: string
}

export interface ManagedWorktreeValidation {
  readonly kind: 'managed-linked-worktree'
  readonly cwd: string
  readonly headOid: string
  /** Opaque Core identity for the repository/gitdir facts behind this grant. */
  readonly repositoryIdentity: string
}

interface DirectoryIdentity {
  readonly dev: string
  readonly ino: string
  readonly birthtimeMs: string
}

export interface ManagedWorktreeSnapshot {
  readonly root: string
  readonly executionCwd: string
  readonly baseRoot: string
  readonly stagingRoot: string
  readonly commonDirectory: string
  readonly gitDirectory: string
  readonly objectDirectory: string
  readonly packedRefsLock: string
  readonly headOid: string
  readonly identity: DirectoryIdentity
  readonly executionCwdIdentity: DirectoryIdentity
  readonly baseRootIdentity: DirectoryIdentity
  readonly stagingRootIdentity: DirectoryIdentity
  readonly commonDirectoryIdentity: DirectoryIdentity
  readonly gitDirectoryIdentity: DirectoryIdentity
  readonly objectDirectoryIdentity: DirectoryIdentity
  readonly repositoryIdentity: string
}

interface ManagedWorktreeOwnershipProof {
  readonly ownerThreadId: string
  readonly root: string
  readonly executionCwd: string
  readonly baseRoot: string
  readonly stagingRoot: string
  readonly commonDirectory: string
  readonly gitDirectory: string
  readonly objectDirectory: string
  readonly packedRefsLock: string
  readonly identity: DirectoryIdentity
  readonly baseRootIdentity: DirectoryIdentity
  readonly stagingRootIdentity: DirectoryIdentity
  readonly commonDirectoryIdentity: DirectoryIdentity
  readonly gitDirectoryIdentity: DirectoryIdentity
  readonly objectDirectoryIdentity: DirectoryIdentity
  readonly repositoryIdentity: string
  readonly creationHeadOid: string
  readonly currentHeadOid: string
  readonly initialGrantPending: boolean
}

interface ManagedWorktreeOwnershipRegistry {
  readonly version: 1
  readonly entries: readonly ManagedWorktreeOwnershipProof[]
}

interface OwnedWorktree {
  readonly ownerThreadId: string
  readonly proof: ManagedWorktreeOwnershipProof
}

type ManagedWorktreeInspectionPolicy = 'observe' | 'admit' | 'authorize'

export interface ManagedWorktreeAuthorizationRequest {
  readonly ownerThreadId: string
  readonly worktree: AgentWorktree
  /** Optional immutable call-boundary HEAD that must still be checked out. */
  readonly expectedHeadOid?: string
  /** Optional canonical execution cwd captured by an earlier Core validation. */
  readonly expectedCwd?: string
  /** Opaque provider-neutral repository identity captured by Core. */
  readonly expectedRepositoryIdentity?: string
  readonly signal?: AbortSignal
}

export interface PersistedManagedWorktreeOwner {
  readonly ownerThreadId: string
  readonly worktree: AgentWorktree
}

export interface ManagedWorktreeRecoveryFailure {
  readonly ownerThreadId?: string
  readonly error: Error
}

type CleanupStage = 'worktree-remove' | 'directory-remove'

interface WorktreeManagerHooks {
  /** Core-only current-schema ownership registry. Omit only in isolated tests. */
  registryPath?: string
  /** Test-only limits; production always uses the strict current-schema caps. */
  maxRegistryBytes?: number
  maxRegistryEntries?: number
  beforeRegistryPersist?: (serialized: string) => void | Promise<void>
  afterStagingCreated?: (root: string) => void | Promise<void>
  beforeWorktreeAdd?: (root: string) => void | Promise<void>
  afterWorktreeAdd?: (root: string) => void | Promise<void>
  beforeWorktreeValidation?: (root: string) => void | Promise<void>
  beforeWorkspaceWriteGrantRevalidation?: (root: string) => void | Promise<void>
  afterManagedExecutionAdmissionProofPersisted?: (root: string) => void | Promise<void>
  afterWorkspaceWriteGrantProofPersisted?: (root: string) => void | Promise<void>
  beforeDiscardCleanup?: (root: string) => void | Promise<void>
  beforeCleanupStage?: (stage: CleanupStage, root: string) => void | Promise<void>
}

/** Creates and reuses Git worktrees requested through the Core product boundary. */
export class WorktreeManager {
  private readonly ownedRoots = new Map<string, OwnedWorktree>()
  private readonly ownershipProofs = new Map<string, ManagedWorktreeOwnershipProof>()
  private ownershipQueue: Promise<void> = Promise.resolve()
  private registryLoaded: boolean
  private registryError: Error | undefined

  constructor(private readonly hooks: WorktreeManagerHooks = {}) {
    if (hooks.maxRegistryBytes !== undefined &&
        (!Number.isSafeInteger(hooks.maxRegistryBytes) || hooks.maxRegistryBytes <= 0)) {
      throw new Error('managed worktree registry byte limit 必须是正整数')
    }
    if (hooks.maxRegistryEntries !== undefined &&
        (!Number.isSafeInteger(hooks.maxRegistryEntries) || hooks.maxRegistryEntries <= 0)) {
      throw new Error('managed worktree registry entry limit 必须是正整数')
    }
    this.registryLoaded = hooks.registryPath === undefined
  }

  async prepare(options: PrepareWorktreeOptions): Promise<AgentWorktree> {
    return (await this.prepareForStart(options)).worktree
  }

  async prepareForStart(options: PrepareWorktreeOptions): Promise<WorktreePreparation> {
    if (options.existing?.cwd) {
      const validation = await this.validateManagedWorktree({
        ownerThreadId: options.threadId,
        worktree: options.existing
      })
      return {
        worktree: options.existing,
        created: false,
        ownerThreadId: options.threadId,
        baselineOid: validation.headOid
      }
    }

    const { canonicalCwd, repository } = await requiredWorktreeBaseContext(options.cwd)
    const subdirectory = relative(repository.root, canonicalCwd)
    if (subdirectory === '..' || subdirectory.startsWith(`..${sep}`)) {
      throw new Error('无法解析 worktree 中的工作目录')
    }
    if (subdirectory) {
      await assertHeadDirectoryPath(repository.root, subdirectory)
    }

    const label = slug(options.requested?.name || 'task')
    const identity = slug(options.threadId).slice(0, 12) || 'thread'
    const directoryName = `${label}-${identity}`
    const expectedOid = await git(repository.root, ['rev-parse', '--verify', 'HEAD^{commit}'])
    const root = await createPrivateStagingDirectory(repository.worktreesRoot, directoryName)
    const rootIdentity = await requiredDirectoryIdentity(root)
    try {
      await this.hooks.afterStagingCreated?.(root)
      await this.hooks.beforeWorktreeAdd?.(root)
      // Checkout the immutable commit OID detached, never the mutable ref.
      // A concurrent ref replacement therefore cannot select another commit.
      await git(repository.root, ['worktree', 'add', '--detach', root, expectedOid])
      await this.hooks.afterWorktreeAdd?.(root)
      await assertDirectoryIdentity(root, rootIdentity)
      await assertDetachedWorktreeHead(root, expectedOid)
      await assertRegisteredWorktree(repository.root, root)
      await this.hooks.beforeWorktreeValidation?.(root)

      const worktreeCwd = subdirectory ? join(root, subdirectory) : root
      // Git does not materialize empty or entirely untracked directories in a
      // new worktree. Preserve the directory the user explicitly selected so
      // every target Harness receives a valid cwd.
      await ensureFilesystemDirectoryPath(root, worktreeCwd, rootIdentity)
      const [canonicalRoot, canonicalWorktreeCwd] = await Promise.all([
        realpath(root),
        realpath(worktreeCwd)
      ])
      const canonicalSubdirectory = relative(canonicalRoot, canonicalWorktreeCwd)
      if (
        canonicalSubdirectory === '..' ||
        canonicalSubdirectory.startsWith(`..${sep}`)
      ) {
        throw new Error('worktree 工作目录解析到了隔离目录之外')
      }

      await assertDirectoryIdentity(root, rootIdentity)
      await assertRegisteredWorktree(repository.root, root)
      await assertDetachedWorktreeHead(root, expectedOid)
      const worktree: AgentWorktree = {
        baseCwd: options.cwd,
        name: options.requested?.name,
        native: false,
        cwd: canonicalWorktreeCwd
      }
      const snapshot = await inspectManagedWorktree(worktree, expectedOid)
      await this.registerOwnedWorktree(options.threadId, snapshot, true)
      return {
        worktree,
        created: true,
        ownerThreadId: options.threadId,
        baselineOid: expectedOid
      }
    } catch (error) {
      try {
        await cleanupWorktreeAttempt(
          repository.root,
          root,
          rootIdentity,
          this.hooks
        )
      } catch (cleanupError) {
        throw combineErrors(error, cleanupError, 'worktree 回滚失败')
      }
      throw error
    }
  }

  async discard(preparation: WorktreePreparation): Promise<void> {
    if (!preparation.created || preparation.worktree.native || !preparation.worktree.cwd) return
    const base = await repositoryContext(preparation.worktree.baseCwd)
    const existing = await repositoryContext(preparation.worktree.cwd)
    if (base.commonDirectory !== existing.commonDirectory) {
      throw new Error(`拒绝回滚不属于原仓库的 worktree：${preparation.worktree.cwd}`)
    }
    const headName = await git(preparation.worktree.cwd, [
      'rev-parse', '--abbrev-ref', 'HEAD'
    ])
    if (headName !== 'HEAD') {
      throw new Error(`拒绝回滚非 detached worktree：${preparation.worktree.cwd}`)
    }
    const root = resolve(existing.root)
    const ownership = this.ownedRoots.get(root)
    if (!ownership || ownership.ownerThreadId !== preparation.ownerThreadId) {
      throw new Error(`拒绝清理缺少本次调用所有权证明的 worktree：${existing.root}`)
    }
    const verified = await inspectManagedWorktree(preparation.worktree)
    assertSnapshotMatchesProof(verified, ownership.proof)
    await this.hooks.beforeDiscardCleanup?.(root)
    await cleanupWorktreeAttempt(
      base.root,
      existing.root,
      ownership.proof.identity,
      this.hooks
    )
    await this.unregisterProofByRoot(
      preparation.ownerThreadId,
      root,
      ownership.proof
    )
  }

  /**
   * Validates managed-worktree ownership and immutable identity without
   * consuming the first native write grant's creation-HEAD baseline.
   */
  async validateManagedWorktree(
    request: ManagedWorktreeAuthorizationRequest
  ): Promise<ManagedWorktreeValidation> {
    return this.withOwnershipLock(async () => {
      const { verified } = await this.inspectOwnedManagedWorktree(request, 'observe')
      return Object.freeze({
        kind: 'managed-linked-worktree' as const,
        cwd: verified.executionCwd,
        headOid: verified.headOid,
        repositoryIdentity: verified.repositoryIdentity
      })
    })
  }

  /**
   * Admits one provider-neutral native execution against the Thread-bound
   * managed worktree. Unlike a write grant this exposes no repository write
   * roots, but it durably consumes/advances the HEAD baseline before any
   * Plugin native process is allowed to run.
   */
  async admitManagedWorktreeExecution(
    request: ManagedWorktreeAuthorizationRequest
  ): Promise<ManagedWorktreeValidation> {
    return this.withOwnershipLock(async () => {
      const { verified, owned } = await this.inspectOwnedManagedWorktree(request, 'admit')
      await this.advanceProofAndFinallyVerify(
        request,
        verified,
        owned,
        this.hooks.afterManagedExecutionAdmissionProofPersisted
      )
      return Object.freeze({
        kind: 'managed-linked-worktree' as const,
        cwd: verified.executionCwd,
        headOid: verified.headOid,
        repositoryIdentity: verified.repositoryIdentity
      })
    })
  }

  /**
   * Authorizes the smallest provider-neutral write grant for a managed linked
   * worktree. The second inspection closes the HEAD/path/identity race between
   * validation and granting; providers never perform or import this check.
   */
  async authorizeManagedWorkspaceWrite(
    request: ManagedWorktreeAuthorizationRequest
  ): Promise<ManagedWorkspaceWriteGrant> {
    return this.withOwnershipLock(async () => {
      const { verified, owned } = await this.inspectOwnedManagedWorktree(
        request,
        'authorize'
      )
      await this.advanceProofAndFinallyVerify(
        request,
        verified,
        owned,
        this.hooks.afterWorkspaceWriteGrantProofPersisted
      )
      const writableRoots = Object.freeze(uniquePaths([
        verified.gitDirectory,
        verified.objectDirectory,
        verified.packedRefsLock
      ]))
      return Object.freeze({
        kind: 'managed-linked-worktree' as const,
        cwd: verified.executionCwd,
        headOid: verified.headOid,
        writableRoots
      })
    })
  }

  private async advanceProofAndFinallyVerify(
    request: ManagedWorktreeAuthorizationRequest,
    verified: ManagedWorktreeSnapshot,
    owned: OwnedWorktree,
    afterProofPersisted?: (root: string) => void | Promise<void>
  ): Promise<void> {
    const previousProof = owned.proof
    const nextProof: ManagedWorktreeOwnershipProof = {
      ...previousProof,
      currentHeadOid: verified.headOid,
      initialGrantPending: false
    }
    const proofChanged = previousProof.initialGrantPending ||
      previousProof.currentHeadOid !== verified.headOid
    // Durability is part of the authority boundary: native execution cannot
    // begin until its baseline update is committed to the Core-only proof.
    if (proofChanged) await this.replaceProof(previousProof, nextProof)
    try {
      await afterProofPersisted?.(verified.root)
      throwIfAborted(request.signal)
      const finalVerified = await inspectManagedWorktree(
        request.worktree,
        verified.headOid,
        verified,
        request.signal
      )
      throwIfAborted(request.signal)
      assertSnapshotMatchesProof(finalVerified, nextProof)
    } catch (error) {
      if (proofChanged) {
        try {
          await this.replaceProof(nextProof, previousProof)
        } catch (rollbackError) {
          const failure = combineErrors(
            error,
            rollbackError,
            'managed worktree proof rollback 失败'
          )
          this.registryError = failure
          this.ownedRoots.clear()
          throw failure
        }
      }
      throw error
    }
    this.ownedRoots.set(verified.root, {
      ownerThreadId: owned.ownerThreadId,
      proof: proofChanged ? nextProof : previousProof
    })
  }

  /**
   * Loads the current Core-only proof registry and rehydrates only owners that
   * exactly match trusted persisted Agent Thread records. Invalid/missing
   * proofs fail independently; crash-orphan proofs are pruned durably.
   */
  async rehydratePersistedOwners(
    records: readonly PersistedManagedWorktreeOwner[]
  ): Promise<readonly ManagedWorktreeRecoveryFailure[]> {
    return this.withOwnershipLock(async () => {
      if (this.registryLoaded) {
        if (this.ownedRoots.size || this.ownershipProofs.size) {
          throw new Error('managed worktree ownership registry 已初始化')
        }
        return []
      }
      const failures: ManagedWorktreeRecoveryFailure[] = []
      let registry: ManagedWorktreeOwnershipRegistry
      try {
        registry = await this.loadRegistry()
      } catch (error) {
        const failure = asError(error)
        this.registryLoaded = true
        this.registryError = failure
        return records.map(record => ({
          ownerThreadId: record.ownerThreadId,
          error: new Error(`managed worktree ownership proof 不可用：${failure.message}`)
        }))
      }

      this.registryLoaded = true
      const inspected: readonly {
        readonly record: PersistedManagedWorktreeOwner
        readonly snapshot?: ManagedWorktreeSnapshot
      }[] = await Promise.all(records.map(async record => {
        try {
          assertOwnerThreadId(record.ownerThreadId)
          const snapshot = await inspectManagedWorktree(record.worktree)
          return { record, snapshot }
        } catch (error) {
          failures.push({ ownerThreadId: record.ownerThreadId, error: asError(error) })
          return { record }
        }
      }))

      const nextProofs = new Map<string, ManagedWorktreeOwnershipProof>()
      for (const { record, snapshot } of inspected) {
        if (!snapshot) continue
        try {
          const trustedOwnerRecords = inspected.filter(candidate =>
            candidate.record.ownerThreadId === record.ownerThreadId
          )
          if (trustedOwnerRecords.length !== 1) {
            throw new Error('managed worktree trusted Thread ownerId 不唯一')
          }
          const trustedRootRecords = inspected.filter(candidate =>
            candidate.snapshot?.root === snapshot.root
          )
          if (trustedRootRecords.length !== 1) {
            throw new Error(
              `managed worktree root 存在多个可信 Thread owner：${snapshot.root}`
            )
          }
          const ownerProofs = registry.entries.filter(candidate =>
            candidate.ownerThreadId === record.ownerThreadId
          )
          const rootProofs = registry.entries.filter(candidate =>
            candidate.root === snapshot.root
          )
          if (ownerProofs.length !== 1 || rootProofs.length !== 1 ||
              ownerProofs[0] !== rootProofs[0]) {
            throw new Error(
              'managed worktree 缺少唯一 exact owner/root Core ownership proof'
            )
          }
          const proof = ownerProofs[0]
          assertSnapshotMatchesProof(snapshot, proof)
          if (proof.initialGrantPending && snapshot.headOid !== proof.creationHeadOid) {
            throw new Error(
              `worktree HEAD 已变化（expected ${proof.creationHeadOid}, actual ${snapshot.headOid}）`
            )
          }
          const currentProof = proof.currentHeadOid === snapshot.headOid
            ? proof
            : { ...proof, currentHeadOid: snapshot.headOid }
          nextProofs.set(snapshot.root, currentProof)
        } catch (error) {
          failures.push({ ownerThreadId: record.ownerThreadId, error: asError(error) })
        }
      }

      try {
        await this.persistProofMap(nextProofs)
      } catch (error) {
        const failure = asError(error)
        this.registryError = failure
        failures.push({
          error: new Error(`managed worktree ownership proof prune/update 失败：${failure.message}`)
        })
        return failures
      }
      this.ownershipProofs.clear()
      this.ownedRoots.clear()
      for (const [root, proof] of nextProofs) {
        this.ownershipProofs.set(root, proof)
        this.ownedRoots.set(root, { ownerThreadId: proof.ownerThreadId, proof })
      }
      return failures
    })
  }

  /** Removes exactly one matching Thread owner; mismatches are rejected. */
  async unregisterOwnedWorktree(request: {
    readonly ownerThreadId: string
    readonly worktree?: AgentWorktree
  }): Promise<void> {
    return this.withOwnershipLock(async () => {
      this.assertRegistryUsable()
      assertOwnerThreadId(request.ownerThreadId)
      const candidates = [...this.ownershipProofs.values()].filter(
        proof => proof.ownerThreadId === request.ownerThreadId
      )
      if (candidates.length === 0) return
      if (candidates.length !== 1) {
        throw new Error(`Thread ownership proof 不唯一：${request.ownerThreadId}`)
      }
      const proof = candidates[0]
      if (request.worktree?.cwd) {
        if (request.worktree.native !== false ||
            request.worktree.cwd !== proof.executionCwd) {
          throw new Error('拒绝注销不匹配 Thread worktree 的 ownership proof')
        }
      }
      await this.removeProofByRoot(request.ownerThreadId, proof.root, proof)
    })
  }

  /** Clears every Core ownership proof after all Thread handles are revoked. */
  async clearOwnedWorktrees(): Promise<void> {
    return this.withOwnershipLock(async () => {
      if (!this.registryLoaded) {
        throw new Error('managed worktree ownership registry 尚未初始化')
      }
      this.ownershipProofs.clear()
      this.ownedRoots.clear()
      try {
        await this.persistProofMap(new Map())
        this.registryError = undefined
      } catch (error) {
        this.registryError = asError(error)
        throw error
      }
    })
  }

  private async inspectOwnedManagedWorktree(
    request: ManagedWorktreeAuthorizationRequest,
    policy: ManagedWorktreeInspectionPolicy
  ): Promise<{
    readonly verified: ManagedWorktreeSnapshot
    readonly owned: OwnedWorktree
  }> {
    this.assertRegistryUsable()
    assertOwnerThreadId(request.ownerThreadId)
    throwIfAborted(request.signal)
    const requestedCwd = request.worktree.cwd
      ? await realpath(request.worktree.cwd).catch(() => resolve(request.worktree.cwd!))
      : undefined
    const ownedEntry = requestedCwd
      ? [...this.ownedRoots.entries()].find(([root, owner]) =>
          owner.ownerThreadId === request.ownerThreadId && isWithin(root, requestedCwd)
        )
      : undefined
    if (!ownedEntry) {
      throw new Error(`managed worktree 缺少 Thread-bound Core ownership：${request.ownerThreadId}`)
    }
    const [ownedRoot, owned] = ownedEntry
    const proofHeadOid = owned.proof.initialGrantPending
      ? owned.proof.creationHeadOid
      : policy === 'authorize'
        ? owned.proof.currentHeadOid
        : undefined
    if (proofHeadOid !== undefined && request.expectedHeadOid !== undefined &&
        request.expectedHeadOid !== proofHeadOid) {
      throw new Error(
        `worktree expected HEAD 与 Core admitted HEAD 不匹配` +
        `（expected ${request.expectedHeadOid}, admitted ${proofHeadOid}）`
      )
    }
    const expectedHeadOid = proofHeadOid ?? request.expectedHeadOid
    const first = await inspectManagedWorktree(
      request.worktree,
      expectedHeadOid,
      undefined,
      request.signal
    )
    throwIfAborted(request.signal)
    if (first.root !== ownedRoot) throw new Error('worktree root 与 Core ownership 不匹配')
    assertSnapshotMatchesProof(first, owned.proof)
    await this.hooks.beforeWorkspaceWriteGrantRevalidation?.(first.root)
    throwIfAborted(request.signal)
    const verified = await inspectManagedWorktree(
      request.worktree,
      first.headOid,
      first,
      request.signal
    )
    throwIfAborted(request.signal)
    if (request.expectedCwd !== undefined &&
        verified.executionCwd !== request.expectedCwd) {
      throw new Error('worktree execution cwd 已变化')
    }
    if (request.expectedRepositoryIdentity !== undefined &&
        verified.repositoryIdentity !== request.expectedRepositoryIdentity) {
      throw new Error('worktree repository identity 已变化')
    }

    assertSnapshotMatchesProof(verified, owned.proof)
    return { verified, owned }
  }

  private async registerOwnedWorktree(
    ownerThreadId: string,
    snapshot: ManagedWorktreeSnapshot,
    initialGrantPending: boolean
  ): Promise<void> {
    await this.withOwnershipLock(async () => {
      this.assertRegistryUsable()
      assertOwnerThreadId(ownerThreadId)
      const existing = this.ownershipProofs.get(snapshot.root)
      if (existing && existing.ownerThreadId !== ownerThreadId) {
        this.ownedRoots.delete(snapshot.root)
        throw new Error(
          `managed worktree root 已属于另一个 Thread：${existing.ownerThreadId}`
        )
      }
      const otherRoot = [...this.ownershipProofs.values()].find(
        proof => proof.ownerThreadId === ownerThreadId && proof.root !== snapshot.root
      )
      if (otherRoot) {
        throw new Error(`Thread 已绑定另一个 managed worktree：${ownerThreadId}`)
      }
      const proof = proofFromSnapshot(
        ownerThreadId,
        snapshot,
        initialGrantPending
      )
      const next = new Map(this.ownershipProofs)
      next.set(snapshot.root, proof)
      await this.persistProofMap(next)
      this.ownershipProofs.set(snapshot.root, proof)
      this.ownedRoots.set(snapshot.root, { ownerThreadId, proof })
    })
  }

  private async replaceProof(
    expected: ManagedWorktreeOwnershipProof,
    replacement: ManagedWorktreeOwnershipProof
  ): Promise<void> {
    const current = this.ownershipProofs.get(expected.root)
    if (current !== expected) throw new Error('managed worktree ownership proof 已变化')
    const next = new Map(this.ownershipProofs)
    next.set(expected.root, replacement)
    await this.persistProofMap(next)
    this.ownershipProofs.set(expected.root, replacement)
  }

  private unregisterProofByRoot(
    ownerThreadId: string,
    root: string,
    expected: ManagedWorktreeOwnershipProof
  ): Promise<void> {
    return this.withOwnershipLock(() =>
      this.removeProofByRoot(ownerThreadId, root, expected)
    )
  }

  private async removeProofByRoot(
    ownerThreadId: string,
    root: string,
    expected: ManagedWorktreeOwnershipProof
  ): Promise<void> {
    const current = this.ownershipProofs.get(root)
    const owned = this.ownedRoots.get(root)
    if (current !== expected || current.ownerThreadId !== ownerThreadId ||
        owned?.ownerThreadId !== ownerThreadId || owned.proof !== expected) {
      throw new Error('拒绝注销不匹配 owner/root/proof 的 managed worktree')
    }
    const next = new Map(this.ownershipProofs)
    next.delete(root)
    this.ownershipProofs.delete(root)
    this.ownedRoots.delete(root)
    try {
      await this.persistProofMap(next)
    } catch (error) {
      this.registryError = asError(error)
      this.ownedRoots.clear()
      throw error
    }
  }

  private async loadRegistry(): Promise<ManagedWorktreeOwnershipRegistry> {
    const path = this.hooks.registryPath
    if (!path) return { version: 1, entries: [] }
    const maxBytes = this.hooks.maxRegistryBytes ?? MAX_OWNERSHIP_REGISTRY_BYTES
    let serialized: string
    try {
      serialized = await readBoundedRegularFile(path, maxBytes)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: [] }
      }
      throw error
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      throw new Error('managed worktree ownership registry 过大')
    }
    let value: unknown
    try {
      value = JSON.parse(serialized) as unknown
    } catch (error) {
      throw new Error('managed worktree ownership registry 不是合法 JSON', { cause: error })
    }
    return parseOwnershipRegistry(
      value,
      this.hooks.maxRegistryEntries ?? MAX_OWNERSHIP_REGISTRY_ENTRIES
    )
  }

  private async persistProofMap(
    proofs: ReadonlyMap<string, ManagedWorktreeOwnershipProof>
  ): Promise<void> {
    const path = this.hooks.registryPath
    if (!path) return
    const entries = [...proofs.values()].sort((left, right) =>
      left.root.localeCompare(right.root) || left.ownerThreadId.localeCompare(right.ownerThreadId)
    )
    const maxEntries = this.hooks.maxRegistryEntries ?? MAX_OWNERSHIP_REGISTRY_ENTRIES
    if (entries.length > maxEntries) {
      throw new Error('managed worktree ownership registry entries 超过安全上限')
    }
    const serialized = JSON.stringify({ version: 1, entries })
    const maxBytes = this.hooks.maxRegistryBytes ?? MAX_OWNERSHIP_REGISTRY_BYTES
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
      throw new Error('managed worktree ownership registry 超过安全上限')
    }
    await this.hooks.beforeRegistryPersist?.(serialized)
    await writePrivateFileAtomically(path, serialized)
  }

  private assertRegistryUsable(): void {
    if (!this.registryLoaded) {
      throw new Error('managed worktree ownership registry 尚未初始化')
    }
    if (this.registryError) {
      throw new Error(`managed worktree ownership registry 不可用：${this.registryError.message}`)
    }
  }

  private withOwnershipLock<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.ownershipQueue.then(operation)
    this.ownershipQueue = result.then(() => undefined, () => undefined)
    return result
  }
}

/**
 * Resolves and verifies the immutable identity of an OpenAgent-managed linked
 * worktree. This is deliberately stricter than "same repository": a detached
 * user worktree elsewhere in the repository is not an authorized target.
 */
export async function inspectManagedWorktree(
  worktree: AgentWorktree,
  expectedHeadOid?: string,
  expectedSnapshot?: ManagedWorktreeSnapshot,
  signal?: AbortSignal
): Promise<ManagedWorktreeSnapshot> {
  throwIfAborted(signal)
  if (worktree.native || !worktree.cwd) {
    throw new Error('受控 Git 操作仅支持 OpenAgent 管理的 non-native worktree')
  }
  const executionCwd = await realpath(worktree.cwd)
  const [base, existing] = await Promise.all([
    repositoryContext(worktree.baseCwd, signal),
    repositoryContext(executionCwd, signal)
  ])
  throwIfAborted(signal)
  if (base.commonDirectory !== existing.commonDirectory || base.root === existing.root) {
    throw new Error('worktree 与原仓库不匹配或指向了主工作树')
  }

  const stagingRootMetadata = await lstat(base.worktreesRoot)
  assertPrivateStagingRoot(base.worktreesRoot, stagingRootMetadata)
  const stagingRoot = await realpath(base.worktreesRoot)
  if (dirname(existing.root) !== stagingRoot) {
    throw new Error('worktree 不在 OpenAgent 私有 staging 根目录中')
  }
  const relativeExecutionCwd = relative(existing.root, executionCwd)
  if (
    relativeExecutionCwd === '..' ||
    relativeExecutionCwd.startsWith(`..${sep}`)
  ) {
    throw new Error('worktree execution cwd 越出了隔离工作树')
  }

  const rootMetadata = await lstat(existing.root)
  const identity = directoryIdentity(existing.root, rootMetadata)
  const headName = await git(
    existing.root,
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    signal
  )
  if (headName !== 'HEAD') throw new Error(`worktree 不再 detached：${headName}`)
  await assertRegisteredWorktree(base.root, existing.root, signal)

  const headOid = await git(
    existing.root,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    signal
  )
  if (expectedHeadOid && headOid !== expectedHeadOid) {
    throw new Error(`worktree HEAD 已变化（expected ${expectedHeadOid}, actual ${headOid}）`)
  }

  const gitDirectoryValue = await git(existing.root, ['rev-parse', '--git-dir'], signal)
  const gitDirectory = await realpath(resolve(existing.root, gitDirectoryValue))
  const commonWorktreesDirectory = await realpath(join(existing.commonDirectory, 'worktrees'))
  if (dirname(gitDirectory) !== commonWorktreesDirectory) {
    throw new Error('worktree gitdir 不在共享仓库的 worktrees metadata 中')
  }

  const dotGitPath = join(existing.root, '.git')
  const pointer = await readBoundedRegularFile(dotGitPath, MAX_GIT_POINTER_BYTES)
  const pointerMatch = /^gitdir:\s*(.+)\s*$/i.exec(pointer.trim())
  if (!pointerMatch) throw new Error('linked worktree 的 .git pointer 无效')
  const pointerTarget = await realpath(resolve(existing.root, pointerMatch[1]))
  if (pointerTarget !== gitDirectory) throw new Error('linked worktree 的 .git pointer 与 gitdir 不匹配')

  const backlink = (
    await readBoundedRegularFile(join(gitDirectory, 'gitdir'), MAX_GIT_POINTER_BYTES)
  ).trim()
  if (resolve(gitDirectory, backlink) !== dotGitPath) {
    throw new Error('linked worktree gitdir 的 backlink 与工作树不匹配')
  }

  const objectDirectory = await realpath(join(existing.commonDirectory, 'objects'))
  const packedRefsLock = join(existing.commonDirectory, 'packed-refs.lock')
  if (dirname(packedRefsLock) !== existing.commonDirectory ||
      basename(packedRefsLock) !== 'packed-refs.lock') {
    throw new Error('packed-refs.lock 不在已验证的 common git directory 中')
  }
  // A pre-existing lock means another writer owns the repository mutation
  // boundary (or an attacker staged a path). Never grant it to a Plugin.
  if (await lstatIfExists(packedRefsLock)) {
    throw new Error('packed-refs.lock 已存在，拒绝 managed workspace-write grant')
  }

  const [
    executionCwdMetadata,
    baseRootMetadata,
    commonDirectoryMetadata,
    gitDirectoryMetadata,
    objectDirectoryMetadata
  ] =
    await Promise.all([
      lstat(executionCwd),
      lstat(base.root),
      lstat(existing.commonDirectory),
      lstat(gitDirectory),
      lstat(objectDirectory)
    ])
  const executionCwdIdentity = directoryIdentity(executionCwd, executionCwdMetadata)
  const baseRootIdentity = directoryIdentity(base.root, baseRootMetadata)
  const stagingRootIdentity = directoryIdentity(stagingRoot, stagingRootMetadata)
  const commonDirectoryIdentity = directoryIdentity(
    existing.commonDirectory,
    commonDirectoryMetadata
  )
  const gitDirectoryIdentity = directoryIdentity(gitDirectory, gitDirectoryMetadata)
  const objectDirectoryIdentity = directoryIdentity(objectDirectory, objectDirectoryMetadata)
  const snapshot: ManagedWorktreeSnapshot = {
    root: existing.root,
    executionCwd,
    baseRoot: base.root,
    stagingRoot,
    commonDirectory: existing.commonDirectory,
    gitDirectory,
    objectDirectory,
    packedRefsLock,
    headOid,
    identity,
    executionCwdIdentity,
    baseRootIdentity,
    stagingRootIdentity,
    commonDirectoryIdentity,
    gitDirectoryIdentity,
    objectDirectoryIdentity,
    repositoryIdentity: repositoryIdentity([
      [base.root, baseRootIdentity],
      [stagingRoot, stagingRootIdentity],
      [existing.commonDirectory, commonDirectoryIdentity],
      [gitDirectory, gitDirectoryIdentity],
      [objectDirectory, objectDirectoryIdentity]
    ])
  }
  if (expectedSnapshot && !sameSnapshotIdentity(snapshot, expectedSnapshot)) {
    throw new Error('worktree identity 已变化，拒绝继续受控 Git 操作')
  }
  return snapshot
}

async function assertHeadDirectoryPath(repositoryRoot: string, subdirectory: string): Promise<void> {
  const segments = subdirectory.split(sep).filter(Boolean)
  let gitPath = ''
  for (const segment of segments) {
    gitPath = gitPath ? `${gitPath}/${segment}` : segment
    const entryType = await git(repositoryRoot, ['cat-file', '-t', `HEAD:${gitPath}`])
      .catch(() => '')
    if (!entryType) return
    if (entryType !== 'tree') {
      throw new Error('所选工作目录在 HEAD 中的路径包含非目录项，无法创建 worktree')
    }
  }
}

async function ensureFilesystemDirectoryPath(
  root: string,
  target: string,
  rootIdentity: DirectoryIdentity
): Promise<void> {
  const subdirectory = relative(root, target)
  let current = root
  for (const segment of subdirectory.split(sep).filter(Boolean)) {
    await assertDirectoryIdentity(root, rootIdentity)
    current = join(current, segment)
    let metadata = await lstatIfExists(current)
    if (!metadata) {
      try {
        await mkdir(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      metadata = await lstatIfExists(current)
    }
    if (!metadata) throw new Error('worktree 工作目录创建后不可访问')
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error('worktree 工作目录路径包含符号链接或非目录项')
    }
    const canonicalCurrent = await realpath(current)
    const relativeCurrent = relative(root, canonicalCurrent)
    if (relativeCurrent === '..' || relativeCurrent.startsWith(`..${sep}`)) {
      throw new Error('worktree 工作目录解析到了隔离目录之外')
    }
  }
}

async function cleanupWorktreeAttempt(
  repositoryRoot: string,
  worktreeRoot: string,
  identity: DirectoryIdentity,
  hooks: WorktreeManagerHooks
): Promise<void> {
  const cleanupErrors: unknown[] = []
  let ownedPathPresent = false
  let ownershipVerified = false
  let pathKnownAbsent = false
  try {
    const current = await lstatIfExists(worktreeRoot)
    if (current) {
      assertMatchingDirectoryIdentity(worktreeRoot, current, identity)
      ownedPathPresent = true
      ownershipVerified = true
    } else {
      pathKnownAbsent = true
    }
  } catch (error) {
    cleanupErrors.push(error)
  }

  let registered = false
  try {
    registered = await isRegisteredWorktree(repositoryRoot, worktreeRoot)
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (registered && (ownershipVerified || pathKnownAbsent)) {
    try {
      if (ownedPathPresent) {
        const status = await git(worktreeRoot, [
          'status', '--porcelain', '--untracked-files=all', '--ignored=matching'
        ])
        if (status.length > 0) {
          cleanupErrors.push(new Error(
            `worktree 含未知、修改或忽略内容，已保留目录：${worktreeRoot}`
          ))
        }
        await assertDirectoryIdentity(worktreeRoot, identity)
      }
    } catch (error) {
      cleanupErrors.push(error)
    }

    try {
      await hooks.beforeCleanupStage?.('worktree-remove', worktreeRoot)
      if (ownedPathPresent) {
        // This second observation improves the residual report for a writer
        // that lands in the former check-to-remove window. It is deliberately
        // not used to authorize deletion: no sequence of pathname checks can
        // make Git's recursive worktree removal atomic with respect to a
        // concurrent writer.
        const status = await git(worktreeRoot, [
          'status', '--porcelain', '--untracked-files=all', '--ignored=matching'
        ])
        if (status.length > 0) {
          cleanupErrors.push(new Error(
            `worktree 清理期间出现未知、修改或忽略内容，已保留目录：${worktreeRoot}`
          ))
        }
        await assertDirectoryIdentity(worktreeRoot, identity)
      }
    } catch (error) {
      cleanupErrors.push(error)
    }

    cleanupErrors.push(new Error(
      `已注册 worktree 无法原子安全删除，已保留目录与 Git metadata：${worktreeRoot}`
    ))
  }

  let currentMetadata: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    const observedMetadata = await lstatIfExists(worktreeRoot)
    if (observedMetadata) {
      assertMatchingDirectoryIdentity(worktreeRoot, observedMetadata, identity)
      currentMetadata = observedMetadata
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (currentMetadata && !registered) {
    try {
      await hooks.beforeCleanupStage?.('directory-remove', worktreeRoot)
      // rmdir is intentionally non-recursive. A concurrent sentinel, checkout
      // artifact, or any other unknown entry makes it fail without data loss.
      await rmdir(worktreeRoot)
      ownedPathPresent = false
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  try {
    const remaining = await lstatIfExists(worktreeRoot)
    if (remaining) {
      const identityDetail = sameDirectoryIdentity(remaining, identity)
        ? '本次 staging 目录'
        : 'identity 已变化的路径'
      cleanupErrors.push(new Error(`worktree 路径清理后仍存在（${identityDetail}）：${worktreeRoot}`))
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    if (await isRegisteredWorktree(repositoryRoot, worktreeRoot)) {
      cleanupErrors.push(new Error(`worktree metadata 清理后仍存在：${worktreeRoot}`))
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length) {
    throw new Error(cleanupErrors.map(errorMessage).join('；'))
  }
}

async function createPrivateStagingDirectory(
  worktreesRoot: string,
  directoryName: string
): Promise<string> {
  const parent = dirname(worktreesRoot)
  const parentRealpath = await realpath(parent)
  let rootMetadata = await lstatIfExists(worktreesRoot)
  if (rootMetadata) {
    assertPrivateStagingRoot(worktreesRoot, rootMetadata)
  } else {
    await mkdir(worktreesRoot, { mode: 0o700 })
    rootMetadata = await lstat(worktreesRoot)
    assertPrivateStagingRoot(worktreesRoot, rootMetadata)
  }
  const parentIdentity = directoryIdentity(worktreesRoot, rootMetadata)
  const canonicalRoot = await realpath(worktreesRoot)
  if (dirname(canonicalRoot) !== parentRealpath) {
    throw new Error(`worktree staging 父路径解析到了预期目录之外：${worktreesRoot}`)
  }
  await assertDirectoryIdentity(worktreesRoot, parentIdentity)

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const root = join(canonicalRoot, `${directoryName}-${randomUUID()}`)
    let created = false
    try {
      await assertDirectoryIdentity(worktreesRoot, parentIdentity)
      await mkdir(root, { mode: 0o700 })
      created = true
      await assertDirectoryIdentity(worktreesRoot, parentIdentity)
      const canonicalStaging = await realpath(root)
      if (canonicalStaging !== root || dirname(canonicalStaging) !== canonicalRoot) {
        throw new Error(`worktree staging 路径解析到了私有目录之外：${root}`)
      }
      return canonicalStaging
    } catch (error) {
      if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') continue
      if (created) {
        try {
          await rmdir(root)
        } catch (cleanupError) {
          throw combineErrors(error, cleanupError, 'staging 目录回滚失败，已保留现场')
        }
      }
      throw error
    }
  }
  throw new Error('无法创建唯一的 worktree staging 目录')
}

async function requiredDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const metadata = await lstat(path)
  return directoryIdentity(path, metadata)
}

function directoryIdentity(
  path: string,
  metadata: Awaited<ReturnType<typeof lstat>>
): DirectoryIdentity {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`worktree staging 路径不是实体目录：${path}`)
  }
  return {
    dev: String(metadata.dev),
    ino: String(metadata.ino),
    birthtimeMs: String(metadata.birthtimeMs)
  }
}

async function assertDirectoryIdentity(path: string, expected: DirectoryIdentity): Promise<void> {
  const metadata = await lstatIfExists(path)
  if (!metadata) throw new Error(`worktree staging 路径已消失：${path}`)
  assertMatchingDirectoryIdentity(path, metadata, expected)
}

function assertMatchingDirectoryIdentity(
  path: string,
  metadata: Awaited<ReturnType<typeof lstat>>,
  expected: DirectoryIdentity
): void {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !sameDirectoryIdentity(metadata, expected)
  ) {
    throw new Error(`worktree staging 路径 identity 已变化，已保留现场：${path}`)
  }
}

function assertPrivateStagingRoot(
  path: string,
  metadata: Awaited<ReturnType<typeof lstat>>
): void {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`worktree staging 父路径不是可信目录：${path}`)
  }
  if (process.platform !== 'win32') {
    const currentUid = process.getuid?.()
    if (currentUid !== undefined && metadata.uid !== currentUid) {
      throw new Error(`worktree staging 父路径不属于当前用户：${path}`)
    }
    if ((Number(metadata.mode) & 0o077) !== 0) {
      throw new Error(`worktree staging 父路径不是 owner-only：${path}`)
    }
  }
}

function sameDirectoryIdentity(
  metadata: Awaited<ReturnType<typeof lstat>>,
  expected: DirectoryIdentity
): boolean {
  return String(metadata.dev) === expected.dev &&
    String(metadata.ino) === expected.ino &&
    String(metadata.birthtimeMs) === expected.birthtimeMs
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
}

function repositoryIdentity(
  directories: readonly (readonly [string, DirectoryIdentity])[]
): string {
  return JSON.stringify(directories.map(([path, identity]) => [
    path,
    String(identity.dev),
    String(identity.ino),
    String(identity.birthtimeMs)
  ]))
}

function proofFromSnapshot(
  ownerThreadId: string,
  snapshot: ManagedWorktreeSnapshot,
  initialGrantPending: boolean
): ManagedWorktreeOwnershipProof {
  return {
    ownerThreadId,
    root: snapshot.root,
    executionCwd: snapshot.executionCwd,
    baseRoot: snapshot.baseRoot,
    stagingRoot: snapshot.stagingRoot,
    commonDirectory: snapshot.commonDirectory,
    gitDirectory: snapshot.gitDirectory,
    objectDirectory: snapshot.objectDirectory,
    packedRefsLock: snapshot.packedRefsLock,
    identity: snapshot.identity,
    baseRootIdentity: snapshot.baseRootIdentity,
    stagingRootIdentity: snapshot.stagingRootIdentity,
    commonDirectoryIdentity: snapshot.commonDirectoryIdentity,
    gitDirectoryIdentity: snapshot.gitDirectoryIdentity,
    objectDirectoryIdentity: snapshot.objectDirectoryIdentity,
    repositoryIdentity: snapshot.repositoryIdentity,
    creationHeadOid: snapshot.headOid,
    currentHeadOid: snapshot.headOid,
    initialGrantPending
  }
}

function assertSnapshotMatchesProof(
  snapshot: ManagedWorktreeSnapshot,
  proof: ManagedWorktreeOwnershipProof
): void {
  if (
    snapshot.root !== proof.root ||
    snapshot.executionCwd !== proof.executionCwd ||
    snapshot.baseRoot !== proof.baseRoot ||
    snapshot.stagingRoot !== proof.stagingRoot ||
    snapshot.commonDirectory !== proof.commonDirectory ||
    snapshot.gitDirectory !== proof.gitDirectory ||
    snapshot.objectDirectory !== proof.objectDirectory ||
    snapshot.packedRefsLock !== proof.packedRefsLock ||
    snapshot.repositoryIdentity !== proof.repositoryIdentity ||
    !sameIdentity(snapshot.identity, proof.identity) ||
    !sameIdentity(snapshot.baseRootIdentity, proof.baseRootIdentity) ||
    !sameIdentity(snapshot.stagingRootIdentity, proof.stagingRootIdentity) ||
    !sameIdentity(snapshot.commonDirectoryIdentity, proof.commonDirectoryIdentity) ||
    !sameIdentity(snapshot.gitDirectoryIdentity, proof.gitDirectoryIdentity) ||
    !sameIdentity(snapshot.objectDirectoryIdentity, proof.objectDirectoryIdentity)
  ) {
    throw new Error('worktree identity 与持久 Core ownership proof 不匹配')
  }
}

function sameSnapshotIdentity(
  left: ManagedWorktreeSnapshot,
  right: ManagedWorktreeSnapshot
): boolean {
  return left.root === right.root &&
    left.executionCwd === right.executionCwd &&
    left.baseRoot === right.baseRoot &&
    left.stagingRoot === right.stagingRoot &&
    left.commonDirectory === right.commonDirectory &&
    left.gitDirectory === right.gitDirectory &&
    left.objectDirectory === right.objectDirectory &&
    left.packedRefsLock === right.packedRefsLock &&
    left.repositoryIdentity === right.repositoryIdentity &&
    sameIdentity(left.identity, right.identity) &&
    sameIdentity(left.executionCwdIdentity, right.executionCwdIdentity) &&
    sameIdentity(left.baseRootIdentity, right.baseRootIdentity) &&
    sameIdentity(left.stagingRootIdentity, right.stagingRootIdentity) &&
    sameIdentity(left.commonDirectoryIdentity, right.commonDirectoryIdentity) &&
    sameIdentity(left.gitDirectoryIdentity, right.gitDirectoryIdentity) &&
    sameIdentity(left.objectDirectoryIdentity, right.objectDirectoryIdentity)
}

function parseOwnershipRegistry(
  value: unknown,
  maxEntries: number
): ManagedWorktreeOwnershipRegistry {
  const record = strictObject(value, ['version', 'entries'], 'ownership registry')
  if (record.version !== 1 || !Array.isArray(record.entries)) {
    throw new Error('managed worktree ownership registry 不符合当前 v1 格式')
  }
  if (record.entries.length > maxEntries) {
    throw new Error('managed worktree ownership registry entries 过多')
  }
  return {
    version: 1,
    entries: record.entries.map((entry, index) => parseOwnershipProof(entry, index))
  }
}

function parseOwnershipProof(value: unknown, index: number): ManagedWorktreeOwnershipProof {
  const label = `ownership proof[${index}]`
  const record = strictObject(value, [
    'ownerThreadId',
    'root',
    'executionCwd',
    'baseRoot',
    'stagingRoot',
    'commonDirectory',
    'gitDirectory',
    'objectDirectory',
    'packedRefsLock',
    'identity',
    'baseRootIdentity',
    'stagingRootIdentity',
    'commonDirectoryIdentity',
    'gitDirectoryIdentity',
    'objectDirectoryIdentity',
    'repositoryIdentity',
    'creationHeadOid',
    'currentHeadOid',
    'initialGrantPending'
  ], label)
  const ownerThreadId = requiredRegistryString(record.ownerThreadId, `${label}.ownerThreadId`, 128)
  assertOwnerThreadId(ownerThreadId)
  if (typeof record.initialGrantPending !== 'boolean') {
    throw new Error(`${label}.initialGrantPending 必须是 boolean`)
  }
  const proof = {
    ownerThreadId,
    root: requiredAbsolutePath(record.root, `${label}.root`),
    executionCwd: requiredAbsolutePath(record.executionCwd, `${label}.executionCwd`),
    baseRoot: requiredAbsolutePath(record.baseRoot, `${label}.baseRoot`),
    stagingRoot: requiredAbsolutePath(record.stagingRoot, `${label}.stagingRoot`),
    commonDirectory: requiredAbsolutePath(
      record.commonDirectory,
      `${label}.commonDirectory`
    ),
    gitDirectory: requiredAbsolutePath(record.gitDirectory, `${label}.gitDirectory`),
    objectDirectory: requiredAbsolutePath(
      record.objectDirectory,
      `${label}.objectDirectory`
    ),
    packedRefsLock: requiredAbsolutePath(
      record.packedRefsLock,
      `${label}.packedRefsLock`
    ),
    identity: parseDirectoryIdentity(record.identity, `${label}.identity`),
    baseRootIdentity: parseDirectoryIdentity(
      record.baseRootIdentity,
      `${label}.baseRootIdentity`
    ),
    stagingRootIdentity: parseDirectoryIdentity(
      record.stagingRootIdentity,
      `${label}.stagingRootIdentity`
    ),
    commonDirectoryIdentity: parseDirectoryIdentity(
      record.commonDirectoryIdentity,
      `${label}.commonDirectoryIdentity`
    ),
    gitDirectoryIdentity: parseDirectoryIdentity(
      record.gitDirectoryIdentity,
      `${label}.gitDirectoryIdentity`
    ),
    objectDirectoryIdentity: parseDirectoryIdentity(
      record.objectDirectoryIdentity,
      `${label}.objectDirectoryIdentity`
    ),
    repositoryIdentity: requiredRegistryString(
      record.repositoryIdentity,
      `${label}.repositoryIdentity`,
      32 * 1024
    ),
    creationHeadOid: requiredOid(record.creationHeadOid, `${label}.creationHeadOid`),
    currentHeadOid: requiredOid(record.currentHeadOid, `${label}.currentHeadOid`),
    initialGrantPending: record.initialGrantPending
  }
  if (!isWithin(proof.root, proof.executionCwd)) {
    throw new Error(`${label}.executionCwd 越出 root`)
  }
  if (dirname(proof.root) !== proof.stagingRoot) {
    throw new Error(`${label}.root 不在 stagingRoot`)
  }
  if (dirname(proof.packedRefsLock) !== proof.commonDirectory ||
      basename(proof.packedRefsLock) !== 'packed-refs.lock') {
    throw new Error(`${label}.packedRefsLock 无效`)
  }
  return proof
}

function parseDirectoryIdentity(value: unknown, label: string): DirectoryIdentity {
  const record = strictObject(value, ['dev', 'ino', 'birthtimeMs'], label)
  return {
    dev: requiredIdentityPart(record.dev, `${label}.dev`),
    ino: requiredIdentityPart(record.ino, `${label}.ino`),
    birthtimeMs: requiredIdentityPart(record.birthtimeMs, `${label}.birthtimeMs`)
  }
}

function strictObject(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 object`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} 字段不符合当前格式`)
  }
  return record
}

function requiredRegistryString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) {
    throw new Error(`${label} 无效`)
  }
  return value
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const path = requiredRegistryString(value, label, 16 * 1024)
  if (resolve(path) !== path) throw new Error(`${label} 必须是 absolute canonical path`)
  return path
}

function requiredIdentityPart(value: unknown, label: string): string {
  const part = requiredRegistryString(value, label, 128)
  if (!/^\d+(?:\.\d+)?$/.test(part)) throw new Error(`${label} 无效`)
  return part
}

function requiredOid(value: unknown, label: string): string {
  const oid = requiredRegistryString(value, label, 128)
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) throw new Error(`${label} 无效`)
  return oid
}

function assertOwnerThreadId(value: string): void {
  if (!value || value !== value.trim() || value.length > 128 ||
      value.includes('\0') || /\s/.test(value)) {
    throw new Error('managed worktree ownerThreadId 无效')
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function isWithin(root: string, candidate: string): boolean {
  const subpath = relative(root, candidate)
  return subpath !== '..' && !subpath.startsWith(`..${sep}`)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted()
}

async function isRegisteredWorktree(
  repositoryRoot: string,
  worktreeRoot: string,
  signal?: AbortSignal
): Promise<boolean> {
  const expected = resolve(worktreeRoot)
  const entries = await git(
    repositoryRoot,
    ['worktree', 'list', '--porcelain', '-z'],
    signal
  )
  return entries
    .split('\0')
    .some((entry) => entry.startsWith('worktree ') && resolve(entry.slice('worktree '.length)) === expected)
}

async function assertRegisteredWorktree(
  repositoryRoot: string,
  worktreeRoot: string,
  signal?: AbortSignal
): Promise<void> {
  if (!(await isRegisteredWorktree(repositoryRoot, worktreeRoot, signal))) {
    throw new Error(`Git worktree metadata 未绑定 staging 路径：${worktreeRoot}`)
  }
}

async function assertDetachedWorktreeHead(worktreeRoot: string, expectedOid: string): Promise<void> {
  const headName = await git(worktreeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (headName !== 'HEAD') {
    throw new Error(`worktree checkout 未处于 detached HEAD：${headName}`)
  }
  const headOid = await git(worktreeRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (headOid !== expectedOid) {
    throw new Error(`worktree checkout OID 不匹配（expected ${expectedOid}, actual ${headOid}）`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function combineErrors(originalError: unknown, cleanupError: unknown, label: string): Error {
  return new Error(`${errorMessage(originalError)}；${label}：${errorMessage(cleanupError)}`, {
    cause: originalError
  })
}

interface RepositoryContext {
  root: string
  commonDirectory: string
  worktreesRoot: string
}

async function worktreeBaseContext(
  cwd: string
): Promise<{ canonicalCwd: string; repository: RepositoryContext }> {
  const canonicalCwd = await realpath(cwd)
  const repository = await repositoryContext(canonicalCwd)
  await git(repository.root, ['rev-parse', '--verify', 'HEAD'])
  return { canonicalCwd, repository }
}

async function requiredWorktreeBaseContext(
  cwd: string
): ReturnType<typeof worktreeBaseContext> {
  return worktreeBaseContext(cwd).catch(() => {
    throw new Error('worktree 模式要求工作目录位于至少包含一次提交的 Git 仓库中')
  })
}

async function repositoryContext(
  cwd: string,
  signal?: AbortSignal
): Promise<RepositoryContext> {
  const root = await realpath(await git(cwd, ['rev-parse', '--show-toplevel'], signal))
  const commonDirectoryValue = await git(root, ['rev-parse', '--git-common-dir'], signal)
  const commonDirectory = await realpath(resolve(root, commonDirectoryValue))
  const worktreeList = await git(
    root,
    ['worktree', 'list', '--porcelain', '-z'],
    signal
  )
  const mainWorktreeEntry = worktreeList
    .split('\0')
    .find((entry) => entry.startsWith('worktree '))
  if (!mainWorktreeEntry) throw new Error('无法解析 Git 主工作区')
  const listedMainWorktree = await realpath(mainWorktreeEntry.slice('worktree '.length))
  // Absorbed submodules can report their common Git directory as the first
  // `worktree list` entry. Only trust the entry when it is itself a checkout
  // root; otherwise keep worktree files beside the selected checkout.
  const listedTopLevel = await git(
    listedMainWorktree,
    ['rev-parse', '--show-toplevel'],
    signal
  )
    .then((path) => realpath(path))
    .catch(() => undefined)
  const mainWorktreeRoot = listedTopLevel === listedMainWorktree
    ? listedMainWorktree
    : root
  const superprojectRoot = await topmostSuperprojectRoot(root, signal)
  const worktreesRoot = superprojectRoot
    ? join(
        dirname(superprojectRoot),
        `.${basename(superprojectRoot)}-${slug(relative(superprojectRoot, root))}-openagent-worktrees`
      )
    : join(
        dirname(mainWorktreeRoot),
        `.${basename(mainWorktreeRoot)}-openagent-worktrees`
      )
  return { root, commonDirectory, worktreesRoot }
}

async function topmostSuperprojectRoot(
  cwd: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  let current = cwd
  let topmost: string | undefined
  for (let depth = 0; depth < 32; depth += 1) {
    const value = await git(
      current,
      ['rev-parse', '--show-superproject-working-tree'],
      signal
    )
      .catch(() => '')
    if (!value) break
    const parent = await realpath(value).catch(() => undefined)
    if (!parent || parent === current) break
    topmost = parent
    current = parent
  }
  return topmost
}

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task'
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<string> {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) {
    throw new Error(`受限 metadata 文件不是有限 regular file：${path}`)
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number'
    ? fsConstants.O_NOFOLLOW
    : 0
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | noFollow
  )
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > maxBytes ||
        String(metadata.dev) !== String(before.dev) ||
        String(metadata.ino) !== String(before.ino) ||
        String(metadata.birthtimeMs) !== String(before.birthtimeMs)) {
      throw new Error(`受限 metadata 文件不是有限 regular file：${path}`)
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      )
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const after = await handle.stat()
    if (bytesRead > maxBytes || after.size > maxBytes ||
        String(after.dev) !== String(before.dev) ||
        String(after.ino) !== String(before.ino) ||
        String(after.birthtimeMs) !== String(before.birthtimeMs)) {
      throw new Error(`受限 metadata 文件超过安全上限：${path}`)
    }
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
    throw error
  }
}
