// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexHarnessSettingsView, CodexThreadSettingsView } from '../src/renderer/index.js'
import type {
  CodexHarnessSettings,
  CodexSettingsPresentationData,
  CodexThreadSettings,
  CodexThreadSettingsUpdate
} from '../src/shared/types.js'
import type { AgentThreadRecord } from '@openagent/contracts'
import type { HarnessSettingsResource } from '@openagent/contracts/renderer'
import { SettingsFormScope } from '@openagent/plugin-kit/renderer'

afterEach(cleanup)

const PRESENTATION: CodexSettingsPresentationData = {
  cli: {
    available: true,
    executable: '/opt/codex',
    version: '1.2.3'
  },
  models: [{
    value: 'gpt-test',
    displayName: 'GPT Test',
    description: 'Test model',
    supportedReasoningEfforts: [
      { value: 'low' },
      { value: 'high', description: 'More reasoning' }
    ],
    serviceTiers: [
      { value: 'default', displayName: 'Default' },
      { value: 'priority', displayName: 'Priority' }
    ]
  }, {
    value: 'gpt-other',
    displayName: 'GPT Other',
    supportedReasoningEfforts: [{ value: 'medium' }],
    serviceTiers: [{ value: 'default', displayName: 'Default' }]
  }]
}

const RESOURCE: HarnessSettingsResource<CodexSettingsPresentationData> = {
  status: 'ready',
  value: PRESENTATION,
  reload: async () => undefined
}

describe('Codex Harness settings UI', () => {
  it('keeps CLI health available while surfacing the native model catalog error verbatim', () => {
    render(
      <CodexHarnessSettingsView
        section="cli"
        change={() => undefined}
        resource={{
          status: 'ready',
          value: {
            cli: PRESENTATION.cli,
            models: [],
            modelsError: 'model catalog unavailable'
          },
          reload: async () => undefined
        }}
        value={{ threadSettings: {} }}
      />
    )

    expect(screen.getByRole('status').textContent).toContain('1.2.3')
    expect(screen.getByRole('alert').textContent).toContain('model catalog unavailable')
  })

  it('exposes the narrowed creation options with no settings-level CLI path', () => {
    const change = vi.fn()
    render(<HarnessSettingsFixture onChange={change} />)

    expect(screen.getByLabelText('Codex Thread 默认配置 服务层级')).toBeTruthy()
    expect(screen.getByLabelText('Codex Thread 默认配置 权限模式')).toBeTruthy()
    expect(screen.queryByLabelText('Codex Thread 默认配置 Personality')).toBeNull()
    expect(screen.queryByLabelText('Codex Thread 默认配置 沙箱')).toBeNull()
    expect(screen.queryByLabelText('Codex Thread 默认配置 推理摘要')).toBeNull()

    fireEvent.change(screen.getByLabelText('Codex Thread 默认配置 服务层级'), {
      target: { value: 'priority' }
    })
    fireEvent.change(screen.getByLabelText('Codex Thread 默认配置 权限模式'), {
      target: { value: 'full-access' }
    })
    fireEvent.change(screen.getByLabelText('Codex Thread 默认配置 推理强度'), {
      target: { value: 'high' }
    })

    expect(change.mock.lastCall?.[0]).toStrictEqual({
      threadSettings: {
        model: 'gpt-test',
        effort: 'high',
        serviceTier: 'priority',
        permissionMode: 'full-access',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        summary: 'concise'
      }
    })
  })

  it('keeps Thread edits local until Apply and reports rejected updates', async () => {
    const update = vi.fn<(change: CodexThreadSettingsUpdate) => Promise<void>>()
      .mockRejectedValue(new Error('Codex update rejected'))
    render(React.createElement(CodexThreadSettingsView, {
      thread: thread(),
      resource: RESOURCE,
      update
    }))

    fireEvent.change(screen.getByLabelText('Codex Thread 推理强度'), {
      target: { value: 'high' }
    })
    fireEvent.change(screen.getByLabelText('Codex Thread 服务层级'), {
      target: { value: 'priority' }
    })
    fireEvent.change(screen.getByLabelText('Codex Thread 权限模式'), {
      target: { value: 'approve-for-me' }
    })

    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '应用 Thread 配置' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith({
      effort: 'high',
      serviceTier: 'priority',
      permissionMode: 'approve-for-me'
    }))
    expect((await screen.findByRole('alert')).textContent).toContain('Codex update rejected')
  })

  it('locks every mutable Thread field while an execution is active', () => {
    render(React.createElement(CodexThreadSettingsView, {
      thread: thread(true),
      resource: RESOURCE,
      update: async () => undefined
    }))

    for (const control of screen.getAllByRole('combobox')) {
      expect((control as HTMLSelectElement).disabled).toBe(true)
    }
    expect((screen.getByRole('button', {
      name: '应用 Thread 配置'
    }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Thread 正在运行/)).toBeTruthy()
  })

  it('clears an unsupported effort in the same local model draft', async () => {
    const update = vi.fn<(change: CodexThreadSettingsUpdate) => Promise<void>>()
      .mockResolvedValue(undefined)
    render(React.createElement(CodexThreadSettingsView, {
      thread: thread(false, { serviceTier: 'priority' }),
      resource: RESOURCE,
      update
    }))

    fireEvent.change(screen.getByLabelText('Codex Thread 模型'), {
      target: { value: 'gpt-other' }
    })

    expect((screen.getByLabelText('Codex Thread 推理强度') as HTMLSelectElement).value)
      .toBe('')
    expect(update).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '应用 Thread 配置' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      model: 'gpt-other',
      effort: null,
      serviceTier: null
    }))
  })

  it('clears the permission preset back to the OpenAgent default', async () => {
    const update = vi.fn<(change: CodexThreadSettingsUpdate) => Promise<void>>()
      .mockResolvedValue(undefined)
    render(React.createElement(CodexThreadSettingsView, {
      thread: thread(false, { permissionMode: 'approve-for-me' }),
      resource: RESOURCE,
      update
    }))

    fireEvent.change(screen.getByLabelText('Codex Thread 权限模式'), {
      target: { value: '' }
    })
    fireEvent.click(screen.getByRole('button', { name: '应用 Thread 配置' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith({
      permissionMode: null
    }))
  })
})

describe('Codex custom Thread defaults gate', () => {
  it('hides the Thread default rows and uses the Agent defaults by default', () => {
    render(
      <SettingsFormScope>
        <HarnessSettingsFixture
          initial={{ threadSettings: {} }}
          onChange={() => undefined}
        />
      </SettingsFormScope>
    )

    expect(useDefaultsSwitch().checked).toBe(true)
    expect(screen.queryByLabelText('Codex Thread 默认配置 模型')).toBeNull()
    expect(screen.queryByLabelText('Codex Thread 默认配置 推理强度')).toBeNull()
    expect(screen.queryByLabelText('Codex Thread 默认配置 权限模式')).toBeNull()
  })

  it('ignores stored Thread defaults without the flag and keeps the Agent defaults', () => {
    render(
      <SettingsFormScope>
        <HarnessSettingsFixture
          initial={{ threadSettings: { model: 'gpt-test' } }}
          onChange={() => undefined}
        />
      </SettingsFormScope>
    )

    expect(useDefaultsSwitch().checked).toBe(true)
    expect(screen.queryByLabelText('Codex Thread 默认配置 模型')).toBeNull()
  })

  it('shows the Thread default rows once the switch leaves the Agent defaults', () => {
    render(
      <SettingsFormScope>
        <HarnessSettingsFixture
          initial={{ useDefaultThreadSettings: false, threadSettings: {} }}
          onChange={() => undefined}
        />
      </SettingsFormScope>
    )

    expect(useDefaultsSwitch().checked).toBe(false)
    expect(screen.getByLabelText('Codex Thread 默认配置 模型')).toBeTruthy()
    expect(screen.getByLabelText('Codex Thread 默认配置 推理强度')).toBeTruthy()
    expect(screen.getByLabelText('Codex Thread 默认配置 权限模式')).toBeTruthy()
  })

  it('shows the rows for Thread defaults persisted with the switch moved off', () => {
    render(
      <SettingsFormScope>
        <HarnessSettingsFixture
          initial={{ useDefaultThreadSettings: false, threadSettings: { model: 'gpt-test' } }}
          onChange={() => undefined}
        />
      </SettingsFormScope>
    )

    expect(useDefaultsSwitch().checked).toBe(false)
    expect(screen.getByLabelText('Codex Thread 默认配置 模型')).toBeTruthy()
  })

  it('clears stored Thread defaults and the flag when the switch returns to the Agent defaults', () => {
    const change = vi.fn()
    render(
      <SettingsFormScope>
        <HarnessSettingsFixture
          initial={{
            useDefaultThreadSettings: false,
            threadSettings: { model: 'gpt-test', effort: 'low' }
          }}
          onChange={change}
        />
      </SettingsFormScope>
    )

    fireEvent.click(useDefaultsSwitch())

    const emitted = change.mock.lastCall?.[0]
    expect(emitted).toMatchObject({ threadSettings: {} })
    expect(emitted).not.toHaveProperty('executablePath')
    expect(emitted?.useDefaultThreadSettings).toBeUndefined()
    expect(useDefaultsSwitch().checked).toBe(true)
    expect(screen.queryByLabelText('Codex Thread 默认配置 模型')).toBeNull()
  })
})

function useDefaultsSwitch(): HTMLInputElement {
  return screen.getByRole('switch', { name: '使用默认配置' }) as HTMLInputElement
}

function HarnessSettingsFixture(props: {
  readonly initial?: CodexHarnessSettings
  onChange(value: CodexHarnessSettings): void
}): React.JSX.Element {
  const [value, setValue] = useState<CodexHarnessSettings>(
    props.initial ?? {
      threadSettings: {
        model: 'gpt-test',
        effort: 'low',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        summary: 'concise'
      }
    }
  )
  return <>
  {(['thread'] as const).map((section) => <CodexHarnessSettingsView
    key={section}
      section={section}
    change={(next) => {
      setValue(next)
      props.onChange(next)
    }}
    resource={RESOURCE}
    value={value}
  />)}
  </>
}

function thread(
  active = false,
  settings: Partial<CodexThreadSettings> = {}
): AgentThreadRecord<'codex', CodexThreadSettings> {
  return {
    id: 'codex-thread-1',
    harnessId: 'codex',
    revision: 1, archived: false,
    title: 'Codex settings test',
    tags: [],
    cwd: '/workspace',
    settings: {
      executablePath: '/opt/codex',
      model: 'gpt-test',
      effort: 'low',
      serviceTier: 'default',
      personality: 'pragmatic',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      summary: 'concise',
      ...settings
    },
    sessionState: null,
    observation: {
      latestExecution: active
        ? {
            executionId: 'execution-1',
            status: 'running',
            startedAt: 2
          }
        : null,
      backgroundWork: null
    },
    createdAt: 1,
    updatedAt: 1
  }
}
