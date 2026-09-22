import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutableNotFoundError } from '@openagent/contracts'
import { createCodexExecutableResolver } from '../src/main/executable.js'

const fixtures: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Codex executable selection', () => {
  it.skipIf(process.platform === 'win32')('uses the newer app-server for both automatic catalog and execution resolution', async () => {
    const oldCli = await executable('codex-cli 0.153.4')
    const desktopCli = await executable('codex-cli 0.155.0-alpha.9.2')
    const resolve = vi.fn(async (_cwd: string, configured?: string) => configured || oldCli)
    const selected = createCodexExecutableResolver(resolve, async () => ({}), [desktopCli])

    await expect(selected('/workspace')).resolves.toBe(desktopCli)
    await expect(selected('/workspace', oldCli)).resolves.toBe(oldCli)
    expect(resolve).toHaveBeenLastCalledWith('/workspace', oldCli)
  })

  it.skipIf(process.platform === 'win32')('keeps a newer PATH CLI and stable releases ahead of the same prerelease', async () => {
    const pathCli = await executable('codex-cli 0.155.0')
    const desktopCli = await executable('codex-cli 0.155.0-alpha.9.2')
    const selected = createCodexExecutableResolver(
      async (_cwd, configured) => configured || pathCli,
      async () => ({}),
      [desktopCli]
    )

    await expect(selected('/workspace')).resolves.toBe(pathCli)
  })

  it.skipIf(process.platform === 'win32')('falls back to an installed CLI when PATH is missing', async () => {
    const installedCli = await executable('codex-cli 0.155.0')
    const selected = createCodexExecutableResolver(
      async (_cwd, configured) => {
        if (!configured) throw new HarnessExecutableNotFoundError('codex')
        return configured
      },
      async () => ({}),
      [installedCli]
    )

    await expect(selected('/workspace')).resolves.toBe(installedCli)
  })

  it.skipIf(process.platform === 'win32')('preserves a working PATH wrapper whose version cannot be identified', async () => {
    const wrapper = await executable('custom-wrapper 1.0.0')
    const desktopCli = await executable('codex-cli 0.155.0')
    const selected = createCodexExecutableResolver(
      async (_cwd, configured) => configured || wrapper,
      async () => ({}),
      [desktopCli]
    )

    await expect(selected('/workspace')).resolves.toBe(wrapper)
  })

  it.skipIf(process.platform !== 'win32')('compares versions exposed by Windows command shims', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openagent-codex-windows-shims-'))
    fixtures.push(directory)
    const pathCli = join(directory, 'codex.cmd')
    const installedCli = join(directory, 'installed.cmd')
    await writeFile(pathCli, '@echo off\r\necho codex-cli 0.153.4\r\n')
    await writeFile(installedCli, '@echo off\r\necho codex-cli 0.155.0\r\n')
    const selected = createCodexExecutableResolver(
      async (_cwd, configured) => configured || pathCli,
      async () => ({ ...process.env }),
      [installedCli]
    )

    await expect(selected('C:\\workspace')).resolves.toBe(installedCli)
  })

  it('keeps a configured path authoritative even when it is missing', async () => {
    const resolve = vi.fn(async (_cwd: string, configured?: string): Promise<string> => {
      if (configured) throw new HarnessExecutableNotFoundError(configured)
      return '/path/codex'
    })
    const selected = createCodexExecutableResolver(resolve, async () => ({}), ['/desktop/codex'])

    await expect(selected('/workspace', '/missing/codex')).rejects.toThrow('未找到')
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

async function executable(version: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-codex-executable-'))
  fixtures.push(directory)
  const path = join(directory, 'codex')
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 })
  return path
}
