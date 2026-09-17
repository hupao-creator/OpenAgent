export interface RendererFirstCommitDiagnostic {
  readonly kind: 'reasoning' | 'text'
  readonly threadId: string
  readonly executionId: string
  /** Renderer-local monotonic delay from commit to the following frame. */
  readonly durationMs: number
}
