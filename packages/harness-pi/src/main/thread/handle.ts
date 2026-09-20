import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessPluginHostContext, HarnessThreadHandle, HarnessThreadOpenContext, PublicExecution, PublicInteraction } from '@openagent/contracts'
import {
  advanceBartForeground,
  advanceBartReasoning,
  headPoints,
  MAX_BART_TOOL_NAME_POINTS,
  type HarnessBartActivityBody,
  type HarnessBartForeground
} from '@openagent/contracts/renderer'
import { piJson, piState } from '../../shared/state.js'
import { parsePiTodos } from '../../shared/todos.js'
import type { PiMessage, PiThreadSettings } from '../../shared/types.js'
import { startPiRpc, type PiRpc } from '../runtime/rpc.js'
import { piModelArguments } from '../runtime/model-options.js'
import { piEnvironment, piProviderSettings } from '../runtime/provider-override.js'
import { piHostExtensionSource } from '../runtime/host-extension.js'

/** Longest call identifier the persisted foreground accepts; see `piState`. */
const CALL_ID_CHARACTERS = 1_024

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''
const clean = (value: unknown, max = 100_000): string => string(value).replaceAll('\0', '').slice(0, max)
function content(value: unknown, kind = 'text'): string {
  if (typeof value === 'string') return value
  return Array.isArray(value) ? value.map(record).filter(p => p.type === kind).map(p => string(p[kind])).join('\n') : ''
}
/** Pi reports cumulative message content; the foreground sees only the new suffix. */
function delta(next: string, previous: string): string {
  if (next === previous) return ''
  return next.startsWith(previous) ? next.slice(previous.length) : next
}

export async function openPiThread(host: HarnessPluginHostContext, context: HarnessThreadOpenContext<'pi', PiThreadSettings>): Promise<HarnessThreadHandle> {
  const injection = context.injection
  if (injection?.tools && injection.tools.mode !== 'exclusive') throw new Error('Pi Host supports exclusive injected tools only')
  const names = injection?.tools?.bindings.map(tool => tool.name) ?? []
  if (new Set(names).size !== names.length || names.some(name => !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name))) {
    throw new Error('Pi Host tool names must be unique identifiers')
  }
  context.signal.throwIfAborted()
  const directory = join(host.harnessDataRoot, context.thread.id)
  const state = piState(context.sessionState.read())
  const lifetime = new AbortController()
  let rpc: PiRpc | undefined
  let connecting: Promise<PiRpc> | undefined
  let connectionAbort: AbortController | undefined
  let connectionConfig: string | undefined
  let unsubscribe = () => {}
  let unsubscribeFailure = () => {}
  let disposed = false
  let closing = false
  let stopping: Promise<void> | undefined
  let pendingStop: { status: 'failed' | 'interrupted'; reason?: string } | undefined
  let queue: Promise<void> = Promise.resolve()
  let sends: Promise<void> = Promise.resolve()
  let assistantId: string | undefined
  let lastStop: string | undefined
  let lastError: string | undefined
  const interactionMap = new Map<string, { nativeId: string; method: string; options: string[]; timer?: ReturnType<typeof setTimeout> }>()
  const abortListeners = new Map<AbortSignal, () => void>()
  const pendingUserEchoes: { id: string; executionId: string; text: string; echoed: boolean }[] = []
  const latest = (): PublicExecution | undefined => state.executions.find(e => e.executionId === state.latestExecutionId)
  const active = (): PublicExecution | undefined => { const e = latest(); return e && ['running', 'waiting-for-user'].includes(e.status) ? e : undefined }
  const commit = () => context.sessionState.commit(piJson(state))
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const result = queue.then(operation)
    queue = result.catch(() => undefined)
    return result
  }
  const accept = (operation: () => Promise<void>): Promise<void> => {
    const result = sends.then(operation)
    sends = result.catch(() => undefined)
    return result
  }
  function clearInteractions() {
    for (const item of interactionMap.values()) if (item.timer) clearTimeout(item.timer)
    interactionMap.clear()
  }
  function replaceExecution(execution: PublicExecution) {
    const index = state.executions.findIndex(e => e.executionId === execution.executionId)
    if (index < 0) state.executions.push(execution)
    else state.executions[index] = execution
  }
  function foregroundOf(executionId: string) {
    return state.foregrounds?.find(entry => entry.executionId === executionId)?.foreground
  }
  /**
   * A bare body is advanced against what is showing; a caller that already ran
   * the shared reasoning helper hands over the finished snapshot, because
   * advancing it a second time would fold its new segment back into the
   * sequence of the segment it replaces.
   */
  function setForeground(executionId: string, next: HarnessBartActivityBody | HarnessBartForeground) {
    const list = state.foregrounds ?? (state.foregrounds = [])
    const index = list.findIndex(entry => entry.executionId === executionId)
    const foreground = 'sequence' in next
      ? next
      : advanceBartForeground(index < 0 ? undefined : list[index]!.foreground, next)
    const entry = { executionId, foreground }
    if (index < 0) list.push(entry)
    else list[index] = entry
  }
  async function finish(status: 'completed' | 'failed' | 'interrupted', error?: string) {
    const e = active()
    if (!e) return
    const summary = state.messages.filter(m => m.executionId === e.executionId && m.role === 'assistant').at(-1)?.text
    replaceExecution({ executionId: e.executionId, startedAt: e.startedAt, status,
      finishedAt: Math.max(e.startedAt, Date.now()), ...(summary ? { summary: clean(summary) } : {}),
      ...(status === 'failed' && error ? { error: clean(error) } : {}) })
    // Foreground activity is a live-run surface; a settled Execution keeps none.
    if (state.foregrounds) {
      state.foregrounds = state.foregrounds.filter(entry => entry.executionId !== e.executionId)
    }
    try { await commit() } catch (error) { replaceExecution(e); throw error }
    clearInteractions()
    for (let index = pendingUserEchoes.length - 1; index >= 0; index--) {
      if (pendingUserEchoes[index]?.executionId === e.executionId) pendingUserEchoes.splice(index, 1)
    }
    for (const [s, fn] of abortListeners) s.removeEventListener('abort', fn)
    abortListeners.clear()
  }
  function stop(status: 'failed' | 'interrupted', reason?: string): Promise<void> {
    if (stopping) return stopping
    pendingStop = { status, reason }
    closing = true
    stopping = Promise.resolve().then(async () => {
      connectionAbort?.abort()
      await rpc?.dispose()
      await connecting?.catch(() => undefined)
      rpc = undefined
      unsubscribe(); unsubscribeFailure()
      await serialize(async () => {
        if (state.sessionFile) {
          try { state.nativeSessionJsonl = await readFile(state.sessionFile, 'utf8') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') delete state.nativeSessionJsonl }
        }
        await finish(status, reason)
      })
      pendingStop = undefined
    }).catch(error => { stopping = undefined; throw error })
    return stopping
  }
  const failed = (error: Error) => { void stop(context.signal.aborted ? 'interrupted' : 'failed', error.message).catch(() => undefined) }
  const handleEvent = (event: Record<string, unknown>) => {
    if (disposed || closing) return
    void serialize(async () => {
      if (closing) return
      const execution = active()
      if (!execution) {
        if (['agent_start', 'extension_ui_request', 'message_start'].includes(string(event.type))) {
          throw new Error('Pi initiated work outside an admitted Execution; background extension work is unsupported')
        }
        return
      }
      const type = string(event.type)
      if (type === 'message_start' || type === 'message_update' || type === 'message_end') {
        const message = record(event.message)
        const role = message.role
        if (role === 'assistant') {
          if (type === 'message_start' || !assistantId) assistantId = `pi-${randomUUID()}`
          const previous = state.messages.findIndex(m => m.id === assistantId)
          const row: PiMessage = { id: assistantId, executionId: execution.executionId, role: 'assistant', text: content(message.content),
            ...(content(message.content, 'thinking') ? { thinking: content(message.content, 'thinking') } : {}),
            ...(message.model ? { model: string(message.model) } : {}), ...(message.provider ? { provider: string(message.provider) } : {}) }
          const usage = record(message.usage)
          if (['input', 'output', 'cacheRead', 'cacheWrite'].every(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]))) {
            row.usage = { input: usage.input as number, output: usage.output as number, cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number,
              ...(typeof record(usage.cost).total === 'number' ? { cost: record(usage.cost).total as number } : {}) }
          }
          const previousRow = previous < 0 ? undefined : state.messages[previous]
          // The foreground snapshot is persisted like the rest of the turn and
          // its codec rejects a NUL, so the native delta is sanitized before it.
          const thinkingDelta = delta(row.thinking ?? '', previousRow?.thinking ?? '').replaceAll('\0', '')
          const textDelta = delta(row.text, previousRow?.text ?? '')
          if (previous < 0) state.messages.push(row); else state.messages[previous] = row
          if (thinkingDelta) {
            // A row that was not there before is a new native message, so its
            // thinking opens a new segment rather than extending the last one.
            setForeground(execution.executionId, advanceBartReasoning(
              foregroundOf(execution.executionId),
              thinkingDelta,
              previous >= 0
            ))
          }
          if (textDelta && type !== 'message_end') {
            setForeground(execution.executionId, { kind: 'assistant-text' })
          }
          if (row.text.trim()) replaceExecution({ ...execution, summary: clean(row.text) })
          if (type === 'message_end') { lastStop = string(message.stopReason); lastError = clean(message.errorMessage); assistantId = undefined }
        } else if (role === 'user' && type === 'message_start') {
          const text = content(message.content)
          const echo = pendingUserEchoes.findIndex(input => input.executionId === execution.executionId && input.text === text)
          if (echo >= 0) { pendingUserEchoes[echo]!.echoed = true; pendingUserEchoes.splice(echo, 1) }
          else state.messages.push({ id: `pi-${randomUUID()}`, executionId: execution.executionId, role: 'user', text })
        }
        await commit()
      } else if (type.startsWith('tool_execution_')) {
        const id = `tool:${string(event.toolCallId)}`
        const index = state.messages.findIndex(m => m.id === id)
        const result = record(event.result ?? event.partialResult)
        const row: PiMessage = { id, executionId: execution.executionId, role: 'tool', toolName: string(event.toolName),
          text: type === 'tool_execution_start' ? JSON.stringify(event.args ?? {}) : content(result.content), isError: event.isError === true }
        if (type === 'tool_execution_end' && row.toolName === 'todo' && !row.isError) {
          const details = record(result.details)
          const todos = details.error === undefined ? parsePiTodos(details.todos) : undefined
          if (todos) row.todos = todos
        }
        if (index < 0) state.messages.push(row); else state.messages[index] = row
        // An extension reports the identifier, so it is bounded and sanitized
        // the way `piState` will read it back: the codec refuses a NUL and a
        // longer value by failing the whole commit.
        const callId = clean(event.toolCallId, CALL_ID_CHARACTERS)
        const toolName = string(event.toolName).trim()
        if (type === 'tool_execution_start' && callId && toolName) {
          setForeground(execution.executionId, {
            kind: 'tool-call',
            callId,
            toolName: headPoints(toolName, MAX_BART_TOOL_NAME_POINTS)
          })
        }
        await commit()
      } else if (type === 'extension_ui_request') {
        await handleInteraction(event, execution)
      } else if (type === 'extension_error') {
        throw new Error(`Pi extension failed: ${clean(event.error) || 'unknown extension error'}`)
      } else if (type === 'agent_settled') {
        if (interactionMap.size) throw new Error('Pi settled with unresolved user interactions')
        if (state.sessionFile) {
          try { state.nativeSessionJsonl = await readFile(state.sessionFile, 'utf8') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        await finish(lastStop === 'error' ? 'failed' : lastStop === 'aborted' ? 'interrupted' : 'completed', lastError)
      }
    }).catch(failed)
  }
  async function ensureConnection(steering: boolean): Promise<PiRpc> {
    // A steering message belongs to the already-running native configuration.
    if (steering) {
      if (rpc && !closing) return rpc
      throw new Error('Pi active Execution has no native connection')
    }
    const current = context.thread.read()
    const cwd = current.worktree?.cwd || current.cwd
    const settings = current.settings
    const config = JSON.stringify([cwd, settings.executablePath, settings.provider, settings.model, settings.thinkingLevel])
    if (rpc && !closing && connectionConfig === config) return rpc
    if (connecting) return connecting
    const controller = new AbortController()
    connectionAbort = controller
    const nativeSignal = AbortSignal.any([context.signal, lifetime.signal, controller.signal])
    const initialize = async (): Promise<PiRpc> => {
      let opened: PiRpc | undefined
      let staging: string | undefined
      let extensionFile: string | undefined
      try {
        await stopping
        nativeSignal.throwIfAborted()
        if (disposed) throw new Error('Pi Thread is disposed')
        if (rpc) { unsubscribe(); unsubscribeFailure(); await rpc.dispose(); rpc = undefined }
        closing = false; stopping = undefined
        await mkdir(directory, { recursive: true, mode: 0o700 })
        nativeSignal.throwIfAborted()
        const executablePath = await host.resolveExecutable('pi', cwd, current.settings.executablePath)
        const env = await piEnvironment(host)
        nativeSignal.throwIfAborted()
        // CLI overrides are session-local; set_model/set_thinking_level RPCs
        // also write Pi's global defaults and must never configure an OpenAgent Thread.
        const modelArgs = piModelArguments(piProviderSettings(settings, host.providerOverride))
        const hostArgs: string[] = []
        const hostBridge = injection ? { injection, canExecute: () => !disposed && !closing && Boolean(active()) } : undefined
        if (injection) {
          extensionFile = join(directory, `host-extension-${randomUUID()}.mjs`)
          await writeFile(extensionFile, piHostExtensionSource(injection), { mode: 0o600, flag: 'wx' })
          hostArgs.push('-e', extensionFile)
          if (injection.tools?.mode === 'exclusive') {
            hostArgs.push('--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
              ...(names.length ? ['--tools', names.join(',')] : []))
          }
        }
        const args = ['--session-dir', directory, ...modelArgs, ...hostArgs]
        if (state.forkSource) {
          staging = join(directory, `fork-source-${randomUUID()}.jsonl`)
          await writeFile(staging, state.forkSource.jsonl, { mode: 0o600, flag: 'wx' })
          args.push('--session', staging, '--no-extensions')
        } else if (state.sessionFile) args.push('--session', state.sessionFile)
        opened = await startPiRpc({ executablePath, cwd, env, args, signal: nativeSignal, hostBridge })
        nativeSignal.throwIfAborted()
        if (staging) {
          const result = await opened.request({ type: 'clone' }, nativeSignal)
          if (result.cancelled) throw new Error('Pi cancelled the native clone')
        }
        const native = await opened.request({ type: 'get_state' }, nativeSignal)
        if (!native.sessionFile || native.sessionFile === staging) throw new Error('Pi did not allocate an independent persistent session')
        state.sessionFile = string(native.sessionFile)
        delete state.forkSource
        await commit()
        if (staging) {
          await opened.dispose()
          opened = await startPiRpc({ executablePath, cwd, env, args: ['--session-dir', directory, '--session', state.sessionFile, ...modelArgs, ...hostArgs], signal: nativeSignal, hostBridge })
        }
        nativeSignal.throwIfAborted()
        rpc = opened; connectionConfig = config
        unsubscribeFailure = opened.onFailure(failed)
        unsubscribe = opened.subscribe(handleEvent)
        return opened
      } catch (error) { await opened?.dispose(); throw error }
      finally {
        if (staging) await rm(staging, { force: true })
        if (extensionFile) await rm(extensionFile, { force: true })
      }
    }
    connecting = initialize()
    try { return await connecting } finally { connecting = undefined }
  }
  async function handleInteraction(event: Record<string, unknown>, execution: PublicExecution) {
    const method = string(event.method)
    if (['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(method)) {
      state.messages.push({ id: `pi-${randomUUID()}`, executionId: execution.executionId, role: 'tool', toolName: `Pi ${method}`,
        text: clean(event.message ?? event.statusText ?? event.title ?? event.text ?? (Array.isArray(event.widgetLines) ? event.widgetLines.join('\n') : '')) })
      await commit(); return
    }
    if (!['confirm', 'select', 'input', 'editor'].includes(method)) throw new Error(`Unsupported Pi interaction: ${method}`)
    const id = `pi-ui-${randomUUID()}`
    const options = Array.isArray(event.options) ? event.options.map(v => clean(v, 2000)).filter(Boolean) : []
    if (method === 'select' && (!options.length || new Set(options).size !== options.length)) throw new Error('Pi select request has invalid choices')
    const interaction: PublicInteraction = {
      id, kind: method === 'confirm' ? 'permission' : 'question', title: clean(event.title, 2000) || 'Pi request',
      ...(event.message ? { description: clean(event.message, 20_000) } : {}),
      actions: method === 'confirm' ? [{ id: 'allow', intent: 'allow', label: 'Confirm' }, { id: 'deny', intent: 'deny', label: 'Decline' }]
        : [{ id: 'submit', intent: 'submit', label: 'Submit' }, { id: 'cancel', intent: 'cancel', label: 'Cancel' }],
      questions: method === 'confirm' ? [] : [{ id: 'answer', prompt: clean(event.title, 20_000) || 'Pi request', multiple: false,
        allowOther: method !== 'select', secret: false, options: options.map(value => ({ value, label: value })) }]
    }
    const item = { nativeId: string(event.id), method, options, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    if (!item.nativeId) throw new Error('Pi interaction is missing an identity')
    if (typeof event.timeout === 'number' && Number.isFinite(event.timeout) && event.timeout >= 0) {
      item.timer = setTimeout(() => failed(new Error('Pi user request expired; rerun the task to answer again')), Math.min(event.timeout, 2_147_483_647))
    }
    interactionMap.set(id, item)
    const current = active()!
    replaceExecution({ executionId: current.executionId, startedAt: current.startedAt, status: 'waiting-for-user',
      interactions: [...(current.status === 'waiting-for-user' ? current.interactions : []), interaction] })
    await commit()
  }
  // Restoring observations does not require launching native code or loading extensions.
  if (active()) await finish('interrupted')
  const onContextAbort = () => { void stop('interrupted').catch(() => undefined) }
  context.signal.addEventListener('abort', onContextAbort, { once: true })
  if (context.signal.aborted) onContextAbort()

  return {
    send(request) { return accept(async () => {
      if (disposed) throw new Error('Pi Thread is disposed')
      context.signal.throwIfAborted()
      request.signal.throwIfAborted()
      const pieces: string[] = []
      const images: unknown[] = []
      const imageReferences: string[] = []
      for (const part of request.input.parts) {
        if (part.kind === 'text') pieces.push(part.text)
        else if (part.kind === 'local-file') pieces.push(`Attached file: ${part.file.path}`)
        else if (part.kind === 'mention' || part.kind === 'skill') pieces.push(`${part.kind}: ${part.name}\n${part.path}`)
        else if (part.kind === 'image') {
          images.push({ type: 'image', mimeType: part.file.mimeType, data: (await readFile(part.file.path)).toString('base64') })
          imageReferences.push(`Attached image: ${part.file.path}`)
        }
        else throw new Error(`Pi does not support ${part.kind} inputs; attach a local image or file`)
      }
      const message = [...(request.contextEntries ?? []).map(e => e.content), ...pieces].join('\n\n')
      // Injected run context reaches native only. The durable user row stays the
      // user's own text so Thread History never renders injected context.
      const visibleText = [...pieces, ...imageReferences].filter(Boolean).join('\n\n')
      if (message.trimStart().startsWith('/')) throw new Error('Pi slash commands are unsupported in Threads; send a natural-language task')
      if (pendingStop && !stopping) await stop(pendingStop.status, pendingStop.reason)
      await stopping
      let steering = false
      const submitted = { id: `pi-${randomUUID()}`, executionId: request.executionId, text: message, echoed: false }
      await serialize(async () => {
        if (disposed) throw new Error('Pi Thread is disposed')
        request.signal.throwIfAborted()
        context.signal.throwIfAborted()
        const current = active()
        if (current && current.executionId !== request.executionId) throw new Error('Pi already has an active Execution')
        steering = Boolean(current)
        const previous = structuredClone(state)
        if (!current) {
          lastStop = undefined; lastError = undefined; assistantId = undefined
          delete state.nativeSessionJsonl
          state.latestExecutionId = request.executionId
          replaceExecution({ executionId: request.executionId, startedAt: Date.now(), status: 'running' })
        }
        state.messages.push({ id: submitted.id, executionId: request.executionId, role: 'user', text: visibleText })
        try { await commit() } catch (error) { Object.assign(state, previous); throw error }
        pendingUserEchoes.push(submitted)
      })
      const onAbort = () => { void stop('interrupted').catch(() => undefined) }
      if (!steering && !abortListeners.has(request.signal)) { abortListeners.set(request.signal, onAbort); request.signal.addEventListener('abort', onAbort, { once: true }) }
      try {
        request.signal.throwIfAborted()
        // The running commit above is Core's durability/workspace admission boundary.
        const native = await ensureConnection(steering)
        request.signal.throwIfAborted()
        await native.request({ type: 'prompt', message, ...(images.length ? { images } : {}), ...(steering ? { streamingBehavior: 'steer' } : {}) }, request.signal)
      } catch (error) {
        if (!steering) await stop(request.signal.aborted ? 'interrupted' : 'failed', error instanceof Error ? error.message : String(error))
        else await serialize(async () => {
          // A native echo proves delivery even if cancellation raced the acknowledgement.
          if (submitted.echoed) return
          const previous = state.messages
          state.messages = previous.filter(row => row.id !== submitted.id)
          try { await commit() } catch (commitError) { state.messages = previous; throw commitError }
          const index = pendingUserEchoes.findIndex(input => input.id === submitted.id)
          if (index >= 0) pendingUserEchoes.splice(index, 1)
        })
        throw error
      } finally {
        // Caller cancellation governs acceptance only. Bart tool scopes end after ack.
        request.signal.removeEventListener('abort', onAbort)
        abortListeners.delete(request.signal)
      }
    }) },
    async respond(request) {
      if (disposed || closing || !rpc) throw new Error('Pi connection is closed')
      await serialize(async () => {
        const item = interactionMap.get(request.interactionId)
        const current = active()
        if (!item || current?.status !== 'waiting-for-user') throw new Error('Unknown or expired Pi interaction')
        const interaction = current.interactions.find(i => i.id === request.interactionId)
        if (!interaction?.actions.some(a => a.id === request.actionId)) throw new Error('Invalid Pi response action')
        let payload: Record<string, unknown>
        if (item.method === 'confirm') payload = { confirmed: request.actionId === 'allow' }
        else if (request.actionId === 'cancel') payload = { cancelled: true }
        else {
          const value = request.answers?.answer
          if (typeof value !== 'string' || (item.method === 'select' && !item.options.includes(value))) throw new Error('Invalid Pi answer')
          payload = { value }
        }
        if (!rpc || closing) throw new Error('Pi connection is closed')
        await rpc.write({ type: 'extension_ui_response', id: item.nativeId, ...payload })
        if (item.timer) clearTimeout(item.timer)
        interactionMap.delete(request.interactionId)
        const remaining = current.interactions.filter(i => i.id !== request.interactionId)
        replaceExecution({ executionId: current.executionId, startedAt: current.startedAt,
          ...(remaining.length ? { status: 'waiting-for-user' as const, interactions: remaining } : { status: 'running' as const }) })
        await commit()
      })
    },
    async interrupt() { await stop('interrupted') },
    async read(_question, readSignal) {
      readSignal.throwIfAborted(); await queue; readSignal.throwIfAborted()
      return state.messages.map(m => `[${m.role}${m.toolName ? `:${m.toolName}` : ''}] ${m.text}`).join('\n\n')
    },
    async dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort()
      context.signal.removeEventListener('abort', onContextAbort)
      await stop('interrupted')
      unsubscribe(); unsubscribeFailure(); clearInteractions()
      await queue
    }
  }
}
