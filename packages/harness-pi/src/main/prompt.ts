import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isJsonValue, type HarnessPluginHostContext, type HarnessPromptApi } from '@openagent/contracts'
import type { PiThreadSettings } from '../shared/types.js'
import { startPiRpc, type PiRpc } from './runtime/rpc.js'
import { piModelArguments } from './runtime/model-options.js'
import { piEnvironment, piProviderSettings } from './runtime/provider-injection.js'

export function createPiPrompt(host: HarnessPluginHostContext): HarnessPromptApi<PiThreadSettings> {
  return { async complete(request) {
    request.signal.throwIfAborted()
    await mkdir(host.temporaryWorkspaceRoot, { recursive: true, mode: 0o700 })
    const cwd = await mkdtemp(join(host.temporaryWorkspaceRoot, 'pi-prompt-'))
    let rpc: PiRpc | undefined
    try {
      const executablePath = await host.resolveExecutable('pi', cwd, request.settings?.executablePath)
      rpc = await startPiRpc({ executablePath, cwd, env: await piEnvironment(host), signal: request.signal,
        args: ['--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', ...piModelArguments(piProviderSettings(request.settings ?? {}, host.providers?.explicit?.injection))] })
      let text = ''
      let stopReason = ''
      let resolve!: () => void
      let reject!: (error: Error) => void
      const settled = new Promise<void>((res, rej) => { resolve = res; reject = rej })
      void settled.catch(() => undefined)
      rpc.onFailure(reject)
      rpc.subscribe(event => {
        if (event.type === 'agent_settled') {
          if (stopReason === 'error' || stopReason === 'aborted') reject(new Error('Pi metadata completion failed or was interrupted'))
          else resolve()
        }
        else if (event.type === 'extension_ui_request') reject(new Error('Pi metadata prompt requested unsupported user interaction'))
        else if (event.type === 'message_end') {
          const message = event.message as Record<string, unknown> | undefined
          if (message?.role === 'assistant') {
            stopReason = String(message.stopReason ?? '')
            text = Array.isArray(message.content) ? message.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : ''
          }
        }
      })
      const message = ['Complete this isolated OpenAgent request. Messages follow as JSON data:',
        ...request.messages.map(m => JSON.stringify(m)), request.outputFormat.type === 'json_schema'
          ? `Return only one JSON value matching this schema: ${JSON.stringify(request.outputFormat.schema)}` : 'Return only the requested text.'].join('\n')
      await rpc.request({ type: 'prompt', message }, request.signal)
      await settled
      request.signal.throwIfAborted()
      const finishReason = stopReason === 'stop' ? 'stop' : stopReason === 'length' ? 'length' : 'other'
      if (request.outputFormat.type === 'text') return { output: { type: 'text', text }, finishReason }
      const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
      const value: unknown = JSON.parse(fenced ? fenced[1]! : text.trim())
      if (!isJsonValue(value)) throw new Error('Pi returned invalid JSON')
      return { output: { type: 'json', value }, finishReason }
    } finally { await rpc?.dispose(); await rm(cwd, { recursive: true, force: true }) }
  } }
}
