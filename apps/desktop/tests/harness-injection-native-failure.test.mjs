import { describe, expect, it } from 'vitest'
import { assertNativeReceiptArguments, collectCleanupErrors } from './harness-injection-native.mjs'

describe('native injection failure reporting', () => {
  const receipt = '0123456789abcdef0123456789abcdef55aa55bb'

  it('aborts on the first mistyped receipt and preserves the exact failed native invocation', () => {
    const controller = new AbortController()
    const failures = []
    const expected = { thread: receipt, send: receipt }
    const request = { callId: 'native-call-1', arguments: { thread: receipt.replace('55', '5'), send: receipt } }

    expect(() => assertNativeReceiptArguments(request, expected, controller, failures)).toThrow('lost or mixed')

    expect(controller.signal.aborted).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      callId: request.callId,
      arguments: request.arguments,
      expectedArguments: expected,
      error: expect.stringContaining('native custom tool lost or mixed injection receipts')
    })
    expect(failures[0].expectedArguments.thread).toHaveLength(40)
    request.arguments.thread = 'changed-after-failure'
    expect(failures[0].arguments.thread).toBe(receipt.replace('55', '5'))
    const reason = controller.signal.reason
    expect(() => assertNativeReceiptArguments({ arguments: expected }, expected, controller, failures)).toThrow(reason)
    expect(failures).toHaveLength(1)
  })

  it('accepts unchanged exact receipt arguments without aborting', () => {
    const controller = new AbortController()
    const failures = []
    const expected = { thread: receipt }
    expect(() => assertNativeReceiptArguments({ arguments: { ...expected } }, expected, controller, failures)).not.toThrow()
    expect(controller.signal.aborted).toBe(false)
    expect(failures).toEqual([])
  })

  it('records stalled cleanup and continues to remaining cleanup/reporting work', async () => {
    const completed = []
    const errors = await collectCleanupErrors([
      { label: 'Thread.dispose', run: () => new Promise(() => {}) },
      { label: 'Plugin.dispose', run: () => { completed.push('plugin released') } },
      { label: 'native log flush', run: () => { completed.push('logs flushed') } }
    ], 10)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Thread.dispose timed out after 10ms')
    expect(completed).toEqual(['plugin released', 'logs flushed'])
  })
})
