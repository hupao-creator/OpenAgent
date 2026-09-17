import { describe, expect, it } from 'vitest'
import claudeNativeTestAdapter from '../src/test-support/index.js'

// Native state sample: recorded Claude Code stream-json frames. The adapter
// reads observed identities, never the requested alias.
describe('Claude native model evidence', () => {
  it('extracts committed turn models instead of requested aliases', () => {
    expect(claudeNativeTestAdapter.sessionModelEvidence({ model: 'requested', turns: [{ runtimeModel: 'claude-native' }] })).toEqual(['claude-native'])
    expect(claudeNativeTestAdapter.sessionModelEvidence({ turns: [] })).toEqual([])
  })
  it('reads native init/modelUsage rather than a requested alias', () => {
    expect(claudeNativeTestAdapter.nativeModelEvidence([
      { wrapperPid: 1, type: 'spawn', arguments: ['--model', 'sonnet'] },
      { wrapperPid: 1, direction: 'stdout', text: '{"type":"system","subtype":"init","model":"claude-native"}\n' },
      { wrapperPid: 1, direction: 'stdout', text: '{"type":"result","modelUsage":{"claude-native":{"inputTokens":10}}}\n' }
    ])).toEqual(['claude-native'])
  })
})
