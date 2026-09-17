// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import React, { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeHarnessSettingsPanel,
  ClaudeThreadSettingsPanel
} from '../src/renderer/index.js'
import { normalizeClaudeHarnessSettings } from '../src/shared/settings.js'
import type {
  ClaudeHarnessSettings,
  ClaudeSettingsPresentationData,
  ClaudeThreadSettings
} from '../src/shared/settings.js'
import { SettingsFormScope } from '@openagent/plugin-kit/renderer'
import type { AgentThreadRecord } from '@openagent/contracts'

afterEach(cleanup)

const INITIAL_SETTINGS: ClaudeHarnessSettings = {
  threadSettings: {
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'auto'
  }
}

const PRESENTATION: ClaudeSettingsPresentationData = {
  cli: {
    status: 'available',
    executablePath: '/opt/claude'
  },
  models: [{
    value: 'sonnet',
    displayName: 'Sonnet',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
  }, {
    value: 'haiku',
    displayName: 'Haiku',
    supportedEfforts: ['low']
  }, {
    value: 'no-effort',
    displayName: 'No effort',
    supportedEfforts: []
  }]
}

describe('Claude Harness settings', () => {
  it('deletes cleared optional Thread default values from the emitted JSON settings', () => {
    const change = vi.fn()
    render(<HarnessSettingsFixture onChange={change} />)

    fireEvent.change(control('模型'), { target: { value: '' } })
    fireEvent.change(control('推理强度'), { target: { value: '' } })
    fireEvent.change(control('权限模式'), { target: { value: '' } })

    const emitted = change.mock.lastCall?.[0]
    expect(emitted).toStrictEqual({
      threadSettings: {}
    })
    expect(JSON.parse(JSON.stringify(emitted))).toStrictEqual(emitted)
  })

  it('atomically clears incompatible effort when the Thread defaults changes model', () => {
    const change = vi.fn()
    render(<HarnessSettingsFixture onChange={change} />)

    fireEvent.change(control('模型'), { target: { value: 'haiku' } })
    fireEvent.change(control('模型'), { target: { value: 'haiku' } })
    expect(change.mock.lastCall?.[0]).toMatchObject({
      threadSettings: { model: 'haiku' }
    })
    expect(change.mock.lastCall?.[0].threadSettings)
      .not.toHaveProperty('effort')
    expect(control('推理强度')).toHaveValue('')
  })

  it('does not allow an effort-only or capability-free profile', () => {
    render(<HarnessSettingsFixture
      initial={{ threadSettings: {} }}
      onChange={() => undefined}
    />)

    expect(control('推理强度')).toBeDisabled()
    fireEvent.change(control('模型'), { target: { value: 'no-effort' } })
    expect(control('推理强度')).toBeDisabled()
    expect(withinSelect(control('推理强度'))).toEqual([''])
  })

  it('exposes only the narrowed creation options in Thread defaults', () => {
    const change = vi.fn()
    render(<HarnessSettingsFixture onChange={change} />)
    fireEvent.change(control('模型'), { target: { value: 'haiku' } })
    fireEvent.change(control('权限模式'), { target: { value: 'acceptEdits' } })
    expect(change.mock.lastCall?.[0]).toMatchObject({
      threadSettings: {
        model: 'haiku',
        permissionMode: 'acceptEdits'
      }
    })
    expect(change.mock.lastCall?.[0].threadSettings).not.toHaveProperty('effort')
    expect(screen.queryByText('Thread 可执行文件路径')).toBeNull()
    expect(screen.queryByText('Goal 模式')).toBeNull()
    expect(screen.queryByText('允许的工具')).toBeNull()
    expect(screen.queryByText('禁止的工具')).toBeNull()
  })

  it('preserves legacy runtime fields in Thread defaults while editing creation options', () => {
    const change = vi.fn()
    render(<HarnessSettingsFixture
      initial={{
        threadSettings: {
          executablePath: '/thread/claude',
          goalMode: true,
          allowedTools: ['Read'],
          disallowedTools: ['Bash'],
          permissionMode: 'auto'
        }
      }}
      onChange={change}
    />)
    fireEvent.change(control('权限模式'), { target: { value: 'manual' } })
    expect(change.mock.lastCall?.[0]).toMatchObject({
      threadSettings: {
        executablePath: '/thread/claude',
        goalMode: true,
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
        permissionMode: 'manual'
      }
    })
  })

  it('matches Main model-switch semantics in a Thread draft', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    render(<ClaudeThreadSettingsPanel
      thread={threadRecord()}
      resource={{
        status: 'ready',
        value: PRESENTATION,
        reload: async () => undefined
      }}
      update={update}
    />)

    fireEvent.change(control('模型'), { target: { value: 'haiku' } })
    expect(control('推理强度')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '应用 Thread 配置' }))
    expect(update).toHaveBeenCalledWith({ model: 'haiku' })
  })

  it('blocks Apply while the displayed Thread model is invalid', () => {
    const update = vi.fn().mockResolvedValue(undefined)
    render(<ClaudeThreadSettingsPanel
      thread={threadRecord()}
      resource={{
        status: 'ready',
        value: PRESENTATION,
        reload: async () => undefined
      }}
      update={update}
    />)

    const apply = screen.getByRole('button', { name: '应用 Thread 配置' })
    fireEvent.change(control('模型'), { target: { value: 'haiku' } })
    expect(apply).toBeEnabled()

    // The draft keeps the last accepted prefix while the editor shows the
    // rejected text, so Apply must not persist `haiku` behind the user's back.
    fireEvent.change(control('模型'), { target: { value: 'haiku ' } })
    expect(control('模型')).toHaveValue('haiku ')
    expect(apply).toBeDisabled()
    fireEvent.click(apply)
    expect(update).not.toHaveBeenCalled()

    fireEvent.change(control('模型'), { target: { value: 'haiku' } })
    expect(apply).toBeEnabled()
    fireEvent.click(apply)
    expect(update).toHaveBeenCalledWith({ model: 'haiku' })
  })

  it('hides the Thread default rows and uses the Agent defaults by default', () => {
    renderSettingsPage({ threadSettings: {} })

    expect(customSwitch()).toBeChecked()
    expect(screen.queryByText('模型')).toBeNull()
    expect(screen.queryByText('推理强度')).toBeNull()
    expect(screen.queryByText('权限模式')).toBeNull()
  })

  it('shows the Thread default rows once the switch leaves the Agent defaults', () => {
    renderSettingsPage({ useDefaultThreadSettings: false, threadSettings: {} })

    expect(customSwitch()).not.toBeChecked()
    expect(screen.getByText('模型')).toBeTruthy()
    expect(screen.getByText('推理强度')).toBeTruthy()
    expect(screen.getByText('权限模式')).toBeTruthy()
  })

  it('ignores persisted Thread values that carry no customization flag', () => {
    renderSettingsPage(normalizeClaudeHarnessSettings({
      threadSettings: { model: 'sonnet' }
    }))

    expect(customSwitch()).toBeChecked()
    expect(screen.queryByText('模型')).toBeNull()
  })

  it('clears stored Thread defaults and the flag when the switch returns to the Agent defaults', () => {
    const change = vi.fn()
    render(
      <SettingsFormScope>
        <HarnessSettingsFixture
          initial={{
            useDefaultThreadSettings: false,
            threadSettings: { model: 'sonnet', effort: 'high' }
          }}
          onChange={change}
        />
      </SettingsFormScope>
    )

    fireEvent.click(customSwitch())

    const emitted = change.mock.lastCall?.[0]
    expect(emitted).toMatchObject({
      threadSettings: {}
    })
    expect(emitted.useDefaultThreadSettings).toBeUndefined()
    expect(customSwitch()).toBeChecked()
    expect(screen.queryByText('模型')).toBeNull()
  })
})

function renderSettingsPage(initial: ClaudeHarnessSettings): void {
  render(
    <SettingsFormScope>
      <HarnessSettingsFixture initial={initial} onChange={() => undefined} />
    </SettingsFormScope>
  )
}

function customSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: '使用默认配置' })
}

function HarnessSettingsFixture(props: {
  initial?: ClaudeHarnessSettings
  onChange(value: ClaudeHarnessSettings): void
}): React.JSX.Element {
  const [value, setValue] = useState<ClaudeHarnessSettings>(
    props.initial || INITIAL_SETTINGS
  )
  return (
    <>
    {(['thread'] as const).map((section) => <ClaudeHarnessSettingsPanel
      key={section}
      section={section}
      value={value}
      resource={{
        status: 'ready',
        value: PRESENTATION,
        reload: async () => undefined
      }}
      change={(next) => {
        setValue(next)
        props.onChange(next)
      }}
    />)}
    </>
  )
}

function threadRecord(): AgentThreadRecord<'claude', ClaudeThreadSettings> {
  return {
    id: 'claude-settings-thread',
    harnessId: 'claude',
    revision: 1, archived: false,
    title: 'Claude settings',
    tags: [],
    cwd: '/tmp/project',
    sessionState: null,
    observation: { latestExecution: null, backgroundWork: null },
    settings: {
      executablePath: '/opt/claude',
      model: 'sonnet',
      effort: 'high'
    },
    createdAt: 1,
    updatedAt: 1
  }
}

function control(label: string, index = 0): Element {
  const field = screen.getAllByText(label)[index]?.closest('label')
    ?.querySelector('input, select, textarea')
  if (!field) throw new Error(`Missing settings control: ${label}[${index}]`)
  return field
}

function withinSelect(element: Element): string[] {
  return [...element.querySelectorAll('option')].map((option) => option.value)
}
