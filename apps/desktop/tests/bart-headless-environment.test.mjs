import { describe, expect, it } from 'vitest'
import { createHeadlessEnvironment } from './bart-headless/headless.mjs'
import { isolatedNativeEnvironment } from './bart-headless/native-environment.mjs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Bart headless acceptance environment', () => {
  it('starts from empty native profiles and excludes inherited credentials and shell hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'headless-auth-isolation-'))
    try {
      const environment = await isolatedNativeEnvironment(root, {
        HOME: '/real-home', CODEX_HOME: '/real-codex', CLAUDE_CONFIG_DIR: '/real-claude',
        PI_CODING_AGENT_DIR: '/real-pi', ANTHROPIC_AUTH_TOKEN: 'native-login', OPENAI_API_KEY: 'other-key',
        DEEPSEEK_API_KEY: 'ambient-key', ZDOTDIR: '/real-shell', BASH_ENV: '/real-hook',
        PATH: '/usr/bin',
        ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
          'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].map(key => [key, 'http://127.0.0.1:9999']))
      })
      expect(environment.PATH).toBe('/usr/bin')
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
        'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) expect(environment[key]).toBeUndefined()
      for (const key of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ZDOTDIR', 'BASH_ENV']) expect(environment[key]).toBeUndefined()
      for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) {
        expect(environment[key].startsWith(root + '/')).toBe(true)
        expect(await readdir(environment[key])).toEqual([])
      }
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('pins both mutable OpenAgent roots to the worker directory', () => {
    const environment = createHeadlessEnvironment({
      userData: '/tmp/run/w0/user-data',
      openAgentHome: '/tmp/run/w0/openagent-home',
      repositoryRoot: '/tmp/repository',
      provider: 'deepseek'
    }, { HOME: '/Users/real-user', PRESERVED: 'yes' })

    expect(environment).toMatchObject({
      HOME: '/Users/real-user',
      PRESERVED: 'yes',
      OPENAGENT_HEADLESS: '1',
      OPENAGENT_HEADLESS_PORT: '0',
      OPENAGENT_HEADLESS_USER_DATA: '/tmp/run/w0/user-data',
      OPENAGENT_HEADLESS_HOME: '/tmp/run/w0/openagent-home',
      OPENAGENT_DEV_CWD: '/tmp/repository',
      OPENAGENT_BART_HEADLESS_PROVIDER: 'deepseek'
    })
    expect(environment.OPENAGENT_HEADLESS_HOME).not.toContain('/Users/real-user')
  })
})
