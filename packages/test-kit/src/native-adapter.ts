import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HarnessPluginDescriptor, JsonValue } from '@openagent/contracts'

/**
 * One recorded frame of the native protocol evidence file. The generic
 * recorder only guarantees direction/wrapper identity/text; the concrete
 * frame shape inside `text` belongs to the owning Harness adapter.
 */
export interface NativeProtocolEvent {
  readonly type?: string
  readonly direction?: string
  readonly wrapperPid?: number
  readonly pid?: number
  readonly text?: string
}

/** Scenario tags a real CLI genuinely supports in headless acceptance. */
export type HarnessScenarioCapability =
  | 'plain'
  | 'shell'
  | 'permission'
  | 'question'
  | 'question-cancel'
  | 'background'
  | (string & {})

/** Native tool names a Harness exposes for the acceptance scenarios, if any. */
export interface HarnessNativeToolNames {
  readonly permission?: string
  readonly question?: string
  readonly background?: string
  readonly plan?: string
}

/**
 * Harness-specific wording generic capture/acceptance runners cannot know.
 * Absent fields mean the runner must diagnose the scenario as unsupported for
 * this Harness instead of guessing a prompt.
 */
export interface HarnessScenarioDialect {
  /** Extra instruction appended to permission-gated command prompts (e.g. a Codex escalation request). */
  readonly permissionEscalation?: string
  /** Native tool that runs a command as background work, when different from the permission tool. */
  readonly backgroundTool?: string
  /** Flags/wording that turn a command into background work. */
  readonly backgroundLaunchFlags?: string
  /** Follow-up send after background work started. */
  readonly backgroundFollowUp?: string
}

/**
 * Test-only knowledge of one registered Harness, owned by that Harness package
 * and exported from `@openagent/harness-<id>/test-support`. Generic runners
 * drive process flow, timeouts, cleanup and assertions; everything that
 * requires native protocol facts lives here. Adapters adapt the real system:
 * they never replace native evidence with fake transports or simulated tools,
 * and expected results must not be derived from the output under test.
 */
export interface HarnessNativeTestAdapter {
  readonly id: string
  readonly displayName: string
  /**
   * The Harness's own plugin descriptor, re-exported so generic runners derive
   * roles (such as the Bart host) from declared capabilities instead of
   * hand-written id lists.
   */
  readonly descriptor: HarnessPluginDescriptor<string>
  /**
   * Scenario capabilities of the real CLI. A generic runner must skip a case
   * only when the adapter does not declare the capability, and must say so.
   */
  readonly scenarioCapabilities: readonly HarnessScenarioCapability[]
  /** Least-privilege Thread settings for observation cases. */
  readonly observationThreadSettings: Readonly<Record<string, JsonValue>>
  /** Thread settings that let the native agent touch the filesystem without a permission interaction. */
  readonly permissiveThreadSettings: Readonly<Record<string, JsonValue>>
  readonly nativeTools: HarnessNativeToolNames
  /** Construct a real native shell call from a scripted model action. Null means another dialect. */
  readonly llmShellCall: (input: {
    readonly command: string
    readonly toolNames: readonly string[]
    readonly permission?: boolean
    readonly background?: boolean
  }) => { name: string; args: Record<string, JsonValue> } | null
  readonly llmNotificationReply?: (input: {
    readonly lastMessage: string
    readonly messages: readonly { readonly role: string; readonly content: string; readonly toolCallId?: string }[]
  }) => string | null
  readonly llmContinueShellCall?: (input: { readonly result: string; readonly toolNames: readonly string[] }) =>
    { name: string; args: Record<string, JsonValue> } | null
  readonly llmMetadataContext?: (input: {
    readonly format: string; readonly toolNames: readonly string[]; readonly messages: readonly { readonly content: string }[]
  }) => { content: string; replyTool?: string } | null
  readonly llmReadCall?: (input: { readonly path: string; readonly toolNames: readonly string[] }) =>
    { name: string; args: Record<string, JsonValue> } | null
  readonly llmQuestionCall?: (input: {
    readonly toolNames: readonly string[]
    readonly options: readonly string[]
    readonly multiple: boolean
  }) => { name: string; args: Record<string, JsonValue> } | null
  readonly scenarioDialect?: HarnessScenarioDialect
  /** Extra CLI args for the transparent native protocol recorder wrapper. */
  readonly recorderArgs: readonly string[]
  /** Extract the native session identity from the plugin's published opaque session state. */
  readonly nativeSessionIdentity: (sessionState: JsonValue) => string | null
  /** Parse concrete model identities from recorded native protocol frames. */
  readonly nativeModelEvidence: (events: readonly NativeProtocolEvent[]) => readonly string[]
  /** Concrete model identities in this plugin's committed native session state. */
  readonly sessionModelEvidence: (sessionState: JsonValue) => readonly string[]
  /**
   * Render the requested model the way the native protocol reports it
   * (for example a provider-qualified name). Return undefined when the
   * request carries no model and the native default applies.
   */
  readonly qualifyRequestedModel: (
    requested: { readonly model?: string; readonly provider?: string }
  ) => string | undefined
  /**
   * True when the requested model is a native alias that the CLI resolves to
   * a concrete model at runtime; exact string equality is not expected then.
   */
  readonly isNativeAliasModel: (requested: string | undefined) => boolean
  /** Whether the Harness rotates its native session to replace thread-bound tool schemas. */
  readonly rotatesSessionOnSchemaChange: boolean
  /**
   * Thread settings for the missing-executable failure scenario: the settings
   * must point at an executable path that does not exist. Return null when
   * this Harness cannot express the scenario through Thread options (for
   * example because the host always resolves the executable); generic runners
   * must then report the scenario as unsupported instead of guessing.
   */
  readonly missingExecutableThreadSettings:
    (harnessId: string) => Record<string, JsonValue> | null
}

const HARNESS_PACKAGE_PATTERN = /^@openagent\/harness-([a-z][a-z0-9-]*)$/

function findWorkspaceRootWithHarnesses(start: string): string {
  let current = start
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      const metadata = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'))
      if (metadata && typeof metadata === 'object' &&
          Object.keys(metadata.dependencies ?? {})
            .some(name => HARNESS_PACKAGE_PATTERN.test(name))) {
        return current
      }
    } catch { /* no readable package.json here; keep walking */ }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(
    'test-kit: 未找到声明 @openagent/harness-* 依赖的 package.json；' +
    '原生测试 Adapter 从 Desktop 的依赖集合派生注册集合，请在 apps/desktop 下运行，' +
    '或显式传入 workspaceRoot'
  )
}

/**
 * Derive the registered Harness set from the workspace dependency mechanism
 * (the same source the registry generator reads) and load each Harness's
 * native test adapter. A registered Harness without an adapter is a hard,
 * named failure — generic runners must never silently skip it.
 */
export async function loadNativeTestAdapters(
  options: { readonly workspaceRoot?: string } = {}
): Promise<Readonly<Record<string, HarnessNativeTestAdapter>>> {
  const root = findWorkspaceRootWithHarnesses(options.workspaceRoot ?? process.cwd())
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const ids = Object.keys(metadata.dependencies ?? {})
    .map(name => HARNESS_PACKAGE_PATTERN.exec(name)?.[1])
    .filter((id): id is string => Boolean(id))
  // Loaded concurrently but assembled in dependency/registry order: the
  // record's property order is observable (generic runners pick the first
  // host-capable or first eligible entry).
  const loaded = await Promise.all(ids.map(async id => {
    // Bare-specifier dynamic imports resolve from THIS module's location, not
    // the caller's cwd; pnpm does not link @openagent/* at the repository
    // root. Resolve through the workspace root's dependency links instead.
    const specifier = `@openagent/harness-${id}/test-support`
    const packageRoot = join(root, 'node_modules', '@openagent', `harness-${id}`)
    let entry: string
    try {
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
      entry = manifest.exports?.['./test-support']?.default
    } catch (error) {
      throw new Error(
        `test-kit: 已注册 Harness "${id}" 缺少原生测试 Adapter（${specifier} 不可解析）。` +
        `请在 packages/harness-${id}/src/test-support/ 提供并默认导出该 Adapter，` +
        '并在其 package.json 中声明 "./test-support" export。' +
        '通用 runner 不手抄 Harness 名单，也不静默漏跑。' +
        `原始错误：${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (typeof entry !== 'string') {
      throw new Error(
        `test-kit: 已注册 Harness "${id}" 缺少原生测试 Adapter（${specifier} 未在 exports 中声明）。` +
        `请在 packages/harness-${id}/package.json 的 exports 中加入 "./test-support"。`
      )
    }
    let imported: Record<string, unknown>
    try {
      imported = await import(pathToFileURL(join(packageRoot, entry)).href) as Record<string, unknown>
    } catch (error) {
      throw new Error(
        `test-kit: 已注册 Harness "${id}" 的原生测试 Adapter 加载失败（${specifier}）。` +
        '通常意味着包未构建：先运行 pnpm build:packages。' +
        `原始错误：${error instanceof Error ? error.message : String(error)}`
      )
    }
    const adapter = imported.default
    if (!isAdapter(adapter)) {
      throw new Error(
        `test-kit: ${specifier} 未导出符合 HarnessNativeTestAdapter 的默认 Adapter`
      )
    }
    if (adapter.id !== id) {
      throw new Error(`test-kit: ${specifier} 的 Adapter id "${adapter.id}" 与注册 id "${id}" 不一致`)
    }
    return { id, adapter }
  }))
  const adapters: Record<string, HarnessNativeTestAdapter> = {}
  for (const { id, adapter } of loaded) adapters[id] = adapter
  return Object.freeze(adapters)
}

function isAdapter(value: unknown): value is HarnessNativeTestAdapter {
  return typeof value === 'object' && value !== null &&
    typeof (value as HarnessNativeTestAdapter).id === 'string' &&
    Array.isArray((value as HarnessNativeTestAdapter).scenarioCapabilities) &&
    typeof (value as HarnessNativeTestAdapter).llmShellCall === 'function' &&
    typeof (value as HarnessNativeTestAdapter).nativeSessionIdentity === 'function' &&
    typeof (value as HarnessNativeTestAdapter).nativeModelEvidence === 'function' &&
    typeof (value as HarnessNativeTestAdapter).sessionModelEvidence === 'function'
}
