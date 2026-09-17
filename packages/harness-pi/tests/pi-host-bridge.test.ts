import { afterEach, describe, expect, it, vi } from 'vitest'
import { Duplex } from 'node:stream'
import { connectPiHostBridge } from '../src/main/runtime/host-bridge.js'
import type { HarnessToolBinding } from '@openagent/contracts'

const disposals: (() => void)[] = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers() })
function bridge(execute: HarnessToolBinding['execute'] = async input => input.arguments) {
  const replies: Record<string, unknown>[] = []
  const channel = new Duplex({ read() {}, write(chunk, _encoding, callback) { replies.push(JSON.parse(chunk.toString())); callback() } })
  const failure = vi.fn()
  let admitted = true
  const binding = vi.fn(execute)
  const owner = connectPiHostBridge(channel, { injection: { tools: { mode: 'exclusive', bindings: [
    { name: 'create_task', description: 'Create', inputSchema: { type: 'object' }, execute: binding }
  ] } }, canExecute: () => admitted }, failure)
  disposals.push(owner.dispose)
  const send = (value: unknown) => channel.push(Buffer.from(JSON.stringify(value) + '\n'))
  const ready = async () => { send({ type: 'ready', tools: ['create_task'] }); await owner.ready }
  const call = (id = '1', callId = 'native-1') => send({ type: 'call', id, callId, name: 'create_task', arguments: { task: 'one' } })
  return { ...owner, ready, send, call, binding, failure, replies, channel, disallow() { admitted = false } }
}

describe('Pi Host private tool bridge', () => {
  it('correlates concurrent results by bridge and native identity', async () => {
    let complete!: (result: { done: string }) => void
    const test = bridge(input => input.callId === 'native-slow' ? new Promise(resolve => { complete = resolve }) : Promise.resolve({ done: 'fast' }))
    await test.ready(); test.call('1', 'native-slow'); test.call('2', 'native-fast')
    await vi.waitFor(() => expect(test.replies).toEqual([{ id: '2', result: { done: 'fast' } }]))
    complete({ done: 'slow' })
    await vi.waitFor(() => expect(test.replies).toHaveLength(2))
    expect(test.replies[1]).toEqual({ id: '1', result: { done: 'slow' } })
    expect(test.binding.mock.calls[0]![0]).toMatchObject({ callId: 'native-slow', arguments: { task: 'one' } })
  })
  it('returns binding errors to the correct native call without failing the bridge', async () => {
    const test = bridge(async () => { throw new Error('Task does not exist') })
    await test.ready(); test.call()
    await vi.waitFor(() => expect(test.replies).toEqual([{ id: '1', error: 'Task does not exist' }]))
    expect(test.failure).not.toHaveBeenCalled()
  })
  it.each(['dispose', 'cancel', 'disconnect'])('aborts bindings and discards late results after %s', async mode => {
    let complete!: (value: string) => void
    const test = bridge(async () => new Promise(resolve => { complete = resolve }))
    await test.ready(); test.call()
    await vi.waitFor(() => expect(test.binding).toHaveBeenCalledOnce())
    const signal = test.binding.mock.calls[0]![0].signal
    if (mode === 'dispose') test.dispose()
    else if (mode === 'cancel') test.send({ type: 'cancel', id: '1' })
    else test.channel.destroy()
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
    complete('late')
    await new Promise(resolve => setImmediate(resolve))
    expect(test.replies).toEqual([])
  })
  it.each(['unknown', 'unadmitted', 'duplicate-id', 'duplicate-native'])('fails closed for %s calls', async mode => {
    const test = bridge(); await test.ready()
    if (mode === 'unknown') test.send({ type: 'call', id: '1', callId: 'native-1', name: 'bash', arguments: {} })
    else if (mode === 'unadmitted') { test.disallow(); test.call() }
    else {
      test.call(); await vi.waitFor(() => expect(test.binding).toHaveBeenCalledOnce())
      test.call(mode === 'duplicate-id' ? '1' : '2', mode === 'duplicate-id' ? 'native-2' : 'native-1')
    }
    await vi.waitFor(() => expect(test.failure).toHaveBeenCalledOnce())
    expect(test.binding).toHaveBeenCalledTimes(mode.startsWith('duplicate') ? 1 : 0)
  })
  it('rejects startup with a builtin or missing tool and times out a missing extension', async () => {
    const invalid = bridge()
    invalid.send({ type: 'ready', tools: ['create_task', 'bash'] })
    await expect(invalid.ready()).rejects.toThrow()
    expect(invalid.failure).toHaveBeenCalledOnce()
    vi.useFakeTimers()
    const silent = bridge()
    await vi.advanceTimersByTimeAsync(15001)
    expect(silent.failure).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('reinstall Pi') }))
  })
  it('revalidates the same exact tools on native session replacement', async () => {
    const test = bridge(); await test.ready(); await test.ready()
    test.call()
    await vi.waitFor(() => expect(test.replies).toHaveLength(1))
    expect(test.failure).not.toHaveBeenCalled()
  })
})
