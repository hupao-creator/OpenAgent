import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CliResolver } from '../src/main/services/cli-resolver'
import { HarnessExecutableNotFoundError } from '@openagent/contracts'
import { flushDebugLog, initDebugLog } from '@openagent/plugin-kit/main'

describe('CLI resolver path resolution', () => {
  it.each(['summary', 'detail'])('records missing candidates as discovery results in %s mode', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'openagent-cli-log-'))
    vi.stubEnv('OPENAGENT_DEBUG_LOG', mode)
    const logPath = initDebugLog(join(directory, 'logs'))!
    const resolver = new CliResolver({ PATH: directory })
    try {
      await expect(resolver.resolve('missing-candidate')).rejects.toBeInstanceOf(HarnessExecutableNotFoundError)
      await flushDebugLog()
      const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const started = events.find(event => event.evt === 'cli.resolve.started')
      const terminals = events.filter(event => event.evt === 'cli.resolve.completed' || event.evt === 'cli.resolve.failed')
      expect(terminals).toEqual([expect.objectContaining({
        evt: 'cli.resolve.completed', level: 'info', resolved: false,
        command: 'missing-candidate', spanId: started.spanId
      })])
      expect(events.filter(event => event.level === 'error')).toEqual([])
      const misses = events.filter(event => event.evt === 'cli.resolve.not-found')
      expect(misses).toHaveLength(mode === 'detail' ? 1 : 0)
      if (mode === 'detail') expect(misses[0]).toMatchObject({ level: 'debug', spanId: started.spanId })
    } finally {
      vi.stubEnv('OPENAGENT_DEBUG_LOG', 'off')
      initDebugLog(join(directory, 'logs'))
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('records an unexpected resolution failure exactly once and preserves the caller error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openagent-cli-error-'))
    vi.stubEnv('OPENAGENT_DEBUG_LOG', 'summary')
    const logPath = initDebugLog(join(directory, 'logs'))!
    const resolver = new CliResolver()
    const failure = new Error('environment unavailable')
    vi.spyOn(resolver, 'environment').mockRejectedValue(failure)
    try {
      await expect(resolver.resolve('unavailable')).rejects.toBe(failure)
      await flushDebugLog()
      const events = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(events.filter(event => event.evt === 'cli.resolve.failed')).toEqual([
        expect.objectContaining({ level: 'error', error: expect.objectContaining({ message: failure.message }) })
      ])
      expect(events.some(event => event.evt === 'cli.resolve.completed' || event.evt === 'cli.resolve.not-found')).toBe(false)
    } finally {
      vi.stubEnv('OPENAGENT_DEBUG_LOG', 'off')
      initDebugLog(join(directory, 'logs'))
      vi.unstubAllEnvs()
      await rm(directory, { recursive: true, force: true })
    }
  })

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
