import {
  MAX_PENDING_SCHEDULED_DISPATCHES,
  compareScheduledDispatches,
  scheduledDispatchSummary,
  shouldExecuteScheduledDispatch,
  type ScheduledDispatch,
  type ScheduledDispatchRequest,
  type ScheduledDispatchStore,
  type ScheduledDispatchSummary
} from '../scheduled-dispatch'
import { SerialQueue } from '../services/serial-queue'

const RETRY_MS = 1_000
const MAX_SAVE_RETRIES = 120

/** Dispatch uses the one authoritative Thread lifecycle owned by the application. */
interface ScheduledThreadCommands {
  dispatch(request: ScheduledDispatchRequest): Promise<void>
  reportDispatchFailure(dispatchId: string, error: unknown): Promise<void>
  reportPersistenceFailure(error: unknown): void
}

/** Owns pending schedules, persistence authority, timers, retry, and batch execution. */
export class ScheduledDispatcher {
  private readonly commands = new SerialQueue()
  private readonly callbacks = new SerialQueue()
  private pending: ScheduledDispatch[] = []
  private timer: NodeJS.Timeout | undefined
  private ready = false
  private running = false
  private closed = false

  constructor(
    private readonly store: Pick<ScheduledDispatchStore, 'load' | 'save'>,
    private readonly threads: ScheduledThreadCommands,
    private readonly now: () => number
  ) {}

  async initialize(signal: AbortSignal, onReady: () => void): Promise<void> {
    this.pending = await this.store.load()
    await this.commands.run(async () => {
      while (true) {
        const startupNow = this.now()
        const next = this.pending.filter(item => item.executeAt > startupNow)
        if (next.length === this.pending.length) {
          // Publish readiness and arm the timer at the final wall-clock check.
          // Persisted due entries were never armed by this process; consume them
          // without executing, including those within the grace window.
          signal.throwIfAborted()
          onReady()
          this.ready = true
          this.resume()
          return
        }
        await this.store.save(next)
        this.pending = next
      }
    })
  }

  async add(dispatch: ScheduledDispatch, signal: AbortSignal): Promise<void> {
    await this.commands.run(async () => {
      signal.throwIfAborted()
      if (dispatch.executeAt <= this.now()) throw new Error('executeAt 在计划创建完成前已到期')
      if (this.pending.length >= MAX_PENDING_SCHEDULED_DISPATCHES) {
        throw new Error('待执行计划数量已达上限')
      }
      const previous = this.pending
      const next = [...previous, dispatch].sort(compareScheduledDispatches)
      signal.throwIfAborted()
      await this.saveWithAuthority(previous, next, signal, () => {
        if (dispatch.executeAt <= this.now()) throw new Error('executeAt 在计划持久化完成前已到期')
      })
      this.pending = next
      this.arm()
    })
  }

  list(): ScheduledDispatchSummary[] {
    return this.pending.map(scheduledDispatchSummary)
  }

  cancel(scheduleId: string, signal: AbortSignal): Promise<ScheduledDispatch> {
    return this.commands.run(async () => {
      signal.throwIfAborted()
      const current = this.pending.find(item => item.id === scheduleId)
      if (!current) throw new Error(`计划派发不存在: ${scheduleId}`)
      const previous = this.pending
      const next = previous.filter(item => item.id !== scheduleId)
      signal.throwIfAborted()
      await this.saveWithAuthority(previous, next, signal)
      this.pending = next
      this.arm()
      return current
    })
  }

  pause(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  resume(): void {
    if (!this.ready || this.closed) return
    this.running = true
    this.arm()
  }

  close(): void {
    this.closed = true
    this.pause()
  }

  drainCallbacks(): Promise<void> { return this.callbacks.drain() }
  drainCommands(): Promise<void> { return this.commands.drain() }

  private async saveWithAuthority(
    previous: readonly ScheduledDispatch[],
    next: readonly ScheduledDispatch[],
    signal: AbortSignal,
    validateAfterSave?: () => void
  ): Promise<void> {
    await this.store.save(next)
    try {
      signal.throwIfAborted()
      validateAfterSave?.()
    } catch (error) {
      try {
        await this.store.save(previous)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], '失权 Scheduled Dispatch sidecar 回滚失败')
      }
      throw error
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.running) return
    const next = this.pending[0]
    if (!next) return
    const delay = Math.max(0, Math.min(next.executeAt - this.now(), 2_147_483_647))
    this.scheduleCallback(delay, 0)
  }

  private scheduleCallback(delay: number, failedSaveAttempts: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      // Each retry samples wall time afresh, so failed durable consumption can
      // never turn an expired grace window into a late execution.
      const callbackNow = this.now()
      void this.callbacks.run(() => this.consumeDue(callbackNow)).catch(error => {
        this.threads.reportPersistenceFailure(error)
        if (this.running && failedSaveAttempts < MAX_SAVE_RETRIES) {
          this.scheduleCallback(RETRY_MS, failedSaveAttempts + 1)
        }
      })
    }, delay)
  }

  private async consumeDue(callbackNow: number): Promise<void> {
    const consumed = await this.commands.run(async () => {
      if (!this.running) return []
      const consumed = this.pending.filter(item => item.executeAt <= callbackNow)
      if (!consumed.length) {
        this.arm()
        return []
      }
      const next = this.pending.filter(item => item.executeAt > callbackNow)
      // At most once: durable consumption precedes every Thread creation.
      await this.store.save(next)
      this.pending = next
      this.arm()
      return consumed
    })
    // Release the persistence lock before creating Threads; the callback queue
    // retains batch order without distorting subsequent grace checks.
    for (const dispatch of consumed) {
      if (!shouldExecuteScheduledDispatch(dispatch, callbackNow)) continue
      try {
        await this.threads.dispatch(dispatch.request)
      } catch (error) {
        if (this.running) {
          await this.threads.reportDispatchFailure(dispatch.id, error).catch(() => undefined)
        }
      }
    }
  }
}
