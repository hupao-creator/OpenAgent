import { render, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, vi } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import { ConversationOverview } from '../src/renderer/src/components/ConversationOverview'
import { projectHarnessOverviewThread } from '../src/renderer/src/harness-composition'

/** Exercise both Core caches and the mounted overview with an unchanged Thread. */
export async function expectOverviewPolicyToggle(thread: AgentThreadRecord): Promise<void> {
  const original = JSON.stringify(thread)
  const respond = vi.fn(async (_request: { readonly threadId: string }) => undefined)
  const input = (hideInterventions: boolean) => ({ thread, displayPolicy: { hideInterventions } })
  const card = (hidden: boolean) => <ConversationOverview embedded
    threads={[input(hidden)]} transitionId={null} interrupt={async () => undefined}
    onSelect={() => undefined} respond={respond} />
  const visible = projectHarnessOverviewThread(input(false), 1)
  const hidden = projectHarnessOverviewThread(input(true), 1)
  expect(hidden.envelope.footprint).toEqual({ columns: 1, rows: 1 })
  expect(visible.envelope.footprint.rows).toBeGreaterThan(1)
  const view = render(card(false))
  const intervention = () => view.container.querySelector('[data-extension-kind="intervention"]')
  expect(intervention()).not.toBeNull()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    view.rerender(card(true))
    await waitFor(() => expect(intervention()).toBeNull())
    expect(view.container.querySelector('.thread-card-identity')).not.toBeNull()
    expect(respond).not.toHaveBeenCalled()
    view.rerender(card(false))
    await waitFor(() => expect(intervention()).not.toBeNull())
  }
  expect(JSON.stringify(thread)).toBe(original)
  const controls = within(intervention() as HTMLElement)
  const action = controls.queryByRole('button', { name: /^(跳过|Skip)$/ }) ?? Array.from(intervention()!.querySelectorAll<HTMLButtonElement>('.thread-card-intervention-actions button')).at(-1) ?? controls.getAllByRole('button').at(-1)!
  await userEvent.setup().click(action)
  await waitFor(() => expect(respond).toHaveBeenCalledOnce())
  expect(respond.mock.calls[0]?.[0]).toMatchObject({ threadId: thread.id })
  view.unmount()
}
