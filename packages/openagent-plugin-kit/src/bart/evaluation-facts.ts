/**
 * Provider-neutral model evaluation facts supplied to Bart Plugins.
 *
 * The shared Plugin module owns acquisition and durability. A Plugin owns the mapping from its
 * native catalog identities to these canonical releases. No native selector,
 * Harness id, or provider-specific setting belongs in this contract.
 */

export const BART_EVALUATION_BENCHMARK_IDS = [
  'hleText',
  'terminalBenchV21',
  'tau3Banking'
] as const

export type BartEvaluationBenchmarkId =
  (typeof BART_EVALUATION_BENCHMARK_IDS)[number]

export type BartEvaluationBenchmarkScores = Readonly<
  Record<BartEvaluationBenchmarkId, number | null>
>

export interface BartEvaluationConfiguration {
  readonly reasoning: boolean
  readonly effort?: string
}

/** One complete, source-observed evaluation configuration. */
export interface BartModelEvaluation {
  readonly slug: string
  readonly evaluatedModel: string
  readonly configuration: BartEvaluationConfiguration
  /**
   * Evaluator source metadata; interpreting it for model routing belongs to
   * the Bart policy layer.
   */
  readonly deprecated: boolean
  readonly intelligenceIndex: number
  readonly medianOutputTokensPerSecond: number
  readonly costPerIntelligenceIndexTaskUsd: number
  readonly benchmarkScores: BartEvaluationBenchmarkScores
  readonly medianTimeToFirstAnswerTokenSeconds: number | null
  readonly inputUsdPer1MTokens: number | null
  readonly outputUsdPer1MTokens: number | null
}

export interface BartEvaluationRelease {
  /** Canonical source identity. */
  readonly slug: string
  readonly name: string
  /** Additional source-owned identities, never native provider selectors. */
  readonly aliases: readonly string[]
  readonly evaluations: readonly BartModelEvaluation[]
}

export interface BartEvaluationFactsSnapshot {
  readonly source: string
  readonly observedAt: string | null
  readonly availability: 'available' | 'unavailable'
  readonly releases: readonly BartEvaluationRelease[]
}

export interface BartEvaluationModelIdentity {
  readonly selector: string
  readonly displayName?: string
  readonly aliases?: readonly string[]
  /** Provider-authoritative release. Null suppresses uncertain name-based fallback. */
  readonly evaluationRelease?: string | null
}

/** Clone and recursively freeze the cross-Plugin facts generation. */
export function immutableBartEvaluationFactsSnapshot(
  snapshot: BartEvaluationFactsSnapshot
): BartEvaluationFactsSnapshot {
  return deepFreeze(structuredClone(snapshot))
}

export function bartEvaluationBenchmarkScores(
  scores: Partial<Record<BartEvaluationBenchmarkId, number | null>>
): BartEvaluationBenchmarkScores {
  return Object.fromEntries(BART_EVALUATION_BENCHMARK_IDS.map(id => [
    id,
    scores[id] ?? null
  ])) as unknown as BartEvaluationBenchmarkScores
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
