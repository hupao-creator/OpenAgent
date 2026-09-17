import { describe, expect, it } from 'vitest'
import codexNativeTestAdapter from '../src/test-support/index.js'

// Native state sample: recorded Codex app-server frames. Expected identities
// come from the protocol facts below, never from a request under test.
describe('Codex native model evidence', () => {
  it('extracts published runtime facts instead of the requested model', () => {
    expect(codexNativeTestAdapter.sessionModelEvidence({ model: 'requested', runtime: { model: 'actual' }, turns: [{ runtimeModel: 'actual' }, { runtimeModel: 'previous' }] })).toEqual(['actual', 'previous'])
    expect(codexNativeTestAdapter.sessionModelEvidence(null)).toEqual([])
  })
  it('reads native result frames across transport chunks and ignores requests', () => {
    expect(codexNativeTestAdapter.nativeModelEvidence([
      { wrapperPid: 1, direction: 'stdin', text: '{"params":{"model":"requested-only"}}\n' },
      { wrapperPid: 1, direction: 'stdout', text: '{"id":1,"result":{"model":"native-' },
      { wrapperPid: 2, direction: 'stdout', text: 'a version line\n' },
      { wrapperPid: 1, direction: 'stdout', text: 'actual"}}\n' }
    ])).toEqual(['native-actual'])
  })
})
