import type { AgentThreadRecord, BartThreadRecord, DeepReadonly } from '@openagent/contracts'
import { debugDetail, debugLog, withDebugContext } from '@openagent/plugin-kit/main'
import type { HarnessThreadInstanceView } from '../harness-composition'
import type { ActiveThreadExecution } from '../harness-thread-runtime'
import { AUTO_INTERVENTION_COMPLETION_TIMEOUT_MS, buildAutoInterventionPrompt, parseAutoInterventionOutput } from '../internal-runs'
import { ensureDebugContext, runServiceDebugSpan } from '../services/service-debug'
import { errorMessage } from '../services/error-message'
import { promptResultValue, type PromptCompleter } from './prompt-completion'
import { publicThreadEnvelope, bartTranscriptFingerprint } from './thread-observation'

interface InterventionContext {
  operational(): boolean
  enabled(): boolean
  pendingAdmissions(): number
  hasThread(threadId: string): boolean
  readThread(threadId: string): DeepReadonly<AgentThreadRecord>
  readBart(): DeepReadonly<BartThreadRecord>
}

interface InterventionThreadCommands {
  openExecution(threadId: string): Promise<ActiveThreadExecution | null>
  execution(threadId: string): ActiveThreadExecution | null | undefined
  activeThreadIds(): readonly string[]
  withThread(threadId: string, operation: (thread: Pick<HarnessThreadInstanceView, 'respond'>) => Promise<void>): Promise<void>
}

interface InterventionBartCommands {
  run(operation: () => Promise<void>): Promise<void>
  append(message: string): Promise<void>
}

/** Owns coalesced decisions and their revocable authority, not Thread lifecycle. */
export class AutoInterventionService {
  private readonly runs = new Map<string, Promise<void>>()
  private readonly dirty = new Set<string>()
  private readonly fingerprints = new Map<string, string>()
  private controller = new AbortController()
  private closed = false

  constructor(
    private readonly context: InterventionContext,
    private readonly threads: InterventionThreadCommands,
    private readonly bart: InterventionBartCommands,
    private readonly complete: PromptCompleter,
    private readonly onFailure: (error: unknown) => void
  ) {}

  cancel(reason: Error): void { this.controller.abort(reason) }

  close(reason: Error): void {
    this.closed = true
    this.cancel(reason)
  }

  renewAuthority(): void {
    if (!this.closed) this.controller = new AbortController()
  }

  invalidateDecisions(): void { this.fingerprints.clear() }

  clearHistory(): void {
    this.fingerprints.clear()
    this.dirty.clear()
  }

  resetAfterClear(): void {
    // Retain revoked runs until settlement; their successors must not overlap.
    this.dirty.clear()
    this.fingerprints.clear()
    this.renewAuthority()
  }

  async drain(): Promise<void> {
    while (this.runs.size) await Promise.allSettled(this.runs.values())
  }

  request(threadId: string): void {
    if (!this.context.hasThread(threadId)) {
      this.forgetThread(threadId)
      return
    }
    if (
      !this.context.operational() ||
      !this.context.enabled()
    ) return
    this.dirty.add(threadId)
    withDebugContext(ensureDebugContext({ threadId }), () => debugLog(
      'bart.auto-intervention.queued',
      { threadId, pendingBartUserAdmissions: this.context.pendingAdmissions() }
    ))
    if (
      this.controller.signal.aborted ||
      this.context.pendingAdmissions() > 0 ||
      this.runs.has(threadId)
    ) return

    const signal = this.controller.signal
    let tracked!: Promise<void>
    tracked = Promise.resolve()
      .then(() => this.runAutoInterventionCoalesced(threadId, signal))
      .catch(error => this.onFailure(error))
      .finally(() => {
        if (this.runs.get(threadId) !== tracked) return
        this.runs.delete(threadId)
        if (
          this.dirty.has(threadId) &&
          this.canRun()
        ) {
          this.request(threadId)
        } else if (
          !this.context.operational() ||
          !this.context.enabled()
        ) {
          this.dirty.delete(threadId)
        }
      })
    this.runs.set(threadId, tracked)
  }

  forgetThread(threadId: string): void {
    this.fingerprints.delete(threadId)
    this.dirty.delete(threadId)
  }

  private async runAutoInterventionCoalesced(threadId: string, signal: AbortSignal): Promise<void> {
    while (
      !signal.aborted &&
      signal === this.controller.signal &&
      this.dirty.has(threadId) &&
      this.canRun()
    ) {
      this.dirty.delete(threadId)
      await this.runAutoIntervention(threadId, signal)
    }
  }

  private async runAutoIntervention(threadId: string, signal: AbortSignal): Promise<void> {
    return runServiceDebugSpan(
      'bart.auto-intervention',
      { threadId },
      () => this.runAutoInterventionImpl(threadId, signal),
      { threadId }
    )
  }

  private async runAutoInterventionImpl(threadId: string, authoritySignal: AbortSignal): Promise<void> {
    const execution = await this.threads.openExecution(threadId)
    if (!execution || authoritySignal.aborted || authoritySignal !== this.controller.signal) return
    const thread = this.context.readThread(threadId)
    const threadStatus = publicThreadEnvelope(thread)
    const threadFingerprint = JSON.stringify(threadStatus)
    const bart = this.context.readBart()
    const bartThreadId = bart.id
    const transcriptFingerprint = bartTranscriptFingerprint(bart)
    const authorityFingerprint = JSON.stringify({
      thread: threadFingerprint,
      bartThreadId,
      transcriptFingerprint
    })
    if (this.fingerprints.get(threadId) === authorityFingerprint) return
    this.fingerprints.set(threadId, authorityFingerprint)
    const plan = buildAutoInterventionPrompt({
      bartTranscript: bart.transcript,
      threadStatus
    })
    withDebugContext(ensureDebugContext({
      threadId,
      executionId: execution.executionId,
      harnessId: bart.harnessId
    }), () => debugDetail('bart.auto-intervention.input', {
      threadId,
      executionId: execution.executionId,
      threadStatus,
      bartTranscript: bart.transcript,
      prompt: plan
    }))
    const authority = {
      threadId,
      executionId: execution.executionId,
      bartThreadId,
      transcriptFingerprint,
      threadFingerprint,
      authorityFingerprint,
      authoritySignal
    }
    try {
      const completion = await withDebugContext(ensureDebugContext({
        threadId,
        executionId: execution.executionId,
        harnessId: bart.harnessId
      }), () => this.complete(bart.harnessId, {
        ...plan,
        signal: AbortSignal.any([
          authoritySignal,
          AbortSignal.timeout(AUTO_INTERVENTION_COMPLETION_TIMEOUT_MS)
        ])
      }))
      if (!this.isCurrent(authority)) {
        this.markAutoInterventionDirtyIfActive(threadId, execution.executionId)
        return
      }
      const decision = parseAutoInterventionOutput(promptResultValue(completion))
      debugDetail('bart.auto-intervention.result', {
        threadId,
        executionId: execution.executionId,
        decision
      })
      if (!decision.respond) return
      await this.bart.run(async () => {
        authoritySignal.throwIfAborted()
        if (!this.isCurrent(authority)) {
          this.markAutoInterventionDirtyIfActive(threadId, execution.executionId)
          return
        }
        await this.threads.withThread(threadId, async latest => {
          authoritySignal.throwIfAborted()
          if (!this.isCurrent(authority)) {
            this.markAutoInterventionDirtyIfActive(threadId, execution.executionId)
            return
          }
          await latest.respond(decision.response)
        })
        if (
          authoritySignal.aborted ||
          this.context.readBart().id !== bartThreadId ||
          bartTranscriptFingerprint(this.context.readBart()) !==
            transcriptFingerprint ||
          !this.context.enabled() ||
          this.threads.execution(threadId)?.executionId !== execution.executionId ||
          this.fingerprints.get(threadId) !== authorityFingerprint
        ) return
        await this.bart.append(
          `Auto intervention responded to Thread ${threadId}: ${decision.reason}`
        )
      })
    } catch (error) {
      await this.recordAutoInterventionFailureIfCurrent(authority, error)
      throw error
    }
  }

  private isCurrent(input: {
    readonly threadId: string
    readonly executionId: string
    readonly bartThreadId: string
    readonly transcriptFingerprint: string
    readonly threadFingerprint: string
    readonly authorityFingerprint: string
    readonly authoritySignal: AbortSignal
  }): boolean {
    if (
      !this.context.operational() ||
      this.context.pendingAdmissions() > 0 ||
      input.authoritySignal.aborted
    ) return false
    if (
      !this.context.enabled() ||
      this.context.readBart().id !== input.bartThreadId ||
      bartTranscriptFingerprint(this.context.readBart()) !== input.transcriptFingerprint ||
      this.fingerprints.get(input.threadId) !== input.authorityFingerprint
    ) return false
    const execution = this.threads.execution(input.threadId)
    if (!execution || execution.executionId !== input.executionId) return false
    if (!this.context.hasThread(input.threadId)) return false
    const thread = this.context.readThread(input.threadId)
    const latestStatus = publicThreadEnvelope(thread)
    return JSON.stringify(latestStatus) === input.threadFingerprint
  }

  private markAutoInterventionDirtyIfActive(
    threadId: string,
    executionId: string
  ): void {
    if (
      this.context.operational() &&
      this.context.enabled() &&
      this.threads.execution(threadId)?.executionId === executionId
    ) {
      this.dirty.add(threadId)
    }
  }

  private canRun(): boolean {
    return this.context.operational() &&
      this.context.pendingAdmissions() === 0 &&
      !this.controller.signal.aborted &&
      this.context.enabled()
  }

  requestActive(): void {
    if (!this.canRun()) return
    for (const threadId of this.threads.activeThreadIds()) this.request(threadId)
  }

  private async recordAutoInterventionFailureIfCurrent(
    authority: Parameters<AutoInterventionService['isCurrent']>[0],
    error: unknown
  ): Promise<void> {
    if (!this.isCurrent(authority)) return
    await this.bart.run(async () => {
      if (!this.isCurrent(authority)) return
      if (
        this.fingerprints.get(authority.threadId) ===
        authority.authorityFingerprint
      ) {
        this.fingerprints.delete(authority.threadId)
      }
      await this.bart.append(
        `自动介入评估失败，控制权保留给用户：${errorMessage(error)}`
      )
    })
  }
}
