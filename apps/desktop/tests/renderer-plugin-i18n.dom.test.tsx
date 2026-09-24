// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ClaudeHarnessSettingsPanel,
  ClaudeThreadView
} from '../../../packages/harness-claude/src/renderer'
import { CodexHarnessSettingsView } from '../../../packages/harness-codex/src/renderer'
import { CodexThreadView } from '../../../packages/harness-codex/src/renderer/ThreadView'
import {
  HarnessOverviewCardHost,
  harnessRendererTranslations,
  harnessRendererPlugins,
  projectHarnessOverviewThread
} from '../src/renderer/src/harness-composition'
import type { HarnessSettingsSection } from '@openagent/contracts/renderer'
import { kitRendererTranslations } from '@openagent/plugin-kit/renderer'
import { HARNESS_IDS, harnessDescriptors, type HarnessId } from '../src/shared/harnesses'
import { AppI18nProvider as I18nProvider } from '../src/renderer/src/i18n'
import { coreRendererTranslations } from '../src/renderer/src/translations'
import type { AgentThreadRecord } from '@openagent/contracts'

afterEach(cleanup)

const LOADING_RESOURCE = {
  status: 'loading' as const,
  reload: async () => undefined
}

const THREAD_ACTIONS = {
  interrupt: async () => undefined,
  respond: async () => undefined,
  invokeHarnessExtension: async () => null,
  forkThread: async () => ({ threadId: 'unused' }),
  openExternal: async () => undefined,
  openFollowUp: () => undefined
}

function English({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <I18nProvider locale="en-US" translations={harnessRendererTranslations}>
      {children}
    </I18nProvider>
  )
}

describe('Plugin-owned Renderer translations', () => {
  it('covers every concrete descriptor with the same key', () => {
    expect(Object.keys(harnessRendererPlugins)).toEqual(HARNESS_IDS)
    for (const harnessId of HARNESS_IDS) {
      expect(harnessDescriptors[harnessId].id).toBe(harnessId)
      expect(harnessRendererPlugins[harnessId]).toBeTruthy()
    }
  })

  it('composes disjoint Harness-owned translations once', () => {
    const owners = new Map<string, HarnessId>()
    for (const harnessId of HARNESS_IDS) {
      const dictionary = harnessRendererPlugins[harnessId].translations?.['en-US']
      for (const key of Object.keys(dictionary || {})) {
        expect(
          (coreRendererTranslations['en-US']?.[key] ?? kitRendererTranslations['en-US'][key]),
          `${key} is duplicated between Core and ${harnessId}`
        ).toBeUndefined()
        expect(owners.get(key), `${key} is owned by more than one Harness`).toBeUndefined()
        owners.set(key, harnessId)
      }
    }
    expect(harnessRendererTranslations['en-US']).toEqual(Object.fromEntries(
      Array.from(owners, ([key, harnessId]) => [
        key,
        harnessRendererPlugins[harnessId].translations?.['en-US']?.[key]
      ])
    ))
  })

  it('does not let a Plugin catalog override provider-neutral Core copy', () => {
    const core = { ...kitRendererTranslations['en-US'], ...coreRendererTranslations['en-US'] }
    const plugins = harnessRendererTranslations['en-US'] ?? {}
    expect(Object.keys(plugins).filter((source) => source in core).sort()).toEqual([])
  })

  it('consumes the Codex settings catalog in en-US', () => {
    render(
      <English>
        <CodexHarnessSettingsView
          section="thread"
          change={() => undefined}
          resource={LOADING_RESOURCE}
          value={{ threadSettings: {} }}
        />
      </English>
    )

    expect(screen.getByText('Native defaults for new threads, including the Bart host.'))
      .toBeInTheDocument()
  })

  it('consumes the Claude settings catalog in en-US', () => {
    render(
      <English>
        <ClaudeHarnessSettingsPanel
          section="thread"
          change={() => undefined}
          resource={LOADING_RESOURCE}
          value={{ threadSettings: {} }}
        />
      </English>
    )

    expect(screen.getByText('Claude native defaults shared by ordinary threads and Bart.'))
      .toBeInTheDocument()
  })

  it.each([
    ['Codex', (section: HarnessSettingsSection) => (
      <CodexHarnessSettingsView
        section={section}
        change={() => undefined}
        resource={{
          status: 'ready',
          value: {
            cli: { available: true, executable: '/opt/codex', version: 'test' },
            models: []
          },
          reload: async () => undefined
        }}
        value={{ threadSettings: {} }}
      />
    )],
    ['Claude', (section: HarnessSettingsSection) => (
      <ClaudeHarnessSettingsPanel
        section={section}
        change={() => undefined}
        resource={{
          status: 'ready',
          value: {
            cli: { status: 'available', executablePath: '/opt/claude' },
            models: []
          },
          reload: async () => undefined
        }}
        value={{ threadSettings: {} }}
      />
    )],
  ])('renders the ready %s settings surface in en-US without static Han copy', (_name, panel) => {
    for (const section of ['cli', 'thread'] as const) {
      const view = render(<English>{panel(section)}</English>)
      expect(view.container.innerHTML).not.toMatch(/[\u3400-\u9fff]/u)
      view.unmount()
    }
  })

  it.each([
    ['Codex', CodexThreadView, 'codex'],
    ['Claude', ClaudeThreadView, 'claude'],
  ] as const)(
    'renders a newly created %s thread in en-US without static Han copy',
    (_name, ThreadView, harnessId) => {
      const thread: AgentThreadRecord = {
        ...newThread(harnessId, `${_name} new thread`)
      }
      const view = render(
        <English>
          <ThreadView
            actions={THREAD_ACTIONS}
            thread={thread}
          />
        </English>
      )
      expect(view.container.innerHTML).not.toMatch(/[\u3400-\u9fff]/u)
      view.rerender(
        <English>
          <ThreadView
            actions={THREAD_ACTIONS}
            thread={{ ...thread, revision: 2, emoji: '👩🏽‍💻' }}
          />
        </English>
      )
      expect(screen.getByRole('heading', { name: thread.title })).toBeInTheDocument()
    }
  )

  it.each([
    ['Codex', 'codex'],
    ['Claude', 'claude'],
  ] as const)(
    'renders a newly created %s overview card in en-US without static Han copy',
    (_name, harnessId) => {
      const thread = newThread(harnessId, `${_name} new thread`)
      const projected = projectHarnessOverviewThread({ thread }, 2)
      const view = render(
        <English>
          <HarnessOverviewCardHost
            actions={THREAD_ACTIONS}
            availableColumns={2}
            envelope={projected.envelope}
            openThread={() => undefined}
            thread={thread}
          />
        </English>
      )
      expect(view.container.innerHTML).not.toMatch(/[\u3400-\u9fff]/u)
    }
  )
})

function newThread(
  harnessId: AgentThreadRecord['harnessId'],
  title: string
): AgentThreadRecord {
  return {
    id: `${harnessId}-new-thread`,
    harnessId,
    revision: 1, archived: false,
    title,
    tags: [],
    cwd: '/tmp',
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    settings: {},
    createdAt: 1,
    updatedAt: 1
  }
}
