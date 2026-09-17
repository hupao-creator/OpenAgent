import { once } from 'node:events'
import { request, type ClientRequest, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeToolBridge } from '../src/main/tool-bridge.js'
import type { HarnessToolBinding } from '@openagent/contracts'
import type { JsonValue } from '@openagent/contracts'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe('Claude tool bridge lifecycle', () => {
  it('closes while an authenticated request body is incomplete', async () => {
    const execute = vi.fn(async () => null)
    const fixture = await createFixture(execute)
    await beginRequest(fixture, '{"name":')
    let disposed = false
    const disposal = fixture.bridge.dispose().then(() => { disposed = true })
    await expect.poll(() => disposed, { timeout: 1_000 }).toBe(true)
    await disposal
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(['abort', 'deactivate', 'replace'] as const)(
    'does not dispatch a partially received call after execution %s',
    async (operation) => {
      const execute = vi.fn(async () => 'should not run')
      const fixture = await createFixture(execute)
      const pending = await beginRequest(fixture, '{"name":')
      if (operation === 'abort') fixture.controller.abort()
      else if (operation === 'deactivate') fixture.bridge.deactivate()
      else fixture.bridge.activate(new AbortController().signal)
      pending.request.end('"fixture_tool","arguments":{}}')
      const response = await pending.response.catch(() => undefined)
      expect(execute).not.toHaveBeenCalled()
      expect(response?.status).not.toBe(200)
    }
  )

  it('aborts the tool and releases its HTTP response when the execution is cancelled', async () => {
    const started = deferred<AbortSignal>()
    const result = deferred<JsonValue>()
    cleanups.push(() => result.resolve(null))
    const fixture = await createFixture(async ({ signal }) => {
      started.resolve(signal)
      return result.promise
    })
    const pending = await beginRequest(fixture, '{"name":"fixture_tool","arguments":{}}', true)
    const toolSignal = await started.promise
    let settled = false
    void pending.response.then(
      () => { settled = true },
      () => { settled = true }
    )
    fixture.controller.abort()
    expect(toolSignal.aborted).toBe(true)
    await expect.poll(() => settled, { timeout: 1_000 }).toBe(true)
  })

  it('disposes without waiting for a tool that ignores its cancellation signal', async () => {
    const started = deferred<AbortSignal>()
    const result = deferred<JsonValue>()
    cleanups.push(() => result.resolve(null))
    const fixture = await createFixture(async ({ signal }) => {
      started.resolve(signal)
      return result.promise
    })
    await beginRequest(fixture, '{"name":"fixture_tool","arguments":{}}', true)
    const toolSignal = await started.promise
    let disposed = false
    const disposal = fixture.bridge.dispose().then(() => { disposed = true })
    await expect.poll(() => disposed, { timeout: 1_000 }).toBe(true)
    await disposal
    expect(toolSignal.aborted).toBe(true)
  })

  it('cancels a tool when its native client disconnects', async () => {
    const started = deferred<AbortSignal>()
    const result = deferred<JsonValue>()
    cleanups.push(() => result.resolve(null))
    const fixture = await createFixture(async ({ signal }) => {
      started.resolve(signal)
      return result.promise
    })
    const pending = await beginRequest(fixture, '{"name":"fixture_tool","arguments":{}}', true)
    const toolSignal = await started.promise
    pending.request.destroy()
    await expect.poll(() => toolSignal.aborted, { timeout: 1_000 }).toBe(true)
  })

  it('preserves successful tool calls and keeps their execution available', async () => {
    const execute = vi.fn(async () => ({ answer: 'ok' }))
    const fixture = await createFixture(execute)
    const pending = await beginRequest(
      fixture,
      '{"name":"fixture_tool","callId":"native-call","arguments":{"input":"value"}}',
      true
    )
    await expect(pending.response).resolves.toEqual({
      status: 200,
      body: { result: { answer: 'ok' } }
    })
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      callId: 'native-call',
      arguments: { input: 'value' }
    }))
    expect(fixture.controller.signal.aborted).toBe(false)
  })
})

interface Fixture {
  bridge: ClaudeToolBridge
  controller: AbortController
  endpoint: string
  token: string
}

async function createFixture(execute: HarnessToolBinding['execute']): Promise<Fixture> {
  const bridge = await ClaudeToolBridge.create([{
    name: 'fixture_tool',
    description: 'Lifecycle test tool',
    inputSchema: { type: 'object' },
    execute
  }])
  cleanups.push(() => bridge.dispose())
  const controller = new AbortController()
  bridge.activate(controller.signal)
  const configuration = bridge.claudeConfiguration() as {
    mcpServers: { openagent: { env: Record<string, string> } }
  }
  const environment = configuration.mcpServers.openagent.env
  return {
    bridge,
    controller,
    endpoint: environment.OPENAGENT_TOOL_BRIDGE_URL!,
    token: environment.OPENAGENT_TOOL_BRIDGE_TOKEN!
  }
}

async function beginRequest(
  fixture: Fixture,
  body: string,
  complete = false
): Promise<{
  request: ClientRequest
  response: Promise<{ status: number | undefined; body: unknown }>
}> {
  // Observe only the standard HTTP request event to place cancellation after
  // headers have reached the bridge but before the gated body is complete.
  const received = once((fixture.bridge as unknown as { server: Server }).server, 'request')
  let client!: ClientRequest
  const response = new Promise<{ status: number | undefined; body: unknown }>((resolve, reject) => {
    client = request(fixture.endpoint, {
      method: 'POST',
      agent: false,
      headers: { authorization: `Bearer ${fixture.token}` }
    }, (incoming) => {
      let text = ''
      incoming.setEncoding('utf8')
      incoming.on('data', (chunk: string) => { text += chunk })
      incoming.once('error', reject)
      incoming.once('end', () => {
        try { resolve({ status: incoming.statusCode, body: JSON.parse(text) }) }
        catch (error) { reject(error) }
      })
    })
    client.once('error', reject)
    cleanups.push(() => { client.destroy() })
    if (complete) client.end(body)
    else client.write(body)
  })
  void response.catch(() => undefined)
  await received
  return { request: client, response }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
