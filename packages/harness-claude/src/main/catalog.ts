import { randomUUID } from 'node:crypto'
import type { DeepReadonly } from '@openagent/contracts'
import {
  CLAUDE_EFFORT_LEVELS,
  type ClaudeModelPresentation,
  type ClaudeSettingsPresentationData,
  type ClaudeThreadSettingsRequest
} from '../shared/settings.js'
import { ClaudeTransport } from './runtime/transport.js'
import {
  debugEnvironmentSummary,
  debugError,
  debugLog,
  startDebugSpan
} from './debug.js'

export interface ClaudeCatalogContext {
  readonly providers?: import('@openagent/contracts').HarnessProviderAccess
  resolveExecutable(cwd: string, configuredPath?: string): Promise<string>
  environment(): Promise<NodeJS.ProcessEnv>
}

export interface ClaudeCatalogLoadInput {
  readonly executablePath?: string
  readonly cwd: string
  readonly signal: AbortSignal
  /** A user-initiated reload, which must not be answered from the cache. */
  readonly refresh?: boolean
}

/** Live, Plugin-owned source shared by settings, evaluation advice, and validation. */
export interface ClaudeCatalogSource {
  load(input: ClaudeCatalogLoadInput): Promise<ClaudeSettingsPresentationData>
}

/** Native catalogs move when the CLI or the account does, not per settings read. */
const CATALOG_TTL_MS = 5 * 60 * 1_000

export function createClaudeCatalogSource(
  context: ClaudeCatalogContext
): ClaudeCatalogSource {
  // Every settings read would otherwise boot a fresh transport for the same
  // executable. Only a real catalog is kept: an unavailable CLI has to be
  // retried, since its message is the only clue that the installation broke.
  const catalogs = new Map<string, { at: number; value: ClaudeSettingsPresentationData }>()
  // The newest load that has reached an identity, whether or not it succeeds.
  // Each load names two: the CLI the caller asked for, known before resolution,
  // and the executable resolution returns. The first is what fences a load that
  // dies before the cache key exists — an older snapshot landing late must not
  // take the cache back, and the next read has to retry rather than replay an
  // answer a newer load already retired. The second is needed because one binary
  // has two names: a caller that names the executable and one that lets the host
  // detect it share this cache but not their requested identity, so without it
  // the older of the two would overwrite the newer.
  const newest = new Map<string, number>()
  let sequence = 0
  // A refresh retires everything that began before it, including loads still in
  // flight under a name it cannot know yet: the reader asked for the truth as it
  // is now, and whoever is on the way with the older truth must not land.
  let obsolete = 0
  return {
    async load(input) {
      throwIfAborted(input.signal)
      const configuredExecutable = input.executablePath || 'claude'
      // Numbered before the executable is even resolved: cache misses run
      // concurrently, and a load that started earlier must not win the write
      // just because it finished later. Resolution order is not start order.
      const request = ++sequence
      const asked = `${configuredExecutable}\0${input.cwd}`
      newest.set(asked, request)
      if (input.refresh) {
        // Retire the snapshots up front rather than only the one this load
        // happens to name: a refresh that comes back empty or broken must not
        // leave the answer it set out to replace in place for the rest of the
        // TTL.
        obsolete = request
        catalogs.clear()
      }
      let executable = configuredExecutable
      let transport: ClaudeTransport | undefined
      const probe = startDebugSpan('claude.catalog.probe', {
        harnessId: 'claude',
        purpose: 'model-catalog',
        cwd: input.cwd,
        configuredExecutable
      })
      try {
        const resolveSpan = startDebugSpan('claude.resolve-environment', {
          harnessId: 'claude',
          purpose: 'model-catalog',
          cwd: input.cwd,
          configuredExecutable
        })
        let resolved: [string, NodeJS.ProcessEnv]
        try {
          resolved = await abortable(Promise.all([
            context.resolveExecutable(input.cwd, input.executablePath),
            context.environment()
          ]), input.signal)
          resolveSpan.end({
            executable: resolved[0],
            ...debugEnvironmentSummary(resolved[1])
          })
        } catch (error) {
          resolveSpan.fail(error)
          throw error
        }
        executable = resolved[0]
        const environment = resolved[1]
        throwIfAborted(input.signal)
        const key = `${executable}\0${input.cwd}`
        newest.set(key, Math.max(newest.get(key) ?? 0, request))
        const cached = input.refresh ? undefined : catalogs.get(key)
        if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
          throwIfAborted(input.signal)
          debugLog('claude.catalog.cache-hit', {
            harnessId: 'claude',
            purpose: 'model-catalog',
            executable,
            modelCount: cached.value.models.length
          })
          probe.end({ modelCount: cached.value.models.length, available: true })
          return cached.value
        }
        transport = new ClaudeTransport({
          executable,
          cwd: input.cwd,
          environment,
          providerInjection: context.providers?.explicit?.injection,
          sessionId: randomUUID(),
          resume: false,
          settings: { executablePath: configuredExecutable },
          interactive: false,
          persistSession: false,
          debugPurpose: 'model-catalog',
          applicationToolsOnly: true,
          onEvent: () => undefined
        })
        const initialization = await abortable(
          transport.inspectInitialization(),
          input.signal
        )
        throwIfAborted(input.signal)
        const version = initializationVersion(initialization)
        const result: ClaudeSettingsPresentationData = {
          cli: {
            status: 'available',
            executablePath: executable,
            ...(version ? { version } : {})
          },
          models: initializationModels(initialization)
        }
        // Validation reads an empty catalog as unavailable, so caching one would
        // keep replaying the broken answer after the CLI or account recovered.
        // Only the newest load for either identity may write: a later one has
        // already superseded this answer even if it ended in a failure.
        const current =
          request >= obsolete &&
          newest.get(asked) === request &&
          newest.get(key) === request
        if (result.models.length > 0 && current) {
          catalogs.set(key, { at: Date.now(), value: result })
        }
        debugLog('claude.catalog.result', {
          harnessId: 'claude',
          purpose: 'model-catalog',
          executable,
          modelCount: result.models.length,
          available: result.cli.status === 'available'
        })
        probe.end({ modelCount: result.models.length, available: true })
        return result
      } catch (error) {
        throwIfAborted(input.signal)
        debugError('claude.catalog.error', error, {
          harnessId: 'claude',
          purpose: 'model-catalog',
          cwd: input.cwd,
          executable
        })
        probe.fail(error)
        return {
          cli: {
            status: 'unavailable',
            executablePath: executable,
            message: errorMessage(error)
          },
          // A configured selector is not evidence that the native provider
          // supports it. Fail closed instead of manufacturing catalog rows.
          models: []
        }
      } finally {
        await transport?.dispose()
      }
    }
  }
}

export function validateClaudeCatalogSelection(
  catalog: DeepReadonly<ClaudeSettingsPresentationData>,
  selection: DeepReadonly<Pick<ClaudeThreadSettingsRequest, 'model' | 'effort'>>
): void {
  const model = selection.model
  const effort = selection.effort
  if (!model && !effort) return
  if (catalog.cli.status !== 'available' || catalog.models.length === 0) {
    throw new Error(
      'Claude 模型目录不可用；model 与 effort 必须保持 provider-default'
    )
  }
  if (!model) {
    throw new Error('Claude effort override 必须同时选择模型')
  }
  const advertised = catalog.models.find((candidate) => candidate.value === model)
  if (!advertised) throw new Error(`未知 Claude 模型：${model}`)
  if (effort && !advertised.supportedEfforts.includes(effort)) {
    throw new Error(`Claude 模型 ${model} 不支持 effort：${effort}`)
  }
}

function initializationModels(value: unknown): ClaudeModelPresentation[] {
  if (!isRecord(value) || !Array.isArray(value.models)) return []
  const models = value.models.flatMap((model): ClaudeModelPresentation[] => {
    if (!isRecord(model)) return []
    const id = stringValue(model.value) || stringValue(model.id) || stringValue(model.model)
    if (!id) return []
    const efforts = Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels
          .map(stringValue)
          .filter((effort): effort is (typeof CLAUDE_EFFORT_LEVELS)[number] =>
            CLAUDE_EFFORT_LEVELS.includes(
              effort as (typeof CLAUDE_EFFORT_LEVELS)[number]
            )
          )
      : []
    return [{
      value: id,
      displayName: stringValue(model.displayName) || stringValue(model.name) || id,
      ...(stringValue(model.description)
        ? { description: stringValue(model.description) }
        : {}),
      supportedEfforts: [...new Set(efforts)]
    }]
  })
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.value)) return false
    seen.add(model.value)
    return true
  })
}

function initializationVersion(value: unknown): string {
  if (!isRecord(value)) return ''
  return stringValue(value.claudeVersion) || stringValue(value.version)
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', onAbort)
    )
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
