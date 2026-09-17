// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BartThreadView } from '../src/renderer/src/components/BartThreadView'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import type { BartThreadRecord } from '@openagent/contracts'
import type { CodexThreadSettings } from '../../../packages/harness-codex/src/shared/types'
import { createEmptyCodexState, stageCodexExecution } from '../../../packages/harness-codex/src/shared/state'

afterEach(cleanup)

describe('Bart Thread view', () => {
  it('mounts the selected Plugin and keeps terminal failures visible until retried', () => {
    const internalEvent = '{"event":"thread-terminal","private":true}'
    const pluginState = stageCodexExecution(
      createEmptyCodexState(1),
      'execution-1',
      { parts: [{ kind: 'text', text: internalEvent }], presentation: 'internal' },
      2,
      'message-1'
    )
    let thread: BartThreadRecord<'codex', CodexThreadSettings> = {
      id: 'bart-thread-1',
      bart: true,
      harnessId: 'codex',
      revision: 0,
      sessionState: JSON.parse(JSON.stringify(pluginState)),
      observation: { latestExecution: null, backgroundWork: null },
      title: 'Bart',
      tags: [],
      cwd: '/workspace/.bart',
      settings: { executablePath: '/usr/local/bin/codex' },
      transcript: [],
      createdAt: 1,
      updatedAt: 1
    }
    const renderThread = () => (
      <I18nProvider locale="zh-CN">
        <BartThreadView
          attachments={[]}
          clearing={false}
          error=""
          execution={null}
          inputValue=""
          onBack={vi.fn()}
          onCancel={async () => undefined}
          onChooseFiles={vi.fn()}
          onClear={vi.fn()}
          onInputChange={vi.fn()}
          onPasteFiles={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onSettings={vi.fn()}
          onSubmit={vi.fn()}
          respond={vi.fn(async () => undefined)}
          submitting={false}
          thread={thread}
        />
      </I18nProvider>
    )
    const view = render(renderThread())

    expect(view.container.querySelector('[data-thread-surface-kind="codex"]'))
      .toBeInTheDocument()
    expect(view.container.querySelector('.thread-detail .message-scroll'))
      .toBeInTheDocument()
    expect(view.queryByText(internalEvent)).not.toBeInTheDocument()

    thread = {
      ...thread,
      observation: {
        latestExecution: {
          executionId: 'failed-reopen', status: 'failed', startedAt: 2, finishedAt: 3,
          error: 'Native session could not resume'
        },
        backgroundWork: null
      }
    }
    view.rerender(renderThread())
    expect(view.getByText('Native session could not resume')).toBeInTheDocument()

    thread = {
      ...thread,
      observation: {
        latestExecution: { executionId: 'retry', status: 'running', startedAt: 4 },
        backgroundWork: null
      }
    }
    view.rerender(renderThread())
    expect(view.queryByText('Native session could not resume')).not.toBeInTheDocument()
  })
})
