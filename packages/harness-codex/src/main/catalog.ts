import type { CodexModelOption } from '../shared/types.js'
import type { CodexRuntime } from './runtime/index.js'
import { debugError, debugLog, startDebugSpan } from './debug.js'

export interface CodexCatalogSnapshot {
  readonly models: readonly CodexModelOption[]
  readonly computerUse: boolean
}

export interface CodexCatalogSource {
  load(input: {
    readonly cwd: string
    readonly executablePath?: string
    readonly signal: AbortSignal
  }): Promise<CodexCatalogSnapshot>
  /**
   * Reads the automatic-review approval alone, from a runtime started now
   * rather than from the cached catalog. Local configuration and enterprise
   * configRequirements move while the app runs, and the runtime re-checks this
   * same capability at every turn, so a permission accepted against a stale
   * answer would only surface as a Thread that cannot run.
   */
  probeAutoReview(input: {
    readonly cwd: string
    readonly executablePath?: string
    readonly signal: AbortSignal
  }): Promise<boolean>
  /**
   * Forgets every snapshot. Callers that just learned the native truth moved —
   * a reader who asked to refresh the page — must not have validation answer
   * from the list that refresh replaced.
   */
  invalidate(): void
  /**
   * Takes the model list a settings presentation just read as this source's own.
   * Both read the same native listing through caches of their own, and a page
   * offering a model that validation then rejects is worse than a page one
   * listing behind. Only a snapshot already held is amended: a cold source has
   * nothing stale to disagree with, and its next read probes for itself.
   */
  adoptModels(input: {
    readonly cwd: string
    readonly executablePath?: string
    readonly models: readonly CodexModelOption[]
  }): void
}

/** Native catalogs move when the CLI or the account does, not per settings read. */
export const CATALOG_TTL_MS = 5 * 60 * 1_000

export function createCodexCatalogSource(runtime: CodexRuntime): CodexCatalogSource {
  // One snapshot costs a full runtime boot, and a single settings read asks for
  // the catalog several times. Only successes are kept: a failed boot has to be
  // retried rather than pinned for the rest of the session.
  const catalogs = new Map<string, { at: number; value: CodexCatalogSnapshot }>()
  // The newest load that has begun for a key, whether or not it succeeds. A
  // probe that fails still supersedes the loads that started before it, so an
  // older snapshot landing late must not take the cache back: the next read has
  // to retry rather than replay what the newer probe retired.
  const started = new Map<string, number>()
  let sequence = 0
  // Loads begun before an invalidation carry the truth it just discarded. The
  // refresh path starts no catalog load of its own, so this is a plain floor.
  let obsolete = 0
  return {
    async load(input) {
      input.signal.throwIfAborted()
      // Numbered before the cache lookup so ordering follows load initiation,
      // not whichever concurrent miss happens to finish first.
      const request = ++sequence
      const key = catalogKey(input)
      started.set(key, request)
      const cached = catalogs.get(key)
      if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
        debugLog('codex.catalog.cache-hit', {
          harnessId: 'codex',
          purpose: 'model-catalog',
          cwd: input.cwd,
          modelCount: cached.value.models.length
        })
        return cached.value
      }
      const value = await loadCatalog(runtime, input)
      // Only the newest load for this key may write, and only if the snapshot it
      // carries postdates the last invalidation.
      if (request > obsolete && started.get(key) === request) {
        catalogs.set(key, { at: Date.now(), value })
      }
      input.signal.throwIfAborted()
      return value
    },
    invalidate() {
      obsolete = sequence
      catalogs.clear()
    },
    adoptModels(input) {
      const key = catalogKey(input)
      // A load already in flight read its listing before the page read this one,
      // so it must not be the one that settles what validation sees. Registering
      // the adoption as the newest load for the key retires every earlier one,
      // whether or not it has written yet — a cold or expired cache included,
      // where the page's listing has nothing to be stored next to.
      started.set(key, ++sequence)
      const held = catalogs.get(key)
      // An expired snapshot cannot be replayed, so it cannot disagree with the
      // listing the page just read either; leave it for the next load to retry.
      if (!held || Date.now() - held.at >= CATALOG_TTL_MS) return
      // The capability is not part of what a presentation reads, so the snapshot
      // keeps the one its own probe found and takes only the newer listing. The
      // timestamp stays with the facts it was taken for.
      catalogs.set(key, { at: held.at, value: { models: [...input.models], computerUse: held.value.computerUse } })
    },
    async probeAutoReview(input) {
      input.signal.throwIfAborted()
      const acquired = await runtime.server(
        input.cwd,
        input.executablePath,
        input.signal,
        'standard',
        'capability-probe'
      )
      try {
        return await acquired.server.supportsAutoReview(input.cwd, input.signal)
      } finally {
        await acquired.server.dispose()
      }
    }
  }
}

function catalogKey(input: { readonly cwd: string; readonly executablePath?: string }): string {
  return `${input.executablePath ?? ''}\0${input.cwd}`
}

async function loadCatalog(
  runtime: CodexRuntime,
  input: {
    readonly cwd: string
    readonly executablePath?: string
    readonly signal: AbortSignal
  }
): Promise<CodexCatalogSnapshot> {
  input.signal.throwIfAborted()
  let server: Awaited<ReturnType<CodexRuntime['server']>>['server'] | undefined
  const span = startDebugSpan('codex.catalog.probe', {
    harnessId: 'codex',
    purpose: 'model-catalog',
    cwd: input.cwd,
    ...(input.executablePath ? { executablePath: input.executablePath } : {})
  })
  try {
    const acquired = await runtime.server(
      input.cwd,
      input.executablePath,
      input.signal,
      'standard',
      'model-catalog'
    )
    server = acquired.server
    const modelsSpan = startDebugSpan('codex.catalog.models', {
      harnessId: 'codex',
      purpose: 'model-catalog',
      cwd: input.cwd
    })
    const computerUseSpan = startDebugSpan('codex.catalog.computer-use', {
      harnessId: 'codex',
      purpose: 'capability-probe',
      cwd: input.cwd
    })
    const [models, computerUse] = await Promise.all([
      server.listModels(input.signal).then((value) => {
        modelsSpan.end({ modelCount: value.length })
        return value
      }, (error) => {
        modelsSpan.fail(error)
        throw error
      }),
      server.supportsComputerUse(input.cwd, input.signal).then((value) => {
        computerUseSpan.end({ supported: value })
        return value
      }, (error) => {
        input.signal.throwIfAborted()
        computerUseSpan.end({ supported: false, probeError: true })
        void error
        return false
      })
    ])
    input.signal.throwIfAborted()
    if (models.length === 0) throw new Error('Codex model catalog 为空')
    const result = { models: [...models], computerUse }
    debugLog('codex.catalog.result', {
      harnessId: 'codex',
      purpose: 'model-catalog',
      modelCount: result.models.length,
      computerUse
    })
    span.end({ modelCount: result.models.length, computerUse })
    return result
  } catch (error) {
    span.fail(error)
    debugError('codex.catalog.error', error, {
      harnessId: 'codex',
      purpose: 'model-catalog',
      cwd: input.cwd
    })
    input.signal.throwIfAborted()
    throw error
  } finally {
    await server?.dispose()
  }
}

export function selectCodexModel(
  models: readonly CodexModelOption[],
  requestedModel: string | undefined
): CodexModelOption | undefined {
  const normalized = requestedModel?.trim().toLowerCase()
  if (!normalized || normalized === 'codex-default') {
    return models.find((model) => model.isDefault) || models[0]
  }
  return models.find((model) => model.value.trim().toLowerCase() === normalized)
}

export function validateCodexModelSettings(
  models: readonly CodexModelOption[],
  settings: {
    readonly model?: string
    readonly effort?: string
    readonly serviceTier?: string
  },
  label: string
): CodexModelOption {
  const selected = selectCodexModel(models, settings.model)
  if (!selected) {
    throw new Error(
      settings.model
        ? `Codex ${label} 指定了未知模型：${settings.model}`
        : `Codex ${label} 无法解析默认模型`
    )
  }
  if (settings.effort) {
    const supported = selected.supportedReasoningEfforts.map((entry) => entry.value)
    if (!supported.includes(settings.effort)) {
      throw new Error(
        supported.length > 0
          ? `Codex 模型 ${selected.value} 不支持 effort：${settings.effort}`
          : `Codex 模型 ${selected.value} 未报告 reasoning effort，无法确认 ${settings.effort}`
      )
    }
  }
  if (settings.serviceTier) {
    const supported = selected.serviceTiers.map((entry) => entry.value)
    if (!supported.includes(settings.serviceTier)) {
      throw new Error(
        supported.length > 0
          ? `Codex 模型 ${selected.value} 不支持 service tier：${settings.serviceTier}`
          : `Codex 模型 ${selected.value} 未报告 service tier，无法确认 ${settings.serviceTier}`
      )
    }
  }
  return selected
}
