import {
  type AgentThreadRecord,
  type DeepReadonly,
  type HarnessRespondRequest
} from '@openagent/contracts'
import type { HarnessThreadInstanceView } from '../harness-composition'

interface ThreadLifecycleRepository {
  read(threadId: string): DeepReadonly<AgentThreadRecord>
  delete(threadId: string): Promise<void>
}

interface ThreadLifecycleRuntime<Cancellation> {
  run<Result>(threadId: string, operation: () => Promise<Result>): Promise<Result>
  open(threadId: string): Promise<HarnessThreadInstanceView>
  peek(threadId: string): HarnessThreadInstanceView | undefined
  forget(threadId: string, instance: HarnessThreadInstanceView): void
  cancelPending(threadId: string, reason: Error): Cancellation
  interrupt(threadId: string, signal: AbortSignal, cancellation: Cancellation,
    expectedExecutionId: string | null, allowDeleting?: boolean): Promise<void>
  admit(threadId: string, harnessId: string, signal: AbortSignal): Promise<unknown>
  forgetIntervention(threadId: string): void
  releaseWorkspace(thread: DeepReadonly<AgentThreadRecord>): Promise<void>
}

/** Shared Agent lifecycle. GUI and Bart adapters supply validated DTOs and cancellation scopes. */
export class ThreadLifecycleService<Cancellation> {
  private readonly deleting = new Set<string>()

  constructor(
    private readonly repository: ThreadLifecycleRepository,
    private readonly runtime: ThreadLifecycleRuntime<Cancellation>
  ) {}

  isDeleting(threadId: string): boolean { return this.deleting.has(threadId) }

  reserveDeletion(threadId: string): () => void {
    if (this.deleting.has(threadId)) throw new Error(`Agent Thread 正在删除: ${threadId}`)
    this.deleting.add(threadId)
    this.runtime.forgetIntervention(threadId)
    return () => this.deleting.delete(threadId)
  }

  read(threadId: string, question: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    return this.runtime.run(threadId, async () => {
      const instance = await this.runtime.open(threadId)
      signal.throwIfAborted()
      const source = this.repository.read(threadId)
      await this.runtime.admit(source.id, source.harnessId, signal)
      signal.throwIfAborted()
      return instance.read(question, signal)
    })
  }

  async interrupt(threadId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const source = this.repository.read(threadId)
    const cancellation = this.runtime.cancelPending(
      threadId, new Error(`Agent Thread interrupted: ${threadId}`)
    )
    await this.runtime.interrupt(threadId, signal, cancellation, activeExecutionId(source))
  }

  respond(threadId: string, response: HarnessRespondRequest, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return this.runtime.run(threadId, async () => {
      const instance = await this.runtime.open(threadId)
      signal.throwIfAborted()
      await instance.respond(response)
    })
  }

  async delete(threadId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const snapshot = this.repository.read(threadId)
    assertNoBackgroundWork(snapshot)
    // Claim synchronously before entering the command queue so deletion can
    // stop a blocked send/opening instead of waiting behind it.
    const release = this.reserveDeletion(threadId)
    const cancellation = this.runtime.cancelPending(
      threadId, new Error(`Agent Thread deleted: ${threadId}`)
    )
    try {
      if (this.runtime.peek(threadId)) {
        await this.runtime.interrupt(threadId, signal, cancellation,
          activeExecutionId(snapshot), true).catch(() => undefined)
      }
      await this.runtime.run(threadId, async () => {
        signal.throwIfAborted()
        assertNoBackgroundWork(this.repository.read(threadId))
        const instance = this.runtime.peek(threadId)
        if (instance) {
          try { await instance.dispose() }
          finally { this.runtime.forget(threadId, instance) }
        }
        signal.throwIfAborted()
        await this.repository.delete(threadId)
        await this.runtime.releaseWorkspace(snapshot)
      })
    } finally { release() }
  }
}

function activeExecutionId(thread: DeepReadonly<AgentThreadRecord>): string | null {
  const execution = thread.observation.latestExecution
  return execution && !['completed', 'failed', 'interrupted'].includes(execution.status)
    ? execution.executionId : null
}

function assertNoBackgroundWork(thread: DeepReadonly<AgentThreadRecord>): void {
  if (thread.observation.backgroundWork !== null) {
    throw new Error(`Agent Thread 有后台任务，停止后才能删除: ${thread.id}`)
  }
}
