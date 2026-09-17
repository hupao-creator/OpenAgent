import { type PublicExecution, threadTagKey } from '@openagent/contracts'
import {
  parseReportHtml,
  parseReportRelatedExecutions,
  parseReportTitle,
  reportThreadSummary,
  type ReportExecutionReference,
  type ReportThreadRecord,
  type ReportThreadSummary
} from '../../shared/report-thread'
import { SerialQueue } from '../services/serial-queue'

const MAX_REPORTS = 10_000

export interface ReportCreated {
  readonly type: 'report-created'
  readonly reportId: string
}

/** Report persistence and Thread tag lookup; no runtime or Renderer access. */
export interface ReportRepository {
  readReports(): readonly ReportThreadRecord[]
  readThreadTags(threadId: string): readonly string[]
  resolveExecution(threadId: string, executionId: string): PublicExecution | null
  /** Explicit new references must be checked while their Thread commit scopes are held. */
  replaceReports(reports: ReportThreadRecord[], event?: ReportCreated,
    relatedExecutionChecks?: readonly ReportExecutionReference[]): Promise<void>
  /** One durable command locks these references and checks public latest IDs before archiving. */
  archiveReport(reportId: string, relatedThreadIds: readonly string[]): Promise<void>
}

interface ReportFields {
  readonly title?: unknown
  readonly html?: unknown
  readonly relatedExecutions?: unknown
}

/** Owns report validation, tag snapshots, serial mutation, and reset barriers. */
export class ReportService {
  private readonly commands = new SerialQueue()

  constructor(
    private readonly repository: ReportRepository,
    private readonly clock: { timestamp(...floors: number[]): number; createId(): string }
  ) {}

  read(reportId: string): ReportThreadRecord {
    const report = this.repository.readReports().find(item => item.id === reportId)
    if (!report) throw new Error(`Report Thread 不存在: ${reportId}`)
    return structuredClone(report)
  }

  list(): ReportThreadSummary[] {
    return this.repository.readReports().map(reportThreadSummary)
  }

  async create(input: ReportFields, signal: AbortSignal): Promise<ReportThreadSummary> {
    signal.throwIfAborted()
    const relatedExecutions = parseReportRelatedExecutions(input.relatedExecutions)
    return this.commands.run(async () => {
      signal.throwIfAborted()
      const at = this.clock.timestamp()
      const report: ReportThreadRecord = {
        id: this.clock.createId(),
        title: parseReportTitle(input.title),
        html: parseReportHtml(input.html),
        relatedExecutions,
        tags: this.tagSnapshot(relatedExecutions),
        createdAt: at,
        updatedAt: at,
        archived: false
      }
      const reports = [...this.repository.readReports(), report]
      if (reports.length > MAX_REPORTS) throw new Error('Report Thread 数量过多')
      signal.throwIfAborted()
      await this.repository.replaceReports(reports, { type: 'report-created', reportId: report.id }, relatedExecutions)
      return reportThreadSummary(report)
    })
  }

  async update(
    reportId: string,
    input: ReportFields,
    signal: AbortSignal
  ): Promise<ReportThreadSummary> {
    signal.throwIfAborted()
    if (input.title === undefined && input.html === undefined && input.relatedExecutions === undefined) {
      throw new Error('report update 至少需要一个替换字段')
    }
    return this.commands.run(async () => {
      signal.throwIfAborted()
      const reports = [...this.repository.readReports()]
      const index = reports.findIndex(report => report.id === reportId)
      if (index < 0) throw new Error(`Report Thread 不存在: ${reportId}`)
      const current = reports[index]
      const relatedExecutions = input.relatedExecutions === undefined
        ? current.relatedExecutions
        : parseReportRelatedExecutions(input.relatedExecutions)
      const report = {
        ...current,
        ...(input.title === undefined ? {} : { title: parseReportTitle(input.title) }),
        ...(input.html === undefined ? {} : { html: parseReportHtml(input.html) }),
        ...(input.relatedExecutions === undefined
          ? {}
          : { relatedExecutions, tags: this.tagSnapshot(relatedExecutions) }),
        updatedAt: this.clock.timestamp(current.updatedAt)
      }
      reports[index] = report
      signal.throwIfAborted()
      await this.repository.replaceReports(reports, undefined,
        input.relatedExecutions === undefined ? undefined : relatedExecutions)
      return reportThreadSummary(report)
    })
  }

  async setArchived(reportId: string, archived: boolean, signal: AbortSignal): Promise<void> {
    if (typeof archived !== 'boolean') throw new Error('archived 必须是 boolean')
    await this.commands.run(async () => {
      signal.throwIfAborted()
      const reports = [...this.repository.readReports()]
      const index = reports.findIndex(report => report.id === reportId)
      if (index < 0) throw new Error(`Report Thread 不存在: ${reportId}`)
      const current = reports[index]
      if (archived) {
        await this.repository.archiveReport(reportId, current.relatedExecutions.map(reference => reference.threadId))
        return
      }
      if (current.archived === archived) return
      reports[index] = { ...current, archived }
      signal.throwIfAborted()
      await this.repository.replaceReports(reports)
    })
  }

  async delete(reportId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return this.commands.run(async () => {
      signal.throwIfAborted()
      const current = this.repository.readReports()
      const reports = current.filter(report => report.id !== reportId)
      if (reports.length === current.length) throw new Error(`Report Thread 不存在: ${reportId}`)
      signal.throwIfAborted()
      await this.repository.replaceReports(reports)
    })
  }

  /** A global history reset must hold the same mutation barrier as report writes. */
  withHistoryReset<Result>(reset: () => Promise<Result>): Promise<Result> {
    return this.commands.run(reset)
  }

  drain(): Promise<void> {
    return this.commands.drain()
  }

  private tagSnapshot(relatedExecutions: readonly ReportExecutionReference[]): string[] {
    const seen = new Set<string>()
    const tags: string[] = []
    for (const { threadId, executionId } of relatedExecutions) {
      const execution = this.repository.resolveExecution(threadId, executionId)
      assertCompletedReportExecution({ threadId, executionId }, execution)
      for (const tag of this.repository.readThreadTags(threadId)) {
        const key = threadTagKey(tag)
        if (!key || seen.has(key)) continue
        seen.add(key)
        tags.push(tag)
      }
    }
    return tags
  }
}

/** Same product rule for eager validation and the authoritative locked commit check. */
export function assertCompletedReportExecution(
  reference: ReportExecutionReference,
  execution: PublicExecution | null
): void {
  if (!execution || execution.executionId !== reference.executionId || execution.status !== 'completed') {
    throw new Error(`报告只能关联属于 Thread 的 completed Execution: ${reference.threadId}/${reference.executionId}`)
  }
}
