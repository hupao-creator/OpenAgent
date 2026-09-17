import { describe, expect, it } from 'vitest'
import piNativeTestAdapter from '../src/test-support/index.js'

// Native state sample: recorded Pi RPC frames. Selected/requested models are
// ignored; only completed assistant identities are evidence.
describe('Pi native model evidence', () => {
  it('qualifies committed assistant identities and ignores user/tool messages', () => {
    expect(piNativeTestAdapter.sessionModelEvidence({ messages: [
      { role: 'assistant', provider: 'deepseek', model: 'deepseek-v4-flash' },
      { role: 'toolResult', provider: 'other', model: 'ignored' },
      { role: 'user', model: 'untrusted' }
    ] })).toEqual(['deepseek/deepseek-v4-flash'])
  })
  it('reads completed native assistant identities and ignores selected/requested models', () => {
    expect(piNativeTestAdapter.nativeModelEvidence([
      { wrapperPid: 1, direction: 'stdin', text: '{"type":"set_model","provider":"request","modelId":"only"}\n' },
      { wrapperPid: 1, direction: 'stdout', text: '{"type":"response","data":{"model":{"provider":"selected","id":"only"}}}\n' },
      { wrapperPid: 1, direction: 'stdout', text: '{"type":"message_end","message":{"role":"assistant","provider":"actual",' },
      { wrapperPid: 1, direction: 'stdout', text: '"model":"native"}}\n' },
      { wrapperPid: 1, direction: 'stdout', text: '{"type":"message_end","message":{"role":"toolResult","provider":"ignored","model":"tool"}}\n' }
    ])).toEqual(['actual/native'])
  })
})
