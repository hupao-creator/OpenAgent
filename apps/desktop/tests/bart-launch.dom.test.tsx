// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { BartDock } from '../src/renderer/src/components/BartDock'
import { prepareBartLaunch } from '../src/renderer/src/bart-motion/launch-capture'

vi.mock('../src/renderer/src/bart-motion/launch-capture', () => ({ prepareBartLaunch: vi.fn() }))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })
const noop = (): void => {}
function pending() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function Harness({ submit, threadOpen = false, facts = {} }: { submit(): Promise<void>; threadOpen?: boolean; facts?: Partial<ComponentProps<typeof BartDock>> }) {
  const [open, setOpen] = useState(true)
  return <BartDock activityContext={{ threadKey: 'bart', execution: null }} threadOpen={threadOpen}
    inputOpen={open} inputValue={'保留我的草稿\n第二行'} bartAttachments={[]}
    sessionIdle onSubmit={submit} onInputOpenChange={setOpen} onInputChange={noop}
    onThreadOpenChange={noop} onChooseFiles={noop} onRemoveBartAttachment={noop} {...facts} />
}
function prepared() {
  const dispose = vi.fn()
  vi.mocked(prepareBartLaunch).mockReturnValue({
    description: { key: 1, startedAt: 0, speed: 1, capsule: { x: 0, y: 500, width: 640, height: 140 },
      bodyOffset: { x: 0, y: -60 }, radius: 80 }, dispose
  })
  return dispose
}
it('closes immediately and stays running during a slow submit, without submitting twice', async () => {
  vi.useFakeTimers()
  const dispose = prepared(), deferred = pending(), submit = vi.fn(() => deferred.promise)
  const { container } = render(<Harness submit={submit} />)
  const form = container.querySelector('form')!
  await act(async () => { fireEvent.submit(form); fireEvent.submit(form) })
  expect(submit).toHaveBeenCalledTimes(1)
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.querySelector('.bart-dock')).toHaveAttribute('data-launching', 'true')
  await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
  expect(container.querySelector('.bart-dock')).toHaveAttribute('data-role', 'running')
  expect(container.querySelector('.bart-dock')).not.toHaveAttribute('data-launching')
  await act(async () => { deferred.resolve() })
  expect(dispose).toHaveBeenCalled()
})
it('restores the editable draft on rejection and permits a retry', async () => {
  prepared()
  const deferred = pending(), submit = vi.fn(() => deferred.promise)
  const { container } = render(<Harness submit={submit} />)
  await act(async () => { fireEvent.submit(container.querySelector('form')!) })
  await act(async () => { deferred.reject(new Error('offline')) })
  expect(container.querySelector('textarea')).toHaveValue('保留我的草稿\n第二行')
  expect(container.querySelector('form')).not.toHaveAttribute('inert')
  await act(async () => { fireEvent.submit(container.querySelector('form')!) })
  expect(submit).toHaveBeenCalledTimes(2)
})
it('releases the animation on navigation and does not reopen a failed composer over the task view', async () => {
  const dispose = prepared(), deferred = pending()
  const view = render(<Harness submit={() => deferred.promise} />)
  await act(async () => { fireEvent.submit(view.container.querySelector('form')!) })
  view.rerender(<Harness submit={() => deferred.promise} threadOpen />)
  expect(dispose).toHaveBeenCalled()
  await act(async () => { deferred.reject(new Error('offline')) })
  view.rerender(<Harness submit={() => deferred.promise} />)
  expect(view.container.querySelector('textarea')).toBeNull()
})
it('still submits and restores failure when motion is unavailable', async () => {
  vi.mocked(prepareBartLaunch).mockReturnValue(undefined)
  const deferred = pending(), submit = vi.fn(() => deferred.promise)
  const { container } = render(<Harness submit={submit} />)
  await act(async () => { fireEvent.submit(container.querySelector('form')!) })
  expect(submit).toHaveBeenCalledOnce()
  expect(container.querySelector('.bart-dock')).toHaveAttribute('data-role', 'running')
  await act(async () => { deferred.reject(new Error('offline')) })
  expect(container.querySelector('textarea')).toHaveValue('保留我的草稿\n第二行')
})

it('finishes the short launch before displaying an immediately arriving operation', async () => {
  vi.useFakeTimers()
  prepared()
  const submit = vi.fn(async () => undefined)
  const view = render(<Harness submit={submit} />)
  await act(async () => { fireEvent.submit(view.container.querySelector('form')!) })
  const facts: Partial<ComponentProps<typeof BartDock>> = {
    activityContext: { threadKey: 'bart', execution: { executionId: 'new', status: 'running' } },
    operations: [{ id: 'read', kind: 'read', phase: 'running' }]
  }
  view.rerender(<Harness submit={submit} facts={facts} />)
  expect(view.container.querySelector('.bart-dock')).toHaveAttribute('data-launching', 'true')
  expect(view.container.querySelector('.bart-dock')).toHaveAttribute('data-activity', 'idle')
  await act(async () => { await vi.advanceTimersByTimeAsync(721) })
  expect(view.container.querySelector('.bart-dock')).toHaveAttribute('data-activity', 'read')
  expect(view.container.querySelector('.bart-dock')).not.toHaveAttribute('data-launching')
})
it('a terminal execution interrupts the intro immediately', async () => {
  prepared()
  const submit = vi.fn(async () => undefined)
  const view = render(<Harness submit={submit} />)
  await act(async () => { fireEvent.submit(view.container.querySelector('form')!) })
  view.rerender(<Harness submit={submit} facts={{
    activityContext: { threadKey: 'bart', execution: { executionId: 'new', status: 'completed' } }
  }} />)
  expect(view.container.querySelector('.bart-dock')).not.toHaveAttribute('data-launching')
  expect(view.container.querySelector('.bart-dock')).toHaveAttribute('data-role', 'idle')
})
