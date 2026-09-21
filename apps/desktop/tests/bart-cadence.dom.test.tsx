// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useState, type ComponentProps } from 'react'
import type { HarnessBartActivity } from '@openagent/contracts/renderer'
import { BartDock } from '../src/renderer/src/components/BartDock'
import { getBartPresenceCoordinator } from '../src/renderer/src/bart-motion/presence'

const noop = (): void => {}
const context = (executionId = 'execution-1', status: 'running' | 'completed' | 'failed' | 'interrupted' | 'waiting-for-user' = 'running', threadKey = 'bart-test') => ({
  threadKey, execution: { executionId, status }
})
const reasoning = (text: string, sequence = 1): HarnessBartActivity => ({
  kind: 'reasoning', text, sequence, executionId: 'execution-1'
})
const tool = (toolName: string, sequence = 2): HarnessBartActivity => ({
  kind: 'tool-call', toolName, callId: `call-${sequence}`, sequence, executionId: 'execution-1'
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => { cleanup(); getBartPresenceCoordinator().reset(); vi.useRealTimers(); vi.restoreAllMocks() })

function fixture(initial: HarnessBartActivity | null) {
  const element = (foregroundActivity: HarnessBartActivity | null, props: Partial<ComponentProps<typeof BartDock>> = {}) => (
    <BartDock threadOpen={false} sessionIdle={false} inputOpen={false} inputValue="" bartAttachments={[]}
      activityContext={context()}
      running foregroundActivity={foregroundActivity}
      onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
      onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop} {...props} />
  )
  const view = render(element(initial))
  return {
    view,
    set: (activity: HarnessBartActivity | null, props?: Partial<ComponentProps<typeof BartDock>>) =>
      view.rerender(element(activity, props)),
    advance: (ms: number) => act(() => vi.advanceTimersByTime(ms)),
    role: () => view.container.querySelector('.bart-dock')?.getAttribute('data-role'),
    name: () => view.container.querySelector('.bart-role-tool-name')?.textContent,
    text: () => view.container.querySelector('textPath')?.textContent?.trim()
  }
}

it('holds the visible fragment for 800ms and then selects the latest activity without replaying intermediates', () => {
  const f = fixture(reasoning('检查调用链'))
  expect(f.role()).toBe('reasoning')
  f.advance(100)
  f.set(tool('read_file'))
  expect(f.role()).toBe('reasoning')
  f.advance(600)
  f.set(tool('write_file', 3))
  f.advance(99)
  expect(f.role()).toBe('reasoning')
  f.advance(1)
  expect(f.role()).toBe('tool')
  expect(f.name()).toBe('write_file')
})

it('shows the first activity immediately and lets a real turn ending bypass its hold', () => {
  const f = fixture(null)
  f.set(reasoning('开始思考'))
  expect(f.role()).toBe('reasoning')
  f.advance(100)
  f.set(tool('read_file'))
  f.set(null, { running: false, sessionIdle: true, activityContext: context('execution-1', 'completed') })
  expect(f.role()).toBe('idle')
  f.advance(2_000)
  expect(f.role()).toBe('idle')
})

it('drops old pending activity as soon as the execution changes, even before the new activity arrives', () => {
  const f = fixture(reasoning('第一轮'))
  f.advance(100)
  f.set(tool('old_tool'))
  f.set(null, { activityContext: context('execution-2') })
  expect(f.role()).toBe('running')
  f.set({ ...tool('new_tool'), executionId: 'execution-2' }, { activityContext: context('execution-2') })
  expect(f.name()).toBe('new_tool')
  f.advance(2_000)
  expect(f.name()).toBe('new_tool')
})

it.each(['completed', 'failed', 'interrupted'] as const)('lets %s clear the displayed activity despite a late source snapshot or old dedicated result', (status) => {
  const f = fixture(reasoning('执行中'))
  f.advance(100)
  f.set(tool('read_file'))
  f.set(reasoning('迟到的旧活动'), {
    activityContext: context('execution-1', status), running: false, sessionIdle: true,
    operations: [{ id: 'old-operation', kind: 'status', phase: 'completed' }]
  })
  expect(f.role()).toBe('idle')
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-activity', 'idle')
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-phase', 'idle')
  f.advance(2_000)
  expect(f.role()).toBe('idle')
})

it('replaces a different Bart session immediately even when execution identifiers match', () => {
  const f = fixture(reasoning('原来的 Bart'))
  f.advance(100)
  f.set(tool('old_tool'))
  f.set(tool('new_session_tool'), { activityContext: context('execution-1', 'running', 'another-bart:harness') })
  expect(f.name()).toBe('new_session_tool')
  f.advance(2_000)
  expect(f.name()).toBe('new_session_tool')
})

it('uses Lab timing choices for both the visible hold and reasoning refresh', () => {
  const f = fixture(reasoning('初始'))
  const displayTiming = { minimumMs: 400, reasoningMs: 100 }
  f.advance(50)
  f.set(reasoning('刷新'), { displayTiming })
  f.advance(49)
  expect(f.text()).toBe('初始')
  f.advance(1)
  expect(f.text()).toBe('刷新')
  f.advance(50)
  f.set(tool('read_file'), { displayTiming })
  f.advance(249)
  expect(f.role()).toBe('reasoning')
  f.advance(1)
  expect(f.role()).toBe('tool')
})

it('resumes from the latest activity after input takes over, with a fresh visible interval', () => {
  const f = fixture(reasoning('旧思考'))
  f.advance(100)
  f.set(tool('read_file'))
  f.set(tool('read_file'), { inputOpen: true })
  f.advance(50)
  f.set(tool('write_file'), { inputOpen: true })
  f.advance(50)
  f.set(tool('write_file'), { inputOpen: false })
  expect(f.role()).toBe('tool')
  expect(f.name()).toBe('write_file')
  f.set(reasoning('恢复后的思考'))
  f.advance(799)
  expect(f.role()).toBe('tool')
  f.advance(1)
  expect(f.role()).toBe('reasoning')
})

it('coalesces reasoning into the latest 150ms sample without restarting its decoration across segments', () => {
  const f = fixture(reasoning('最初片段'))
  const arc = f.view.container.querySelector('.bart-role-arc')
  f.advance(50)
  f.set(reasoning('中间增量'))
  f.advance(50)
  f.set(reasoning('新的完整片段', 2))
  f.advance(49)
  expect(f.text()).toBe('最初片段')
  f.advance(1)
  expect(f.text()).toBe('新的完整片段')
  expect(f.view.container.querySelector('.bart-role-arc')).toBe(arc)
})

it('preserves the tool decoration while replacing rapid names at each display deadline', () => {
  const f = fixture(tool('read_file'))
  const signature = f.view.container.querySelector('.bart-role-signature')
  f.advance(100)
  f.set(tool('write_file', 3))
  f.advance(600)
  f.set(tool('search', 4))
  f.advance(100)
  expect(f.name()).toBe('search')
  expect(f.view.container.querySelector('.bart-role-signature')).toBe(signature)
  f.advance(100)
  f.set(tool('search', 5))
  f.advance(100)
  f.set(tool('list_files', 6))
  f.advance(599)
  expect(f.name()).toBe('search')
  f.advance(1)
  expect(f.name()).toBe('list_files')
})

it('absorbs a brief return to reasoning and never lets a stale reasoning timer paint over a tool', () => {
  const f = fixture(reasoning('旧片段'))
  f.advance(50)
  f.set(reasoning('不应闪现'))
  f.advance(50)
  f.set(tool('read_file'))
  f.advance(100)
  expect(f.text()).toBe('旧片段')
  f.set(reasoning('最新片段', 3))
  f.advance(1)
  expect(f.role()).toBe('reasoning')
  expect(f.text()).toBe('最新片段')
  f.advance(600)
  f.set(tool('write_file', 4))
  f.advance(1)
  expect(f.role()).toBe('tool')
  expect(f.name()).toBe('write_file')
})


it('catches up at the real spatial flight handoff and starts a fresh visible interval', () => {
  const f = fixture(reasoning('飞行前'))
  f.advance(100)
  f.set(tool('read_file'))
  let release!: () => void
  act(() => { release = getBartPresenceCoordinator().hold(Symbol('test-scene')) })
  f.advance(50)
  f.set(tool('write_file'))
  f.advance(50)
  act(() => release())
  expect(f.name()).toBe('write_file')
  f.set(reasoning('返回之后'))
  f.advance(799)
  expect(f.role()).toBe('tool')
  f.advance(1)
  expect(f.text()).toBe('返回之后')
})


it('catches up when the camera uncovers the Dock, even while its own layout stayed mounted', () => {
  const f = fixture(reasoning('镜头前'))
  f.advance(100)
  f.set(tool('read_file'), { presentationCovered: true })
  f.advance(100)
  f.set(tool('write_file'), { presentationCovered: true })
  f.set(tool('write_file'), { presentationCovered: false })
  expect(f.name()).toBe('write_file')
  f.set(reasoning('镜头后'))
  f.advance(799)
  expect(f.role()).toBe('tool')
  f.advance(1)
  expect(f.text()).toBe('镜头后')
})


it('fills the gap before a dedicated Core route arrives, then yields and resumes the latest activity', () => {
  const f = fixture(reasoning('工具前'))
  f.advance(100)
  f.set(tool('openagent_thread_status'))
  expect(f.role()).toBe('reasoning')
  f.advance(700)
  expect(f.role()).toBe('running')
  const operations = [{ id: 'status-operation', kind: 'status' as const, phase: 'running' as const }]
  f.set(reasoning('专属动画期间'), { operations })
  expect(f.role()).toBe('idle')
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-activity', 'status')
  f.advance(100)
  f.set(tool('write_file'), { operations })
  f.set(tool('write_file'), { operations: [{ ...operations[0]!, phase: 'completed' }] })
  expect(f.name()).toBe('write_file')
  f.advance(1_000)
  expect(f.name()).toBe('write_file')
})


it('uses the real terminal lifecycle even before the parent running flag catches up', () => {
  const f = fixture(reasoning('即将完成'))
  f.advance(100)
  f.set(tool('read_file'))
  f.set(null, { activityContext: context('execution-1', 'completed'), running: true })
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-phase', 'idle')
})


it('catches up on window restore without treating a visible blurred window as hidden', () => {
  const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const f = fixture(reasoning('可见'))
  f.advance(100)
  f.set(tool('read_file'))
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  act(() => window.dispatchEvent(new Event('blur')))
  expect(f.role()).toBe('reasoning')
  visible.mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  f.advance(100)
  f.set(tool('write_file'))
  visible.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(f.name()).toBe('write_file')
  f.set(reasoning('恢复'))
  f.advance(799)
  expect(f.role()).toBe('tool')
  f.advance(1)
  expect(f.text()).toBe('恢复')
})

it.each([
  { passiveVisible: false },
  { threadOpen: true },
  { threadFollowUp: { threadId: 'other', threadTitle: 'Other', provider: 'codex', initialDraft: '', requestKey: 1 } },
  { interaction: { threadId: 'bart', threadTitle: 'Bart', intervention: { id: 'permission', title: 'Allow?', actions: [] } } },
  { interaction: { threadId: 'bart', threadTitle: 'Bart', intervention: { id: 'question', title: 'Choose', actions: [], questions: [{ id: 'q', prompt: 'Choose', options: [], multiple: false, allowOther: true, secret: false }] } } }
] satisfies Partial<ComponentProps<typeof BartDock>>[])('recovers after a hidden or interactive Dock (%j)', (props) => {
  const f = fixture(reasoning('接管前'))
  f.advance(100)
  f.set(tool('read_file'), props)
  if (props.interaction || props.threadFollowUp) {
    expect(f.role()).toBe('idle')
    expect(f.view.container.querySelector('.bart-role-stage[data-role]')).toBeNull()
  }
  f.advance(100)
  f.set(tool('write_file'), props)
  f.set(tool('write_file'))
  expect(f.name()).toBe('write_file')
  f.set(reasoning('接管后'))
  f.advance(799)
  expect(f.role()).toBe('tool')
  f.advance(1)
  expect(f.text()).toBe('接管后')
})

it('paces intermediate assistant text as a resident fragment but never implies a final reply', () => {
  const f = fixture(reasoning('思考'))
  f.advance(100)
  f.set({ kind: 'assistant-text', executionId: 'execution-1', sequence: 2 })
  f.advance(700)
  expect(f.role()).toBe('running')
  expect(f.view.container.querySelector('.bart-reply-stage')).toBeNull()
  f.set(tool('read_file'))
  f.advance(799)
  expect(f.role()).toBe('running')
  f.advance(1)
  expect(f.name()).toBe('read_file')
})

it('hydrates directly into the latest snapshot after unmounting with pending activity', () => {
  const old = fixture(reasoning('旧'))
  old.advance(100)
  old.set(tool('old_tool'))
  old.view.unmount()
  const next = fixture(tool('hydrated_tool'))
  expect(next.name()).toBe('hydrated_tool')
  next.advance(2_000)
  expect(next.name()).toBe('hydrated_tool')
})


it('covers submission, execution before its first event, text output and final completion without idle gaps', () => {
  const f = fixture(null)
  f.set(null, { activityContext: context('old', 'completed'), running: false, sessionIdle: true })
  expect(f.role()).toBe('idle')
  f.set(null, { activityContext: context('old', 'completed'), running: false, submitting: true })
  expect(f.role()).toBe('running')
  expect(f.view.container.querySelectorAll('.bart-running-fallback circle')).toHaveLength(3)
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-phase', 'running')
  f.set(null)
  expect(f.role()).toBe('running')
  f.advance(1200)
  f.set(reasoning('开始思考'))
  expect(f.role()).toBe('reasoning')
  f.advance(100)
  f.set(null)
  f.advance(700)
  expect(f.role()).toBe('running')
  f.set({ kind: 'assistant-text', executionId: 'execution-1', sequence: 3 })
  f.advance(500)
  expect(f.role()).toBe('running')
  f.set(null, { activityContext: context('execution-1', 'completed'), running: false, sessionIdle: true })
  expect(f.role()).toBe('idle')
  expect(f.view.container.querySelectorAll('.bart-running-fallback circle')).toHaveLength(0)
})

it('covers the first submission before a session exists and clears a rejected submission', () => {
  const f = fixture(null)
  const activityContext = { threadKey: 'new', execution: null }
  f.set(null, { activityContext, running: false, submitting: true })
  expect(f.role()).toBe('running')
  f.set(null, { activityContext, running: false, submitting: false })
  expect(f.role()).toBe('idle')
  f.advance(2000)
  expect(f.role()).toBe('idle')
})

it('returns from a completed Core route to running even before the next foreground event', () => {
  const f = fixture(null)
  const operation = { id: 'core-route', kind: 'status' as const, phase: 'running' as const }
  f.set(null, { operations: [operation] })
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-activity', 'status')
  f.set(null, { operations: [{ ...operation, phase: 'completed' }] })
  expect(f.role()).toBe('running')
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-activity', 'idle')
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-phase', 'running')
})

it.each(['completed', 'failed', 'interrupted', 'waiting-for-user'] as const)('exits the running fallback immediately on %s', status => {
  const f = fixture(null)
  expect(f.role()).toBe('running')
  f.advance(100)
  f.set(null, { activityContext: context('execution-1', status) })
  expect(f.role()).toBe('idle')
  expect(f.view.container.querySelector('.bart-logo')).toHaveAttribute('data-phase', 'idle')
})


it.each([true, false])('shows running during an open composer submission and settles success=%s', async succeeds => {
  let resolve!: () => void, reject!: (error: Error) => void
  const submission = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  function SubmitFixture() {
    const [inputOpen, setInputOpen] = useState(true)
    const [submitting, setSubmitting] = useState(false)
    const [activityContext, setContext] = useState(context('previous', 'completed'))
    return <BartDock threadOpen={false} sessionIdle={!submitting} running={false}
      inputOpen={inputOpen} inputValue="开始任务" bartAttachments={[]} submitting={submitting}
      activityContext={activityContext}
      onThreadOpenChange={noop} onInputOpenChange={setInputOpen} onInputChange={noop}
      onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={async () => {
        setSubmitting(true)
        try { await submission; setContext(context()) }
        finally { setSubmitting(false) }
      }} />
  }
  const view = render(<SubmitFixture />)
  const dock = view.container.querySelector('.bart-dock')!
  expect(dock).toHaveAttribute('data-role', 'idle')
  fireEvent.submit(view.container.querySelector('form')!)
  expect(dock).toHaveAttribute('data-layout', 'input')
  expect(dock).toHaveAttribute('data-role', 'running')
  expect(view.container.querySelectorAll('.bart-running-fallback circle')).toHaveLength(3)
  act(() => vi.advanceTimersByTime(1200))
  expect(dock).toHaveAttribute('data-role', 'running')
  await act(async () => { if (succeeds) resolve(); else reject(new Error('submission failed')) })
  expect(dock).toHaveAttribute('data-role', succeeds ? 'running' : 'idle')
  if (!succeeds) {
    expect(dock).toHaveAttribute('data-layout', 'input')
    expect(view.getByDisplayValue('开始任务')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.bart-running-fallback circle')).toHaveLength(0)
  }
})
