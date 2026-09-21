import type { PublicExecution, ThreadPublicObservation } from '@openagent/contracts'
import type { OpenAgentState } from '../../shared/openagent-state'
import { reportHtmlPreview, type ReportThreadRecord } from '../../shared/report-thread'
import type {
  RendererAppState,
  RendererBartActivity,
  RendererBartExecution,
  RendererReport,
  RendererStateMutation
} from '../../shared/renderer-state-contracts'
import { createRendererStateMutation } from '../../shared/renderer-state-patch'

const RENDERER_PUBLISH_WINDOW_MS = 50

interface RendererStateSource {
  read(): Pick<OpenAgentState, 'threads' | 'reports' | 'settings' | 'selectedThreadId'>
  execution(): RendererBartExecution | undefined
  readonly defaultCwd: string
}

/** Owns publication cadence, revision, projection cache and subscriber lifetime. */
export class RendererStatePublisher {
  private previous: RendererAppState | undefined
  private timer: NodeJS.Timeout | undefined
  private closed = false
  private delivering = false
  private readonly activities: RendererBartActivity[] = []
  private readonly pending = new Array<RendererStateMutation>()
  private readonly listeners = new Set<(mutation: RendererStateMutation) => void>()
  private readonly executionKeys = new Map<string, string | null>()
  private readonly reportCache = new Map<string, {
    readonly source: ReportThreadRecord
    readonly summary: RendererReport
  }>()

  constructor(
    private readonly source: RendererStateSource,
    private readonly reportFailure: (error: unknown) => void
  ) {}

  initialize(): void {
    if (this.closed || this.previous) return
    this.previous = this.project(0)
    this.rememberExecutionKeys(this.previous)
  }

  snapshot(): RendererAppState {
    if (!this.previous) throw new Error('Renderer publisher 尚未初始化')
    // A load may observe an unflushed streaming commit. It must not advance the
    // shared publication baseline or make other subscribers miss that commit.
    return structuredClone(this.project(this.previous.revision))
  }

  subscribe(listener: (mutation: RendererStateMutation) => void): () => void {
    if (this.closed) return () => undefined
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(effect?: RendererStateMutation['effect']): void {
    if (!this.previous || this.closed) return
    this.cancelPending()
    const next = this.project(this.previous.revision + 1)
    const mutation = structuredClone({
      ...createRendererStateMutation(this.previous, next, effect),
      ...(this.activities.length ? { bartActivities: this.activities.splice(0) } : {})
    })
    this.previous = next
    this.rememberExecutionKeys(next)
    this.pending.push(mutation)
    if (this.delivering) return
    this.delivering = true
    try {
      for (let event = this.pending.shift(); event; event = this.pending.shift()) {
        for (const listener of this.listeners) {
          try { listener(event) } catch (error) { this.reportFailure(error) }
        }
      }
    } finally { this.delivering = false }
  }

  bartActivity(event: RendererBartActivity): void {
    if (!this.previous || this.closed) return
    const captured = structuredClone(event)
    const last = this.activities.at(-1)
    // Coalesce only updates to the same semantic item, never an A → B → A.
    if (last && last.threadId === event.threadId && last.harnessId === event.harnessId &&
      last.activity.executionId === event.activity.executionId && last.activity.sequence === event.activity.sequence) {
      this.activities[this.activities.length - 1] = captured
    } else this.activities.push(captured)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.publish() }, RENDERER_PUBLISH_WINDOW_MS)
    this.timer.unref()
  }

  threadCommitted(change: {
    readonly record: { readonly id: string }
    readonly observation: ThreadPublicObservation
    readonly observationChanged: boolean
  }): void {
    if (!this.previous || this.closed) return
    const execution = change.observation.latestExecution
    const samePublishedKey = this.executionKeys.has(change.record.id) &&
      this.executionKeys.get(change.record.id) === executionLifecycleKey(execution)
    const mayCoalesce = !change.observationChanged ||
      samePublishedKey && (execution === null || execution.status === 'running')
    if (!mayCoalesce) { this.publish(); return }
    if (this.timer) return
    // The first detail event fixes the deadline; sustained streaming cannot
    // postpone visibility. Structural/terminal/effect publications absorb it.
    this.schedule()
  }

  cancelPending(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  close(): void {
    this.closed = true
    this.cancelPending()
    this.listeners.clear()
    this.pending.length = 0
    this.activities.length = 0
    this.previous = undefined
    this.executionKeys.clear()
    this.reportCache.clear()
  }

  private project(revision: number): RendererAppState {
    const state = this.source.read()
    const reports = state.reports.map(report => {
      const cached = this.reportCache.get(report.id)
      if (cached?.source === report) return cached.summary
      const summary: RendererReport = {
        id: report.id,
        title: report.title,
        tags: report.tags,
        relatedExecutions: report.relatedExecutions,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        archived: report.archived,
        previewText: cached?.source.html === report.html && cached.source.title === report.title
          ? cached.summary.previewText : reportHtmlPreview(report.html, report.title)
      }
      this.reportCache.set(report.id, { source: report, summary })
      return summary
    })
    const ids = new Set(reports.map(report => report.id))
    for (const id of this.reportCache.keys()) if (!ids.has(id)) this.reportCache.delete(id)
    const execution = this.source.execution()
    return {
      revision,
      defaultCwd: this.source.defaultCwd,
      threads: state.threads,
      executions: execution ? [execution] : [],
      reports,
      selectedThreadId: state.selectedThreadId,
      settings: state.settings
    }
  }

  private rememberExecutionKeys(state: RendererAppState): void {
    this.executionKeys.clear()
    for (const thread of state.threads) {
      this.executionKeys.set(thread.id, executionLifecycleKey(thread.observation.latestExecution))
    }
  }
}

function executionLifecycleKey(execution: PublicExecution | null): string | null {
  return execution === null ? null : JSON.stringify([execution.executionId, execution.status])
}
