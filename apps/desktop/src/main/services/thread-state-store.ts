import {
  parseOpenAgentState,
  reduceOpenAgentState,
  type OpenAgentState,
  type OpenAgentStateMutation
} from '../../shared/openagent-state'
import { SqliteStatePersistence, type SqliteStatePersistenceOptions } from './sqlite-state-persistence'

const DEFAULT_PERSIST_DEBOUNCE_MS = 750
const DEFAULT_PERSIST_MAX_WAIT_MS = 5_000

type CoalescibleMutation = Extract<
  OpenAgentStateMutation,
  { readonly type: 'replace-thread-session-state' }
>

export interface ThreadStateStoreOptions extends SqliteStatePersistenceOptions {
  readonly persistenceDebounceMs?: number
  readonly persistenceMaxWaitMs?: number
  readonly onBackgroundPersistenceError?: (error: unknown) => void
}

/**
 * Authoritative mutation boundary with independently persisted entity scopes.
 * Reads only the current v6 SQLite namespace; older formats are neither read nor migrated.
 */
export class ThreadStateStore {
  readonly statePath: string
  private closeOperation?: Promise<void>
  private state: OpenAgentState | undefined
  private stateVersion = 0
  private readonly threadVersions = new Map<string, number>()
  private readonly dirtyThreads = new Set<string>()
  private readonly commands = new ScopedCommands()
  private stateQueue: Promise<void> = Promise.resolve()
  private readonly persistence: SqliteStatePersistence
  private persistenceTimer: NodeJS.Timeout | undefined
  private persistenceDeadlineTimer: NodeJS.Timeout | undefined
  private readonly persistenceDebounceMs: number
  private readonly persistenceMaxWaitMs: number
  private readonly onBackgroundPersistenceError: (error: unknown) => void

  constructor(userDataPath: string, options: ThreadStateStoreOptions = {}) {
    this.persistence = new SqliteStatePersistence(userDataPath, options)
    this.statePath = this.persistence.statePath
    this.persistenceDebounceMs = validDelay(options.persistenceDebounceMs, DEFAULT_PERSIST_DEBOUNCE_MS, 'persistenceDebounceMs')
    this.persistenceMaxWaitMs = validDelay(options.persistenceMaxWaitMs, DEFAULT_PERSIST_MAX_WAIT_MS, 'persistenceMaxWaitMs')
    this.onBackgroundPersistenceError = options.onBackgroundPersistenceError ?? (error => {
      console.error('Failed to persist OpenAgent state', error)
    })
  }

  async load(): Promise<OpenAgentState | null> {
    if (this.state) return this.state
    const state = await this.persistence.load()
    if (state) {
      this.state = state
      this.stateVersion = 1
      for (const thread of state.threads) this.threadVersions.set(thread.id, 1)
    }
    return state
  }

  /** Explicit full replacement; all changed entities publish atomically. */
  save(value: OpenAgentState): Promise<OpenAgentState> {
    if (this.closeOperation) return Promise.reject(new Error("ThreadStateStore 已关闭"))
    let parsed: OpenAgentState | null
    try { parsed = parseOpenAgentState(value) } catch (error) { return Promise.reject(error) }
    if (!parsed) return Promise.reject(new Error('无法保存无效的 OpenAgent 状态'))
    return this.commands.exclusive(async () => {
      this.clearPersistenceTimers()
      const version = ++this.stateVersion
      try {
        await this.persistence.persist(parsed!, version)
      } catch (error) {
        this.scheduleAuthoritativePersistenceIfDirty()
        throw error
      }
      this.state = parsed!
      this.threadVersions.clear()
      for (const thread of parsed!.threads) this.threadVersions.set(thread.id, version)
      this.dirtyThreads.clear()
      return parsed!
    })
  }

  read(): OpenAgentState {
    if (!this.state) throw new Error('ThreadStateStore 尚未加载或初始化')
    return this.state
  }

  /** Guards and authority changes remain serialized; durable commands publish
   * only after their changed records and SQLite transaction commits. */
  commit(
    mutation: OpenAgentStateMutation,
    /** Synchronous caller-owned precondition, evaluated while affected scopes are locked. */
    assertCurrent?: (state: OpenAgentState) => void
  ): Promise<OpenAgentState> {
    if (this.closeOperation) return Promise.reject(new Error("ThreadStateStore 已关闭"))
    let snapshot: OpenAgentStateMutation
    try { snapshot = structuredClone(mutation) } catch (error) {
      return Promise.reject(new Error('OpenAgent state mutation 无法序列化', { cause: error }))
    }
    return this.commands.run(mutationScopes(snapshot), async () => {
      const prepared = await this.enqueueState(() => {
        const current = this.read()
        assertCurrent?.(current)
        const next = reduceOpenAgentState(current, snapshot)
        if (next === current) return { current, next, version: this.stateVersion, coalesced: true }
        const version = ++this.stateVersion
        if (isCoalescibleMutation(snapshot)) {
          this.persistence.validate(next, current)
          this.state = next
          this.threadVersions.set(snapshot.threadId, version)
          this.dirtyThreads.add(snapshot.threadId)
          this.schedulePersistence()
          return { current, next, version, coalesced: true }
        }
        return { current, next, version, coalesced: false }
      })
      if (prepared.coalesced) return prepared.next
      try {
        // This potentially large I/O holds only the command's affected scopes.
        // Unrelated threads continue committing and publishing observations.
        await this.persistence.persist(prepared.next, prepared.version, prepared.current)
      } catch (error) {
        this.scheduleAuthoritativePersistenceIfDirty()
        throw error
      }
      return this.enqueueState(() => {
        const current = this.read()
        // Scope locks preserve the mutation's guards. Replaying against current
        // authority retains changes made by independent commands during I/O.
        const next = reduceOpenAgentState(current, snapshot)
        this.persistence.adoptPublishedState(next, current, prepared.version)
        this.state = next
        const before = new Map(current.threads.map(thread => [thread.id, thread]))
        for (const thread of next.threads) {
          if (before.get(thread.id) !== thread) {
            this.threadVersions.set(thread.id, prepared.version)
            this.dirtyThreads.delete(thread.id)
          }
          before.delete(thread.id)
        }
        for (const id of before.keys()) {
          this.threadVersions.delete(id)
          this.dirtyThreads.delete(id)
        }
        if (this.dirtyThreads.size === 0) this.clearPersistenceTimers()
        return next
      })
    })
  }

  /**
   * Persist the current authoritative revision of one thread. Call after the
   * caller's mutations resolve. This deliberately does not drain unrelated
   * commands or staged report/background writes.
   */
  flushThread(threadId: string): Promise<void> {
    return this.commands.run([`thread:${threadId}`], async () => {
      const state = this.read()
      const version = this.threadVersions.get(threadId) ?? 0
      try {
        await this.persistence.persistThread(state, version, threadId)
      } catch {
        await this.persistence.persistThread(state, version, threadId)
      }
      if (this.threadVersions.get(threadId) === version) this.dirtyThreads.delete(threadId)
    })
  }

  /** Shutdown waits for admitted commands, all dirty entities and staged I/O. */
  flush(): Promise<void> {
    return this.commands.exclusive(async () => {
      this.clearPersistenceTimers()
      const version = ++this.stateVersion
      // Join older stages first so shutdown does not duplicate an already
      // staged snapshot. A failed stage is retried from current authority below.
      await this.persistence.drain().catch(() => undefined)
      try {
        await this.persistence.persist(this.read(), version)
        await this.persistence.drain()
      } catch {
        await this.persistence.persist(this.read(), version)
        await this.persistence.drain()
      }
      for (const thread of this.read().threads) this.threadVersions.set(thread.id, version)
      this.dirtyThreads.clear()
    })
  }

  drain(): Promise<void> { return this.flush() }

  /** Shutdown after mutation producers stop; always release owned workers. */
  close(): Promise<void> {
    return this.closeOperation ??= this.commands.exclusive(async () => {
      try {
        this.clearPersistenceTimers()
        await this.persistence.drain().catch(() => undefined)
        if (this.state) {
          const version = ++this.stateVersion
          try {
            await this.persistence.persist(this.state, version)
            await this.persistence.drain()
          } catch {
            await this.persistence.persist(this.state, version)
            await this.persistence.drain()
          }
        }
      } finally { await this.persistence.close() }
    })
  }

  private enqueueState<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const result = this.stateQueue.then(operation)
    this.stateQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private schedulePersistence(): void {
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer)
    this.persistenceTimer = setTimeout(() => {
      this.clearPersistenceTimers()
      void this.persistCurrentState().catch(error => this.reportBackgroundPersistenceError(error))
    }, this.persistenceDebounceMs)
    this.persistenceDeadlineTimer ??= setTimeout(() => {
      this.clearPersistenceTimers()
      void this.persistCurrentState().catch(error => this.reportBackgroundPersistenceError(error))
    }, this.persistenceMaxWaitMs)
  }

  private clearPersistenceTimers(): void {
    if (this.persistenceTimer) clearTimeout(this.persistenceTimer)
    if (this.persistenceDeadlineTimer) clearTimeout(this.persistenceDeadlineTimer)
    this.persistenceTimer = undefined
    this.persistenceDeadlineTimer = undefined
  }

  private scheduleAuthoritativePersistenceIfDirty(): void {
    if (this.dirtyThreads.size > 0) this.schedulePersistence()
  }

  private async persistCurrentState(): Promise<void> {
    const state = this.read()
    const results = await Promise.allSettled([...this.dirtyThreads].map(async threadId => {
      const version = this.threadVersions.get(threadId) ?? 0
      await this.persistence.persistThread(state, version, threadId)
      if (this.threadVersions.get(threadId) === version) this.dirtyThreads.delete(threadId)
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  private reportBackgroundPersistenceError(error: unknown): void {
    try { this.onBackgroundPersistenceError(error) } catch (reportingError) {
      console.error('Failed to report OpenAgent persistence error', reportingError)
    }
  }
}

function validDelay(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${name} 必须是非负有限数`)
  }
  return resolved
}

function isCoalescibleMutation(
  mutation: OpenAgentStateMutation
): mutation is CoalescibleMutation {
  if (mutation.type !== 'replace-thread-session-state') return false
  const status = mutation.observation.latestExecution?.status
  return status !== 'completed' && status !== 'failed' && status !== 'interrupted'
}

/** Read/write scopes for invariants evaluated by reduceOpenAgentState. */
function mutationScopes(mutation: OpenAgentStateMutation): string[] {
  switch (mutation.type) {
    case 'archive-report': return ['reports', ...new Set(
      mutation.relatedThreadIds.map(threadId => `thread:${threadId}`)
    )]
    case 'replace-reports': return ['reports', ...new Set(
      (mutation.relatedExecutionChecks ?? []).map(reference => `thread:${reference.threadId}`)
    )]
    case 'replace-settings': return ['settings']
    case 'replace-thread-settings':
      return mutation.bartAppliedSettings === undefined
        ? [`thread:${mutation.threadId}`]
        : ['settings', `thread:${mutation.threadId}`]
    case 'replace-tag-pool': return ['ui']
    case 'select-thread': return ['ui', 'catalog']
    case 'add-agent-thread': return ['catalog', `thread:${mutation.thread.id}`]
    case 'add-and-select-agent-thread':
      return ['catalog', 'ui', `thread:${mutation.sourceThreadId}`, `thread:${mutation.thread.id}`]
    case 'delete-agent-thread': return ['catalog', 'ui', `thread:${mutation.threadId}`]
    case 'replace-bart-thread':
      return ['catalog', 'ui', 'settings', `thread:${mutation.expectedThreadId}`, `thread:${mutation.threadId}`]
    default: return [`thread:${mutation.threadId}`]
  }
}

/** Same-scope commands serialize; exclusive save/shutdown fences every scope. */
class ScopedCommands {
  private barrier: Promise<void> = Promise.resolve()
  private readonly tails = new Map<string, Promise<void>>()
  private readonly pending = new Set<Promise<void>>()

  run<T>(scopes: string[], operation: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.barrier, ...scopes.map(scope => this.tails.get(scope))]).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    for (const scope of scopes) this.tails.set(scope, settled)
    this.pending.add(settled)
    void settled.then(() => {
      this.pending.delete(settled)
      for (const scope of scopes) if (this.tails.get(scope) === settled) this.tails.delete(scope)
    })
    return result
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.barrier, ...this.pending]).then(operation)
    this.barrier = result.then(() => undefined, () => undefined)
    return result
  }
}
