import { describe, expect, it } from 'vitest'
import { createCodexSettingsApi } from '../src/main/settings.js'

describe('Codex settings prompt', () => {
  it('keeps Codex metadata on the source model and executable with bounded reasoning', () => {
    // A Harness default model/effort lives behind the custom-defaults opt-out;
    // the executable itself is host-owned and never pinned by settings (A1).
    const settings = {
      useDefaultThreadSettings: false,
      threadSettings: {
        model: 'default-model', effort: 'high' as const, sandbox: 'workspace-write' as const
      }
    }
    expect(codexSettingsApi.promptSettings(settings, {
      executablePath: '/thread/codex', model: 'thread-model', effort: 'high',
      serviceTier: 'priority', sandbox: 'workspace-write'
    })).toEqual({
      executablePath: '/thread/codex', model: 'thread-model', effort: 'low',
      serviceTier: 'priority'
    })
    expect(codexSettingsApi.promptSettings(settings, { executablePath: '/thread/codex' }))
      .toEqual({ executablePath: '/thread/codex', effort: 'low' })
    expect(codexSettingsApi.promptSettings(settings)).toEqual({
      model: 'default-model', effort: 'high'
    })
  })
})

const codexSettingsApi = createCodexSettingsApi()
