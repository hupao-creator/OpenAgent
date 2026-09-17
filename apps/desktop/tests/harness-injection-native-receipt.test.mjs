import { describe, expect, it } from 'vitest'
import { assertNativeCompletionReceipt } from './harness-injection-native.mjs'

describe('native completion receipt proof', () => {
  const receipt = 'bc55ccc83c0121819e0f6058282fd009234d587e'

  it('accepts the observed public summary combining commentary and final receipt', () => {
    const summary = 'I’ll run the acceptance receipt procedure now. bc55ccc83c0121819e0f6058282fd009234d587e'
    expect(() => assertNativeCompletionReceipt(summary, receipt)).not.toThrow()
  })

  it.each([
    undefined,
    'The acceptance receipt procedure completed.',
    '0000000000000000000000000000000000000000',
    `prefix${receipt}`,
    `${receipt}suffix`,
    `wrong_${receipt}`
  ])('rejects missing, wrong, or embedded receipt in %s', summary => {
    expect(() => assertNativeCompletionReceipt(summary, receipt)).toThrow('whole token')
  })
})
