import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessToolBinding } from '@openagent/contracts'
import type { JsonValue } from '@openagent/contracts'
import { claudeToolSchema } from './tool-schema.js'
import {
  debugDetail,
  debugError,
  debugFrame,
  effectiveDebugContext,
  getDebugContext,
  inDebugContext,
  startDebugSpan,
  type DebugContext
} from './debug.js'

const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const SERVER_NAME = 'openagent'

export class ClaudeToolBridge {
  private activeSignal?: AbortSignal
  private activeController?: AbortController
  private activeDebugContext?: DebugContext
  private disposed = false
  private disposePromise?: Promise<void>

  private constructor(
    private readonly tools: readonly HarnessToolBinding[],
    private readonly server: Server,
    private readonly directory: string,
    private readonly endpoint: string,
    private readonly token: string,
    private readonly definitionsPath: string,
    private readonly serverPath: string
  ) {}

  static async create(tools: readonly HarnessToolBinding[]): Promise<ClaudeToolBridge> {
    const token = randomBytes(32).toString('base64url')
    const directory = join(
      tmpdir(),
      `openagent-claude-tools-${process.pid}-${randomBytes(8).toString('hex')}`
    )
    const serverPath = join(directory, 'mcp-server.mjs')
    const definitionsPath = join(directory, 'tools.json')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      await Promise.all([
        writeFile(serverPath, MCP_SERVER_SOURCE, { mode: 0o600 }),
        writeFile(
          definitionsPath,
          JSON.stringify(
            tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: claudeToolSchema(tool.inputSchema),
              ...(tool.outputSchema === undefined
                ? {}
                : { outputSchema: tool.outputSchema })
            }))
          ),
          { mode: 0o600 }
        )
      ])
      const server = createServer()
      server.unref()
      await listen(server)
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('无法启动 Claude Core tool bridge')
      }
      const endpoint = `http://127.0.0.1:${address.port}/tool-call`
      const bridge = new ClaudeToolBridge(
        tools,
        server,
        directory,
        endpoint,
        token,
        definitionsPath,
        serverPath
      )
      server.on('request', (request, response) => {
        void bridge.handleRequest(request, response)
      })
      return bridge
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  activate(signal: AbortSignal, debugContext?: DebugContext): void {
    this.assertActive()
    this.deactivate()
    this.activeController = new AbortController()
    this.activeSignal = AbortSignal.any([signal, this.activeController.signal])
    this.activeDebugContext = effectiveDebugContext(
      debugContext,
      getDebugContext()
    )
  }

  deactivate(): void {
    this.activeController?.abort(new Error('Claude execution is not active'))
    this.activeController = undefined
    this.activeSignal = undefined
    this.activeDebugContext = undefined
  }

  claudeConfiguration(): Record<string, unknown> {
    this.assertActive()
    return {
      mcpServers: {
        [SERVER_NAME]: {
          type: 'stdio',
          command: process.execPath,
          args: [this.serverPath],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            OPENAGENT_TOOL_BRIDGE_URL: this.endpoint,
            OPENAGENT_TOOL_BRIDGE_TOKEN: this.token,
            OPENAGENT_TOOL_DEFINITIONS_PATH: this.definitionsPath,
            OPENAGENT_TOOL_SERVER_NAME: SERVER_NAME
          },
          alwaysLoad: true
        }
      }
    }
  }

  claudeToolNames(): string[] {
    return this.tools.map((tool) => `mcp__${SERVER_NAME}__${tool.name}`)
  }

  /**
   * Unwraps the MCP name Claude reports back to the canonical name of the tool
   * this bridge injected. Only the injected set is unwrapped, so an unrelated
   * MCP server that happens to reuse the prefix keeps its own name and cannot
   * impersonate a Core-owned dedicated route.
   */
  canonicalToolName(name: string): string {
    const prefix = `mcp__${SERVER_NAME}__`
    if (!name.startsWith(prefix)) return name
    const canonical = name.slice(prefix.length)
    return this.tools.some((tool) => tool.name === canonical) ? canonical : name
  }

  dispose(): Promise<void> {
    this.disposePromise ||= this.disposeUnlocked()
    return this.disposePromise
  }

  private async disposeUnlocked(): Promise<void> {
    this.disposed = true
    this.deactivate()
    await new Promise<void>((resolve) => {
      try {
        this.server.close(() => resolve())
        // Incomplete bodies and tools that ignore cancellation must not keep
        // the Thread's server alive during shutdown.
        this.server.closeAllConnections()
      } catch {
        resolve()
      }
    })
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined)
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/tool-call') {
      sendJson(response, 404, { error: 'Not found' })
      return
    }
    const authorization = request.headers.authorization
    if (authorization !== `Bearer ${this.token}`) {
      sendJson(response, 401, { error: 'Invalid Claude tool bridge token' })
      return
    }
    const executionSignal = this.activeSignal
    if (!executionSignal || executionSignal.aborted) {
      sendJson(response, 409, { error: 'Claude execution is not active' })
      return
    }
    const clientController = new AbortController()
    const signal = AbortSignal.any([executionSignal, clientController.signal])
    const executionDebugContext = this.activeDebugContext
    const onDisconnect = (): void => {
      if (!response.writableEnded) {
        clientController.abort(new Error('Claude tool client disconnected'))
      }
    }
    const onAbort = (): void => { response.destroy() }
    response.once('close', onDisconnect)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const body = await abortable(readJsonBody(request), signal)
      // A request can finish arriving after its Execution was cancelled or
      // replaced. Never dispatch its tool into the newer Execution.
      signal.throwIfAborted()
      if (!isRecord(body) || typeof body.name !== 'string') {
        throw new Error('Invalid Claude tool call')
      }
      const tool = this.tools.find((candidate) => candidate.name === body.name)
      if (!tool) {
        inDebugContext(executionDebugContext, () => debugError(
          'claude.tool-bridge.error',
          new Error('Unknown OpenAgent tool'),
          { toolName: body.name, arguments: debugFrame(body.arguments) }
        ))
        sendJson(response, 404, { error: 'Unknown OpenAgent tool' })
        return
      }
      const callId =
        typeof body.callId === 'string' || typeof body.callId === 'number'
          ? String(body.callId).slice(0, 256)
          : undefined
      const argumentsValue = isJsonValue(body.arguments) ? body.arguments : null
      const span = inDebugContext(executionDebugContext, () => startDebugSpan(
        'claude.tool-bridge.call',
        {
          harnessId: 'claude',
          purpose: 'tool-bridge',
          toolName: body.name,
          ...(callId === undefined ? {} : { callId })
        }
      ))
      const callDebugContext = effectiveDebugContext(
        executionDebugContext,
        span.context
      )
      inDebugContext(callDebugContext, () => debugDetail(
        'claude.tool-bridge.inbound',
        {
          toolName: body.name,
          ...(callId === undefined ? {} : { callId }),
          arguments: debugFrame(argumentsValue)
        }
      ))
      try {
        const result = await abortable(tool.execute({
          ...(callId === undefined ? {} : { callId }),
          arguments: argumentsValue,
          signal
        }), signal)
        inDebugContext(callDebugContext, () => debugDetail(
          'claude.tool-bridge.result',
          {
            toolName: body.name,
            ...(callId === undefined ? {} : { callId }),
            result: debugFrame(result)
          }
        ))
        inDebugContext(callDebugContext, () => span.end({
          toolName: body.name,
          outcome: 'completed'
        }))
        sendJson(response, 200, { result })
      } catch (error) {
        inDebugContext(callDebugContext, () => debugError(
          'claude.tool-bridge.error',
          error,
          {
            toolName: body.name,
            ...(callId === undefined ? {} : { callId })
          }
        ))
        inDebugContext(callDebugContext, () => span.fail(error, {
          toolName: body.name,
          outcome: 'failed'
        }))
        throw error
      }
    } catch (error) {
      inDebugContext(executionDebugContext, () => debugError(
        'claude.tool-bridge.request-error',
        error,
        { method: request.method, url: request.url }
      ))
      sendJson(response, 422, {
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      signal.removeEventListener('abort', onAbort)
      response.off('close', onDisconnect)
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Claude Core tool bridge 已关闭')
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onListening = (): void => {
      cleanup()
      resolve()
    }
    const cleanup = (): void => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Claude tool call is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    const onAbort = (): void => {
      cleanup()
      reject(signal.reason instanceof Error ? signal.reason : new Error('Claude tool call cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // Keep observing the native tool even when it ignores cancellation, so a
    // later rejection cannot escape as an unhandled promise rejection.
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      }
    )
    if (signal.aborted) onAbort()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

const MCP_SERVER_SOURCE = String.raw`import { readFileSync } from 'node:fs'

const endpoint = process.env.OPENAGENT_TOOL_BRIDGE_URL
const token = process.env.OPENAGENT_TOOL_BRIDGE_TOKEN
const definitionsPath = process.env.OPENAGENT_TOOL_DEFINITIONS_PATH
const tools = JSON.parse(definitionsPath ? readFileSync(definitionsPath, 'utf8') : '[]')
const serverName = process.env.OPENAGENT_TOOL_SERVER_NAME || 'openagent'
let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  while (true) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    try { void handle(JSON.parse(line)) } catch {}
  }
})

function send(value) { process.stdout.write(JSON.stringify(value) + '\n') }

async function handle(message) {
  if (Array.isArray(message)) {
    for (const item of message) await handle(item)
    return
  }
  if (!message || typeof message !== 'object' || message.id === undefined) return
  const base = { jsonrpc: '2.0', id: message.id }
  try {
    if (message.method === 'initialize') {
      send({
        ...base,
        result: {
          protocolVersion: message.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: serverName, version: '1.0.0' }
        }
      })
      return
    }
    if (message.method === 'ping') {
      send({ ...base, result: {} })
      return
    }
    if (message.method === 'tools/list') {
      send({ ...base, result: { tools } })
      return
    }
    if (message.method === 'tools/call') {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          name: message.params?.name,
          arguments: message.params?.arguments || {},
          callId: String(message.id)
        })
      })
      const payload = await response.json()
      if (!response.ok) {
        send({
          ...base,
          result: {
            content: [{ type: 'text', text: String(payload.error || 'OpenAgent tool failed') }],
            isError: true
          }
        })
        return
      }
      const result = payload.result
      send({
        ...base,
        result: {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result ?? null)
          }],
          ...(result && typeof result === 'object' ? { structuredContent: result } : {})
        }
      })
      return
    }
    send({ ...base, error: { code: -32601, message: 'Method not found' } })
  } catch (error) {
    send({
      ...base,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    })
  }
}
`
