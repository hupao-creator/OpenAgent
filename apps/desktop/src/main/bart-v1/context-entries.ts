import type {
  BartContextContributor,
  BartContextEntryId
} from '@openagent/contracts'
import {
  HARNESS_IDS,
  harnessDescriptors,
  type HarnessId
} from '../../shared/harnesses'
import {
  createDebugTrace,
  debugDetail,
  debugError,
  getDebugContext,
  startDebugSpan,
  withDebugContext
} from '@openagent/plugin-kit/main'

type DebugContext = ReturnType<typeof createDebugTrace>

export interface BartContextEntryRule {
  readonly id: BartContextEntryId
  readonly timing: 'system' | 'run'
  readonly timeoutMs: number
  readonly maxContributionBytes: number
  readonly maxEntryBytes: number
}

export const BART_CONTEXT_ENTRY_RULES = [
  {
    id: 'workspace',
    timing: 'system',
    timeoutMs: 2_000,
    maxContributionBytes: 32 * 1024,
    maxEntryBytes: 128 * 1024
  },
  {
    id: 'evaluation',
    timing: 'run',
    timeoutMs: 7_500,
    maxContributionBytes: 32 * 1024,
    maxEntryBytes: 128 * 1024
  },
  {
    id: 'telemetry',
    timing: 'run',
    timeoutMs: 7_500,
    maxContributionBytes: 32 * 1024,
    maxEntryBytes: 128 * 1024
  }
] as const satisfies readonly BartContextEntryRule[]

export interface BartContextEntrySource {
  readonly contextEntries?: Partial<
    Record<BartContextEntryId, BartContextContributor>
  >
}

export type BartContextEntryComposition = Readonly<
  Record<string, BartContextEntrySource>
>

export interface BartContextContributionFailure {
  readonly entryId: BartContextEntryId
  readonly harnessId: HarnessId
  readonly reason:
    | 'timeout'
    | 'aborted'
    | 'failed'
    | 'invalid'
    | 'too-large'
    | 'entry-too-large'
  readonly error?: unknown
}

export interface CollectedBartContextEntry {
  readonly id: BartContextEntryId
  readonly content: string
}

export async function collectBartContextEntries(input: {
  readonly timing: BartContextEntryRule['timing']
  readonly composition: BartContextEntryComposition
  readonly signal: AbortSignal
  readonly onFailure?: (failure: BartContextContributionFailure) => void
  /** Optional lifecycle owner for contributor work that may outlive timeout/abort. */
  readonly trackContributorOperation?: (operation: Promise<unknown>) => void
}): Promise<readonly CollectedBartContextEntry[]> {
  const parent = ensureDebugContext({})
  const span = withDebugContext(parent, () => startDebugSpan(
    'bart.context.collect',
    { timing: input.timing }
  ))
  try {
    const rules = BART_CONTEXT_ENTRY_RULES.filter((rule) => rule.timing === input.timing)
    // Every rule receives the collection span as its explicit parent. The
    // rules run in parallel, so their durations must not be accidentally
    // attributed as serial work to one another.
    const entries = await withDebugContext(span.context, () => Promise.all(rules.map(async (rule) => {
      const ruleSpan = startDebugSpan('bart.context.rule', {
        timing: input.timing,
        entryId: rule.id,
        timeoutMs: rule.timeoutMs
      })
      try {
        const contributions = await Promise.all(HARNESS_IDS.map(async (harnessId) => {
          const contributor = input.composition[harnessId].contextEntries?.[rule.id]
          if (!contributor) return undefined

          const result = await runContribution({
            contributor,
            parentContext: ruleSpan.context,
            entryId: rule.id,
            harnessId,
            parentSignal: input.signal,
            timeoutMs: rule.timeoutMs,
            trackOperation: input.trackContributorOperation
          })
          if (result.kind !== 'value') {
            reportFailure(input.onFailure, {
              entryId: rule.id,
              harnessId,
              reason: result.kind,
              ...(result.error === undefined ? {} : { error: result.error })
            }, ruleSpan.context)
            return undefined
          }
          if (result.value === undefined) return undefined
          if (typeof result.value !== 'string') {
            reportFailure(input.onFailure, {
              entryId: rule.id,
              harnessId,
              reason: 'invalid'
            }, ruleSpan.context)
            return undefined
          }
          if (Buffer.byteLength(result.value, 'utf8') > rule.maxContributionBytes) {
            reportFailure(input.onFailure, {
              entryId: rule.id,
              harnessId,
              reason: 'too-large'
            }, ruleSpan.context)
            return undefined
          }
          if (result.value.length === 0) return undefined
          return {
            harnessId,
            block: formatContribution(harnessId, result.value)
          }
        }))

        const accepted: string[] = []
        let acceptedBytes = 0
        for (const contribution of contributions) {
          if (!contribution) continue
          const separatorBytes = accepted.length === 0 ? 0 : 2
          const blockBytes = Buffer.byteLength(contribution.block, 'utf8')
          if (acceptedBytes + separatorBytes + blockBytes > rule.maxEntryBytes) {
            reportFailure(input.onFailure, {
              entryId: rule.id,
              harnessId: contribution.harnessId,
              reason: 'entry-too-large'
            }, ruleSpan.context)
            continue
          }
          accepted.push(contribution.block)
          acceptedBytes += separatorBytes + blockBytes
        }
        const entry = accepted.length === 0
          ? undefined
          : { id: rule.id, content: accepted.join('\n\n') }
        ruleSpan.end({
          outcome: entry ? 'accepted' : 'empty',
          contributionCount: accepted.length,
          bytes: acceptedBytes
        })
        return entry
      } catch (error) {
        ruleSpan.fail(error, { timing: input.timing, entryId: rule.id })
        throw error
      }
    })))
    const result = entries.filter((entry): entry is CollectedBartContextEntry => entry !== undefined)
    withDebugContext(span.context, () => debugDetail('bart.context.assembled', {
      timing: input.timing,
      entries: result
    }))
    span.end({
      entryIds: result.map(entry => entry.id),
      entryCount: result.length
    })
    return result
  } catch (error) {
    span.fail(error, { timing: input.timing })
    throw error
  }
}

export function formatContribution(harnessId: HarnessId, content: string): string {
  const descriptor = harnessDescriptors[harnessId]
  return `### ${descriptor.displayName} (${descriptor.id})\n${content}`
}

type ContributionResult =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'timeout' | 'aborted' | 'failed'; readonly error?: unknown }

async function runContribution(input: {
  readonly contributor: BartContextContributor
  readonly parentContext: DebugContext
  readonly entryId: BartContextEntryId
  readonly harnessId: HarnessId
  readonly parentSignal: AbortSignal
  readonly timeoutMs: number
  readonly trackOperation?: (operation: Promise<unknown>) => void
}): Promise<ContributionResult> {
  const span = withDebugContext(input.parentContext, () => startDebugSpan(
    'bart.context.contributor',
    {
      entryId: input.entryId,
      harnessId: input.harnessId,
      timeoutMs: input.timeoutMs
    }
  ))
  if (input.parentSignal.aborted) {
    const error = input.parentSignal.reason
    span.fail(error ?? new Error('Bart context contribution aborted'), { outcome: 'aborted' })
    return { kind: 'aborted', error }
  }

  const controller = new AbortController()
  return await new Promise<ContributionResult>((resolve) => {
    let settled = false
    const finish = (result: ContributionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.parentSignal.removeEventListener('abort', onParentAbort)
      withDebugContext(span.context, () => {
        if (result.kind === 'value') {
          span.end({ outcome: 'value' })
        } else {
          span.fail(
            result.error ?? new Error(`Bart context contribution ${result.kind}`),
            { outcome: result.kind }
          )
        }
      })
      resolve(result)
    }
    const onParentAbort = (): void => {
      controller.abort(input.parentSignal.reason)
      finish({ kind: 'aborted', error: input.parentSignal.reason })
    }
    const timeout = setTimeout(() => {
      const error = new Error(`Bart context contribution timed out after ${input.timeoutMs}ms`)
      controller.abort(error)
      finish({ kind: 'timeout', error })
    }, input.timeoutMs)
    input.parentSignal.addEventListener('abort', onParentAbort, { once: true })

    if (input.parentSignal.aborted) {
      onParentAbort()
      return
    }

    const operation = withDebugContext(span.context, () => Promise.resolve()
      .then(() => input.contributor({ signal: controller.signal })))
    input.trackOperation?.(operation)
    void operation.then(
      (value) => withDebugContext(span.context, () => finish({ kind: 'value', value })),
      (error: unknown) => withDebugContext(span.context, () => finish({ kind: 'failed', error }))
    )
  })
}

function reportFailure(
  reporter: ((failure: BartContextContributionFailure) => void) | undefined,
  failure: BartContextContributionFailure,
  context?: DebugContext
): void {
  try {
    const report = () => debugError(
      'bart.context.failure',
      failure.error ?? new Error(`Bart context contribution ${failure.reason}`),
      {
        entryId: failure.entryId,
        harnessId: failure.harnessId,
        reason: failure.reason
      }
    )
    if (context) withDebugContext(context, report)
    else report()
    reporter?.(failure)
  } catch {
    // Diagnostics cannot change Bart context isolation semantics.
  }
}

function ensureDebugContext(fields: Partial<DebugContext>): DebugContext {
  const current = getDebugContext()
  return current.traceId
    ? { ...current, ...fields }
    : createDebugTrace(fields)
}
