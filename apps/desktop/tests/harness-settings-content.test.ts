import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@openagent/contracts'
import { createClaudeMainPlugin } from '../../../packages/harness-claude/src/main'
import { emptyClaudeThreadState } from '../../../packages/harness-claude/src/shared/state'
import { createCodexSettingsApi } from '../../../packages/harness-codex/src/main/settings'
import { createEmptyCodexState } from '../../../packages/harness-codex/src/shared/state'

const context = {
  temporaryWorkspaceRoot: '/unused/content-presence-test',
  async resolveExecutable(): Promise<string> { throw new Error('Unexpected native I/O') },
  async environment(): Promise<NodeJS.ProcessEnv> { throw new Error('Unexpected native I/O') }
}
const claude = createClaudeMainPlugin(context).settings

describe('Harness-owned settings content facts', () => {
  it.each([
    ['Claude', claude, emptyClaudeThreadState()],
    ['Codex', createCodexSettingsApi(), createEmptyCodexState()]
  ] as const)('%s distinguishes empty state from a bound native session without native I/O', (_name, settings, empty) => {
    expect(settings.hasThreadContent(null)).toBe(false)
    expect(settings.hasThreadContent(empty as unknown as JsonValue)).toBe(false)
    expect(settings.hasThreadContent({ ...empty, primarySessionId: 'native-session' } as unknown as JsonValue))
      .toBe(true)
    expect(() => settings.hasThreadContent({ unknownEnvelope: true })).toThrow()
  })

  it('allows Claude tool configuration after empty recovery but protects an existing session', async () => {
    const update = {
      current: { executablePath: '/native/claude' },
      defaults: { executablePath: '/native/claude' },
      update: { allowedTools: ['Read'] },
      cwd: '/workspace',
      signal: new AbortController().signal
    }
    await expect(claude.applyThreadSettingsUpdate({
      ...update,
      hasContent: claude.hasThreadContent(emptyClaudeThreadState() as unknown as JsonValue)
    })).resolves.toMatchObject({ allowedTools: ['Read'] })
    await expect(claude.applyThreadSettingsUpdate({
      ...update,
      hasContent: claude.hasThreadContent({
        ...emptyClaudeThreadState(), primarySessionId: 'native-session'
      } as unknown as JsonValue)
    })).rejects.toThrow('不能更改工具 allow/deny 列表')
  })

  it('uses the same Claude content ownership for goal-mode resolution', async () => {
    const resolve = {
      merged: { executablePath: '/native/claude', goalMode: true },
      existing: { executablePath: '/native/claude', goalMode: false },
      cwd: '/workspace',
      signal: new AbortController().signal
    }
    await expect(claude.resolveThreadSettings({
      ...resolve, sessionState: emptyClaudeThreadState() as unknown as JsonValue
    })).resolves.toMatchObject({ goalMode: true })
    await expect(claude.resolveThreadSettings({
      ...resolve,
      sessionState: { ...emptyClaudeThreadState(), primarySessionId: 'native-session' } as unknown as JsonValue
    })).rejects.toThrow('不能切换 goal mode')
  })
})
