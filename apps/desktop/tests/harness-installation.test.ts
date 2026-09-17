import { describe, expect, it, vi } from 'vitest'
import { createClaudeMainPlugin } from '../../../packages/harness-claude/src/main'
import { createCodexMainPlugin } from '../../../packages/harness-codex/src/main'
import {
  HarnessExecutableNotFoundError,
  type HarnessInstallation
} from '@openagent/contracts'
import type { HarnessId } from '../src/shared/harnesses'

type ResolveExecutable = (
  cwd: string,
  configuredPath?: string
) => Promise<string>

type InstallationPlugin = {
  detectInstallation(input: {
    readonly cwd: string
    readonly signal: AbortSignal
  }): Promise<HarnessInstallation>
}

const plugins: readonly {
  readonly id: HarnessId
  readonly create: (resolveExecutable: ResolveExecutable) => InstallationPlugin
}[] = [
  {
    id: 'codex',
    create: resolveExecutable => createCodexMainPlugin({
      resolveExecutable,
      environment: async () => ({ ...process.env }),
      dataRoot: '/tmp/openagent-installation-codex',
      temporaryWorkspaceRoot: '/tmp'
    })
  },
  {
    id: 'claude',
    create: resolveExecutable => createClaudeMainPlugin({
      resolveExecutable,
      environment: async () => ({ ...process.env })
    })
  }
]

describe('active Harness installation probes', () => {
  it.each(plugins)('$id reports PATH presence without a configured path', async ({ id, create }) => {
    const resolveExecutable = vi.fn(async (cwd: string, configuredPath?: string) => {
      expect(cwd).toBe('/workspace')
      expect(configuredPath).toBeUndefined()
      return `/resolved/${id}`
    })
    const plugin = create(resolveExecutable)

    await expect(plugin.detectInstallation({
      cwd: '/workspace',
      signal: new AbortController().signal
    })).resolves.toEqual({
      status: 'installed',
      executablePath: `/resolved/${id}`
    })
    expect(resolveExecutable).toHaveBeenCalledOnce()
    expect(resolveExecutable).toHaveBeenCalledWith('/workspace')
  })

  it.each(plugins)('$id maps only the typed missing error to missing', async ({ id, create }) => {
    const resolveExecutable = vi.fn(async () => {
      throw new HarnessExecutableNotFoundError(id)
    })
    const plugin = create(resolveExecutable)

    await expect(plugin.detectInstallation({
      cwd: '/workspace',
      signal: new AbortController().signal
    })).resolves.toEqual({ status: 'missing' })
  })

  it.each(plugins)('$id preserves unexpected resolver failures', async ({ create }) => {
    const resolverFailure = new Error('resolver unavailable')
    const resolveExecutable = vi.fn(async () => {
      throw resolverFailure
    })
    const plugin = create(resolveExecutable)

    await expect(plugin.detectInstallation({
      cwd: '/workspace',
      signal: new AbortController().signal
    })).rejects.toBe(resolverFailure)
  })

  it.each(plugins)('$id does not turn an aborted probe into missing', async ({ id, create }) => {
    const abortReason = new Error(`${id} detection aborted`)
    const controller = new AbortController()
    controller.abort(abortReason)
    const resolveExecutable = vi.fn(async () => {
      throw new HarnessExecutableNotFoundError(id)
    })
    const plugin = create(resolveExecutable)

    await expect(plugin.detectInstallation({
      cwd: '/workspace',
      signal: controller.signal
    })).rejects.toSatisfy(error =>
      error === abortReason || (error instanceof Error && error.name === 'AbortError')
    )
    expect(resolveExecutable).not.toHaveBeenCalled()
  })
})
