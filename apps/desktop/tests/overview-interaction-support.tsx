import { render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, vi } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import { ConversationOverview } from '../src/renderer/src/components/ConversationOverview'
import { projectHarnessOverviewThread } from '../src/renderer/src/harness-composition'

/** Exercise pending interactions through Core projection and the mounted overview. */
export async function expectOverviewInteraction(thread: AgentThreadRecord): Promise<void> {
  const original = JSON.stringify(thread)
  const respond = vi.fn(async (_request: { readonly threadId: string }) => undefined)
  const input = { thread }
  const projection = projectHarnessOverviewThread(input, 1)
  expect(projection.envelope.footprint.rows).toBeGreaterThan(1)
  const view = render(<ConversationOverview embedded
    threads={[input]} transitionId={null} interrupt={async () => undefined}
    onSelect={() => undefined} respond={respond} />)
  const intervention = () => view.container.querySelector('[data-extension-kind="intervention"]')
  expect(intervention()).not.toBeNull()
  expect(respond).not.toHaveBeenCalled()
  expect(JSON.stringify(thread)).toBe(original)
  const controls = within(intervention() as HTMLElement)
  const action = controls.queryByRole('button', { name: /^(跳过|Skip)$/ }) ?? Array.from(intervention()!.querySelectorAll<HTMLButtonElement>('.thread-card-intervention-actions button')).at(-1) ?? controls.getAllByRole('button').at(-1)!
  await userEvent.setup().click(action)
  await waitFor(() => expect(respond).toHaveBeenCalledOnce())
  expect(respond.mock.calls[0]?.[0]).toMatchObject({ threadId: thread.id })
  view.unmount()
}
