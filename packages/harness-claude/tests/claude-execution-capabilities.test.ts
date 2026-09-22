import { mockProviderAccess } from '@openagent/test-kit'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutableNotFoundError } from '@openagent/contracts'
import type { HarnessPluginHostContext } from '@openagent/contracts'
import { claudeMainPluginModule } from '../src/main/module.js'
import { ClaudeTransport } from '../src/main/runtime/transport.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('Claude execution capabilities', () => {
  it.each([claudeMainPluginModule])('$id probes execution without loading settings presentation or a model catalog', async module => {
    const context = hostContext()
    const resolveExecutable = vi.spyOn(context, 'resolveExecutable')
    const bundle = module.createMainPlugin(context)
    const presentation = vi.spyOn(bundle.settingsPresentation, 'load').mockRejectedValue(new Error('catalog unavailable'))
    try {
      await expect(bundle.availability.probe({
        settings: { threadSettings: {} }, cwd: tmpdir(), signal: new AbortController().signal
      })).resolves.toEqual({ available: true })
      expect(presentation).not.toHaveBeenCalled()
      expect(resolveExecutable).toHaveBeenCalledWith(module.id, tmpdir(), undefined)
    } finally {
      await bundle.dispose?.()
    }
  })

  // The host auto-detects the CLI, so availability must never be steered by a
  // persisted path: only a created Thread pins one, and that is not a settings
  // concern.
  it.each([claudeMainPluginModule])('$id auto-detects the CLI instead of carrying a configured path', async module => {
    const resolveExecutable = vi.fn(async (_command: string, _cwd: string, configuredPath?: string) => {
      if (configuredPath !== undefined) throw new Error('availability carried a configured executable')
      return process.execPath
    })
    const bundle = module.createMainPlugin({ ...hostContext(), resolveExecutable })
    try {
      await expect(bundle.availability.probe({
        settings: { threadSettings: {} },
        cwd: tmpdir(), signal: new AbortController().signal
      })).resolves.toEqual({ available: true })
      expect(resolveExecutable.mock.calls).toEqual([[module.id, tmpdir(), undefined]])
    } finally {
      await bundle.dispose?.()
    }
  })

  it.each([claudeMainPluginModule])('$id reports an unavailable CLI and propagates cancellation while resolving it', async module => {
    const missing = module.createMainPlugin({
      ...hostContext(), resolveExecutable: async () => '/does-not-exist/probe-cli'
    })
    try {
      await expect(missing.availability.probe({
        settings: { threadSettings: {} }, cwd: tmpdir(), signal: new AbortController().signal
      })).resolves.toMatchObject({ available: false })
    } finally {
      await missing.dispose?.()
    }

    const controller = new AbortController()
    const pending = module.createMainPlugin({
      ...hostContext(), resolveExecutable: () => new Promise<string>(() => undefined)
    })
    const result = pending.availability.probe({
      settings: { threadSettings: {} }, cwd: tmpdir(), signal: controller.signal
    })
    const rejected = expect(result).rejects.toThrow('probe cancelled')
    try {
      controller.abort(new Error('probe cancelled'))
      await rejected
    } finally {
      controller.abort(new Error('probe cancelled'))
      await rejected
      await pending.dispose?.()
    }
  })

  // Claude's defaults name the command rather than a path, so they have to
  // reach the same auto-detection a Thread without a pinned binary uses —
  // including the installer location, which a native installer can populate
  // before the login shell's PATH knows about it.
  it('falls back to the Claude installer location for the default command', async () => {
    const installPath = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
    const attempted: Array<string | undefined> = []
    const resolveExecutable = vi.fn(async (_command: string, _cwd: string, configuredPath?: string) => {
      attempted.push(configuredPath)
      throw new HarnessExecutableNotFoundError('claude')
    })
    const bundle = claudeMainPluginModule.createMainPlugin({ ...hostContext(), resolveExecutable })
    try {
      // Both lookups fail, so the catalog only knows the CLI is unavailable —
      // the point is that the default command reached the installer location.
      await bundle.settings.describe({
        settings: { threadSettings: {} }, cwd: tmpdir(), signal: new AbortController().signal
      })
      expect(attempted).toEqual(['claude', installPath])
    } finally {
      await bundle.dispose?.()
    }
  })
})

describe('Host-owned provider configuration', () => {
  it('passes each Claude transport its explicit provider without ambient policy leakage', async () => {
    vi.stubEnv('OPENAGENT_BART_HEADLESS_PROVIDER', 'unsupported-global-provider')
    const directory = await workspace('unused', 'deepseek-v4-pro')
    const executable = join(directory, 'claude-fixture')
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(process.env.CLI_CAPTURE, JSON.stringify(process.argv.slice(2)))
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line)
  if (value.type === 'control_request') process.stdout.write(JSON.stringify({
    type: 'control_response', response: {
      subtype: 'success', request_id: value.request_id, response: { models: [] }
    }
  }) + String.fromCharCode(10))
})
`, { mode: 0o755 })
    for (const providerOverride of [undefined, {
      provider: 'deepseek', model: 'deepseek-v4-pro', apiKey: 'claude-instance-key', baseUrl: 'http://127.0.0.1:12345'
    }]) {
      const capture = join(directory, providerOverride ? 'override.json' : 'normal.json')
      const transport = new ClaudeTransport({
        executable, cwd: directory, environment: { CLI_CAPTURE: capture }, providerInjection: providerOverride ? mockProviderAccess('claude', providerOverride).explicit!.injection : undefined,
        sessionId: 'host-isolation', resume: false, settings: { executablePath: executable },
        interactive: false, persistSession: false, onEvent: () => undefined
      })
      try {
        await transport.inspectInitialization()
        const args = JSON.parse(await readFile(capture, 'utf8')) as string[]
        const settingsIndex = args.indexOf('--settings')
        const injected = settingsIndex >= 0 ? JSON.parse(args[settingsIndex + 1]) : {}
        if (providerOverride) {
          expect(injected.env).toMatchObject({
            ANTHROPIC_AUTH_TOKEN: 'claude-instance-key',
            ANTHROPIC_MODEL: 'deepseek-v4-pro'
          })
        } else {
          expect(injected.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
          expect(injected.env?.ANTHROPIC_MODEL).toBeUndefined()
        }
      } finally {
        await transport.dispose()
      }
    }
  })
})

function hostContext(): HarnessPluginHostContext {
  return {
    resolveExecutable: async () => process.execPath,
    environment: async () => ({}),
    harnessDataRoot: tmpdir(),
    temporaryWorkspaceRoot: tmpdir()
  }
}

async function workspace(apiKey: string, model: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-provider-config-'))
  directories.push(directory)
  await writeFile(join(directory, '.env'), `DEEPSEEK_API_KEY=${apiKey}\nDEEPSEEK_MODEL=${model}\n`)
  return directory
}
