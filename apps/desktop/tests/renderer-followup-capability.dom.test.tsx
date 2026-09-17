// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BartDock } from '../src/renderer/src/components/BartDock'
import {
  harnessRendererTranslations
} from '../src/renderer/src/harness-composition'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'

beforeEach(() => {
  vi.stubGlobal('openAgent', {
    forkThread: async () => ({ threadId: 'unused-fork' }),
    interruptThread: async () => undefined,
    invokeHarnessExtension: async () => null,
    openExternal: async () => undefined,
    respondToThreadInteraction: async () => undefined
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('provider-neutral follow-up draft capability', () => {
  it('submits a public interaction through the current response DTO without a legacy run id', async () => {
    const user = userEvent.setup()
    const respond = vi.fn(async () => undefined)
    render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <BartDock
          activityContext={{ threadKey: 'follow-up-test', execution: null }}
          bartAttachments={[]}
          inputOpen={false}
          inputValue=""
          interaction={{
            threadId: 'thread-a',
            threadTitle: 'Thread A',
            intervention: {
              id: 'public-question',
              title: 'Choose a route',
              actions: [{ id: 'submit', label: 'Submit', intent: 'submit' }],
              questions: [{
                id: 'route',
                prompt: 'Which route?',
                multiple: false,
                allowOther: false,
                secret: false,
                options: [{
                  id: 'route:0',
                  label: 'Displayed route',
                  value: 'native-route-value'
                }]
              }],
              submitActionId: 'submit'
            }
          }}
          onChooseFiles={() => undefined}
          onInputChange={() => undefined}
          onInputOpenChange={() => undefined}
          onInteractionResponse={respond}
          onRemoveBartAttachment={() => undefined}
          onSubmit={() => undefined}
          onThreadOpenChange={() => undefined}
          sessionIdle
          threadOpen={false}
        />
      </I18nProvider>
    )

    await user.click(screen.getByRole('radio', { name: /Displayed route/ }))
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    expect(respond).toHaveBeenCalledWith({
      threadId: 'thread-a',
      interactionId: 'public-question',
      actionId: 'submit',
      answers: { route: 'native-route-value' }
    })
    expect(JSON.stringify(respond.mock.calls)).not.toContain('runId')
  })

  it('keeps a rejected Dock follow-up visible and retryable', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error('native follow-up rejected'))
      .mockResolvedValueOnce(undefined)
    render(
      <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
        <BartDock
          activityContext={{ threadKey: 'follow-up-test', execution: null }}
          bartAttachments={[]}
          inputOpen={false}
          inputValue=""
          onChooseFiles={() => undefined}
          onInputChange={() => undefined}
          onInputOpenChange={() => undefined}
          onRemoveBartAttachment={() => undefined}
          onSubmit={() => undefined}
          onThreadFollowUpClose={onClose}
          onThreadFollowUpSubmit={submit}
          onThreadOpenChange={() => undefined}
          sessionIdle
          threadFollowUp={{
            threadId: 'thread-a',
            threadTitle: 'Thread A',
            provider: 'claude',
            initialDraft: 'Retry this prompt',
            requestKey: 1
          }}
          threadOpen={false}
        />
      </I18nProvider>
    )

    const send = screen.getByRole('button', { name: '发送到 Thread A' })
    await user.click(send)
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(send).toBeEnabled())
    expect(screen.getByRole('textbox', { name: '直接续写 Thread A' }))
      .toHaveValue('Retry this prompt')
    expect(onClose).not.toHaveBeenCalled()

    await user.click(send)
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
