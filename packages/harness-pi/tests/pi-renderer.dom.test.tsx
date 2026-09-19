// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nProvider, SettingsFormScope } from '@openagent/plugin-kit/renderer'
import type { HarnessThreadRecord, PublicExecution } from '@openagent/contracts'
import { PiThreadView } from '../src/renderer/ThreadView.js'
import { piOverviewCardModule } from '../src/renderer/OverviewCard.js'
import { piLogo } from '../src/renderer/pi-logo.js'
import { PiThreadSettings, PiHarnessSettings } from '../src/renderer/Settings.js'
import { piRendererPluginModule } from '../src/renderer/entry.js'
import { piRendererTranslations } from '../src/renderer/translations.js'
import { piJson } from '../src/shared/state.js'
import type { PiSessionState } from '../src/shared/types.js'

afterEach(cleanup)
const completed: PublicExecution = { executionId: 'first', status: 'completed', startedAt: 1, finishedAt: 2 }
function thread(execution: PublicExecution = completed): HarnessThreadRecord {
  const state: PiSessionState = { version: 1, sessionFile: '/native/session.jsonl', executions: [completed, execution.executionId === 'first' ? { ...completed, executionId: 'second' } : execution], latestExecutionId: execution.executionId === 'first' ? 'second' : execution.executionId, messages: [
    { id: 'u1', executionId: 'first', role: 'user', text: 'Earlier question' },
    { id: 'a1', executionId: 'first', role: 'assistant', text: 'Earlier full answer', usage: { input: 10, output: 4, cacheRead: 5, cacheWrite: 2 } },
    { id: 'u2', executionId: 'second', role: 'user', text: 'Current question' },
    { id: 'a2', executionId: 'second', role: 'assistant', text: 'Current full answer' }
  ] }
  return { id: 'pi-thread', harnessId: 'pi', revision: 1, title: 'Pi task', settings: {}, sessionState: piJson(state), observation: { latestExecution: state.executions[1], backgroundWork: null }, tags: [], cwd: '/project', createdAt: 1, updatedAt: 3 }
}
function actions() { return { interrupt: vi.fn().mockResolvedValue(undefined), respond: vi.fn().mockResolvedValue(undefined), forkThread: vi.fn().mockResolvedValue({ threadId: 'clone' }), openExternal: vi.fn(), openFollowUp: vi.fn(), invokeHarnessExtension: vi.fn() } }
/** One Execution with the given messages, so a card projection can be driven from its transcript. */
function cardThread(messages: PiSessionState['messages'], executionId = 'run'): HarnessThreadRecord {
  const execution: PublicExecution = { executionId, status: 'completed', startedAt: 1, finishedAt: 2 }
  const state: PiSessionState = { version: 1, executions: [execution], latestExecutionId: executionId, messages }
  return { id: 'pi-card', harnessId: 'pi', revision: 1, title: 'Pi task', settings: {}, sessionState: piJson(state),
    observation: { latestExecution: execution, backgroundWork: null }, tags: [], cwd: '/project', createdAt: 1, updatedAt: 3 }
}
function renderCard(current: HarnessThreadRecord, layout = { availableColumns: 2 }) {
  const projection = piOverviewCardModule.project({ thread: current, layout })
  const Card = piOverviewCardModule.Card
  return render(<I18nProvider locale="en-US"><Card thread={current} projection={projection.view} actions={{ ...actions(), openThread: vi.fn() }} /></I18nProvider>)
}
it('uses the official adaptive Pi mark everywhere the Renderer exposes its logo', () => {
  expect(piLogo).toMatch(/^data:image\/svg\+xml,/)
  const markup = decodeURIComponent(piLogo.slice('data:image/svg+xml,'.length))
  expect(markup).toContain('M165.29 165.29')
  expect(markup).toContain('M517.36 400 H634.72 V634.72 H517.36 Z')
  expect(markup).toContain('prefers-color-scheme: dark')
  expect(piRendererPluginModule.plugin.logoSource).toBe(piLogo)
  // Pi's own copy has to reach the Host, or an English locale falls back to the
  // Chinese source for every Pi-only string.
  expect(piRendererPluginModule.plugin.translations).toBe(piRendererTranslations)

  const current = thread()
  const projection = piOverviewCardModule.project({ thread: current, layout: { availableColumns: 2 } })
  const Card = piOverviewCardModule.Card
  const view = render(<I18nProvider locale="en-US"><Card thread={current} projection={projection.view} actions={{ ...actions(), openThread: vi.fn() }} /></I18nProvider>)
  expect(view.container.querySelector('.thread-provider-logo img')).toHaveAttribute('src', piLogo)
})
it('opens full historical execution without a fork entry', async () => {
  const a = actions()
  const view = render(<I18nProvider locale="en-US"><PiThreadView thread={thread()} actions={a} /></I18nProvider>)
  expect(view.container.querySelectorAll('.thread-detail-subpage-link')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /Earlier question/ }))
  expect(await within(view.container.querySelector('.thread-detail-subpage') as HTMLElement).findByText('Earlier full answer')).toBeVisible()
  expect(screen.getByLabelText(/21 tokens/)).toBeVisible()
  expect(screen.queryByRole('button', { name: /复制当前会话|Copy current session/ })).not.toBeInTheDocument()
  expect(a.forkThread).not.toHaveBeenCalled()
})
it.each(['current', 'history'] as const)('merges adjacent tools after visibility filtering in %s reading', async (mode) => {
  const current = thread()
  const executionId = mode === 'history' ? 'first' : 'second'
  const state = current.sessionState as unknown as PiSessionState
  state.messages = [
    ...state.messages.filter(message => message.executionId !== executionId),
    { id: 'tool-1', executionId, role: 'tool', text: 'First result', toolName: 'First tool' },
    { id: 'empty', executionId, role: 'assistant', text: '  ' },
    { id: 'user-middle', executionId, role: 'user', text: 'Continue working' },
    { id: 'tool-2', executionId, role: 'tool', text: 'Second result', toolName: 'Second tool' }
  ]
  const view = render(<I18nProvider locale="en-US"><PiThreadView thread={current} actions={actions()}
    readingTarget={{ requestId: mode, executionId, mode }}
  /></I18nProvider>)
  const page = within(mode === 'history'
    ? view.container.querySelector<HTMLElement>('.thread-detail-subpage')! : view.container)
  fireEvent.click(page.getByRole('button', { name: 'Show work' }))
  const summary = page.getByRole('button', { name: 'Execution process' })
  fireEvent.click(summary)
  expect(page.getByText('First tool')).toBeVisible()
  expect(page.getByText('Second tool')).toBeVisible()
  fireEvent.click(page.getByRole('button', { name: 'Show user messages' }))
  expect(page.getAllByRole('button', { name: 'Execution process' })).toHaveLength(2)
  const userRow = view.container.querySelector<HTMLElement>('.thread-detail-user')!
  expect((await within(userRow).findByText('Continue working')).closest('.thread-execution-process')).toBeNull()
  fireEvent.click(page.getByRole('button', { name: 'Hide user messages' }))
  expect(page.getByRole('button', { name: 'Execution process' })).toBe(summary)
  expect(summary).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(page.getByRole('button', { name: 'Hide work' }))
  expect(page.queryByRole('button', { name: 'Execution process' })).toBeNull()
})
it('interrupts running execution and displays action failures', async () => {
  const a = actions(); a.interrupt.mockRejectedValue(new Error('abort failed'))
  render(<I18nProvider locale="en-US"><PiThreadView thread={thread({ executionId: 'second', startedAt: 3, status: 'running' })} actions={a} /></I18nProvider>)
  fireEvent.click(screen.getByRole('button', { name: '中断' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('abort failed')
  expect(a.interrupt).toHaveBeenCalledOnce()
})
it('answers current public questions and removes controls after resolution', async () => {
  const a = actions()
  const waiting: PublicExecution = { executionId: 'second', startedAt: 3, status: 'waiting-for-user', interactions: [{ id: 'request', kind: 'question', title: 'Choose deployment', actions: [{ id: 'submit', intent: 'submit', label: 'Send answer' }], questions: [{ id: 'target', prompt: 'Which target?', multiple: false, allowOther: false, secret: false, options: [{ value: 'staging', label: 'Staging' }] }] }] }
  const view = render(<I18nProvider locale="en-US"><PiThreadView thread={thread(waiting)} actions={a} /></I18nProvider>)
  expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /Staging/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
  await waitFor(() => expect(a.respond).toHaveBeenCalledWith({ interactionId: 'request', actionId: 'submit', answers: { target: 'staging' } }))
  view.rerender(<I18nProvider locale="en-US"><PiThreadView thread={thread()} actions={a} /></I18nProvider>)
  expect(screen.queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument()
})
it('saves explicit native settings resets and locks configuration during execution', async () => {
  const update = vi.fn().mockResolvedValue(undefined)
  const configured = { ...thread(), settings: { executablePath: '/pinned/pi', provider: 'anthropic', model: 'claude-test' } }
  const resource = { status: 'ready' as const, reload: vi.fn(), value: { cli: { status: 'ready' as const }, models: [] } }
  const view = render(<I18nProvider locale="en-US"><PiThreadSettings thread={configured} resource={resource} update={update} /></I18nProvider>)
  expect(screen.getAllByRole('combobox')).toHaveLength(3)
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Apply thread configuration' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith({ model: null }))
  view.rerender(<I18nProvider locale="en-US"><PiThreadSettings thread={thread({ executionId: 'second', startedAt: 3, status: 'running' })} resource={resource} update={update} /></I18nProvider>)
  expect(screen.getByLabelText('Model')).toBeDisabled()
})

it('reports CLI status without a configurable executable path', () => {
  const change = vi.fn()
  const resource = { status: 'ready' as const, reload: vi.fn(), value: { cli: { status: 'ready' as const }, models: [] } }
  const view = render(<I18nProvider locale="en-US"><PiHarnessSettings section="cli" value={{ threadSettings: {} }} change={change} resource={resource} /></I18nProvider>)
  expect(screen.queryByLabelText('Pi executable path')).not.toBeInTheDocument()
  expect(view.container.querySelector('.sf-executable')).toHaveTextContent('Available')
  expect(change).not.toHaveBeenCalled()
})

it('gates the Thread default rows behind the Agent defaults until the settings opt out', () => {
  const change = vi.fn()
  const resource = { status: 'ready' as const, reload: vi.fn(), value: { cli: { status: 'ready' as const }, models: [] } }
  const view = render(<I18nProvider locale="en-US"><PiHarnessSettings section="thread" value={{ threadSettings: {} }} change={change} resource={resource} /></I18nProvider>)
  expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  expect(screen.getByLabelText('Use default configuration')).toBeChecked()
  view.rerender(<I18nProvider locale="en-US"><PiHarnessSettings section="thread" value={{ useDefaultThreadSettings: false, threadSettings: { provider: 'anthropic' } }} change={change} resource={resource} /></I18nProvider>)
  expect(screen.getAllByRole('combobox')).toHaveLength(3)
  expect(screen.getByLabelText('Use default configuration')).not.toBeChecked()
  view.rerender(<I18nProvider locale="en-US"><PiHarnessSettings section="thread" value={{ useDefaultThreadSettings: false, threadSettings: { provider: 'anthropic', model: 'reasoner', thinkingLevel: 'high' } }} change={change} resource={resource} /></I18nProvider>)
  expect(screen.getAllByRole('combobox')).toHaveLength(3)
  expect(screen.getByLabelText('Use default configuration')).not.toBeChecked()
})

it('encodes the provider in the model value so shared model ids stay distinguishable', () => {
  const change = vi.fn()
  const models = [
    { provider: 'anthropic', id: 'shared', name: 'Claude shared', reasoning: false },
    { provider: 'openai', id: 'shared', name: 'OpenAI shared', reasoning: false }
  ]
  const resource = { status: 'ready' as const, reload: vi.fn(), value: { cli: { status: 'ready' as const }, models } }
  render(<I18nProvider locale="en-US"><SettingsFormScope>
    <PiHarnessSettings section="thread" value={{ useDefaultThreadSettings: false, threadSettings: {} }} change={change} resource={resource} />
  </SettingsFormScope></I18nProvider>)
  const model = screen.getByLabelText('Model') as HTMLSelectElement
  expect(within(model).getAllByRole('option').map(option => (option as HTMLOptionElement).value))
    .toEqual(['', 'anthropic/shared', 'openai/shared'])
  fireEvent.change(model, { target: { value: 'openai/shared' } })
  expect(change).toHaveBeenCalledWith({ useDefaultThreadSettings: false, threadSettings: { provider: 'openai', model: 'shared' } })
})

it('keeps a persisted provider/model visible and repairable when the catalog is unavailable', () => {
  const resource = { status: 'ready' as const, reload: vi.fn(), value: { cli: { status: 'unavailable' as const, message: '未登录' }, models: [] } }
  render(<I18nProvider locale="en-US" translations={piRendererTranslations}><SettingsFormScope>
    <PiHarnessSettings section="thread" value={{ useDefaultThreadSettings: false, threadSettings: { provider: 'anthropic', model: 'retired-model' } }} change={vi.fn()} resource={resource} />
  </SettingsFormScope></I18nProvider>)
  const provider = screen.getByLabelText('Provider') as HTMLSelectElement
  expect(provider.value).toBe('anthropic')
  expect(within(provider).getByRole('option', { name: /anthropic · unavailable in this directory/ })).toBeInTheDocument()
  const model = screen.getByLabelText('Model') as HTMLSelectElement
  expect(model.value).toBe('retired-model')
  expect(within(model).getByRole('option', { name: /retired-model · unavailable in this directory/ })).toBeInTheDocument()
})

it('offers a retry that reloads the resource while an environment is unavailable', async () => {
  const reload = vi.fn(() => new Promise<void>(() => undefined))
  const resource = { status: 'ready' as const, reload, value: { cli: { status: 'unavailable' as const, message: '未登录' }, models: [] } }
  render(<I18nProvider locale="en-US" translations={piRendererTranslations}><PiHarnessSettings section="thread" value={{ useDefaultThreadSettings: false, threadSettings: {} }} change={vi.fn()} resource={resource} /></I18nProvider>)
  const retry = screen.getByRole('button', { name: 'Retry' })
  fireEvent.click(retry)
  await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  // Reload flips the resource to loading; the action stays mounted but pending.
  await waitFor(() => expect(retry).toBeDisabled())
  expect(retry).toHaveTextContent('Retrying…')
})

it('clears the stored Thread defaults and the flag when the switch returns to the Agent defaults', () => {
  const change = vi.fn()
  const resource = { status: 'ready' as const, reload: vi.fn(), value: { cli: { status: 'ready' as const }, models: [] } }
  render(<I18nProvider locale="en-US"><PiHarnessSettings section="thread" value={{ useDefaultThreadSettings: false, threadSettings: { model: 'reasoner' } }} change={change} resource={resource} /></I18nProvider>)
  fireEvent.click(screen.getByLabelText('Use default configuration'))
  const emitted = change.mock.calls[0]![0]
  // The composition boundary rejects an own key holding `undefined`, so the
  // flag has to be absent rather than blanked.
  expect(emitted).not.toHaveProperty('useDefaultThreadSettings')
  expect(emitted.threadSettings).toEqual({})
})

it('honors explicit execution navigation and never falls back from missing history', async () => {
  const a = actions()
  const view = render(<I18nProvider locale="en-US"><PiThreadView thread={thread()} actions={a} readingTarget={{ requestId: 'read-1', executionId: 'first', mode: 'history' }} /></I18nProvider>)
  expect(await within(view.container.querySelector('.thread-detail-subpage') as HTMLElement).findByText('Earlier full answer')).toBeVisible()
  view.rerender(<I18nProvider locale="en-US"><PiThreadView thread={thread()} actions={a} readingTarget={{ requestId: 'read-2', executionId: 'missing', mode: 'history' }} /></I18nProvider>)
  expect(view.container.querySelector('.thread-detail-subpage')).toHaveTextContent(/unavailable/i)
})
it('projects waiting requests through shared overview cards and obeys intervention visibility', async () => {
  const a = { ...actions(), openThread: vi.fn() }
  const waiting = thread({ executionId: 'second', startedAt: 3, status: 'waiting-for-user', interactions: [{ id: 'permission', kind: 'permission', title: 'Allow native action?', questions: [], actions: [{ id: 'yes', intent: 'allow', label: 'Allow action' }, { id: 'no', intent: 'deny', label: 'Deny action' }] }] })
  const projection = piOverviewCardModule.project({ thread: waiting, layout: { availableColumns: 2 } })
  const Card = piOverviewCardModule.Card
  const view = render(<I18nProvider locale="en-US"><Card thread={waiting} projection={projection.view} actions={a} /></I18nProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Allow action' }))
  await waitFor(() => expect(a.respond).toHaveBeenCalledWith({ interactionId: 'permission', actionId: 'yes' }))
  const hidden = piOverviewCardModule.project({ thread: waiting, layout: { availableColumns: 2 }, displayPolicy: { hideInterventions: true } })
  view.rerender(<I18nProvider locale="en-US"><Card thread={waiting} projection={hidden.view} actions={a} /></I18nProvider>)
  expect(screen.queryByRole('button', { name: 'Allow action' })).not.toBeInTheDocument()
})

it('collapses the overview excerpt into one paragraph and marks the cut', () => {
  const current = cardThread([{ id: 'a1', executionId: 'run', role: 'assistant', text: `第一段。\n\n第二段   with   spaces。${'尾'.repeat(700)}` }])
  const projection = piOverviewCardModule.project({ thread: current, layout: { availableColumns: 2 } })
  expect(projection.excerpt).not.toContain('\n')
  expect(projection.excerpt.startsWith('第一段。 第二段 with spaces。')).toBe(true)
  expect(projection.excerpt).toHaveLength(601)
  expect(projection.excerpt.endsWith('…')).toBe(true)
  // Splitting on code points keeps a surrogate pair whole at the cut.
  const emoji = piOverviewCardModule.project({ thread: cardThread([{ id: 'a1', executionId: 'run', role: 'assistant', text: '😀'.repeat(700) }]), layout: { availableColumns: 2 } })
  expect(Array.from(emoji.excerpt)).toHaveLength(601)
  expect(Array.from(emoji.excerpt).at(-2)).toBe('😀')
})
it('leaves a short overview excerpt unmarked', () => {
  const projection = piOverviewCardModule.project({ thread: cardThread([{ id: 'a1', executionId: 'run', role: 'assistant', text: '  短  正文  ' }]), layout: { availableColumns: 2 } })
  expect(projection.excerpt).toBe('短 正文')
})
it('shows the latest run usage and cache ratio on the overview card', () => {
  const view = renderCard(cardThread([{ id: 'u1', executionId: 'run', role: 'user', text: '问题' },
    { id: 'a1', executionId: 'run', role: 'assistant', text: '当前回答', usage: { input: 10, output: 4, cacheRead: 5, cacheWrite: 2 } }]))
  expect(view.container.querySelector('.thread-card-identity-usage')).toHaveTextContent('21tokens · 29.4%cached')
})
it('keeps the previous run usage off a card whose own run reported none', () => {
  const executions: PublicExecution[] = [{ executionId: 'first', status: 'completed', startedAt: 1, finishedAt: 2 },
    { executionId: 'run', status: 'running', startedAt: 3 }]
  const state: PiSessionState = { version: 1, executions, latestExecutionId: 'run',
    messages: [{ id: 'a1', executionId: 'first', role: 'assistant', text: '上一轮', usage: { input: 10, output: 4, cacheRead: 5, cacheWrite: 2 } }] }
  const view = renderCard({ ...cardThread([], 'run'), sessionState: piJson(state), observation: { latestExecution: executions[1]!, backgroundWork: null } })
  expect(view.container.querySelector('.thread-card-identity-usage')).not.toBeInTheDocument()
})
it('reports a ready CLI without version as available and keeps loading distinct from unavailable', () => {
  const reload = vi.fn()
  const change = vi.fn()
  const view = render(<I18nProvider locale="zh-CN"><PiHarnessSettings section="cli" value={{ threadSettings: {} }} change={change}
    resource={{ status: 'ready', reload, value: { cli: { status: 'ready' }, models: [] } }} /></I18nProvider>)
  expect(screen.getAllByRole('status')).toHaveLength(1)
  for (const status of screen.getAllByRole('status')) expect(status).toHaveTextContent(/^可用/)
  expect(view.container.querySelector('.sf-executable')).toHaveTextContent('可用')
  expect(screen.queryByText('不可用')).not.toBeInTheDocument()
  view.rerender(<I18nProvider locale="zh-CN"><PiHarnessSettings section="cli" value={{ threadSettings: {} }} change={change}
    resource={{ status: 'loading', reload }} /></I18nProvider>)
  for (const status of screen.getAllByRole('status')) expect(status).toHaveTextContent('正在读取 Pi 环境…')
  expect(screen.queryByText('不可用')).not.toBeInTheDocument()
})

it('projects the native Bart presentation with stable reply identity and live foreground activity', async () => {
  const { piRendererPluginModule } = await import('../src/renderer/entry.js')
  const project = piRendererPluginModule.plugin.projectBartDock!
  const first = thread()
  const initial = project({ thread: first })!
  expect(initial).toEqual({
    activity: null,
    reply: {
      id: JSON.stringify(['second', 'a2']),
      executionId: 'second',
      excerpt: 'Current full answer',
      target: { executionId: 'second', messageId: 'a2' }
    }
  })
  expect(project({ thread: { ...first, revision: 99 } })).toEqual(initial)
  const state = structuredClone(first.sessionState) as unknown as PiSessionState
  state.messages.at(-1)!.text = 'Current full answer, continued'
  expect(project({ thread: { ...first, sessionState: piJson(state) } })).toEqual({
    ...initial,
    reply: { ...initial.reply!, excerpt: 'Current full answer, continued' }
  })
  state.messages.push({ id: 'a3', executionId: 'second', role: 'assistant', text: 'New native response' })
  expect(project({ thread: { ...first, sessionState: piJson(state) } })?.reply?.id).toBe(JSON.stringify(['second', 'a3']))
  expect(project({ thread: { ...first, sessionState: null } })).toEqual({ activity: null, reply: null })
  // A running Execution surfaces only its own persisted foreground snapshot.
  const running = thread({ executionId: 'second', startedAt: 3, status: 'running' })
  const runningState = structuredClone(running.sessionState) as unknown as PiSessionState
  runningState.foregrounds = [
    { executionId: 'second', foreground: { kind: 'tool-call', callId: 'call-1', toolName: 'read', sequence: 2 } }
  ]
  expect(project({ thread: { ...running, sessionState: piJson(runningState) } })?.activity).toEqual({
    kind: 'tool-call', callId: 'call-1', toolName: 'read', sequence: 2, executionId: 'second'
  })
})
