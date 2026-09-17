import { afterEach, describe, expect, it, vi } from 'vitest'
import { HARNESS_IDS, providerOptions, providerProfile } from './bart-headless/providers.mjs'
import { loadRunConfig, parseArguments } from './bart-headless/plan.mjs'

afterEach(() => vi.unstubAllEnvs())

describe('native acceptance generic Harness profiles', () => {
  it('keeps ambient model overrides out of every mock host and target', async () => {
    const cli = parseArguments([])
    const config = await loadRunConfig('/unused', cli)
    const expected = HARNESS_IDS.map(id => ({
      host: providerProfile(id, config, 'host'), target: providerOptions(id, config)
    }))
    for (const id of HARNESS_IDS) {
      vi.stubEnv(`OPENAGENT_ACCEPTANCE_${id.toUpperCase()}_MODEL`, 'stale-remote-model')
      vi.stubEnv(`OPENAGENT_ACCEPTANCE_HOST_${id.toUpperCase()}_MODEL`, 'stale-host-model')
    }
    const isolated = await loadRunConfig('/unused', cli)
    expect(HARNESS_IDS.map(id => ({
      host: providerProfile(id, isolated, 'host'), target: providerOptions(id, isolated)
    }))).toEqual(expected)
    expect(process.env.OPENAGENT_ACCEPTANCE_CODEX_MODEL).toBe('stale-remote-model')
  })

  it('uses GUI-shaped profiles and preserves all native creation settings', () => {
    const config = { providers: { codex: {
      threadSettings: { model: 'native-model', effort: 'low', personality: 'friendly' }
    } } }
    expect(providerOptions('codex', config)).toMatchObject({
      model: 'native-model', effort: 'low', personality: 'friendly'
    })
    // A profile carrying values must opt out of the Agent defaults, or the
    // product's normalizer discards them before the run can use them.
    expect(providerProfile('codex', config)).toEqual({
      useDefaultThreadSettings: false, threadSettings: config.providers.codex.threadSettings
    })
    expect(providerProfile('codex', { providers: { codex: { threadSettings: {} } } }))
      .toEqual({ threadSettings: {} })
  })

  it('lets the host use independent native settings from its delegated target', () => {
    const config = {
      providers: { claude: { threadSettings: { model: 'target-model' } } },
      hostProfiles: { claude: { threadSettings: { model: 'host-model' } } }
    }
    expect(providerProfile('claude', config, 'host').threadSettings.model).toBe('host-model')
    expect(providerOptions('claude', config).model).toBe('target-model')
  })

  // This helper only forwards what the profile declares. The product's Harness
  // normalizers reject the key, so the injection fixture's own in-process seam
  // is the only consumer that can use a declared Thread executable.
  it.each(['codex', 'claude', 'pi'])('forwards the %s Thread executable into request options', harnessId => {
    const config = { providers: { [harnessId]: {
      threadSettings: { executablePath: `/local/thread-${harnessId}` }
    } } }
    expect(providerOptions(harnessId, config).executablePath).toBe(`/local/thread-${harnessId}`)
  })

  it('rejects old profile fields with an actionable migration error', () => {
    expect(() => providerOptions('codex', {
      providers: { codex: { options: { model: 'old' } } }
    })).toThrow('threadSettings')
    expect(() => providerOptions('codex', {
      providers: { codex: { executablePath: '/local/codex', threadSettings: {} } }
    })).toThrow('threadSettings')
  })
})
