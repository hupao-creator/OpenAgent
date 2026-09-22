/** Shared Bart evaluation matching and advisory formatting. */
import {
  BART_EVALUATION_BENCHMARK_IDS,
  immutableBartEvaluationFactsSnapshot,
  type BartEvaluationBenchmarkId,
  type BartEvaluationBenchmarkScores,
  type BartEvaluationConfiguration,
  type BartEvaluationFactsSnapshot,
  type BartEvaluationModelIdentity,
  type BartEvaluationRelease
} from './evaluation-facts.js'

export interface BartEvaluationBenchmarkDefinition {
  readonly id: BartEvaluationBenchmarkId
  readonly name: string
  readonly evaluator: string
  readonly datasetVersion: string
  readonly metric: string
  readonly scoreUnit: 'proportion'
  readonly scoreRange: readonly [0, 1]
  readonly harness: string
  readonly repeats?: number
}

export const BART_EVALUATION_BENCHMARK_DEFINITIONS:
readonly BartEvaluationBenchmarkDefinition[] = [
  {
    id: 'hleText',
    name: "Humanity's Last Exam (text-only)",
    evaluator: 'Artificial Analysis',
    datasetVersion:
      'Text-only HLE questions scored inside the Artificial Analysis Intelligence Index',
    metric: 'pass@1',
    scoreUnit: 'proportion',
    scoreRange: [0, 1],
    harness: 'Artificial Analysis zero-shot text evaluation',
    repeats: 1
  },
  {
    id: 'terminalBenchV21',
    name: 'Terminal-Bench 2.1',
    evaluator: 'Artificial Analysis',
    datasetVersion:
      'Terminal-Bench 2.1 scored inside the Artificial Analysis Intelligence Index',
    metric: 'test-suite pass@1',
    scoreUnit: 'proportion',
    scoreRange: [0, 1],
    harness: 'Terminus 2'
  },
  {
    id: 'tau3Banking',
    name: 'τ³-Banking',
    evaluator: 'Artificial Analysis',
    datasetVersion:
      'τ³-Banking scored inside the Artificial Analysis Intelligence Index',
    metric: 'backend-state pass@1',
    scoreUnit: 'proportion',
    scoreRange: [0, 1],
    harness: 'Artificial Analysis agent-user simulation'
  }
]

export interface BartEvaluationNativeModel {
  /** Plugin-owned display label; the formatter does not interpret it. */
  readonly label: string
  readonly identity: BartEvaluationModelIdentity
}

export type BartEvaluationReleaseMatch =
  | { readonly status: 'matched'; readonly release: BartEvaluationRelease }
  | { readonly status: 'unmatched' }
  | { readonly status: 'ambiguous' }

export const BART_EVALUATION_FACTS_SCOPE =
  'Objective model evaluation facts and selection advice for native catalog models that uniquely match one source release with at least one complete evaluation configuration. Native-supported models remain selectable regardless of missing or poor evaluation results.'

export const BART_EVALUATION_FACTS_MEANING =
  'Each evaluation describes only the source-observed configuration named by reasoning and optional effort. Intelligence Index, median output tokens per second, and cost per Intelligence Index task are configuration facts; they do not describe a local subscription, re-hosted route, or service tier. A local reasoning, variant, or service-tier selection without an exactly matching evaluation is unmeasured. deprecated is evaluator source metadata only: it does not remove a model from its provider-native catalog. Configuration choices and validation belong to the native settings contract; these facts do not add constraints.'

export const BART_EVALUATION_BENCHMARK_SCORE_MEANING =
  'Benchmark scores are optional evaluator-native proportions for the same evaluation configuration. Null means the source published no score; scores are not normalized, combined, or converted into ranks.'

export const DEFAULT_BART_EVALUATION_ROUTING_GUIDANCE =
  'When routing models, prefer high-intelligence models for complex planning, critical decisions, and independent review, accepting higher cost when warranted. For execution with verifiable results, prefer models that are sufficiently capable, low-cost, and fast. For low-risk information retrieval and initial screening, always prefer the lowest-cost available candidate capable of completing the task, and upgrade only when there is a clear capability, tooling, or reliability gap. Raise the model tier when a task is high-risk, ambiguous, difficult to verify, or requires synthesis and judgment. Treat only the published quality, speed, cost, and benchmark fields as measured evidence.'

const MAX_FORMATTED_EVALUATIONS = 64
/**
 * Keep each final evaluation context contribution bounded independently of
 * native settings and the other context entries. This is a UTF-8 byte limit
 * rather than a JavaScript string-length limit because native labels are not
 * necessarily ASCII.
 */
export const MAX_BART_EVALUATION_FORMATTED_BYTES = 24 * 1024

export function unavailableBartEvaluationFacts(
  source = 'artificial-analysis'
): BartEvaluationFactsSnapshot {
  return immutableBartEvaluationFactsSnapshot({
    source,
    observedAt: null,
    availability: 'unavailable',
    releases: []
  })
}

/**
 * Generic token-containment identity match. The most specific source identity
 * wins; a specificity tie omits uncertain evaluation facts. All tokens for a
 * candidate must occur in one native identity.
 */
export function matchBartEvaluationRelease(
  snapshot: BartEvaluationFactsSnapshot,
  identity: BartEvaluationModelIdentity
): BartEvaluationReleaseMatch {
  if (snapshot.availability !== 'available') return { status: 'unmatched' }
  if (identity.evaluationRelease !== undefined) {
    const release = snapshot.releases.find(value => value.slug === identity.evaluationRelease && value.evaluations.length > 0)
    return release ? { status: 'matched', release } : { status: 'unmatched' }
  }
  const nativeTokens = [identity.selector, identity.displayName, ...(identity.aliases ?? [])]
    .flatMap(value => value === undefined ? [] : [modelIdentityTokens(value)])
    .filter(tokens => tokens.length > 0)
  if (nativeTokens.length === 0) return { status: 'unmatched' }

  let best: BartEvaluationRelease[] = []
  let bestSpecificity = 0
  for (const release of snapshot.releases) {
    if (release.evaluations.length === 0) continue
    let specificity = 0
    for (const candidate of [release.slug, release.name, ...release.aliases]) {
      const releaseTokens = modelIdentityTokens(candidate)
      if (releaseTokens.length <= specificity) continue
      if (nativeTokens.some(tokens => tokensContained(releaseTokens, tokens))) {
        specificity = releaseTokens.length
      }
    }
    if (specificity === 0) continue
    if (specificity > bestSpecificity) {
      bestSpecificity = specificity
      best = [release]
    } else if (
      specificity === bestSpecificity &&
      !best.some(candidate => candidate.slug === release.slug)
    ) {
      best.push(release)
    }
  }
  if (best.length === 0) return { status: 'unmatched' }
  if (best.length > 1) return { status: 'ambiguous' }
  return { status: 'matched', release: best[0] }
}

/** Complete provider-neutral knowledge header for evaluation context. */
export function formatBartEvaluationFactsPreamble(
  snapshot: BartEvaluationFactsSnapshot
): string {
  const lines = [
    `Evaluation source: ${boundedText(snapshot.source, 256)}.`,
    `Evaluation availability: ${snapshot.availability}.`,
    `Evaluation knowledge observed at: ${snapshot.observedAt ?? 'unavailable'}.`,
    `Scope: ${BART_EVALUATION_FACTS_SCOPE}`,
    `Routing guidance: ${DEFAULT_BART_EVALUATION_ROUTING_GUIDANCE}`,
    `Evaluation meaning: ${BART_EVALUATION_FACTS_MEANING}`,
    `Benchmark score meaning: ${BART_EVALUATION_BENCHMARK_SCORE_MEANING}`,
    'Benchmark definitions:',
    ...BART_EVALUATION_BENCHMARK_DEFINITIONS.map(definition => [
      `- ${definition.id}: ${definition.name}`,
      `evaluator=${definition.evaluator}`,
      `dataset=${definition.datasetVersion}`,
      `metric=${definition.metric}`,
      `unit=${definition.scoreUnit}`,
      `range=${definition.scoreRange[0]}..${definition.scoreRange[1]}`,
      `harness=${definition.harness}`,
      ...(definition.repeats === undefined ? [] : [`repeats=${definition.repeats}`])
    ].join('; '))
  ]
  return boundedFormattedText(lines.join('\n'))
}

/**
 * Complete facts for one canonical match. This formatter deliberately emits
 * every baseline comparison field, including null supplements and deprecated
 * source metadata, so individual Plugins cannot silently shrink the evidence.
 */
export function formatBartEvaluationReleaseFacts(
  snapshot: BartEvaluationFactsSnapshot,
  match: BartEvaluationReleaseMatch
): string {
  if (snapshot.availability !== 'available') {
    return 'Evaluation facts unavailable; native-supported configurations remain selectable.'
  }
  if (match.status === 'unmatched') {
    return 'No complete evaluation release matched; this native model is unmeasured and remains selectable.'
  }
  if (match.status === 'ambiguous') {
    return 'Evaluation release matching is ambiguous; uncertain facts are omitted and the native model remains selectable.'
  }
  const release = match.release
  const evaluations = release.evaluations.slice(0, MAX_FORMATTED_EVALUATIONS)
  const lines = [
    `Canonical evaluation release: ${boundedText(release.slug, 512)} (${boundedText(release.name, 512)}).`,
    `Evaluation knowledge observed at: ${snapshot.observedAt ?? 'unavailable'}.`,
    ...evaluations.map(evaluation => [
      `- configuration=${formatConfiguration(evaluation.configuration)}`,
      `slug=${boundedText(evaluation.slug, 512)}`,
      `evaluatedModel=${boundedText(evaluation.evaluatedModel, 512)}`,
      `deprecated=${String(evaluation.deprecated)}`,
      `intelligenceIndex=${formatNumber(evaluation.intelligenceIndex)}`,
      `medianOutputTokensPerSecond=${formatNumber(evaluation.medianOutputTokensPerSecond)}`,
      `costPerIntelligenceIndexTaskUsd=${formatNumber(evaluation.costPerIntelligenceIndexTaskUsd)}`,
      `medianTimeToFirstAnswerTokenSeconds=${formatNullableNumber(evaluation.medianTimeToFirstAnswerTokenSeconds)}`,
      `inputUsdPer1MTokens=${formatNullableNumber(evaluation.inputUsdPer1MTokens)}`,
      `outputUsdPer1MTokens=${formatNullableNumber(evaluation.outputUsdPer1MTokens)}`,
      `benchmarkScores=${formatBenchmarkScores(evaluation.benchmarkScores)}`
    ].join('; ')),
    ...(release.evaluations.length > evaluations.length
      ? [`- ${String(release.evaluations.length - evaluations.length)} additional evaluation configurations omitted by the bounded formatter.`]
      : [])
  ]
  return boundedFormattedText(lines.join('\n'))
}

/**
 * Bounded complete knowledge block for one Plugin catalog. Canonical releases
 * are emitted once even when several native selectors alias the same model.
 */
export function formatBartEvaluationFactsForNativeModels(
  snapshot: BartEvaluationFactsSnapshot,
  models: readonly BartEvaluationNativeModel[]
): string {
  const matched = new Map<string, {
    readonly match: Extract<BartEvaluationReleaseMatch, { status: 'matched' }>
    readonly labels: string[]
  }>()
  const unmatched: string[] = []
  const ambiguous: string[] = []
  for (const model of models.slice(0, 512)) {
    const label = boundedText(model.label, 512)
    const match = matchBartEvaluationRelease(snapshot, model.identity)
    if (match.status === 'unmatched') {
      unmatched.push(label)
      continue
    }
    if (match.status === 'ambiguous') {
      ambiguous.push(label)
      continue
    }
    const group = matched.get(match.release.slug)
    if (group) group.labels.push(label)
    else matched.set(match.release.slug, { match, labels: [label] })
  }
  const lines = [
    formatBartEvaluationFactsPreamble(snapshot),
    'Objective evaluation facts for this native catalog:',
    ...[...matched.values()].flatMap(group => [
      `Native catalog identities: ${group.labels.join(', ')}.`,
      formatBartEvaluationReleaseFacts(snapshot, group.match)
    ]),
    ...(unmatched.length
      ? [`Unmeasured native catalog identities: ${unmatched.join(', ')}.`]
      : []),
    ...(ambiguous.length
      ? [`Ambiguous evaluation matches: ${ambiguous.join(', ')}. No evaluation facts are attributed to these identities.`]
      : []),
    ...(models.length > 512
      ? [`${String(models.length - 512)} additional native catalog identities omitted by the bounded formatter.`]
      : [])
  ]
  return boundedFormattedText(lines.join('\n'))
}

function formatConfiguration(configuration: BartEvaluationConfiguration): string {
  if (!configuration.reasoning) return 'reasoning:false'
  return configuration.effort
    ? `reasoning:true,effort:${boundedText(configuration.effort, 128)}`
    : 'reasoning:true'
}

function formatBenchmarkScores(scores: BartEvaluationBenchmarkScores): string {
  return BART_EVALUATION_BENCHMARK_IDS
    .map(id => `${id}:${formatNullableNumber(scores[id])}`)
    .join(',')
}

function formatNullableNumber(value: number | null): string {
  return value === null ? 'null' : formatNumber(value)
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'invalid'
}

function boundedText(value: string, maxCharacters: number): string {
  const clean = String(value).replace(/[\r\n\u0000]/g, ' ').trim()
  const characters = Array.from(clean)
  return characters.length <= maxCharacters
    ? clean
    : `${characters.slice(0, Math.max(0, maxCharacters - 1)).join('')}…`
}

function boundedFormattedText(value: string): string {
  if (utf8ByteLength(value) <= MAX_BART_EVALUATION_FORMATTED_BYTES) return value
  const marker = 'Additional evaluation knowledge omitted by the bounded formatter.'
  const available = MAX_BART_EVALUATION_FORMATTED_BYTES - utf8ByteLength(marker) - 1
  const prefix = truncateUtf8(value, Math.max(0, available)).replace(/\s+$/u, '')
  return `${prefix}\n${marker}`
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

/** Returns the longest UTF-16 prefix whose encoded form fits `maxBytes`. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8ByteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const prefix = value.slice(0, middle).replace(/[\uD800-\uDBFF]$/u, '')
    if (utf8ByteLength(prefix) <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low).replace(/[\uD800-\uDBFF]$/u, '')
}

function modelIdentityTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function tokensContained(needle: readonly string[], haystack: readonly string[]): boolean {
  const remaining = new Map<string, number>()
  for (const token of haystack) remaining.set(token, (remaining.get(token) ?? 0) + 1)
  for (const token of needle) {
    const count = remaining.get(token) ?? 0
    if (count === 0) return false
    remaining.set(token, count - 1)
  }
  return true
}
