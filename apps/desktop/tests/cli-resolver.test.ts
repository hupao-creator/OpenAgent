import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CliResolver } from '../src/main/services/cli-resolver'

describe('CLI resolver path resolution', () => {
  it('preserves an explicit environment across refresh without reading login-shell exports', async () => {
    const resolver = new CliResolver({ PATH: '/isolated/bin', HOME: '/isolated/home' })
    const first = await resolver.environment()
    expect(first).toEqual({ PATH: '/isolated/bin', HOME: '/isolated/home', TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' })
    first.HOME = '/mutated'
    await resolver.refreshEnvironment()
    expect((await resolver.environment()).HOME).toBe('/isolated/home')
  })

  it('shares concurrent executable discovery and retries after failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openagent-cli-discovery-'))
    const executable = join(directory, 'codex')
    const resolver = new CliResolver()
    const environment = vi.spyOn(resolver, 'environment').mockResolvedValue({})
    try {
      const missing = await Promise.allSettled([
        resolver.resolve('codex', executable),
        resolver.resolve('codex', executable)
      ])
      expect(missing.map(result => result.status)).toEqual(['rejected', 'rejected'])
      expect(environment).toHaveBeenCalledTimes(1)

      await writeFile(executable, '#!/bin/sh\n', { mode: 0o755 })
      await expect(Promise.all([
        resolver.resolve('codex', executable),
        resolver.resolve('codex', executable)
      ])).resolves.toEqual([executable, executable])
      expect(environment).toHaveBeenCalledTimes(2)

      await rm(executable)
      await expect(resolver.resolve('codex', executable)).rejects.toThrow('未找到')
      expect(environment).toHaveBeenCalledTimes(3)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not share mutable launch environments between provider consumers', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const resolver = new CliResolver()
      const [first, second] = await Promise.all([
        resolver.environment(),
        resolver.environment()
      ])
      expect(first === second).toBe(false)
      first.TERM = 'provider-specific-term'
      first.OPENAGENT_RESOLVER_TEST = 'provider-specific-value'
      delete first.NO_COLOR

      const next = await resolver.environment()
      expect(next.TERM).toBe('dumb')
      expect(next.NO_COLOR).toBe('1')
      expect(next.OPENAGENT_RESOLVER_TEST).toBe(second.OPENAGENT_RESOLVER_TEST)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('resolves Windows Path and PathExt keys without relying on their casing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openagent-win-path-'))
    const executable = join(directory, 'codex.CMD')
    const originalPlatform = process.platform
    await writeFile(executable, '@echo off\r\n')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const resolver = new CliResolver()
      vi.spyOn(resolver, 'environment').mockResolvedValue({
        Path: `"${directory}"`,
        PathExt: '.CMD;.EXE'
      })

      await expect(resolver.resolve('codex')).resolves.toBe(executable)
      await expect(resolver.resolve('codex', 'codex.CMD')).resolves.toBe(executable)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resolves configured paths relative to each workspace and keeps choices isolated', async () => {
    const first = await mkdtemp(join(tmpdir(), 'openagent-cli-first-'))
    const second = await mkdtemp(join(tmpdir(), 'openagent-cli-second-'))
    const name = process.platform === 'win32' ? 'custom-agent.exe' : 'custom-agent'
    try {
      for (const directory of [first, second]) await writeFile(join(directory, name), '#!/bin/sh\n', { mode: 0o755 })
      const resolver = new CliResolver()
      vi.spyOn(resolver, 'environment').mockResolvedValue({ PATH: first })
      await expect(resolver.resolve(name)).resolves.toBe(join(first, name))
      await expect(resolver.resolve('unrelated-harness', `./${name}`, first)).resolves.toBe(join(first, name))
      await expect(resolver.resolve('unrelated-harness', `./${name}`, second)).resolves.toBe(join(second, name))
      await expect(resolver.resolve(name, './missing', second)).rejects.toThrow('未找到')
    } finally {
      await Promise.all([first, second].map(directory => rm(directory, { recursive: true, force: true })))
    }
  })

})
