import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { OpenAgentState } from '../../shared/openagent-state'
import { parseOpenAgentState } from '../../shared/openagent-state'
import type { ReportThreadRecord } from '../../shared/report-thread'
import workerSource from './sqlite-state-worker.cjs?raw'

type Parts = Map<string, unknown>
type Fault = 'statement' | 'before-commit' | 'after-commit'
interface EncodedPart { key: string; body?: Uint8Array; html?: Uint8Array; order?: string[]; deleted?: boolean }
export interface SqliteStatePersistenceOptions {
  /** Test/diagnostic boundary, before content enters the preparation pool. */
  beforePrepare?: (key: string, value: unknown) => Promise<void>
  /** Test boundary before the accepted transaction, while publication is serialized. */
  beforeCommit?: (keys: readonly string[]) => Promise<void>
  /** Fault injection inside the actual SQLite transaction; absent in the application. */
  transactionFault?: () => Fault | undefined
  /** Test-only exit inside an admitted preparation worker request. */
  preparationFault?: () => 'exit' | undefined
  onTransaction?: (milliseconds: number) => void
}

/** Physical storage only. ThreadStateStore retains all application authority. */
export class SqliteStatePersistence {
  readonly statePath: string
  private readonly values: Parts = new Map()
  private readonly versions = new Map<string, number>()
  private readonly pending = new Set<Promise<void>>()
  private readonly pendingScopes = new Map<string, number>()
  private publicationQueue: Promise<void> = Promise.resolve()
  private readonly preparation: Array<{ client?: WorkerClient; tail: Promise<unknown> }> = [
    { tail: Promise.resolve() }, { tail: Promise.resolve() }
  ]
  private nextPreparer = 0
  private writer?: WorkerClient
  private fatal?: Error
  private closed = false
  private closing?: Promise<void>

  constructor(userDataPath: string, private readonly options: SqliteStatePersistenceOptions = {}) {
    this.statePath = join(userDataPath, 'openagent-state-v6', 'state.sqlite')
  }

  async load(): Promise<OpenAgentState | null> {
    this.assertOpen()
    const reader = new WorkerClient(this.statePath)
    try {
      const rows = await reader.request<Array<[string, unknown]> | null>('load')
      if (rows === null) return null
      const parts = new Map(rows)
      const threadOrder = parts.get('thread-order') as string[]
      const reportOrder = parts.get('report-order') as string[]
      const ui = parts.get('ui')
      if (!Array.isArray(threadOrder) || !Array.isArray(reportOrder) || !isRecord(ui) ||
          Object.keys(ui).length !== 2 || !Object.hasOwn(ui, 'tagPool') || !Object.hasOwn(ui, 'selectedThreadId') ||
          parts.size !== threadOrder.length + reportOrder.length + 4 ||
          !threadOrder.every(id => isRecord(parts.get(`thread:${id}`)) && (parts.get(`thread:${id}`) as { id: unknown }).id === id) ||
          !reportOrder.every(id => isRecord(parts.get(`report:${id}`)) && (parts.get(`report:${id}`) as { id: unknown }).id === id)) throw invalidState()
      const state = parseOpenAgentState({ threads: threadOrder.map(id => parts.get(`thread:${id}`)),
        reports: reportOrder.map(id => parts.get(`report:${id}`)), settings: parts.get('settings'), ...ui })
      if (!state) throw invalidState()
      for (const [key, value] of partition(state)) { this.values.set(key, value); this.versions.set(key, 1) }
      return state
    } catch (error) { throw new Error('OpenAgent 状态不符合当前格式', { cause: error }) }
    finally { await reader.close() }
  }

  validate(next: OpenAgentState, previous?: OpenAgentState): void {
    this.assertOpen()
    for (const [key, value] of this.changes(next, previous)) {
      if (value !== undefined && !(key === 'thread-order' || key === 'report-order')) serializePart(key, value)
    }
  }

  persist(state: OpenAgentState, version: number, previous?: OpenAgentState): Promise<void> {
    return this.persistParts(this.changes(state, previous), version)
  }

  persistThread(state: OpenAgentState, version: number, threadId: string): Promise<void> {
    const thread = state.threads.find(candidate => candidate.id === threadId)
    if (!thread) return Promise.reject(new Error(`Thread 不存在: ${threadId}`))
    return this.persistParts(new Map([[`thread:${threadId}`, thread]]), version)
  }

  adoptPublishedState(state: OpenAgentState, previous: OpenAgentState, version: number): void {
    for (const [key, value] of this.changes(state, previous)) {
      if (this.versions.get(key) !== version) continue
      if (value === undefined) this.values.delete(key)
      else this.values.set(key, value)
    }
  }

  async drain(): Promise<void> {
    const results = await Promise.allSettled([...this.pending])
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    if (this.fatal) throw this.fatal
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      try { await this.drain() }
      finally {
        const results = await Promise.allSettled([this.writer, ...this.preparation.map(slot => slot.client)]
          .filter((client): client is WorkerClient => !!client).map(client => client.close()))
        const failure = results.find(result => result.status === 'rejected')
        // 已知取舍：drain() 抛出时，这里的 throw 会顶替掉它的原始异常。只影响
        // 「drain 与关闭同时失败」这一支，正常路径由 sqlite-state-persistence.test.ts
        // 的 rejects.toThrow('worker exited') 覆盖；改错误语义需先补该分支的用例。
        // oxlint-disable-next-line eslint/no-unsafe-finally
        if (failure?.status === 'rejected') throw failure.reason
      }
    })()
    return this.closing
  }

  private assertOpen(): void {
    if (this.fatal) throw this.fatal
    if (this.closed) throw new Error('OpenAgent 状态仓库已关闭')
  }

  private changes(state: OpenAgentState, previous?: OpenAgentState): Parts {
    const next = partition(state)
    const before = previous ? partition(previous) : this.values
    const changes: Parts = new Map()
    for (const key of new Set([...before.keys(), ...next.keys(), ...(!previous ? this.pendingScopes.keys() : [])])) {
      if (!samePart(key, before.get(key), next.get(key)) || (!previous && this.pendingScopes.has(key))) changes.set(key, next.get(key))
    }
    return changes
  }

  private persistParts(changes: Parts, version: number): Promise<void> {
    try { this.assertOpen() } catch (error) { return Promise.reject(error) }
    for (const [key, value] of changes) {
      if ((this.versions.get(key) ?? 0) >= version ||
          (samePart(key, this.values.get(key), value) && !this.pendingScopes.has(key))) changes.delete(key)
    }
    if (changes.size === 0) return Promise.resolve()
    for (const key of changes.keys()) this.pendingScopes.set(key, (this.pendingScopes.get(key) ?? 0) + 1)
    const operation = this.prepareAndPublish(changes, version)
    this.pending.add(operation)
    const finished = () => {
      this.pending.delete(operation)
      for (const key of changes.keys()) {
        const remaining = (this.pendingScopes.get(key) ?? 1) - 1
        if (remaining === 0) this.pendingScopes.delete(key)
        else this.pendingScopes.set(key, remaining)
      }
    }
    void operation.then(finished, finished)
    return operation
  }

  private async preparePart(key: string, value: unknown): Promise<EncodedPart> {
    await this.options.beforePrepare?.(key, value)
    if (value === undefined) return { key, deleted: true }
    if ((key === 'thread-order' || key === 'report-order')) return { key, order: value as string[] }
    const slot = this.preparation[this.nextPreparer++ % this.preparation.length]
    const operation = slot.tail.then(async () => {
      slot.client ??= new WorkerClient(this.statePath, error => { this.fatal = error })
      const parts = await slot.client.request<EncodedPart[]>('prepare', { parts: [[key, value]], fault: this.options.preparationFault?.() })
      return parts[0]
    })
    slot.tail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async prepareAndPublish(changes: Parts, version: number): Promise<void> {
    const prepared = await Promise.allSettled([...changes].map(([key, value]) => this.preparePart(key, value)))
    const failure = prepared.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    const parts = prepared.map(result => (result as PromiseFulfilledResult<EncodedPart>).value)
    const publish = this.publicationQueue.then(async () => {
      if (this.fatal) throw this.fatal
      const accepted = parts.filter(part => (this.versions.get(part.key) ?? 0) < version)
      if (accepted.length === 0) return
      await this.options.beforeCommit?.(accepted.map(part => part.key))
      this.writer ??= new WorkerClient(this.statePath, error => { this.fatal = error })
      const result = await this.writer.request<{ transactionMs: number }>('commit', {
        parts: accepted, fault: this.options.transactionFault?.()
      }, accepted.flatMap(part => [part.body?.buffer, part.html?.buffer].filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)))
      for (const part of accepted) {
        this.versions.set(part.key, version)
        const value = changes.get(part.key)
        if (value === undefined) this.values.delete(part.key)
        else this.values.set(part.key, value)
      }
      // Observability callbacks cannot turn a successful COMMIT into failure.
      try { this.options.onTransaction?.(result.transactionMs) } catch { /* diagnostic only */ }
    })
    this.publicationQueue = publish.then(() => undefined, () => undefined)
    await publish
  }
}

class WorkerClient {
  private readonly worker: Worker
  private nextId = 0
  private failed?: Error
  private closing?: Promise<void>
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  constructor(path: string, private readonly onFailure?: (error: Error) => void) {
    this.worker = new Worker(workerSource, { eval: true, workerData: { path } })
    this.worker.on('message', message => {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error))
      else waiter.resolve(message.result)
      if (this.pending.size === 0) this.worker.unref()
    })
    this.worker.on('error', error => this.fail(error))
    this.worker.on('exit', code => {
      if (!this.closing || this.pending.size) this.fail(new Error(`SQLite worker exited (${code}); reopen required`))
    })
    this.worker.unref()
  }
  request<T>(operation: string, args: Record<string, unknown> = {}, transfers: ArrayBuffer[] = []): Promise<T> {
    if (this.failed) return Promise.reject(this.failed)
    if (this.closing) return Promise.reject(new Error('SQLite worker closed'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      this.worker.ref()
      try { this.worker.postMessage({ id, operation, ...args }, transfers) }
      catch (error) {
        this.pending.delete(id)
        if (this.pending.size === 0) this.worker.unref()
        reject(error)
      }
    })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    const close = this.failed ? Promise.resolve() : this.request('close')
    this.closing = close.then(() => undefined).finally(async () => { await this.worker.terminate() })
    return this.closing
  }
  private fail(error: Error): void {
    this.failed ??= error
    this.onFailure?.(this.failed)
    for (const waiter of this.pending.values()) waiter.reject(this.failed)
    this.pending.clear()
  }
}

const MAX_RECORD_BYTES = 50 * 1024 * 1024
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function invalidState(): Error { return new Error('OpenAgent 状态不符合当前格式') }
function partition(state: OpenAgentState): Parts {
  return new Map<string, unknown>([
    ['thread-order', state.threads.map(thread => thread.id)],
    ['report-order', state.reports.map(report => report.id)],
    ['settings', state.settings],
    ['ui', { selectedThreadId: state.selectedThreadId, tagPool: state.tagPool }],
    ...state.threads.map(thread => [`thread:${thread.id}`, thread] as const),
    ...state.reports.map(report => [`report:${report.id}`, report] as const)
  ])
}

function samePart(key: string, left: unknown, right: unknown): boolean {
  if (left === right) return true
  if ((key === 'thread-order' || key === 'report-order') && Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((id, index) => id === right[index])
  }
  if (key.startsWith('report:') && isRecord(left) && isRecord(right)) {
    return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(field => {
      const a = left[field]
      const b = right[field]
      return a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
        a.every((item, index) => item === b[index]))
    })
  }
  return key === 'ui' && isRecord(left) && isRecord(right) &&
    left.selectedThreadId === right.selectedThreadId && left.tagPool === right.tagPool
}

function serializePart(key: string, value: unknown): string[] {
  let values: string[]
  try {
    if (key.startsWith('report:')) {
      const { html, ...metadata } = value as ReportThreadRecord
      values = [JSON.stringify(metadata), html]
    } else {
      values = [JSON.stringify(value)]
    }
  } catch (error) {
    throw new Error('OpenAgent 状态无法序列化', { cause: error })
  }
  if (values.some(value => value === undefined)) throw new Error('OpenAgent 状态无法序列化')
  if (values.some(value => Buffer.byteLength(value, 'utf8') > MAX_RECORD_BYTES)) {
    throw new Error(`OpenAgent ${key} 记录超过 50 MB，无法读写`)
  }
  return values
}

