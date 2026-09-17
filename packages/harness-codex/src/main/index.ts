import { acquireBartEvaluationSource, createBartEvaluationContext } from '@openagent/plugin-kit/bart/main'
import spawn from 'cross-spawn'
import { createCliAvailabilityProbe, runCliInstaller } from '@openagent/plugin-kit/main'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  HarnessExecutableNotFoundError,
  type DeepReadonly,
  type HarnessMainPlugin
} from '@openagent/contracts'
import { CodexAppServer } from './runtime/app-server.js'
import type {
  CodexHarnessSettings,
  CodexPromptSettings,
  CodexSettingsPresentationData,
  CodexThreadSettings,
  CodexThreadSettingsRequest,
  CodexThreadSettingsUpdate
} from '../shared/types.js'
import { createCodexPromptApi } from './prompt.js'
import { CodexRuntime, type CodexMainContext } from './runtime/index.js'
import { createCodexSettingsApi } from './settings.js'
import { openCodexThread } from './thread/thread-handle.js'
import { createCodexBartTelemetryContributor } from '../bart/usage.js'
import { CATALOG_TTL_MS, createCodexCatalogSource } from './catalog.js'
import { normalizeCodexThreadSettings } from '../shared/settings.js'
import { codexSessionState } from '../shared/session-state.js'
import {
  debugEnvironmentSummary,
  debugError,
  debugLog,
  startDebugSpan
} from './debug.js'

export type { CodexMainContext } from './runtime/index.js'

const execFileAsync = promisify(execFile)

type CodexMainPlugin = HarnessMainPlugin<
  'codex',
  CodexHarnessSettings,
  CodexThreadSettings,
  CodexThreadSettingsRequest,
  CodexThreadSettingsUpdate,
  CodexPromptSettings,
  CodexSettingsPresentationData
>

export type CodexMainPluginBundle = CodexMainPlugin & {
  readonly availability: import('@openagent/contracts').HarnessAvailabilityProbe<CodexHarnessSettings>
}

export function createCodexMainPlugin(context: CodexMainContext): CodexMainPluginBundle {
  const evaluationSource = acquireBartEvaluationSource()
  const runtime = new CodexRuntime(context)
  const catalogSource = createCodexCatalogSource(runtime)
  // Every Harness settings change reloads this presentation, and one load boots
  // a whole app-server to list models that only the executable and the
  // workspace decide. Only a usable listing is kept, so a broken installation
  // still reports itself on the next read.
  const presentations = new Map<string, { at: number; value: CodexSettingsPresentationData }>()
  // Two loads can overlap, so each is numbered at entry and the newest number
  // wins, rather than whichever one happens to finish last. A load that ends in
  // a failure still counts. Each load names two identities: the CLI the caller
  // asked for, known before resolution, and the executable resolution returns.
  // The first supersedes the loads that began before a load that dies before the
  // cache key exists; the second orders the two names one binary can arrive
  // under, since a global load detects the same executable a Thread pins and the
  // older of the two would otherwise overwrite the newer.
  const presentationStarts = new Map<string, number>()
  let presentationSequence = 0
  // A refresh retires everything that began before it, including loads still in
  // flight under a name it cannot know yet: the reader asked for the truth as it
  // is now, and whoever is on the way with the older truth must not land.
  let obsoletePresentationRequest = 0

  const plugin = {
    sessionState: codexSessionState,
    async install({ signal }: { readonly signal: AbortSignal }): Promise<void> {
      await runCliInstaller({
        unix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        windows: "$ErrorActionPreference = 'Stop'; irm https://chatgpt.com/codex/install.ps1 | iex",
        environment: { ...await context.environment(), CODEX_NON_INTERACTIVE: '1' },
        signal
      })
    },
    async detectInstallation(input: {
      readonly cwd: string
      readonly signal: AbortSignal
    }) {
      if (input.signal.aborted) throw input.signal.reason || abortError()
      const span = startDebugSpan('codex.detect-installation', {
        harnessId: 'codex',
        purpose: 'installation',
        cwd: input.cwd
      })
      try {
        const executablePath = await context.resolveExecutable(input.cwd)
        if (input.signal.aborted) throw input.signal.reason || abortError()
        span.end({ installed: true, executable: executablePath })
        return { status: 'installed' as const, executablePath }
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason || abortError()
        if (error instanceof HarnessExecutableNotFoundError) {
          span.end({ installed: false })
          return { status: 'missing' as const }
        }
        span.fail(error)
        throw error
      }
    },
    openThread: (openContext) => openCodexThread(runtime, openContext),
    prompt: createCodexPromptApi(runtime),
    // API-key providers have no OpenAI auto-review service. Keep user approval
    // as their default; an explicit approve-for-me request still validates it.
    settings: createCodexSettingsApi(catalogSource, context.providerOverride ? 'ask-for-approval' : undefined),
    settingsPresentation: {
      async load(input): Promise<CodexSettingsPresentationData> {
        if (input.signal.aborted) throw abortError()
        const presentationRequest = ++presentationSequence
        const threadSettings = input.thread
          ? normalizeCodexThreadSettings(
              input.thread.settings as CodexThreadSettings,
              'settings presentation thread settings'
            )
          : undefined
        const cwd = input.cwd
        // A Thread's executable identity is pinned in its own settings.  Do not
        // inherit a later global executable change when loading its catalog.
        // Harness-level settings never choose the binary: normalizing rejects an
        // illegal Harness-level path (result unused) and the host auto-detects.
        plugin.settings.defaultThreadSettings(input.settings)
        const configuredExecutable = input.thread ? threadSettings?.executablePath : undefined
        const asked = `${configuredExecutable ?? ''}\0${cwd}`
        presentationStarts.set(asked, presentationRequest)
        let executable: string | undefined
        let presentationServer: CodexAppServer | undefined
        const presentationSpan = startDebugSpan('codex.settings-presentation', {
          harnessId: 'codex',
          purpose: 'settings-presentation',
          cwd,
          ...(configuredExecutable ? { configuredExecutable } : {})
        })
        try {
          if (input.refresh) {
            // The reader is asking for the truth as it is now, and this load may
            // die before it learns which executable that is about. Retire both
            // caches up front rather than after the resolution that can fail: a
            // refresh coming back broken must leave the next read retrying
            // instead of replaying the models it set out to replace.
            obsoletePresentationRequest = presentationRequest
            presentations.clear()
            catalogSource.invalidate()
          }
          const resolveSpan = startDebugSpan('codex.resolve-environment', {
            harnessId: 'codex',
            purpose: 'settings-presentation',
            cwd,
            ...(configuredExecutable ? { configuredExecutable } : {})
          })
          let resolvedExecutable: string
          let environment: NodeJS.ProcessEnv
          try {
            [resolvedExecutable, environment] = await Promise.all([
              context.resolveExecutable(cwd, configuredExecutable),
              context.environment()
            ])
            resolveSpan.end({ executable: resolvedExecutable, ...debugEnvironmentSummary(environment) })
          } catch (error) {
            resolveSpan.fail(error)
            throw error
          }
          if (input.signal.aborted) throw abortError()
          executable = resolvedExecutable
          const cacheKey = `${executable}\0${cwd}`
          presentationStarts.set(cacheKey, Math.max(presentationStarts.get(cacheKey) ?? 0, presentationRequest))
          const cachedPresentation = input.refresh ? undefined : presentations.get(cacheKey)
          if (cachedPresentation && Date.now() - cachedPresentation.at < CATALOG_TTL_MS) {
            debugLog('codex.settings-presentation.cache-hit', {
              harnessId: 'codex',
              purpose: 'settings-presentation',
              cwd,
              executable,
              modelCount: cachedPresentation.value.models.length
            })
            presentationSpan.end({
              available: cachedPresentation.value.cli.available,
              modelCount: cachedPresentation.value.models.length
            })
            return cachedPresentation.value
          }
          presentationServer = new CodexAppServer(executable, environment, {
            debugPurpose: 'settings-presentation'
          })
          const versionSpan = startDebugSpan('codex.cli-version.probe', {
            harnessId: 'codex',
            purpose: 'settings-presentation',
            executable: resolvedExecutable
          })
          const modelsSpan = startDebugSpan('codex.catalog.models', {
            harnessId: 'codex',
            purpose: 'settings-presentation',
            cwd
          })
          const [cliResult, catalogResult] = await Promise.allSettled([
            execFileAsync(resolvedExecutable, ['--version'], {
              env: environment,
              signal: input.signal,
              timeout: 10_000
            }).then((result) => {
              versionSpan.end({ available: true })
              return result
            }, (error) => {
              versionSpan.fail(error)
              throw error
            }),
            presentationServer.listModels(input.signal).then((result) => {
              modelsSpan.end({ modelCount: result.length })
              return result
            }, (error) => {
              modelsSpan.fail(error)
              throw error
            })
          ])
          if (input.signal.aborted) throw abortError()
          const cli = cliResult.status === 'fulfilled'
            ? {
                available: true as const,
                executable: resolvedExecutable,
                ...(cliResult.value.stdout.trim()
                  ? { version: cliResult.value.stdout.trim() }
                  : {})
              }
            : {
                available: false as const,
                executable: resolvedExecutable,
                error: errorMessage(cliResult.reason)
              }
          const models = catalogResult.status === 'fulfilled'
            ? [...catalogResult.value]
            : []
          const modelsError = catalogResult.status === 'rejected'
            ? errorMessage(catalogResult.reason)
            : models.length === 0
              ? 'Codex model catalog 为空'
              : undefined
          // Only the newest load for either identity may write, so a refresh
          // keeps the list it just fetched instead of leaving the cache to the
          // next read.
          const current =
            presentationRequest >= obsoletePresentationRequest &&
            presentationStarts.get(asked) === presentationRequest &&
            presentationStarts.get(cacheKey) === presentationRequest
          if (current && catalogResult.status === 'fulfilled' && !modelsError) {
            // Validation reads its own cache, which may still hold the listing
            // this probe replaced. It answers about the same executable the page
            // does, so it takes this one rather than serving a model the page has
            // already stopped offering. A superseded probe hands over nothing:
            // the page kept the newer list, and validation has to agree with the
            // page rather than with whichever probe happened to finish last.
            catalogSource.adoptModels({
              cwd,
              ...(configuredExecutable ? { executablePath: configuredExecutable } : {}),
              models
            })
            // Validation names the executable the caller stored, which is not
            // the name this load was asked under: the page reached this binary
            // whether or not it was told which one to use, and a Thread that
            // pinned the detected path reads under that path. Handing the
            // listing to the binary as well keeps such a Thread from being told
            // a model the page offers is unknown.
            if (resolvedExecutable !== configuredExecutable) {
              catalogSource.adoptModels({ cwd, executablePath: resolvedExecutable, models })
            }
          }
          const result = {
            cli,
            models,
            ...(modelsError ? { modelsError } : {})
          }
          debugLog('codex.settings-presentation.result', {
            harnessId: 'codex',
            purpose: 'settings-presentation',
            cwd,
            executable: resolvedExecutable,
            available: cli.available,
            modelCount: models.length,
            ...(modelsError ? { modelsError } : {})
          })
          presentationSpan.end({ available: cli.available, modelCount: models.length })
          if (cli.available && !modelsError && current) {
            presentations.set(cacheKey, { at: Date.now(), value: result })
          }
          return result
        } catch (error) {
          presentationSpan.fail(error)
          debugError('codex.settings-presentation.error', error, {
            harnessId: 'codex',
            purpose: 'settings-presentation',
            cwd,
            ...(executable ? { executable } : {})
          })
          if (input.signal.aborted) throw abortError()
          return {
            cli: {
              available: false,
              ...(executable ? { executable } : {}),
              error: errorMessage(error)
            },
            models: []
          }
        } finally {
          await presentationServer?.dispose()
        }
      }
    }
  } satisfies CodexMainPlugin
  return {
    ...plugin,
    dispose: () => evaluationSource.dispose(),
    availability: createCliAvailabilityProbe<CodexHarnessSettings>(
      context, spawn),
    bartContextEntries: {
      evaluation: createBartEvaluationContext<CodexHarnessSettings>({
        source: evaluationSource,
        // Harness-level settings cannot pin the binary; the host auto-detects.
        async loadIdentities({ cwd, signal }) {
          const catalog = await catalogSource.load({ cwd, signal })
          return catalog.models.map(model => ({
            selector: model.value, displayName: model.displayName, aliases: []
          }))
        }
      }),
      telemetry: (input: {
        readonly settings: DeepReadonly<CodexHarnessSettings>
        readonly cwd: string
        readonly telemetryLedger: import('@openagent/contracts').BartTelemetryLedgerCapability
        readonly signal: AbortSignal
      }) => createCodexBartTelemetryContributor({
        telemetryLedger: input.telemetryLedger,
        readUsage: async (signal) => {
          let server: CodexAppServer | undefined
          try {
            // Harness-level settings never choose the binary; auto-detect it.
            const acquired = await runtime.server(
              input.cwd,
              undefined,
              signal
            )
            server = acquired.server
            return await server.readUsage(signal)
          } finally {
            await server?.dispose()
          }
        }
      })({ signal: input.signal })
    }
  }
}

function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
