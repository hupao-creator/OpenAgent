import { describe, expect, it } from 'vitest'
import { claudePromptSettings } from '../src/shared/settings.js'

describe('Claude plugin settings isolation', () => {
  it('retains Claude metadata identity without inheriting Thread tool permissions', () => {
    // A Harness default model/effort lives behind the custom-defaults opt-out;
    // the executable itself is host-owned and never pinned by settings (A1).
    const settings = {
      useDefaultThreadSettings: false,
      threadSettings: {
        model: 'default-model', effort: 'high' as const, allowedTools: ['Bash']
      }
    }
    expect(claudePromptSettings(settings, {
      executablePath: '/thread/claude', model: 'thread-model', effort: 'low',
      permissionMode: 'bypassPermissions', allowedTools: ['Bash']
    })).toEqual({ executablePath: '/thread/claude', model: 'thread-model', effort: 'low' })
    expect(claudePromptSettings(settings, { executablePath: '/thread/claude' }))
      .toEqual({ executablePath: '/thread/claude' })
    expect(claudePromptSettings(settings)).toEqual({
      executablePath: 'claude', model: 'default-model', effort: 'high'
    })
  })
})
