import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { isJsonValue, type HarnessThreadInjection } from '@openagent/contracts'

export interface PiHostBridgeOptions {
  injection: HarnessThreadInjection
  canExecute(): boolean
}

/** One private inherited pipe per RPC process. Never accepts calls via stdout. */
export function connectPiHostBridge(channel: Duplex, options: PiHostBridgeOptions, fail: (error: Error) => void) {
  const bindings = new Map(options.injection.tools?.bindings.map(tool => [tool.name, tool]))
  const seen = new Set<string>()
  const nativeCalls = new Set<string>()
  const pending = new Map<string, AbortController>()
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  let closed = false
  let readyReceived = false
  let resolve!: () => void
  let reject!: (error: Error) => void
  const ready = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  void ready.catch(() => undefined)
  const timer = setTimeout(() => failed(new Error('Pi Host bridge did not initialize; reinstall Pi 0.83.x and check extension loading')), 15_000)
  function dispose() {
    if (closed) return
    closed = true; clearTimeout(timer)
    reject(new Error('Pi Host bridge closed'))
    for (const controller of pending.values()) controller.abort()
    pending.clear(); channel.destroy()
  }
  function failed(error: Error) { if (!closed) { reject(error); dispose(); fail(error) } }
  function write(value: unknown) {
    if (!closed) channel.write(JSON.stringify(value) + '\n', error => { if (error) failed(new Error('Pi Host bridge output disconnected')) })
  }
  function receive(value: Record<string, unknown>) {
    if (value.type === 'ready') {
      if (!Array.isArray(value.tools) || (options.injection.tools?.mode === 'exclusive' && (value.tools.length !== bindings.size ||
          new Set(value.tools).size !== bindings.size || value.tools.some(name => typeof name !== 'string' || !bindings.has(name))))) {
        throw new Error('Pi Host exclusive tool verification failed')
      }
      readyReceived = true; clearTimeout(timer); resolve(); return
    }
    if (!readyReceived || typeof value.id !== 'string') throw new Error('Invalid Pi Host bridge message')
    if (value.type === 'cancel') { pending.get(value.id)?.abort(); pending.delete(value.id); return }
    if (value.type !== 'call' || seen.has(value.id) || typeof value.callId !== 'string' ||
        nativeCalls.has(value.callId) || typeof value.name !== 'string' || !isJsonValue(value.arguments)) throw new Error('Invalid or replayed Pi Host tool call')
    const binding = bindings.get(value.name)
    if (!binding || !options.canExecute()) throw new Error('Pi Host tool call outside the admitted Execution')
    seen.add(value.id); nativeCalls.add(value.callId)
    const controller = new AbortController()
    const id = value.id
    pending.set(id, controller)
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return binding.execute({ callId: value.callId as string, arguments: value.arguments as Parameters<typeof binding.execute>[0]['arguments'], signal: controller.signal })
    }).then(result => {
      if (!isJsonValue(result)) throw new Error('OpenAgent tool returned an invalid JSON result')
      if (!controller.signal.aborted && !closed) write({ id, result })
    }).catch(error => {
      if (!controller.signal.aborted && !closed) write({ id, error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { pending.delete(id) })
  }
  channel.on('data', (chunk: Buffer) => {
    if (closed) return
    buffer += decoder.write(chunk)
    try {
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        if (Buffer.byteLength(buffer.slice(0, index)) > 8 * 1024 * 1024) throw new Error('Pi Host bridge record exceeds size limit')
        const value: unknown = JSON.parse(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi Host bridge record')
        receive(value as Record<string, unknown>)
      }
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) throw new Error('Pi Host bridge record exceeds size limit')
    } catch (error) { failed(error instanceof Error ? error : new Error('Invalid Pi Host bridge data')) }
  })
  channel.on('error', () => failed(new Error('Pi Host bridge disconnected')))
  channel.on('close', () => failed(new Error('Pi Host bridge disconnected')))
  return { ready, dispose }
}
