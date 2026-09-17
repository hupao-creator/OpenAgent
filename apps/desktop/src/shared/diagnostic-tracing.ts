/**
 * Process-neutral diagnostic identity. These fields are deliberately kept
 * separate from product request envelopes so they can be dropped at the
 * transport boundary and never reach a Harness or the model.
 */
export interface DiagnosticTraceContext {
  readonly traceId: string
  readonly spanId?: string
  readonly parentSpanId?: string
  readonly threadId?: string
  readonly executionId?: string
  readonly nativeSessionId?: string
  readonly harnessId?: string
}

/** Optional trailing argument carried by renderer -> Main IPC calls. */
export interface DiagnosticIpcEnvelope {
  readonly __openagentDiagnostic: true
  readonly context: DiagnosticTraceContext
}

export const DIAGNOSTIC_IPC_CHANNEL = 'debug:renderer' as const
/** Registered only while the effective Main debug mode accepts diagnostics. */
export const DIAGNOSTIC_MODE_CHANNEL = 'debug:renderer-mode' as const

export interface RendererFirstCommitDiagnostic {
  readonly kind: 'reasoning' | 'text'
  readonly threadId: string
  readonly executionId: string
  /** Renderer-local monotonic delay from commit to the following frame. */
  readonly durationMs: number
}

/**
 * Renderer diagnostics have a closed event set. Fields are modeled as a
 * discriminated union so adding a log line cannot accidentally become an
 * arbitrary renderer-controlled event or payload.
 */
export type RendererDiagnostic =
  | {
      readonly event: 'renderer.submit'
      readonly context: DiagnosticTraceContext
      readonly fields?: {
        readonly operation: 'bart-submit'
      }
    }
  | {
      readonly event: 'renderer.exception'
      readonly context?: DiagnosticTraceContext
      readonly fields: {
        readonly message: string
        readonly name?: string
        readonly stack?: string
        readonly source?: string
        readonly line?: number
        readonly column?: number
      }
    }
  | {
      readonly event: 'renderer.unhandled-rejection'
      readonly context?: DiagnosticTraceContext
      readonly fields: {
        readonly message: string
        readonly name?: string
        readonly stack?: string
      }
    }
  | {
      readonly event: 'renderer.first-reasoning-commit'
      readonly context?: DiagnosticTraceContext
      readonly fields: {
        readonly threadId: string
        readonly executionId: string
        /** Renderer-local monotonic delay from commit to the following frame. */
        readonly durationMs: number
      }
    }
  | {
      readonly event: 'renderer.first-text-commit'
      readonly context?: DiagnosticTraceContext
      readonly fields: {
        readonly threadId: string
        readonly executionId: string
        /** Renderer-local monotonic delay from commit to the following frame. */
        readonly durationMs: number
      }
    }

export type RendererDiagnosticEvent = RendererDiagnostic['event']

export const RENDERER_DIAGNOSTIC_EVENTS: readonly RendererDiagnosticEvent[] = [
  'renderer.submit',
  'renderer.exception',
  'renderer.unhandled-rejection',
  'renderer.first-reasoning-commit',
  'renderer.first-text-commit'
]

export function isRendererDiagnosticEvent(
  value: unknown
): value is RendererDiagnosticEvent {
  return typeof value === 'string' &&
    (RENDERER_DIAGNOSTIC_EVENTS as readonly string[]).includes(value)
}
