import { createHash } from 'node:crypto'
import {
  bartEvaluationBenchmarkScores,
  immutableBartEvaluationFactsSnapshot,
  type BartEvaluationConfiguration,
  type BartEvaluationFactsSnapshot,
  type BartEvaluationRelease,
  type BartModelEvaluation
} from './evaluation-facts.js'
import {
  unavailableBartEvaluationFacts
} from './evaluation-policy.js'

const MODELS_INDEX_URL = 'https://artificialanalysis.ai/models/'
const MODEL_URL_PREFIX = 'https://artificialanalysis.ai/models/'
const SOURCE = 'artificial-analysis'
const CACHE_SCHEMA_VERSION = 1
const DETAIL_CONCURRENCY = 4
const REQUEST_TIMEOUT_MS = 15_000
const MAX_ATTEMPTS = 3
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000
const RETRY_INTERVAL_MS = 10 * 60 * 1_000
const MAX_CONFIGURATIONS = 10_000
const MAX_LOCAL_IDENTITY_SETS = 4_096

export interface ArtificialAnalysisFactsStore {
  load(): Promise<unknown | null>
  save(value: unknown): Promise<void>
}

export interface ArtificialAnalysisModelFactsOptions {
  readonly store?: ArtificialAnalysisFactsStore
  readonly fetchImplementation?: typeof fetch
  readonly now?: () => Date
  readonly onPublished?: (snapshot: BartEvaluationFactsSnapshot) => void
}

interface ConfigurationIdentity {
  readonly slug: string
  readonly releaseSlug: string
  readonly releaseName: string
  readonly configuration: BartEvaluationConfiguration
}

interface EvaluationFacts extends Omit<
  BartModelEvaluation,
  'slug' | 'configuration'
> {}

interface PersistedConfiguration extends ConfigurationIdentity {
  readonly observedAt: string
  readonly etag?: string
  readonly facts?: EvaluationFacts
}

interface PersistedArtificialAnalysisSnapshot {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION
  readonly source: typeof SOURCE
  readonly observedAt: string
  readonly fetchedAt: string
  readonly configurations: readonly PersistedConfiguration[]
}

type DocumentResponse =
  | { readonly status: 'ok'; readonly body: string; readonly etag?: string }
  | { readonly status: 'not-modified'; readonly etag?: string }
  | { readonly status: 'gone' }

/**
 * Plugin-owned live facts coordinator. A persisted current generation is the
 * last-known-good; a failed refresh never replaces it. With no current cache,
 * `waitForBootstrap` waits for the first live generation and returns an
 * explicitly unavailable empty snapshot if it fails.
 */
export class ArtificialAnalysisModelFacts {
  private readonly lifecycleController = new AbortController()
  private current: PersistedArtificialAnalysisSnapshot | undefined
  /**
   * Equal catalog requests share one generation. A different catalog observed
   * while refresh is active is serialized behind it instead of incorrectly
   * inheriting a generation that never inspected its identities.
   */
  private readonly refreshRequests = new Map<string, Promise<boolean>>()
  private refreshTail: Promise<void> = Promise.resolve()
  private readonly observedCatalogs = new Set<string>()
  private nextRefreshAt = 0
  private stopped = false

  constructor(private readonly options: ArtificialAnalysisModelFactsOptions = {}) {}

  snapshot(): BartEvaluationFactsSnapshot {
    return this.current
      ? publishedSnapshot(this.current)
      : unavailableBartEvaluationFacts(SOURCE)
  }

  /** Loads only the new current cache schema. No previous schema is migrated. */
  async initialize(): Promise<void> {
    if (!this.options.store) return
    const loaded = parsePersistedArtificialAnalysisSnapshot(
      await this.options.store.load().catch(() => null)
    )
    if (!loaded) return
    this.current = loaded
    this.nextRefreshAt = Date.parse(loaded.fetchedAt) + REFRESH_INTERVAL_MS
  }

  refreshDue(): boolean {
    return !this.stopped && this.nowMs() >= this.nextRefreshAt
  }

  /**
   * Cold start waits for live facts. A warm last-known-good generation is
   * returned immediately while any due refresh continues in the background.
   */
  async waitForBootstrap(
    localModelIdentitySets: readonly (readonly string[])[],
    signal: AbortSignal
  ): Promise<BartEvaluationFactsSnapshot> {
    throwIfAborted(signal)
    const identities = normalizedIdentitySets(localModelIdentitySets)
    const catalogKey = identitySetsKey(identities)
    const newCatalog = !this.observedCatalogs.has(catalogKey)
    if (newCatalog) {
      if (this.observedCatalogs.size >= MAX_LOCAL_IDENTITY_SETS) {
        this.observedCatalogs.delete(this.observedCatalogs.values().next().value!)
      }
      this.observedCatalogs.add(catalogKey)
    }
    const missingCatalogKnowledge = newCatalog && this.current !== undefined &&
      identities.some(identity => !matchReleaseIdentity(identity, releaseIdentities(this.current!.configurations)))
    if (!this.current && (this.refreshDue() || this.refreshRequests.size > 0)) {
      await waitWithSignal(this.refresh(localModelIdentitySets), signal)
    } else if (this.current && (missingCatalogKnowledge || this.refreshDue() || this.refreshRequests.size > 0)) {
      // A warm LKG never waits. Registering a different concurrent catalog is
      // still necessary so the next context contribution can observe its completed facts.
      void this.refresh(localModelIdentitySets)
    }
    throwIfAborted(signal)
    return this.snapshot()
  }

  /** Equal concurrent catalogs share one generation; distinct ones serialize. */
  refresh(localModelIdentitySets: readonly (readonly string[])[]): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    const identities = normalizedIdentitySets(localModelIdentitySets)
    const requestKey = identitySetsKey(identities)
    const existing = this.refreshRequests.get(requestKey)
    if (existing) return existing
    this.nextRefreshAt = this.nowMs() + RETRY_INTERVAL_MS
    const operation = this.refreshTail.then(async () => {
      if (this.stopped) return false
      const published = await this.refreshGeneration(identities).catch(() => false)
      this.nextRefreshAt = this.nowMs() + (
        published ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS
      )
      return published
    })
    this.refreshRequests.set(requestKey, operation)
    this.refreshTail = operation.then(() => undefined, () => undefined)
    void operation.finally(() => {
      if (this.refreshRequests.get(requestKey) === operation) {
        this.refreshRequests.delete(requestKey)
      }
    }).catch(() => undefined)
    return operation
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.lifecycleController.abort(new Error('Artificial Analysis facts stopped'))
  }

  /** Aborts network work and drains the complete refresh/store generation. */
  async dispose(): Promise<void> {
    this.stop()
    await this.refreshTail
  }

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime()
  }

  private async refreshGeneration(
    localModelIdentitySets: readonly (readonly string[])[]
  ): Promise<boolean> {
    const previous = this.current
    const previousConfigurations = previous?.configurations ?? []
    const index = await this.fetchDocument(MODELS_INDEX_URL)
    if (index.status !== 'ok') {
      throw new Error('Artificial Analysis model index is unavailable')
    }
    const indexConfigurations = parseIndexConfigurations(index.body)
    if (indexConfigurations.length === 0) {
      throw new Error('Artificial Analysis model index has no configurations')
    }

    const releaseRoster = releaseIdentities([
      ...indexConfigurations,
      ...previousConfigurations
    ])
    const matchedReleaseSlugs = new Set(localModelIdentitySets.flatMap(identities => {
      const release = matchReleaseIdentity(identities, releaseRoster)
      return release ? [release.slug] : []
    }))
    const targets = new Map<string, ConfigurationIdentity>()
    for (const configuration of [...indexConfigurations, ...previousConfigurations]) {
      if (!matchedReleaseSlugs.has(configuration.releaseSlug)) continue
      if (!targets.has(configuration.slug)) targets.set(configuration.slug, configuration)
    }

    const refreshed = await mapWithConcurrency(
      [...targets.values()],
      DETAIL_CONCURRENCY,
      target => this.refreshConfiguration(
        target,
        previousConfigurations.find(entry => entry.slug === target.slug)
      )
    )
    const retained = previousConfigurations.filter(entry => !targets.has(entry.slug))
    const configurations = [
      ...retained,
      ...refreshed.flatMap(entry => entry ? [entry] : [])
    ].sort((left, right) => left.slug.localeCompare(right.slug))
    if (configurations.length > MAX_CONFIGURATIONS) {
      throw new Error('Artificial Analysis configuration cache is too large')
    }

    const completedAt = (this.options.now?.() ?? new Date()).toISOString()
    const next: PersistedArtificialAnalysisSnapshot = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      source: SOURCE,
      observedAt: completedAt,
      fetchedAt: completedAt,
      configurations
    }
    const validated = parsePersistedArtificialAnalysisSnapshot(next)
    if (!validated) throw new Error('Generated Artificial Analysis snapshot is invalid')
    if (this.stopped) return false
    await this.options.store?.save(validated)
    if (this.stopped) return false
    this.current = validated
    this.options.onPublished?.(this.snapshot())
    return true
  }

  private async refreshConfiguration(
    target: ConfigurationIdentity,
    previous: PersistedConfiguration | undefined
  ): Promise<PersistedConfiguration | undefined> {
    const observedAt = (this.options.now?.() ?? new Date()).toISOString()
    try {
      const response = await this.fetchDocument(
        MODEL_URL_PREFIX + encodeURIComponent(target.slug),
        previous?.etag
      )
      if (response.status === 'gone') return undefined
      if (response.status === 'not-modified') {
        return previous
          ? {
              ...previous,
              observedAt,
              ...(response.etag ? { etag: response.etag } : {})
            }
          : { ...target, observedAt }
      }
      const page = parseConfigurationPage(response.body)
      return {
        ...page.identity,
        observedAt,
        ...(response.etag ? { etag: response.etag } : {}),
        ...(page.facts ? { facts: page.facts } : {})
      }
    } catch {
      return previous ? { ...previous, observedAt } : { ...target, observedAt }
    }
  }

  private async fetchDocument(url: string, etag?: string): Promise<DocumentResponse> {
    const fetchImplementation = this.options.fetchImplementation ?? fetch
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (this.stopped) throw new Error('Artificial Analysis facts stopped')
      const controller = new AbortController()
      const lifecycleAborted = (): void => controller.abort(
        this.lifecycleController.signal.reason
      )
      this.lifecycleController.signal.addEventListener('abort', lifecycleAborted, {
        once: true
      })
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetchImplementation(url, {
          ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
          signal: controller.signal
        })
        const responseEtag = response.headers.get('etag') || etag
        if (response.status === 404 || response.status === 410) return { status: 'gone' }
        if (response.status === 304) {
          return {
            status: 'not-modified',
            ...(responseEtag ? { etag: responseEtag } : {})
          }
        }
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
        return {
          status: 'ok',
          body: await response.text(),
          ...(responseEtag ? { etag: responseEtag } : {})
        }
      } catch (error) {
        lastError = error
        if (this.stopped) throw error
        if (attempt + 1 < MAX_ATTEMPTS) await delay(250 * (2 ** attempt))
      } finally {
        clearTimeout(timeout)
        this.lifecycleController.signal.removeEventListener('abort', lifecycleAborted)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`)
  }
}

function publishedSnapshot(
  persisted: PersistedArtificialAnalysisSnapshot
): BartEvaluationFactsSnapshot {
  const releases = new Map<string, BartEvaluationRelease>()
  for (const configuration of persisted.configurations) {
    if (!configuration.facts) continue
    const existing = releases.get(configuration.releaseSlug)
    const evaluation: BartModelEvaluation = {
      slug: configuration.slug,
      evaluatedModel: configuration.facts.evaluatedModel,
      configuration: { ...configuration.configuration },
      deprecated: configuration.facts.deprecated,
      intelligenceIndex: configuration.facts.intelligenceIndex,
      medianOutputTokensPerSecond:
        configuration.facts.medianOutputTokensPerSecond,
      costPerIntelligenceIndexTaskUsd:
        configuration.facts.costPerIntelligenceIndexTaskUsd,
      benchmarkScores: { ...configuration.facts.benchmarkScores },
      medianTimeToFirstAnswerTokenSeconds:
        configuration.facts.medianTimeToFirstAnswerTokenSeconds,
      inputUsdPer1MTokens: configuration.facts.inputUsdPer1MTokens,
      outputUsdPer1MTokens: configuration.facts.outputUsdPer1MTokens
    }
    if (existing) {
      releases.set(existing.slug, {
        ...existing,
        evaluations: [...existing.evaluations, evaluation]
      })
    } else {
      releases.set(configuration.releaseSlug, {
        slug: configuration.releaseSlug,
        name: configuration.releaseName,
        aliases: [],
        evaluations: [evaluation]
      })
    }
  }
  return immutableBartEvaluationFactsSnapshot({
    source: SOURCE,
    observedAt: persisted.observedAt,
    availability: 'available',
    releases: [...releases.values()]
  })
}

interface ReleaseIdentity {
  readonly slug: string
  readonly name: string
}

function releaseIdentities(configurations: readonly ConfigurationIdentity[]): ReleaseIdentity[] {
  const releases = new Map<string, ReleaseIdentity>()
  for (const configuration of configurations) {
    if (!releases.has(configuration.releaseSlug)) {
      releases.set(configuration.releaseSlug, {
        slug: configuration.releaseSlug,
        name: configuration.releaseName
      })
    }
  }
  return [...releases.values()]
}

function matchReleaseIdentity(
  identities: readonly string[],
  releases: readonly ReleaseIdentity[]
): ReleaseIdentity | undefined {
  const identityTokens = identities.map(modelIdentityTokens).filter(tokens => tokens.length)
  let best: ReleaseIdentity[] = []
  let bestSpecificity = 0
  for (const release of releases) {
    let specificity = 0
    for (const candidate of [release.slug, release.name]) {
      const releaseTokens = modelIdentityTokens(candidate)
      if (releaseTokens.length <= specificity) continue
      if (identityTokens.some(tokens => tokensContained(releaseTokens, tokens))) {
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
  return best.length === 1 ? best[0] : undefined
}

function parseIndexConfigurations(html: string): ConfigurationIdentity[] {
  const configurations = new Map<string, ConfigurationIdentity>()
  const arrayStart = /\\"[A-Za-z0-9_]+\\":\[\{\\"/g
  let match: RegExpExecArray | null
  while ((match = arrayStart.exec(html))) {
    const serialized = readEmbeddedJson(html, match.index + match[0].indexOf('['))
    if (!serialized) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(serialized)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    for (const entry of parsed) {
      const identity = configurationIdentity(entry)
      if (identity && !configurations.has(identity.slug)) {
        configurations.set(identity.slug, identity)
      }
    }
  }
  return [...configurations.values()]
}

function parseConfigurationPage(html: string): {
  readonly identity: ConfigurationIdentity
  readonly facts?: EvaluationFacts
} {
  const marker = '\\"currentModel\\":'
  const markerIndex = html.indexOf(marker)
  if (markerIndex < 0) throw new Error('AA page is missing currentModel')
  const serialized = readEmbeddedJson(html, markerIndex + marker.length)
  if (!serialized) throw new Error('AA currentModel is incomplete')
  const model = JSON.parse(serialized) as unknown
  const identity = configurationIdentity(model)
  if (!identity || !isRecord(model)) throw new Error('AA model identity is invalid')

  const evaluatedModel = canonicalSourceString(model.name) ?? identity.slug
  const speed = isRecord(model.timescaleData)
    ? model.timescaleData.medianOutputSpeed
    : undefined
  const costPerTask = isRecord(model.intelligenceIndexCostPerTask) &&
    isRecord(model.intelligenceIndexCostPerTask.cost)
    ? model.intelligenceIndexCostPerTask.cost.total
    : undefined
  if (!positive(model.intelligenceIndex) || !positive(speed) || !positive(costPerTask)) {
    return { identity }
  }
  const firstAnswer = isRecord(model.timeToFirstAnswerToken)
    ? model.timeToFirstAnswerToken.total
    : undefined
  return {
    identity,
    facts: {
      evaluatedModel,
      deprecated: model.deprecated === true,
      intelligenceIndex: model.intelligenceIndex,
      medianOutputTokensPerSecond: speed,
      costPerIntelligenceIndexTaskUsd: costPerTask,
      benchmarkScores: bartEvaluationBenchmarkScores({
        hleText: proportion(model.hle) ? model.hle : null,
        terminalBenchV21: proportion(model.terminalbenchV21)
          ? model.terminalbenchV21
          : null,
        tau3Banking: proportion(model.tauBanking) ? model.tauBanking : null
      }),
      medianTimeToFirstAnswerTokenSeconds: nonNegative(firstAnswer)
        ? firstAnswer
        : null,
      inputUsdPer1MTokens: nonNegative(model.price1mInputTokens)
        ? model.price1mInputTokens
        : null,
      outputUsdPer1MTokens: nonNegative(model.price1mOutputTokens)
        ? model.price1mOutputTokens
        : null
    }
  }
}

function configurationIdentity(value: unknown): ConfigurationIdentity | undefined {
  if (!isRecord(value)) return undefined
  const release = value.release
  const slug = canonicalSourceString(value.slug)
  if (!slug || typeof value.isReasoning !== 'boolean' || !isRecord(release)) {
    return undefined
  }
  const releaseSlug = canonicalSourceString(release.slug)
  const releaseName = canonicalSourceString(release.name)
  if (!releaseSlug || !releaseName) return undefined
  const effort = isRecord(value.effort)
    ? canonicalSourceString(value.effort.slug)
    : undefined
  return {
    slug,
    releaseSlug,
    releaseName,
    configuration: value.isReasoning
      ? { reasoning: true, ...(effort ? { effort } : {}) }
      : { reasoning: false }
  }
}

function readEmbeddedJson(raw: string, start: number): string | undefined {
  let decoded = ''
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    let character = raw[index]
    if (character === '\\') {
      const next = raw[index + 1]
      if (next === '"' || next === '\\') {
        character = next
        index += 1
      }
    }
    decoded += character
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') {
      depth -= 1
      if (depth === 0) return decoded
    }
  }
  return undefined
}

export function parsePersistedArtificialAnalysisSnapshot(
  value: unknown
): PersistedArtificialAnalysisSnapshot | undefined {
  if (!isRecord(value)) return undefined
  if (!hasExactKeys(
    value,
    ['schemaVersion', 'source', 'observedAt', 'fetchedAt', 'configurations']
  )) return undefined
  if (value.schemaVersion !== CACHE_SCHEMA_VERSION || value.source !== SOURCE) {
    return undefined
  }
  if (!validIsoDate(value.observedAt) || !validIsoDate(value.fetchedAt)) return undefined
  if (!Array.isArray(value.configurations) ||
      value.configurations.length > MAX_CONFIGURATIONS ||
      !value.configurations.every(isPersistedConfiguration)) {
    return undefined
  }
  const slugs = value.configurations.map(configuration => configuration.slug)
  if (new Set(slugs).size !== slugs.length) return undefined
  return value as unknown as PersistedArtificialAnalysisSnapshot
}

function isPersistedConfiguration(value: unknown): value is PersistedConfiguration {
  if (!isRecord(value)) return false
  if (!hasExactKeys(
    value,
    [
      'slug',
      'releaseSlug',
      'releaseName',
      'configuration',
      'observedAt',
      'etag',
      'facts'
    ],
    ['etag', 'facts']
  )) return false
  if (!canonicalSourceString(value.slug) ||
      !canonicalSourceString(value.releaseSlug) ||
      !canonicalSourceString(value.releaseName) ||
      !validIsoDate(value.observedAt)) return false
  if (value.etag !== undefined && !canonicalSourceString(value.etag, 4_096)) return false
  if (!isConfiguration(value.configuration)) return false
  return value.facts === undefined || isEvaluationFacts(value.facts)
}

function isConfiguration(value: unknown): value is BartEvaluationConfiguration {
  if (!isRecord(value) || !hasExactKeys(value, ['reasoning', 'effort'], ['effort'])) {
    return false
  }
  if (typeof value.reasoning !== 'boolean') return false
  if (value.effort === undefined) return true
  return value.reasoning && Boolean(canonicalSourceString(value.effort, 128))
}

function isEvaluationFacts(value: unknown): value is EvaluationFacts {
  if (!isRecord(value) || !hasExactKeys(value, [
    'evaluatedModel',
    'deprecated',
    'intelligenceIndex',
    'medianOutputTokensPerSecond',
    'costPerIntelligenceIndexTaskUsd',
    'benchmarkScores',
    'medianTimeToFirstAnswerTokenSeconds',
    'inputUsdPer1MTokens',
    'outputUsdPer1MTokens'
  ])) return false
  if (!canonicalSourceString(value.evaluatedModel)) return false
  if (typeof value.deprecated !== 'boolean') return false
  if (!positive(value.intelligenceIndex) ||
      !positive(value.medianOutputTokensPerSecond) ||
      !positive(value.costPerIntelligenceIndexTaskUsd)) return false
  if (!isBenchmarkScores(value.benchmarkScores)) return false
  return optionalNonNegative(value.medianTimeToFirstAnswerTokenSeconds) &&
    optionalNonNegative(value.inputUsdPer1MTokens) &&
    optionalNonNegative(value.outputUsdPer1MTokens)
}

function isBenchmarkScores(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['hleText', 'terminalBenchV21', 'tau3Banking']
  )) return false
  return Object.values(value).every(score => score === null || proportion(score))
}

function normalizedIdentitySets(
  values: readonly (readonly string[])[]
): readonly (readonly string[])[] {
  if (values.length > MAX_LOCAL_IDENTITY_SETS) {
    throw new Error(`Local model identity sets cannot exceed ${MAX_LOCAL_IDENTITY_SETS}`)
  }
  return values.map(identities => [...new Set(identities.flatMap(value => {
    const identity = typeof value === 'string' ? value.trim() : ''
    return identity && identity.length <= 1_024 && !identity.includes('\0')
      ? [identity]
      : []
  }))])
}

function identitySetsKey(values: readonly (readonly string[])[]): string {
  return createHash('sha256').update(JSON.stringify(values
    .map(identities => [...identities].sort())
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))))
    .digest('hex')
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length })
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(values[index])
    }
  }))
  return results
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set(keys)
  const optionalKeys = new Set(optional)
  return Object.keys(value).every(key => allowed.has(key)) &&
    keys.every(key => optionalKeys.has(key) || Object.hasOwn(value, key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalSourceString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value === value.trim() && !value.includes('\0')
    ? value
    : undefined
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0
}

function proportion(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1
}

function optionalNonNegative(value: unknown): boolean {
  return value === null || nonNegative(value)
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
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

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('The operation was aborted', 'AbortError')
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason ?? new DOMException(
      'The operation was aborted',
      'AbortError'
    ))
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', aborted)
    })
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
