import {
  DEFAULT_THREAD_EMOJI, threadTagKey,
  type AgentInput, type AgentInputPart, type AgentThreadRecord, type DeepReadonly
} from '@openagent/contracts'
import { debugDetail, debugLog, withDebugContext } from '@openagent/plugin-kit/main'
import { MAX_TAG_POOL_SIZE, type OpenAgentTagPoolEntry, type OpenAgentStateMutation } from '../../shared/openagent-state'
import {
  buildThreadMetadataPrompt, fallbackThreadMetadata,
  parseThreadMetadataOutput, THREAD_METADATA_COMPLETION_TIMEOUT_MS,
  validateThreadMetadata, type ValidatedThreadMetadata
} from '../internal-runs'
import { SerialQueue } from '../services/serial-queue'
import { ensureDebugContext, runServiceDebugSpan } from '../services/service-debug'
import { sameJson } from '../services/state-comparison'
import { promptResultValue, type PromptCompleter } from './prompt-completion'

const MAX_INPUT_TEXT = 1_000_000
const MAX_PENDING_METADATA_PARTS = 128

type MetadataMutation = Extract<OpenAgentStateMutation, { type: 'update-agent-thread-metadata' | 'replace-tag-pool' }>
interface MetadataRepository {
  readThread(threadId: string): Readonly<AgentThreadRecord>
  readAgentThreads(): readonly DeepReadonly<AgentThreadRecord>[]
  readTagPool(): readonly OpenAgentTagPoolEntry[]
  commit(mutation: MetadataMutation): Promise<void>
}

/** Owns bounded input coalescing, classifier runs, cancellation, and metadata commits. */
export class ThreadMetadataService {
  private readonly commits = new SerialQueue()
  private readonly runs = new Map<string, Promise<void>>()
  private readonly pendingInputs = new Map<string, AgentInput>()
  private readonly activeInputs = new Map<string, { input: AgentInput; signal: AbortSignal }>()
  private readonly recoveryInputs = new Map<string, AgentInput>()
  private controller = new AbortController()
  private closed = false

  constructor(
    private readonly repository: MetadataRepository,
    private readonly complete: PromptCompleter,
    private readonly timestamp: (...floors: number[]) => number,
    private readonly onFailure: (error: unknown) => void
  ) {}

  cancel(reason: Error): void {
    const signal = this.controller.signal
    if (signal.aborted) return
    this.recoveryInputs.clear()
    if (!this.closed) {
      for (const [threadId, input] of this.pendingInputs) {
        this.recoveryInputs.set(threadId, structuredClone(input))
      }
      for (const [threadId, active] of this.activeInputs) {
        if (active.signal !== signal) continue
        const pending = this.pendingInputs.get(threadId)
        this.recoveryInputs.set(threadId, pending
          ? mergeThreadMetadataInput(active.input, pending)
          : structuredClone(active.input))
      }
    }
    this.controller.abort(reason)
  }

  close(reason: Error): void {
    this.closed = true
    this.cancel(reason)
    this.recoveryInputs.clear()
  }

  resetAfterClear(): void {
    // Keep cancelled runs tracked until they settle. The next scope hands off
    // each Thread only after its former classifier releases that run slot.
    this.pendingInputs.clear()
    if (!this.closed) {
      const retained = new Set(this.repository.readAgentThreads().map(thread => thread.id))
      for (const [threadId, input] of this.recoveryInputs) {
        if (retained.has(threadId)) this.pendingInputs.set(threadId, input)
      }
      this.controller = new AbortController()
    }
    this.recoveryInputs.clear()
  }

  /** Resume only after the application has restored Thread ownership authority. */
  resumePending(): void {
    for (const threadId of this.pendingInputs.keys()) this.startThreadMetadataRun(threadId)
  }

  withHistoryReset<Result>(reset: () => Promise<Result>): Promise<Result> {
    return this.commits.run(reset)
  }

  async drainRuns(): Promise<void> {
    while (this.runs.size) await Promise.allSettled(this.runs.values())
  }
  drainCommits(): Promise<void> { return this.commits.drain() }

  async settlePending(): Promise<void> {
    for (const snapshot of this.repository.readAgentThreads()) {
      if (snapshot.titlePending !== true) continue
      const current = this.repository.readThread(snapshot.id)
      if (current.titlePending !== true) continue
      await this.repository.commit({
        type: 'update-agent-thread-metadata',
        threadId: current.id,
        onlyIfPending: true,
        // The record already carries its first-prompt placeholder; only the
        // pending flag is settled here.
        title: current.title,
        emoji: DEFAULT_THREAD_EMOJI,
        tags: [],
        updatedAt: this.timestamp(current.updatedAt)
      })
    }
  }

  request(threadId: string, userInput: AgentInput): void {
    if (this.controller.signal.aborted) return
    const pending = this.pendingInputs.get(threadId)
    this.pendingInputs.set(
      threadId,
      mergeThreadMetadataInput(pending, userInput)
    )
    withDebugContext(ensureDebugContext({ threadId }), () => debugLog(
      'agent.metadata.queued',
      { threadId, coalesced: pending !== undefined }
    ))
    if (this.runs.has(threadId)) return
    this.startThreadMetadataRun(threadId)
  }

  private startThreadMetadataRun(threadId: string): void {
    if (this.runs.has(threadId) ||
        this.controller.signal.aborted) return
    const signal = this.controller.signal
    const run = runServiceDebugSpan(
      'agent.metadata.refresh',
      { threadId },
      async () => {
        while (!signal.aborted) {
          const input = this.pendingInputs.get(threadId)
          if (!input) return
          this.pendingInputs.delete(threadId)
          this.activeInputs.set(threadId, { input, signal })
          try {
            await this.refreshThreadMetadata(threadId, input, signal)
          } finally {
            if (this.activeInputs.get(threadId)?.signal === signal) this.activeInputs.delete(threadId)
          }
        }
      },
      { threadId }
    )
    this.runs.set(threadId, run)
    void run.catch(error => this.onFailure(error)).finally(() => {
      if (this.runs.get(threadId) !== run) return
      this.runs.delete(threadId)
      // A request can land after the drain's final empty check but before this
      // settlement callback. Re-arm from the one bounded aggregate instead of
      // dropping it or launching overlapping classifiers.
      if (this.pendingInputs.has(threadId)) {
        this.startThreadMetadataRun(threadId)
      }
    })
  }

  private async refreshThreadMetadata(
    threadId: string,
    userInput: AgentInput,
    signal: AbortSignal
  ): Promise<void> {
    const thread = this.repository.readThread(threadId)
    const promptInput = {
      thread,
      userInput,
      tagPool: this.repository.readTagPool()
    }
    let metadata: ValidatedThreadMetadata
    try {
      const plan = buildThreadMetadataPrompt(promptInput)
      debugDetail('agent.metadata.input', {
        threadId,
        promptInput,
        prompt: plan
      })
      const result = await this.complete(
        thread.harnessId,
        {
          ...plan,
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(THREAD_METADATA_COMPLETION_TIMEOUT_MS)
          ])
        },
        thread
      )
      metadata = validateThreadMetadata(
        parseThreadMetadataOutput(promptResultValue(result)),
        promptInput
      )
    } catch (error) {
      if (signal.aborted) return
      this.onFailure(error)
      metadata = fallbackThreadMetadata(promptInput)
    }
    await this.commits.run(async () => {
      if (signal.aborted) return
      const latest = this.repository.readThread(threadId)
      const title = latest.titlePending ? metadata.title : latest.title
      const emoji = latest.titlePending ? metadata.emoji : latest.emoji ?? metadata.emoji
      if (
        title !== latest.title || emoji !== latest.emoji ||
        !sameJson(metadata.tags, latest.tags) || latest.titlePending !== undefined
      ) {
        await this.repository.commit({
          type: 'update-agent-thread-metadata',
          threadId,
          title: metadata.title,
          emoji: metadata.emoji,
          tags: metadata.tags,
          updatedAt: this.timestamp(latest.updatedAt)
        })
      }
      // Cross-Thread metadata completions share this queue and merge into the
      // latest aggregate, so one completion cannot erase another Thread's tag.
      if (signal.aborted) return
      const currentPool = this.repository.readTagPool()
      const mergedPool = mergeTagPool(
        currentPool,
        metadata.tagPool,
        this.repository.readAgentThreads()
      )
      if (!sameJson(mergedPool, currentPool)) {
        await this.repository.commit({ type: 'replace-tag-pool', tagPool: mergedPool })
      }
    })
  }
}

/** Bounded intent evidence; only Core-submitted input is coalesced, never Plugin history. */
function mergeThreadMetadataInput(
  pending: AgentInput | undefined,
  next: AgentInput
): AgentInput {
  const combined = [
    ...(pending?.parts ?? []),
    ...structuredClone(next.parts)
  ]
  const retained: AgentInputPart[] = []
  let textCharacters = MAX_INPUT_TEXT
  for (let index = combined.length - 1;
    index >= 0 && retained.length < MAX_PENDING_METADATA_PARTS;
    index -= 1) {
    const part = combined[index]
    if (part.kind !== 'text') {
      retained.push(structuredClone(part))
      continue
    }
    if (textCharacters <= 0) continue
    const text = part.text.length <= textCharacters
      ? part.text
      : part.text.slice(part.text.length - textCharacters)
    textCharacters -= text.length
    if (text) retained.push({ kind: 'text', text })
  }
  retained.reverse()
  if (retained.length === 0) retained.push({ kind: 'text', text: '' })
  return { parts: retained }
}

function mergeTagPool(
  current: readonly OpenAgentTagPoolEntry[],
  generated: readonly OpenAgentTagPoolEntry[],
  threads: readonly DeepReadonly<AgentThreadRecord>[]
): OpenAgentTagPoolEntry[] {
  const merged = current.map(entry => ({ ...entry }))
  const names = new Set(merged.map(entry => threadTagKey(entry.name)))
  for (const entry of generated) {
    const key = threadTagKey(entry.name)
    if (names.has(key)) continue
    names.add(key)
    merged.push({ ...entry })
  }
  if (merged.length <= MAX_TAG_POOL_SIZE) return merged
  const bindingCounts = new Map<string, number>()
  for (const thread of threads) {
    for (const key of new Set(thread.tags.map(threadTagKey))) {
      bindingCounts.set(key, (bindingCounts.get(key) || 0) + 1)
    }
  }
  const evictionCount = merged.length - MAX_TAG_POOL_SIZE
  const evictedIndexes = new Set(
    merged
      .map((entry, index) => ({
        index,
        bindings: bindingCounts.get(threadTagKey(entry.name)) || 0
      }))
      .sort((left, right) => left.bindings - right.bindings || left.index - right.index)
      .slice(0, evictionCount)
      .map(entry => entry.index)
  )
  return merged.filter((_entry, index) => !evictedIndexes.has(index))
}
