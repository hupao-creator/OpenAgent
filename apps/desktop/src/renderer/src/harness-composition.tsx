import { ThreadDetailSurface } from '@openagent/plugin-kit/renderer'
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode
} from 'react'
import type {
  DeepReadonly,
  HarnessThreadRecord
} from '@openagent/contracts'
import {
  isJsonObject,
  isJsonValue,
  type JsonObject,
  type JsonValue
} from '@openagent/contracts'
import type {
  HarnessBartPresentation,
  HarnessRendererPlugin,
  HarnessRendererThreadActions,
  HarnessRendererThreadInput,
  HarnessTranslationCatalog,
  HarnessSettingsResource
} from '@openagent/contracts/renderer'
import type {
  HarnessOverviewEnvelope,
  HarnessOverviewThread,
  HarnessOverviewThreadInput
} from '@openagent/contracts/renderer'
import {
  harnessDisplayName,
  HARNESS_IDS,
  type HarnessId
} from '../../shared/harnesses'
import { harnessRendererPluginModules } from '../../generated/harness-registry.renderer'
import type {
  HarnessSettingsPresentationRequest,
  HarnessSettingsPresentationResult,
  OpenAgentSettings
} from '../../shared/openagent-settings'
import type { ThreadInteractionResponseRequest } from '../../shared/desktop-api'
import { useI18n } from '@openagent/plugin-kit/renderer'

interface HarnessRendererBinding {
  readonly id: string
  readonly logoSource: string
  readonly translations?: HarnessTranslationCatalog
  executionTokenUsage(thread: DeepReadonly<HarnessThreadRecord>, executionId: string):
    { readonly value: string; readonly count: number; readonly suffix: string } | undefined
  renderThread(props: HarnessThreadHostProps): React.JSX.Element
  projectOverview(
    input: HarnessOverviewThreadInput,
    availableColumns: number
  ): ReturnType<typeof projectOverviewBranch>
  projectBartDock(thread: DeepReadonly<HarnessThreadRecord>): HarnessBartPresentation | undefined
  renderOverview(props: HarnessOverviewCardHostProps): React.JSX.Element
  renderHarnessSettings(props: HarnessSettingsHostProps): React.JSX.Element
}

/**
 * One typed adaptation point per statically composed Renderer Plugin. Core
 * hosts dispatch through this closed binding and never branch on Harness id.
 */
function bindRendererHarness<
  Id extends string,
  OverviewView,
  ThreadSettingsUpdate,
  HarnessSettings,
  SettingsPresentationData
>(
  id: Id,
  plugin: HarnessRendererPlugin<
    OverviewView,
    ThreadSettingsUpdate,
    HarnessSettings,
    SettingsPresentationData
  >
): HarnessRendererBinding & { readonly id: Id } {
  // Share the private view between mutation-boundary capture and card rendering.
  // Weak keys release obsolete revisions instead of retaining entire histories.
  const projections = new WeakMap<
    DeepReadonly<HarnessThreadRecord>,
    Map<string, ReturnType<typeof projectOverviewBranch<OverviewView>>>
  >()
  const executionUsages = new WeakMap<
    DeepReadonly<HarnessThreadRecord>,
    Map<string, ReturnType<HarnessRendererBinding['executionTokenUsage']>>
  >()
  const projectOverview = (input: HarnessOverviewThreadInput, columns: number) => {
    const key = overviewProjectionKey(columns)
    let widths = projections.get(input.thread)
    if (!widths) {
      widths = new Map()
      projections.set(input.thread, widths)
    }
    if (!widths.has(key)) {
      widths.set(key, projectOverviewBranch(plugin.OverviewCard, input, columns))
    }
    return widths.get(key)
  }
  return {
    id,
    logoSource: plugin.logoSource,
    translations: plugin.translations,
    executionTokenUsage(thread, executionId) {
      let byExecution = executionUsages.get(thread)
      if (!byExecution) {
        byExecution = new Map()
        executionUsages.set(thread, byExecution)
      }
      if (byExecution.has(executionId)) return byExecution.get(executionId)
      let usage: ReturnType<HarnessRendererBinding['executionTokenUsage']>
      try {
        usage = plugin.OverviewCard.executionTokenUsage?.(thread, executionId)
      } catch {
        usage = undefined
      }
      byExecution.set(executionId, usage)
      return usage
    },
    renderThread(props) {
      const ThreadView = plugin.ThreadView
      return <ThreadView {...props} />
    },
    projectOverview,
    projectBartDock(thread) {
      try {
        return plugin.projectBartDock?.({ thread })
      } catch {
        return undefined
      }
    },
    renderOverview(props) {
      return renderOverviewBranch(plugin.OverviewCard, props, projectOverview(props, props.availableColumns))
    },
    renderHarnessSettings(props) {
      const HarnessSettings = plugin.HarnessSettings
      const resource = props.resources[id] as HarnessSettingsResource<SettingsPresentationData>
      return (
        <HarnessSettings
          section={props.section}
          host={{
            cwd: props.cwd,
            invokeExtension: (method, payload) =>
              window.openAgent.invokeHarnessExtension({
                harnessId: id as HarnessId,
                method,
                payload: jsonValue(payload)
              }),
            openExternal: (url) => window.openAgent.openExternal(url)
          }}
          resource={resource}
          value={concreteJsonObject<DeepReadonly<HarnessSettings>>(
            props.value.harnesses[id] ?? {}
          )}
          change={(value) => props.change({
            ...props.value,
            harnesses: {
              ...props.value.harnesses,
              [id]: jsonObject(value)
            }
          })}
        />
      )
    }
  }
}

/**
 * The Renderer composition is driven by the generated module registry. The
 * concrete exports retain their Harness-specific generic types inside their
 * own packages; type erasure happens only at this aggregation boundary, and
 * every dispatch site tolerates an unknown Harness id (e.g. a persisted Thread
 * whose Plugin is no longer registered).
 */
export const harnessRendererPlugins: Readonly<Record<string, HarnessRendererBinding>> =
  Object.fromEntries(
    harnessRendererPluginModules.map((pluginModule) => [
      pluginModule.id,
      bindRendererHarness(pluginModule.id, pluginModule.plugin)
    ])
  )

export const harnessRendererTranslations: HarnessTranslationCatalog = Object.freeze({
  'en-US': Object.freeze(Object.assign(
    {},
    ...harnessRendererPluginModules.map((pluginModule) =>
      pluginModule.plugin.translations?.['en-US'] ?? {}
    )
  ))
})

export function harnessLogoSource(harnessId: string): string {
  return harnessRendererPlugins[harnessId]?.logoSource ?? ''
}

export type HarnessPresentationResources = Readonly<
  Record<string, HarnessSettingsResource<unknown>>
>

export type HarnessPresentationLoader = (
  request: HarnessSettingsPresentationRequest
) => Promise<HarnessSettingsPresentationResult>

/**
 * The presentation cache is part of the one Renderer composition. Nothing is
 * probed at app startup: the matching settings host loads its resource on
 * first mount, and a saved Harness-settings change invalidates only that
 * Harness slice. HARNESS_IDS is a build-time constant from the generated
 * registry, so this loop calls hooks in a stable order on every render.
 */
export function useHarnessPresentationResources(
  settings: OpenAgentSettings,
  load: HarnessPresentationLoader,
  defaultCwd: string
): HarnessPresentationResources {
  const resources: Record<string, HarnessSettingsResource<unknown>> = {}
  for (const harnessId of HARNESS_IDS) {
    const loadHarness = useCallback(async (refresh?: boolean): Promise<unknown> => {
      const result = await load({ scope: 'global', harnessId, ...(refresh ? { refresh: true } : {}) })
      if (result.scope !== 'global') throw mismatchedPresentationScope('global', result.scope)
      if (result.harnessId !== harnessId) throw mismatchedPresentation(harnessId, result.harnessId)
      return concreteJsonValue<unknown>(result.value)
    }, [load, harnessId])
    resources[harnessId] = usePresentationResource(
      JSON.stringify([defaultCwd, settings.harnesses[harnessId]]),
      loadHarness
    )
  }
  return resources
}

const UNAVAILABLE_PRESENTATION_RESOURCE: HarnessSettingsResource<never> = {
  status: 'error',
  message: '此 Harness 未注册',
  reload: async () => undefined
}

type PresentationLoadState<Value> =
  | { readonly key: string; readonly status: 'loading' }
  | { readonly key: string; readonly status: 'ready'; readonly value: DeepReadonly<Value> }
  | { readonly key: string; readonly status: 'error'; readonly message: string }

function usePresentationResource<Value>(
  key: string,
  load: (refresh?: boolean) => Promise<DeepReadonly<Value>>
): HarnessSettingsResource<Value> {
  const [state, setState] = useState<PresentationLoadState<Value>>({
    key,
    status: 'loading'
  })
  const currentKey = useRef(key)
  // reload is a stable-per-key callback, so it reads the last committed state
  // through a mirror instead of closing over it.
  const stateRef = useRef(state)
  const sequence = useRef(0)
  const pending = useRef<{
    readonly key: string
    readonly sequence: number
    readonly promise: Promise<void>
  } | null>(null)
  currentKey.current = key
  stateRef.current = state

  const reload = useCallback(async (options?: { readonly refresh?: boolean }): Promise<void> => {
    // A reader who asked for a refresh is not served the request already in
    // flight; the newer sequence makes its own answer the one that lands.
    if (!options?.refresh && pending.current?.key === key) return pending.current.promise
    const requestSequence = ++sequence.current
    // A settled read for this key stays on screen while the re-read travels:
    // hovering the Agent row or refocusing the window must not blank a version
    // the user is already looking at. Only a never-read resource (or a changed
    // settings key, whose old value describes a different configuration) shows
    // the loading state; a failed re-read still settles into its own error.
    const shown = stateRef.current
    if (shown.key !== key || shown.status !== 'ready') {
      setState({ key, status: 'loading' })
    }
    const promise = (async () => {
      try {
        const value: DeepReadonly<Value> = await load(options?.refresh)
        if (currentKey.current === key && sequence.current === requestSequence) {
          setState({ key, status: 'ready', value })
        }
      } catch (cause) {
        if (currentKey.current === key && sequence.current === requestSequence) {
          setState({ key, status: 'error', message: errorMessage(cause) })
        }
      } finally {
        if (pending.current?.sequence === requestSequence) pending.current = null
      }
    })()
    pending.current = { key, sequence: requestSequence, promise }
    return promise
  }, [key, load])

  if (state.key !== key) return { status: 'loading', reload }
  switch (state.status) {
    case 'loading': return { status: 'loading', reload }
    case 'ready': return { status: 'ready', value: state.value, reload }
    case 'error': return { status: 'error', message: state.message, reload }
  }
}

export interface HarnessThreadHostProps {
  readonly readingTarget?: HarnessRendererThreadInput['readingTarget']
  readonly thread: DeepReadonly<HarnessThreadRecord>
  readonly actions: HarnessRendererThreadActions
}

/**
 * The switch is intentionally exhaustive. It preserves each concrete plugin's
 * types instead of erasing them behind an unknown-valued runtime registry.
 */
export const HarnessThreadViewHost = memo(function HarnessThreadViewHost(
  props: HarnessThreadHostProps
): React.JSX.Element {
  const binding = harnessRendererPlugins[props.thread.harnessId]
  const fallback = <ThreadDetailSurface
    threadId={props.thread.id} title={props.thread.title} rows={[]} running={false}
    emptyState={<HarnessPluginFallback title={props.thread.title} />}
  />
  const content = binding ? binding.renderThread(props) : fallback
  return (
    <HarnessPluginBoundary
      fallbackTitle={props.thread.title}
      fallback={fallback}
      key={props.thread.id}
      recoveryKey={props.thread.revision}
    >
      {content}
    </HarnessPluginBoundary>
  )
})

export type { HarnessOverviewEnvelope, HarnessOverviewThread, HarnessOverviewThreadInput }

export interface HarnessOverviewCardHostProps extends HarnessThreadHostProps {
  readonly thread: HarnessOverviewThreadInput['thread']
  readonly availableColumns: number
  /** Structure/footprint selected by the queued Core layout revision. */
  readonly envelope: HarnessOverviewEnvelope
  readonly openThread: () => void
}

const overviewThreads = new WeakMap<DeepReadonly<HarnessThreadRecord>, Map<string, HarnessOverviewThread>>()

/**
 * Closed composition shared by live rendering and mutation-boundary capture.
 * Only immutable inputs are cached; plugin-private views stay in their binding.
 */
export function projectHarnessOverviewThread(
  input: HarnessOverviewThreadInput,
  availableColumns: number
): HarnessOverviewThread {
  const key = overviewProjectionKey(availableColumns)
  let widths = overviewThreads.get(input.thread)
  const cached = widths?.get(key)
  if (cached) return cached
  const projection = harnessRendererPlugins[input.thread.harnessId]
    ?.projectOverview(input, availableColumns)
  const result = {
    ...input,
    // Semantic grouping remains derived from public observation even when a
    // Renderer Plugin fails; this fallback only supplies layout structure.
    envelope: projection?.envelope ?? unavailableOverviewEnvelope()
  }
  if (!widths) {
    widths = new Map()
    overviewThreads.set(input.thread, widths)
  }
  widths.set(key, result)
  return result
}

function overviewProjectionKey(columns: number): string {
  return String(columns)
}

/** Harness-owned Bart presentation: current activity and last final reply. */
export function projectHarnessBartPresentation(
  thread: DeepReadonly<HarnessThreadRecord>
): HarnessBartPresentation | undefined {
  return harnessRendererPlugins[thread.harnessId]?.projectBartDock(thread)
}

export function projectExecutionTokenUsage(
  thread: DeepReadonly<HarnessThreadRecord>, executionId: string
): { readonly value: string; readonly count: number; readonly suffix: string } | undefined {
  const usage = harnessRendererPlugins[thread.harnessId]?.executionTokenUsage(thread, executionId)
  return usage && Number.isFinite(usage.count) && usage.count > 0 ? usage : undefined
}

/**
 * Plugin-private `view` data stays inside its concrete branch. Only the small
 * layout envelope crosses back into the Core overview coordinator.
 */
export const HarnessOverviewCardHost = memo(function HarnessOverviewCardHost(
  props: HarnessOverviewCardHostProps
): React.JSX.Element {
  const binding = harnessRendererPlugins[props.thread.harnessId]
  if (!binding) return <HarnessPluginFallback title={props.thread.title} />
  return binding.renderOverview(props)
})

function renderOverviewBranch<View>(
  module: {
    readonly project: (input: {
      readonly thread: DeepReadonly<HarnessThreadRecord>
      readonly layout: { readonly availableColumns: number }
    }) => {
      readonly footprint: { readonly columns: number; readonly rows: number }
      readonly structureKey: string
      readonly excerpt: string
      readonly view: View
    }
    readonly Card: ComponentType<HarnessThreadHostProps & {
      readonly projection: View
      readonly actions: HarnessRendererThreadActions & { openThread(): void }
    }>
  },
  props: HarnessOverviewCardHostProps,
  result: ReturnType<typeof projectOverviewBranch<View>>
): React.JSX.Element {
  // Keep the content wrapper pointer-transparent so the stretched open button
  // receives card clicks; .thread-card-extension re-enables embedded controls.
  if (!result) {
    return (
      <div
        className="harness-overview-structure-beat thread-card-layout"
        data-overview-structure-key={props.envelope.structureKey}
        key={props.envelope.structureKey}
      >
        <div
          className="harness-overview-content thread-card-extension"
          style={{ gridColumn: '1 / -1', gridRow: '1 / -1', padding: 0 }}
        >
          <button
            className="harness-overview-fallback"
            onClick={props.openThread}
            type="button"
          >
            <strong>{props.thread.title}</strong>
            <HarnessOverviewFallback excerpt={props.envelope.excerpt} />
          </button>
        </div>
      </div>
    )
  }
  const projection = result.projection
  const Card = module.Card
  return (
    <HarnessPluginBoundary
      fallbackTitle={props.thread.title}
      key={props.thread.id}
      recoveryKey={`${props.thread.revision}:${props.envelope.structureKey}`}
    >
      <div
      className="harness-overview-structure-beat thread-card-layout"
      data-overview-structure-key={props.envelope.structureKey}
      key={props.envelope.structureKey}
    >
      <div
        className="harness-overview-content thread-card-extension"
        style={{ gridColumn: '1 / -1', gridRow: '1 / -1', padding: 0 }}
      >
        <Card
          thread={props.thread}
          projection={projection.view}
          actions={{ ...props.actions, openThread: props.openThread }}
        />
      </div>
      </div>
    </HarnessPluginBoundary>
  )
}

function HarnessOverviewFallback(props: { readonly excerpt: string }): React.JSX.Element {
  const { t } = useI18n()
  return <p>{props.excerpt || t('此 Harness 的俯瞰投影暂时不可用。')}</p>
}

export class HarnessPluginBoundary extends Component<
  {
    readonly fallbackTitle: string
    readonly fallback?: ReactNode
    /**
     * A new committed projection may repair a plugin render failure. This is a
     * retry signal, not React identity: healthy streaming updates must preserve
     * the plugin subtree and its local interaction state.
     */
    readonly recoveryKey: string | number
    readonly children: ReactNode
  },
  { readonly failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('Harness Renderer Plugin failed', error)
  }

  componentDidUpdate(previous: Readonly<typeof this.props>): void {
    if (this.state.failed && previous.recoveryKey !== this.props.recoveryKey) {
      this.setState({ failed: false })
    }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return this.props.fallback ?? <HarnessPluginFallback title={this.props.fallbackTitle} />
  }
}

function HarnessPluginFallback(props: { readonly title: string }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="harness-plugin-error" role="alert">
      <strong>{props.title}</strong>
      <span>{t('此 Harness 的渲染模块暂时不可用；其他 Thread 不受影响。')}</span>
    </div>
  )
}

function projectOverviewBranch<View>(
  module: {
    readonly project: (input: {
      readonly thread: DeepReadonly<HarnessThreadRecord>
      readonly layout: { readonly availableColumns: number }
    }) => {
      readonly footprint: { readonly columns: number; readonly rows: number }
      readonly structureKey: string
      readonly excerpt: string
      readonly view: View
    }
  },
  input: { readonly thread: DeepReadonly<HarnessThreadRecord> },
  availableColumns: number
): {
  readonly projection: ReturnType<typeof module.project>
  readonly envelope: HarnessOverviewEnvelope
} | undefined {
  try {
    const projection = module.project({
      thread: input.thread,
      layout: { availableColumns }
    })
    const maximumColumns = positiveInteger(availableColumns) ? availableColumns : 1
    if (
      !positiveInteger(projection.footprint.columns) ||
      projection.footprint.columns > maximumColumns ||
      !positiveInteger(projection.footprint.rows) ||
      typeof projection.structureKey !== 'string' ||
      projection.structureKey.length === 0 ||
      typeof projection.excerpt !== 'string'
    ) {
      return undefined
    }
    return {
      projection,
      envelope: {
        footprint: {
          columns: projection.footprint.columns,
          rows: projection.footprint.rows
        },
        structureKey: projection.structureKey,
        excerpt: projection.excerpt
      }
    }
  } catch {
    return undefined
  }
}

function unavailableOverviewEnvelope(): HarnessOverviewEnvelope {
  return {
    footprint: {
      columns: 1,
      rows: 1
    },
    structureKey: 'projection-error',
    excerpt: ''
  }
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

export interface HarnessSettingsHostProps {
  readonly section: import('@openagent/contracts/renderer').HarnessSettingsSection
  readonly harnessId: string
  readonly cwd: string
  readonly value: OpenAgentSettings
  readonly resources: HarnessPresentationResources
  readonly change: (settings: OpenAgentSettings) => void
}

/** The only global Harness-settings component composition. */
export function HarnessSettingsHost(
  props: HarnessSettingsHostProps
): React.JSX.Element {
  const { t } = useI18n()
  const binding = harnessRendererPlugins[props.harnessId]
  const resource = props.resources[props.harnessId] ?? UNAVAILABLE_PRESENTATION_RESOURCE
  useEnsurePresentationResource(resource)
  const content = binding
    ? binding.renderHarnessSettings(props)
    : <HarnessPluginFallback title={props.harnessId} />
  return (
    <HarnessPluginBoundary
      fallbackTitle={t('{title} 设置', {
        title: harnessDisplayName(props.harnessId)
      })}
      key={props.harnessId}
      recoveryKey={`${JSON.stringify(props.value.harnesses[props.harnessId])}:${
        resourceRecoveryKey(resource)
      }`}
    >
      {content}
    </HarnessPluginBoundary>
  )
}

function useEnsurePresentationResource(
  resource: HarnessSettingsResource<unknown>
): void {
  useEffect(() => {
    if (resource.status === 'loading') void resource.reload()
  }, [resource.status, resource.reload])
}

function resourceRecoveryKey(
  resource: HarnessSettingsResource<unknown>
): string {
  switch (resource.status) {
    case 'loading': return 'loading'
    case 'error': return `error:${resource.message}`
    case 'ready': {
      try {
        return `ready:${JSON.stringify(resource.value)}`
      } catch {
        return 'ready:unserializable'
      }
    }
  }
}

export function threadActions(input: {
  readonly harnessId: string
  readonly threadId: string
  readonly interrupt: (threadId: string) => Promise<void>
  readonly openFollowUp: (initialDraft: string) => void
  readonly respond: (request: ThreadInteractionResponseRequest) => Promise<unknown>
}): HarnessRendererThreadActions {
  return {
    forkThread: (request) => window.openAgent.forkThread({
      threadId: input.threadId,
      request: jsonValue(request)
    }),
    interrupt: () => input.interrupt(input.threadId),
    invokeHarnessExtension: (method, payload) =>
      window.openAgent.invokeHarnessExtension({
        harnessId: input.harnessId as HarnessId,
        method,
        payload: jsonValue(payload)
      }),
    openExternal: (url) => window.openAgent.openExternal(url),
    openFollowUp: (initialDraft) => input.openFollowUp(followUpDraft(initialDraft)),
    respond: async (response) => {
      await input.respond({ threadId: input.threadId, ...response })
    }
  }
}

const FOLLOW_UP_DRAFT_MAX_CHARACTERS = 1_000_000

function followUpDraft(value: string): string {
  if (!value.trim()) throw new Error('Thread follow-up draft 不能为空')
  if (value.length > FOLLOW_UP_DRAFT_MAX_CHARACTERS) {
    throw new Error('Thread follow-up draft 超出长度限制')
  }
  return value
}

function mismatchedPresentation(expected: string, received: string): Error {
  return new Error(`Settings presentation Harness 不匹配: ${expected} / ${received}`)
}

function mismatchedPresentationScope(
  expected: 'global' | 'thread',
  received: 'global' | 'thread'
): Error {
  return new Error(`Settings presentation scope 不匹配: ${expected} / ${received}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function jsonObject(value: unknown): JsonObject {
  const cloned: unknown = structuredClone(value)
  if (!isJsonObject(cloned)) throw new Error('Harness settings 必须是 JSON object')
  return cloned
}

function concreteJsonObject<Value>(value: unknown): Value {
  return jsonObject(value) as unknown as Value
}

function concreteJsonValue<Value>(value: JsonValue): Value {
  return jsonValue(value) as Value
}

function jsonValue(value: unknown): JsonValue {
  const cloned: unknown = structuredClone(value)
  if (!isJsonValue(cloned)) throw new Error('Harness JSON value 无效')
  return cloned
}
