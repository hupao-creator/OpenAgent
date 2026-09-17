import type { RendererStateMutation } from '../shared/renderer-state-contracts'
import { mergeRendererStateMutations } from '../shared/renderer-state-patch'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createChannelHandlers,
  isCommandChannel,
  type CommandRuntimeServices,
  type CommandService
} from './command-router'
import {
  createDebugTrace,
  debugDetail,
  debugError,
  debugLog,
  getDebugLogMode,
  startDebugSpan,
  withDebugContext
} from '@openagent/plugin-kit/main'
import type { OpenAgentService } from './openagent-service'

/**
 * Headless 功能调试控制面（设计见 docs/bart-headless-mode.md）。
 *
 * 不是旁路：命令处理体来自 createChannelHandlers，与 GUI 的 ipcMain 路径逐字同源；
 * 本模块只承担 transport——loopback HTTP 进命令、NDJSON 出 state:mutation。
 * 信任边界 = 仅绑定 127.0.0.1，对应 GUI 路径里 trusted() 的 sender 校验。
 */

export const DEFAULT_HEADLESS_PORT = 45775

const MAX_SHARED_PAYLOAD_BYTES = 8 * 1024 * 1024
// Shared channel parsers cap their largest *inner* JSON value at 8 MiB. HTTP
// additionally carries bounded channel fields (`threadId`, `method`, wrappers,
// etc.), so its transport ceiling must leave room for that legal envelope.
const MAX_INVOKE_BODY_BYTES = MAX_SHARED_PAYLOAD_BYTES + 64 * 1024
const EVENT_BACKPRESSURE_TIMEOUT_MS = 5_000
const MAX_PENDING_EFFECT_EVENTS = 64
const MAX_PENDING_EFFECT_BYTES = 8 * 1024 * 1024

interface EventSubscriber {
  readonly response: ServerResponse
  readonly onDrain: () => void
  readonly pendingEffectLines: string[]
  pendingEffectBytes: number
  pendingPatch?: { readonly mutation: RendererStateMutation; readonly line: string }
  waitingForDrain: boolean
  backpressureTimer?: NodeJS.Timeout
}

export interface HeadlessControl {
  port: number
  close(): Promise<void>
}

export async function startHeadlessControl(
  service: CommandService & Pick<OpenAgentService, 'onStateMutation'>,
  runtimeServices: CommandRuntimeServices,
  port: number
): Promise<HeadlessControl> {
  debugLog('headless.start', { requestedPort: port })
  const eventSubscribers = new Set<EventSubscriber>()
  const removeSubscriber = (
    subscriber: EventSubscriber,
    destroy = false
  ): void => {
    if (!eventSubscribers.delete(subscriber)) return
    if (subscriber.backpressureTimer) {
      clearTimeout(subscriber.backpressureTimer)
      subscriber.backpressureTimer = undefined
    }
    subscriber.response.removeListener('drain', subscriber.onDrain)
    subscriber.pendingEffectLines.length = 0
    subscriber.pendingEffectBytes = 0
    subscriber.pendingPatch = undefined
    if (destroy && !subscriber.response.destroyed) {
      subscriber.response.destroy()
    }
  }
  const writeEvent = (subscriber: EventSubscriber, line: string): void => {
    const response = subscriber.response
    if (response.destroyed || response.writableEnded) {
      removeSubscriber(subscriber)
      return
    }
    try {
      // A false return means the complete line was accepted into Node's
      // writable buffer. Wait for drain; it is not a socket failure.
      if (response.write(line)) return
    } catch {
      removeSubscriber(subscriber, true)
      return
    }
    subscriber.waitingForDrain = true
    response.once('drain', subscriber.onDrain)
    subscriber.backpressureTimer = setTimeout(() => {
      removeSubscriber(subscriber, true)
    }, EVENT_BACKPRESSURE_TIMEOUT_MS)
    subscriber.backpressureTimer.unref()
  }
  const flushPendingEvents = (subscriber: EventSubscriber): void => {
    while (!subscriber.waitingForDrain && eventSubscribers.has(subscriber)) {
      let line = subscriber.pendingEffectLines.shift()
      if (line) {
        subscriber.pendingEffectBytes -= Buffer.byteLength(line, 'utf8')
      } else {
        line = subscriber.pendingPatch?.line
        subscriber.pendingPatch = undefined
      }
      if (!line) return
      writeEvent(subscriber, line)
    }
  }
  const eventLine = (mutation: RendererStateMutation): string =>
    `${JSON.stringify({ channel: 'state:mutation', payload: mutation })}\n`
  const queueEvent = (
    subscriber: EventSubscriber,
    incoming: RendererStateMutation,
    incomingLine: string
  ): void => {
    let mutation = incoming
    let line = incomingLine
    if (subscriber.pendingPatch) {
      try {
        mutation = mergeRendererStateMutations(subscriber.pendingPatch.mutation, incoming)
        line = eventLine(mutation)
      } catch {
        removeSubscriber(subscriber, true)
        return
      }
    }
    if (!mutation.effect) {
      // Each delta contributes changes. Only a composed patch can subsume the
      // previous one; dropping a plain delta would silently lose other Threads.
      subscriber.pendingPatch = { mutation, line }
      return
    }
    // A preceding plain patch can join this effect's state transition. An
    // older effect remains a separate ordered event and is never replayed.
    subscriber.pendingPatch = undefined
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (subscriber.pendingEffectLines.length >= MAX_PENDING_EFFECT_EVENTS ||
        subscriber.pendingEffectBytes + lineBytes > MAX_PENDING_EFFECT_BYTES) {
      removeSubscriber(subscriber, true)
      return
    }
    subscriber.pendingEffectLines.push(line)
    subscriber.pendingEffectBytes += lineBytes
  }
  const send = (mutation: RendererStateMutation): void => {
    const line = eventLine(mutation)
    for (const subscriber of eventSubscribers) {
      if (subscriber.response.destroyed || subscriber.response.writableEnded) {
        removeSubscriber(subscriber)
        continue
      }
      if (subscriber.waitingForDrain) {
        queueEvent(subscriber, mutation, line)
        continue
      }
      writeEvent(subscriber, line)
    }
  }
  const handlers = createChannelHandlers(service, runtimeServices)
  const removeMutationListener = service.onStateMutation((mutation) => {
    send(mutation)
  })
  const activeRequests = new Set<Promise<void>>()
  let closing = false

  const server = createServer((request, response) => {
    if (closing) {
      response.destroy()
      return
    }
    const responseSettled = waitForResponseSettlement(response)
    const handlerSettled = (async () => {
      try {
        const url = new URL(request.url || '/', 'http://127.0.0.1')
        if (request.method === 'GET' && url.pathname === '/events') {
          response.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'cache-control': 'no-store'
          })
          response.flushHeaders()
          let subscriber: EventSubscriber
          const onDrain = (): void => {
            subscriber.waitingForDrain = false
            if (subscriber.backpressureTimer) {
              clearTimeout(subscriber.backpressureTimer)
              subscriber.backpressureTimer = undefined
            }
            flushPendingEvents(subscriber)
          }
          subscriber = {
            response,
            onDrain,
            pendingEffectLines: [],
            pendingEffectBytes: 0,
            waitingForDrain: false
          }
          eventSubscribers.add(subscriber)
          debugLog('headless.events.subscribe', {
            subscribers: eventSubscribers.size
          })
          response.once('close', () => removeSubscriber(subscriber))
          response.once('error', () => removeSubscriber(subscriber))
          return
        }
        if (request.method === 'POST' && url.pathname.startsWith('/invoke/')) {
          const rawChannel = url.pathname.slice('/invoke/'.length)
          const trace = createDebugTrace()
          await withDebugContext(trace, async () => {
            const span = startDebugSpan('headless.invoke', {
              method: request.method,
              path: url.pathname,
              channel: rawChannel
            })
            await withDebugContext(span.context, async () => {
              let channel: string | undefined
              let bodyBytes = 0
              let payload: unknown
              try {
                channel = decodeURIComponent(rawChannel)
                if (!isCommandChannel(channel)) {
                  respondJson(response, 404, {
                    ok: false,
                    error: `未知 channel: ${channel}`
                  })
                  span.end({
                    channel,
                    status: 404,
                    outcome: 'rejected'
                  })
                  return
                }
                const handler = handlers[channel]
                const body = await readBody(request)
                bodyBytes = Buffer.byteLength(body, 'utf8')
                payload = body.length ? JSON.parse(body) : undefined
                // HTTP bodies represent the channel payload directly. The one shared
                // multi-argument command uses an argument tuple; array-valued payloads
                // such as attachment imports must remain a single handler argument.
                const args = (channel === 'report:set-archived' || channel === 'thread:set-archived')
                  ? requiredArgumentTuple(payload, 2, channel)
                  : payload === undefined ? [] : [payload]
                const requestFields = {
                  method: request.method,
                  path: url.pathname,
                  channel,
                  bodyBytes,
                  argumentCount: args.length
                }
                if (getDebugLogMode() === 'detail') {
                  debugDetail('headless.invoke.request', {
                    ...requestFields,
                    payload: debugPayload(payload)
                  })
                } else {
                  debugLog('headless.invoke.request', requestFields)
                }
                const result = await handler(...args)
                if (channel === 'state:load') {
                  // Renderer state is intentionally excluded from detail logs; the
                  // mutation stream below is likewise kept out of per-event tracing.
                  debugLog('headless.invoke.result', {
                    channel,
                    status: 200,
                    resultKind: debugValueKind(result)
                  })
                } else if (getDebugLogMode() === 'detail') {
                  debugDetail('headless.invoke.result', {
                    channel,
                    result: debugPayload(result === undefined ? null : result)
                  })
                } else {
                  debugLog('headless.invoke.result', {
                    channel,
                    resultKind: debugValueKind(result)
                  })
                }
                respondJson(response, 200, {
                  ok: true,
                  result: result === undefined ? null : result
                })
                span.end({
                  channel,
                  status: 200,
                  outcome: 'succeeded',
                  resultKind: debugValueKind(result)
                })
              } catch (error) {
                debugError('headless.invoke.failed', error, {
                  method: request.method,
                  path: url.pathname,
                  ...(channel === undefined ? {} : { channel }),
                  bodyBytes
                })
                span.fail(error, {
                  ...(channel === undefined ? {} : { channel }),
                  status: 400,
                  bodyBytes
                })
                const message = error instanceof Error ? error.message : String(error)
                respondJson(response, 400, { ok: false, error: message })
              }
            })
          })
          return
        }
        debugLog('headless.request.rejected', {
          method: request.method,
          path: url.pathname,
          status: 404
        })
        respondJson(response, 404, { ok: false, error: '未知端点；可用：POST /invoke/{channel}、GET /events' })
      } catch (error) {
        debugError('headless.request.failed', error, {
          method: request.method,
          path: request.url || '/'
        })
        const message = error instanceof Error ? error.message : String(error)
        respondJson(response, 400, { ok: false, error: message })
      }
    })()
    const requestSettled = Promise.allSettled([
      handlerSettled,
      responseSettled
    ]).then(() => undefined)
    activeRequests.add(requestSettled)
    void requestSettled.finally(() => {
      activeRequests.delete(requestSettled)
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    debugError('headless.listen.failed', error, { requestedPort: port })
    closing = true
    removeMutationListener()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    throw error
  }
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  debugLog('headless.listening', { port: boundPort })
  let closePromise: Promise<void> | undefined

  return {
    port: boundPort,
    close: () => {
      closePromise ??= (async () => {
        debugLog('headless.close.start', {
          port: boundPort,
          subscribers: eventSubscribers.size,
          activeRequests: activeRequests.size
        })
        closing = true
        removeMutationListener()
        for (const subscriber of [...eventSubscribers]) {
          removeSubscriber(subscriber)
          subscriber.response.end()
        }
        const closed = new Promise<void>((resolve) => server.close(() => resolve()))
        // server.close() waits for an incomplete request body forever. Headless
        // shutdown owns this loopback transport, so terminate all remaining
        // connections after stopping new accepts.
        server.closeAllConnections()
        await closed
        while (activeRequests.size > 0) {
          await Promise.allSettled([...activeRequests])
        }
        debugLog('headless.close.done', { port: boundPort })
      })()
      return closePromise
    }
  }
}

function requiredArgumentTuple(
  value: unknown,
  length: number,
  channel: string
): unknown[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${channel} 需要 ${length} 个参数`)
  }
  return value
}

/** Keep byte-backed attachment requests useful without copying their contents. */
function debugPayload(value: unknown, key?: string): unknown {
  try {
    if (key === 'bytes') return debugBinaryMetadata(value)
    if (value instanceof ArrayBuffer) return debugBinaryMetadata(value)
    if (ArrayBuffer.isView(value)) return debugBinaryMetadata(value)
    if (Array.isArray(value)) return value.map(item => debugPayload(item))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          debugPayload(entryValue, entryKey)
        ])
      )
    }
    return value
  } catch {
    return { type: 'unserializable' }
  }
}

function debugBinaryMetadata(value: unknown): Record<string, unknown> {
  if (value instanceof ArrayBuffer) {
    return { type: 'ArrayBuffer', byteLength: value.byteLength }
  }
  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      byteLength: value.byteLength
    }
  }
  if (Array.isArray(value)) {
    return { type: 'byte-array', byteLength: value.length }
  }
  if (typeof value === 'string') {
    return { type: 'encoded-binary', characterCount: value.length }
  }
  if (value && typeof value === 'object') {
    return { type: 'binary-object', keyCount: Object.keys(value).length }
  }
  return { type: typeof value, value }
}

function debugValueKind(value: unknown): string {
  try {
    if (value === null) return 'null'
    if (Array.isArray(value)) return 'array'
    return typeof value
  } catch {
    return 'uninspectable'
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const cleanup = (): void => {
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('error', onError)
      request.removeListener('aborted', onAborted)
      request.removeListener('close', onClose)
    }
    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > MAX_INVOKE_BODY_BYTES) {
        request.resume()
        fail(new Error('请求体过大'))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => succeed()
    const onError = (error: Error): void => fail(error)
    const onAborted = (): void => fail(new Error('请求已中止'))
    const onClose = (): void => {
      if (!request.complete) fail(new Error('请求在正文接收完成前关闭'))
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
    request.once('close', onClose)
  })
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded || response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function waitForResponseSettlement(response: ServerResponse): Promise<void> {
  if (response.destroyed || response.writableFinished) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const cleanup = (): void => {
      response.removeListener('finish', settle)
      response.removeListener('close', settle)
      response.removeListener('error', settle)
    }
    const settle = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    response.once('finish', settle)
    response.once('close', settle)
    response.once('error', settle)
  })
}
