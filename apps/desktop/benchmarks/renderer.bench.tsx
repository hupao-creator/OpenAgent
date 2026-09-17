import { createRendererStateMutation } from '../src/shared/renderer-state-patch'
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { RendererCapabilitiesProvider, type RendererCapabilities } from '@openagent/plugin-kit/renderer'
import type { AgentThreadRecord, BartTranscriptItem, JsonValue } from '@openagent/contracts'
import App from '../src/renderer/src/App'
import { harnessRendererPlugins } from '../src/renderer/src/harness-composition'
import { createInitialRendererState } from '../src/shared/renderer-state'
import { HARNESS_IDS } from '../src/shared/harnesses'
import type { DesktopApi } from '../src/shared/desktop-api'
import type { RendererAppState, RendererStateMutation } from '../src/shared/renderer-state-contracts'
import { createCodexPreview } from '../playgrounds/thread-detail/src/native-fixtures/codex'
import { createClaudePreview } from '../playgrounds/thread-detail/src/native-fixtures/claude'
import '../src/renderer/src/fonts.css'
import '../src/renderer/src/styles.css'

// This runs the production App and native plugin renderers with synthetic IPC
// mutations. No agent is started and no real user data or backend is accessed.
const query = new URLSearchParams(location.search)
const fixtures = { codex: createCodexPreview, claude: createClaudePreview }
const harness = query.get('harness') as keyof typeof fixtures || 'codex'
const count = Math.max(1, Math.min(200, Number(query.get('threads')) || 48))
const history = Math.max(1, Math.min(160, Number(query.get('turns')) || 24))
const mode = query.get('mode') || 'overview'
/** A real probe asks the machine and takes time to answer; this one can be made to. */
const probeDelay = Math.max(0, Math.min(10_000, Number(query.get('probeDelay')) || 0))
const answer = '正在检查前端渲染性能。保留现有交互，减少重复投影与无效渲染。'
const makeFixture = (text: string, threadId: string, phase: 'running' | 'completed' = 'running') => {
  const fixture = fixtures[harness]({ phase, history: true, answer: text, threadId })
  const data = fixture.sessionState as Record<string, unknown>
  return { ...fixture, sessionState: { ...data, turns: (data.turns as unknown[]).slice(-history) } } as typeof fixture
}
const threads: AgentThreadRecord[] = Array.from({ length: count }, (_, index) => ({
  id: `benchmark-${index}`, harnessId: harness, revision: 1, archived: false,
  title: `渲染性能任务 ${index + 1}`, tags: ['性能优化'], settings: {},
  cwd: '/workspace/OpenAgent', createdAt: 1_000 + index, updatedAt: 2_000,
  ...makeFixture(answer, `benchmark-${index}`)
}))
/**
 * Bart's own tool operations are what the Dock paints, and the cross-page flight
 * has to carry whatever they are holding. `bartOps` names one to seed — a
 * running call with no `completedAt`, which is what makes the Dock busy — and
 * `rendererBenchmark.setBartOperation` replaces it while a copy is in the air,
 * which is the only way to put a *new* expression on the destination mid-flight.
 */
const BART_TOOL_NAMES: Record<string, string> = {
  list: 'openagent_thread_list', start: 'openagent_thread_start',
  send: 'openagent_thread_send', read: 'openagent_thread_read'
}
const bartOperation = (kind: string): BartTranscriptItem => ({
  type: 'tool-operation', id: `benchmark-bart-op-${kind}`, executionId: 'benchmark-bart-execution',
  callId: `benchmark-bart-op-${kind}`, name: BART_TOOL_NAMES[kind] ?? kind,
  arguments: { threadId: 'benchmark-0' }, createdAt: 1_000
})
const seededBartOperation = query.get('bartOps')
/**
 * A Dock that is wearing a *role* rather than an operation. The operations above
 * are Bart's own, and each one owns a route of its own, so the generic face stays
 * untouched; a foreground call with no route of its own is what makes
 * `bart-role.css` shift and squash the engine's face, and a foreground reasoning
 * segment is what hides it. `projectBartDock` publishes an activity only for a
 * *running* turn, so the last one has to be running with the call attached.
 */
const BART_ROLE_TOOLS: Record<string, string> = { tool: 'shell', reasoning: 'analysis' }
const bartRole = query.get('bartRole')
const bartRoleSession = (kind: string): JsonValue => {
  const session = makeFixture(answer, 'bart').sessionState as Record<string, JsonValue>
  const turns = session.turns as Record<string, JsonValue>[]
  const last = turns[turns.length - 1]!
  return {
    ...session,
    turns: [...turns.slice(0, -1), {
      ...last,
      status: 'running',
      foreground: kind === 'reasoning'
        ? { kind: 'reasoning', text: '正在核对设置页与俯瞰视图之间的坐标映射，确认席位滑动与路线尺度不相互干扰', sequence: 1 }
        : { kind: 'tool-call', callId: 'benchmark-role-call', toolName: BART_ROLE_TOOLS[kind] ?? kind, sequence: 1 }
    }]
  }
}
const initial = createInitialRendererState('/workspace/OpenAgent')
let snapshot: RendererAppState = {
  ...initial,
  // The real Main supplies normalized plugin settings before hydration.
  settings: { ...initial.settings, harnesses: Object.fromEntries(HARNESS_IDS.map(id => [id, { threadSettings: {} }])) },
  revision: 1,
  threads: [{
    ...threads[0]!, id: 'bart', bart: true, title: 'Bart', transcript: [],
    ...(bartRole ? { sessionState: bartRoleSession(bartRole), observation: { latestExecution: null, backgroundWork: null }, transcript: [] }
      : query.has('bartSession') ? makeFixture('## 会话在 Bart 内部\n\n镜头穿过眼睛后，正文和输入区保持最终阅读位置。', 'bart', 'completed')
      : { sessionState: null, observation: { latestExecution: null, backgroundWork: null },
          transcript: seededBartOperation ? [bartOperation(seededBartOperation)] : [] })
  }, ...threads],
  selectedThreadId: mode === 'overview' ? null : threads[0]!.id
}
let publishedSnapshot = snapshot
const listeners = new Set<(mutation: RendererStateMutation) => void>()
// Only the Harness under test is on the machine by default; `installed` widens
// the roster so a second one can be picked as coordinator.
const installedIds = new Set((query.get('installed') ?? harness).split(','))
const noop = async () => undefined
window.openAgent = {
  platform: 'darwin', loadState: async () => structuredClone(snapshot),
  onStateMutation: (listener: (mutation: RendererStateMutation) => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  openExternal: noop, interruptThread: noop, respondToThreadInteraction: noop,
  // An edit has to be saved before the settings page will close, and a rejected
  // save leaves the reader on the page with a banner instead. Nothing is persisted
  // here, but the write still has to succeed.
  updateAppSettings: noop,
  loadHarnessSettingsPresentation: async (request: { scope: 'global'; harnessId: string }) => ({
    ...request, value: { cli: { available: true, status: request.harnessId === 'pi' ? 'ready' : 'available', executablePath: `/usr/local/bin/${request.harnessId}` }, models: [] }
  }),
  // Settings probes every Harness on open. Without a probe the whole map settles
  // into `error`, no Harness reads as installed, and the Bart tab renders no
  // coordinator seat — leaving the cross-page transition with no landing target.
  detectHarnessInstallations: async () => {
    if (probeDelay) await new Promise((done) => setTimeout(done, probeDelay))
    return Object.fromEntries(HARNESS_IDS.map((harnessId) => [
      harnessId,
      installedIds.has(harnessId) ? { status: 'installed', executablePath: `/usr/local/bin/${harnessId}` } : { status: 'missing' }
    ]))
  },
  updateUiState: async (update: { selectedThreadId?: string | null }) => {
    snapshot = { ...snapshot, ...update, revision: snapshot.revision + 1 }
    emit(takeMutation())
  }
} as unknown as DesktopApi

let measuring = false
let projectionCalls = 0
let commits: number[] = []
const onRender: ProfilerOnRenderCallback = (_id, _phase, duration) => {
  if (measuring) commits.push(duration)
}
for (const binding of Object.values(harnessRendererPlugins)) {
  const project = binding.projectOverview
  binding.projectOverview = (...args) => {
    if (measuring) projectionCalls += 1
    return project(...args)
  }
}
function takeMutation(): RendererStateMutation {
  const mutation = createRendererStateMutation(publishedSnapshot, snapshot)
  publishedSnapshot = snapshot
  return structuredClone(mutation)
}
function emit(mutation: RendererStateMutation): void {
  for (const listener of listeners) listener(mutation)
}
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0

async function run(samples = 60) {
  await document.fonts.ready
  await new Promise((done) => setTimeout(done, 1_000))
  const updateMs: number[] = []
  commits = []
  projectionCalls = 0
  const target = mode === 'background' ? threads.at(-1)!.id : threads[0]!.id
  // Warm the same update path before recording, including lazy Markdown imports.
  for (let index = -10; index < samples; index += 1) {
    await frame()
    const fixture = makeFixture(`${answer}\n\n当前进度 ${index + 11}，继续检查。`, target)
    snapshot = {
      ...snapshot, revision: snapshot.revision + 1,
      threads: snapshot.threads.map((thread) => thread.id === target
        ? { ...thread, ...fixture, revision: thread.revision + 1, updatedAt: thread.updatedAt + 1 }
        : thread)
    }
    // IPC structured cloning happens before delivery; exclude fixture/transport
    // creation from the measured renderer notification + React commit duration.
    const incoming = takeMutation()
    measuring = index >= 0
    const start = performance.now()
    flushSync(() => emit(incoming))
    if (measuring) updateMs.push(performance.now() - start)
  }
  measuring = false
  const result = {
    harness, mode, threads: count, turnsPerThread: history, samples,
    updateMedianMs: percentile(updateMs, .5), updateP95Ms: percentile(updateMs, .95),
    reactTotalMs: commits.reduce((sum, value) => sum + value, 0),
    reactCommits: commits.length, projectionCalls,
    domElements: document.querySelectorAll('*').length,
    renderedTurns: document.querySelectorAll('[data-turn-id]').length,
    revision: document.querySelector('.app-shell')?.getAttribute('data-state-revision')
  }
  console.info('Renderer benchmark', result)
  return result
}

/** Replaces Bart's live tool operation, or clears it, in the same tick it is called. */
function setBartOperation(kind: string | null): void {
  snapshot = {
    ...snapshot, revision: snapshot.revision + 1,
    threads: snapshot.threads.map((thread) => thread.bart === true
      ? { ...thread, revision: thread.revision + 1, transcript: kind ? [bartOperation(kind)] : [] }
      : thread)
  }
  // Synchronous, because the caller is watching a flight that is measured in
  // hundreds of milliseconds: an operation delivered a frame late is no longer a
  // change that arrives while the copy is in the air.
  flushSync(() => emit(takeMutation()))
}

Object.assign(window, { rendererBenchmark: { run, setBartOperation } })
const rendererCapabilities: RendererCapabilities = { openExternal: noop }
createRoot(document.querySelector('#root')!).render(
  <RendererCapabilitiesProvider capabilities={rendererCapabilities}>
    <Profiler id="app" onRender={onRender}><App /></Profiler>
  </RendererCapabilitiesProvider>
)
